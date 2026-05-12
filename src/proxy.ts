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
};

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_UPSTREAM_TIMEOUT_MS = 120_000;

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

  // Load and decrypt any required variables
  const vars: Record<string, string> = {};
  const refs = collectVarRefs(route);
  if (refs.size > 0) {
    if (!ownerUserId) return new Response('Proxy variables require an authenticated site', { status: 502 });
    const placeholders = [...refs].map((_, i) => `?${i + 2}`).join(',');
    const rows = await env.DB.prepare(
      `SELECT name, value_encrypted FROM variables WHERE owner_user_id = ?1 AND name IN (${placeholders})`,
    ).bind(ownerUserId, ...refs).all<{ name: string; value_encrypted: string }>();
    for (const r of rows.results ?? []) {
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

  // Strip headers that would confuse the browser when streaming
  const outHeaders = new Headers();
  for (const [k, v] of upstreamRes.headers) {
    if (FORBIDDEN_RES_HEADERS.has(k.toLowerCase())) continue;
    outHeaders.set(k, v);
  }
  outHeaders.set('x-push-live-proxy', 'true');
  return new Response(upstreamRes.body, {
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
