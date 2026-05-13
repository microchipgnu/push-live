import type { Env } from './types.ts';
import { casKey } from './lib/hash.ts';
import { decryptValue } from './lib/crypto.ts';

type ProxyRoute = {
  match: string;                       // path pattern: /api/x or /api/x/*
  upstream: string;                    // absolute URL
  method?: string | string[];          // limit which methods proxy
  headers?: Record<string, string>;    // forwarded headers (with ${VAR} refs)
  forwardBody?: boolean;               // default true for POST/PUT/PATCH
  stripHeaders?: string[];             // request headers to strip before forwarding
  passQuery?: boolean;                 // default true
  timeoutMs?: number;                  // upstream fetch timeout; default 30s, max 120s
  rateLimit?: string;                  // "20/hour/ip" or "100/min/ip" — default DEFAULT_RATE_LIMIT
};

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_UPSTREAM_TIMEOUT_MS = 120_000;
const DEFAULT_RATE_LIMIT = '100/hour/ip';
const PROXY_BODY_CAP_BYTES = 10 * 1024 * 1024;

type ProxyManifest = {
  routes: ProxyRoute[];
};

const FORBIDDEN_REQ_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'cookie', 'authorization',
]);
const FORBIDDEN_RES_HEADERS = new Set([
  'set-cookie', 'transfer-encoding', 'content-encoding',
  'content-length',
]);

export async function tryProxyRoute(
  env: Env,
  slug: string,
  versionId: string,
  ownerUserId: string | null,
  pathname: string,
  req: Request,
): Promise<Response | null> {
  const proxyFile = await env.DB.prepare(
    `SELECT sha256 FROM site_files WHERE version_id = ?1 AND path = '.push-live/proxy.json'`,
  ).bind(versionId).first<{ sha256: string }>();
  if (!proxyFile) return null;

  const cacheKey = `proxy:${slug}:${versionId}`;
  let manifest: ProxyManifest | null = null;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    try { manifest = JSON.parse(cached) as ProxyManifest; } catch {}
  }
  if (!manifest) {
    const obj = await env.SITES.get(casKey(proxyFile.sha256));
    if (!obj) return null;
    try {
      manifest = JSON.parse(await obj.text()) as ProxyManifest;
    } catch {
      return null;
    }
    await env.KV.put(cacheKey, JSON.stringify(manifest), { expirationTtl: 300 });
  }

  const route = pickRoute(manifest, pathname, req.method);
  if (!route) return null;

  // Per-route rate limit (default 100/hr/ip). KV-backed, second-resolution.
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const limit = parseRateLimit(route.rateLimit ?? DEFAULT_RATE_LIMIT);
  if (limit) {
    const rlKey = `rl:proxy:${slug}:${route.match}:${limit.scope === 'ip' ? ip : 'all'}`;
    const wait = await checkProxyRate(env, rlKey, limit);
    if (wait > 0) {
      return new Response(
        JSON.stringify({ error: 'Proxy rate exceeded', code: 'rate_limit_exceeded', retry_after: wait, docs_url: '/docs#limits' }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(wait) } },
      );
    }
  }

  // Load and decrypt any required variables
  const vars: Record<string, string> = {};
  const refs = collectVarRefs(route);
  const upstreamHost = (() => {
    try { return new URL(route.upstream).host; } catch { return ''; }
  })();
  if (refs.size > 0) {
    if (!ownerUserId) return new Response('Proxy variables require an authenticated site', { status: 502 });
    const placeholders = [...refs].map((_, i) => `?${i + 2}`).join(',');
    const rows = await env.DB.prepare(
      `SELECT name, value_encrypted, pin_origin FROM variables WHERE owner_user_id = ?1 AND name IN (${placeholders})`,
    ).bind(ownerUserId, ...refs).all<{ name: string; value_encrypted: string; pin_origin: string | null }>();
    for (const r of rows.results ?? []) {
      // allowedUpstreams gate: if the variable was created with an allow-list,
      // refuse to expand it when the proxy route's upstream host isn't on it.
      // pin_origin stores either a single hostname (legacy) or a JSON array.
      if (r.pin_origin && upstreamHost) {
        const allowed = parseAllowedUpstreams(r.pin_origin);
        if (allowed.length > 0 && !allowed.some((h) => hostMatches(upstreamHost, h))) {
          return new Response(`Variable ${r.name} is not allowed for upstream ${upstreamHost}`, { status: 502 });
        }
      }
      try {
        vars[r.name] = await decryptValue(env.SIGNING_KEY, r.value_encrypted);
      } catch {
        return new Response(`Failed to decrypt variable ${r.name}`, { status: 502 });
      }
    }
    for (const name of refs) {
      if (!(name in vars)) {
        return new Response(`Missing required variable: ${name}`, { status: 502 });
      }
    }
  }

  // Build upstream URL
  const reqUrl = new URL(req.url);
  const tail = route.match.endsWith('/*') ? pathname.slice(route.match.length - 2) : '';
  const upstreamUrl = new URL(route.upstream);
  if (tail) upstreamUrl.pathname = (upstreamUrl.pathname.replace(/\/$/, '') + tail) || '/';
  if (route.passQuery !== false) {
    for (const [k, v] of reqUrl.searchParams) upstreamUrl.searchParams.append(k, v);
  }

  // Build request headers
  const reqHeaders = new Headers();
  for (const [k, v] of req.headers) {
    const lc = k.toLowerCase();
    if (FORBIDDEN_REQ_HEADERS.has(lc)) continue;
    if (route.stripHeaders?.some((h) => h.toLowerCase() === lc)) continue;
    reqHeaders.set(k, v);
  }
  for (const [k, v] of Object.entries(route.headers ?? {})) {
    reqHeaders.set(k, interpolate(v, vars));
  }

  // Forward body where appropriate
  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && route.forwardBody !== false;
  const upstreamReq = new Request(upstreamUrl.toString(), {
    method,
    headers: reqHeaders,
    body: hasBody ? req.body : undefined,
    redirect: 'manual',
  });

  const timeoutMs = Math.min(route.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS, MAX_UPSTREAM_TIMEOUT_MS);
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamReq, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return new Response(
      isTimeout
        ? `Upstream timed out after ${timeoutMs}ms`
        : `Upstream fetch failed: ${e instanceof Error ? e.message : 'unknown'}`,
      { status: isTimeout ? 504 : 502 },
    );
  }

  // 10 MB response cap: reject up front via content-length, and also wrap the
  // body stream so streaming responses get cut off if they exceed the budget.
  const declaredLen = parseInt(upstreamRes.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLen) && declaredLen > PROXY_BODY_CAP_BYTES) {
    return new Response(`Upstream response exceeds ${PROXY_BODY_CAP_BYTES} byte cap`, { status: 502 });
  }
  const cappedBody = upstreamRes.body ? capStream(upstreamRes.body, PROXY_BODY_CAP_BYTES) : null;

  // Strip headers that would confuse the browser when streaming
  const outHeaders = new Headers();
  for (const [k, v] of upstreamRes.headers) {
    if (FORBIDDEN_RES_HEADERS.has(k.toLowerCase())) continue;
    outHeaders.set(k, v);
  }
  outHeaders.set('x-push-live-proxy', 'true');
  return new Response(cappedBody, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: outHeaders,
  });
}

function pickRoute(manifest: ProxyManifest, pathname: string, method: string): ProxyRoute | null {
  const upper = method.toUpperCase();
  for (const r of manifest.routes ?? []) {
    if (!matchesPath(r.match, pathname)) continue;
    if (r.method) {
      const allowed = Array.isArray(r.method) ? r.method : [r.method];
      if (!allowed.map((m) => m.toUpperCase()).includes(upper)) continue;
    }
    return r;
  }
  return null;
}

function matchesPath(pattern: string, pathname: string): boolean {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return pathname === base || pathname.startsWith(base + '/');
  }
  return pathname === pattern;
}

function collectVarRefs(route: ProxyRoute): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(route.headers ?? {})) {
    for (const m of v.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) out.add(m[1]);
  }
  return out;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => vars[name] ?? '');
}

type RateLimit = { count: number; windowSeconds: number; scope: 'ip' | 'all' };
function parseRateLimit(spec: string): RateLimit | null {
  const m = /^\s*(\d+)\s*\/\s*(sec(?:ond)?|min(?:ute)?|hour)\s*(?:\/\s*(ip|all))?\s*$/i.exec(spec);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const windowSeconds = unit.startsWith('sec') ? 1 : unit.startsWith('min') ? 60 : 3600;
  const scope = (m[3]?.toLowerCase() === 'all' ? 'all' : 'ip') as 'ip' | 'all';
  if (!Number.isFinite(count) || count <= 0) return null;
  return { count, windowSeconds, scope };
}

async function checkProxyRate(env: Env, key: string, limit: RateLimit): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - limit.windowSeconds;
  const raw = await env.KV.get(key);
  let stamps: number[] = [];
  if (raw) {
    try { stamps = JSON.parse(raw) as number[]; } catch { stamps = []; }
  }
  stamps = stamps.filter((t) => t > windowStart);
  if (stamps.length >= limit.count) {
    return Math.max(1, (stamps[0] + limit.windowSeconds) - now);
  }
  stamps.push(now);
  await env.KV.put(key, JSON.stringify(stamps), { expirationTtl: limit.windowSeconds + 60 });
  return 0;
}

function parseAllowedUpstreams(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    } catch { /* fall through */ }
  }
  // Legacy single-origin form: store-as-is, treat as one-entry allow-list.
  return [trimmed];
}

function hostMatches(actual: string, allowed: string): boolean {
  if (actual === allowed) return true;
  // Allow "*.example.com" to match any subdomain.
  if (allowed.startsWith('*.')) {
    const base = allowed.slice(2);
    return actual === base || actual.endsWith('.' + base);
  }
  return false;
}

// Cuts off a ReadableStream at a byte budget. Once the budget is exceeded the
// downstream consumer sees a clean end-of-stream rather than a runaway body.
function capStream(input: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let read = 0;
  const reader = input.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) { controller.close(); return; }
      if (read + value.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - read);
        if (remaining > 0) controller.enqueue(value.subarray(0, remaining));
        controller.close();
        reader.cancel().catch(() => {});
        return;
      }
      read += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
}
