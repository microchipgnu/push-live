import type { App, AppContext } from './types.ts';
import type { Env } from '../types.ts';
import { sha256Hex } from '../lib/hash.ts';
import { userPlan } from '../lib/quotas.ts';

// Inline to avoid circular import with registry.ts.
function jsonError(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message, code, message, docs_url: `/docs#apps` }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

// Pinned constants in lieu of feature flags. Sites get analytics for free
// on top of their plan; the per-plan cap lives in src/lib/quotas.ts.
const RATE_LIMIT_PER_IP_PER_MIN = 60;
const HIT_PAYLOAD_MAX_BYTES = 2 * 1024;
const MAX_FIELD_LEN = 512;

export const analyticsApp: App = {
  id: 'analytics',
  async handle(ctx) {
    if (ctx.req.method === 'POST' && ctx.subPath === '/hit') return handleHit(ctx);
    if (ctx.req.method === 'GET'  && ctx.subPath === '/hit') return handleHitGet(ctx);   // <img> beacon fallback
    return jsonError('not_found', `analytics: ${ctx.req.method} ${ctx.subPath} not handled`, 404);
  },
};

// POST /__pl/analytics/hit
// Body (optional JSON): { path, referrer, screen? }. Anything missing
// falls back to the request's own Referer.
async function handleHit(ctx: AppContext): Promise<Response> {
  const { env, slug, req } = ctx;

  if (!await checkOrigin(req)) return noContent();   // silently drop cross-origin posts

  const ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  if (!await passRateLimit(env, slug, ip)) return noContent();

  if (!await passQuota(env, slug, ctx.ownerUserId)) return noContent();

  // Body is optional. Empty body still records a hit.
  let body: HitBody = {};
  const cl = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (cl > 0 && cl < HIT_PAYLOAD_MAX_BYTES) {
    try { body = (await req.json()) as HitBody; } catch { /* keep defaults */ }
  } else if (cl >= HIT_PAYLOAD_MAX_BYTES) {
    return noContent();
  }

  await recordHit(env, slug, req, body);
  return noContent();
}

// GET fallback for <img src="…/hit?path=/x"> style beacons. No CORS issues,
// works even if a page is dynamically inserted into a foreign iframe.
async function handleHitGet(ctx: AppContext): Promise<Response> {
  const { env, slug, req } = ctx;

  if (!await checkOrigin(req)) return transparentPixel();

  const ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  if (!await passRateLimit(env, slug, ip)) return transparentPixel();
  if (!await passQuota(env, slug, ctx.ownerUserId)) return transparentPixel();

  const url = new URL(req.url);
  await recordHit(env, slug, req, {
    path: url.searchParams.get('path') ?? undefined,
    referrer: url.searchParams.get('ref') ?? undefined,
  });
  return transparentPixel();
}

type HitBody = { path?: string; referrer?: string; screen?: string };

async function recordHit(env: Env, slug: string, req: Request, body: HitBody): Promise<void> {
  const ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  const ua = req.headers.get('user-agent') ?? '';
  const country = req.headers.get('cf-ipcountry') ?? null;
  const refererHeader = req.headers.get('referer');
  const day = new Date().toISOString().slice(0, 10);

  // Per-site, per-day rotating visitor identifier. Stable within a day,
  // unlinkable across days. No raw IP/UA stored.
  const visitorHash = (await sha256Hex(`v1:${day}:${slug}:${ip}`)).slice(0, 16);
  const uaHash = ua ? (await sha256Hex(`v1:${ua}`)).slice(0, 12) : null;

  const path = clip(body.path ?? safePathFrom(refererHeader)) ?? null;
  const referrer = clip(body.referrer ?? refererHeader) ?? null;

  await env.DB.prepare(
    `INSERT INTO site_app_events (slug, app, event, ts, path, referrer, country, ua_hash, visitor_hash)
     VALUES (?1, 'analytics', 'hit', ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(slug, Date.now(), path, referrer, country, uaHash, visitorHash).run();
}

// Origin check: must be missing (server-to-server agents) or match the
// request's own host. Stops other sites from posting to your meter.
async function checkOrigin(req: Request): Promise<boolean> {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

// 60 requests/IP/minute per slug — KV-backed sliding window.
async function passRateLimit(env: Env, slug: string, ip: string): Promise<boolean> {
  const key = `rl:app:analytics:${slug}:${ip}`;
  const raw = await env.KV.get(key);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 60;
  let stamps: number[] = [];
  if (raw) { try { stamps = JSON.parse(raw) as number[]; } catch { stamps = []; } }
  stamps = stamps.filter((t) => t > windowStart);
  if (stamps.length >= RATE_LIMIT_PER_IP_PER_MIN) return false;
  stamps.push(now);
  await env.KV.put(key, JSON.stringify(stamps), { expirationTtl: 120 });
  return true;
}

// Monthly quota — looked up by owner plan. Anonymous sites get nothing.
async function passQuota(env: Env, slug: string, ownerUserId: string | null): Promise<boolean> {
  if (!ownerUserId) return false;
  const plan = await userPlan(env, ownerUserId);
  if (plan.appAnalyticsEventsPerMonth <= 0) return false;
  const monthStart = startOfMonthMs();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM site_app_events
     WHERE slug = ?1 AND app = 'analytics' AND ts >= ?2`,
  ).bind(slug, monthStart).first<{ n: number }>();
  return (row?.n ?? 0) < plan.appAnalyticsEventsPerMonth;
}

function startOfMonthMs(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function clip(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.slice(0, MAX_FIELD_LEN);
}

function safePathFrom(refererHeader: string | null): string | undefined {
  if (!refererHeader) return undefined;
  try { return new URL(refererHeader).pathname; } catch { return undefined; }
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

// 1×1 transparent GIF for the beacon path so a hit logged via <img> doesn't
// trigger a broken-image icon. Avoids the cost of PNG/SVG encoding.
const TRANSPARENT_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

function transparentPixel(): Response {
  return new Response(TRANSPARENT_GIF, { status: 200, headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' } });
}

// Owner-side read helper: shared with the /api/v1/publish/:slug/analytics
// route in sites.ts so the dashboard and CLI both go through one query.
export type AnalyticsSummary = {
  slug: string;
  period: string;
  windowMs: number;
  events: number;
  uniqueVisitors: number;
  byDay: Array<{ day: string; events: number; uniqueVisitors: number }>;
  topPaths: Array<{ path: string | null; events: number }>;
  topReferrers: Array<{ referrer: string | null; events: number }>;
  topCountries: Array<{ country: string | null; events: number }>;
};

export async function loadAnalyticsSummary(env: Env, slug: string, periodDays: number): Promise<AnalyticsSummary> {
  const windowMs = periodDays * 86_400_000;
  const since = Date.now() - windowMs;

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS events, COUNT(DISTINCT visitor_hash) AS uniques
     FROM site_app_events WHERE slug = ?1 AND app = 'analytics' AND ts >= ?2`,
  ).bind(slug, since).first<{ events: number; uniques: number }>();

  const dayRows = await env.DB.prepare(
    `SELECT
       strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
       COUNT(*) AS events,
       COUNT(DISTINCT visitor_hash) AS uniques
     FROM site_app_events
     WHERE slug = ?1 AND app = 'analytics' AND ts >= ?2
     GROUP BY day ORDER BY day`,
  ).bind(slug, since).all<{ day: string; events: number; uniques: number }>();

  const pathRows = await env.DB.prepare(
    `SELECT path, COUNT(*) AS events FROM site_app_events
     WHERE slug = ?1 AND app = 'analytics' AND ts >= ?2
     GROUP BY path ORDER BY events DESC LIMIT 10`,
  ).bind(slug, since).all<{ path: string | null; events: number }>();

  const refRows = await env.DB.prepare(
    `SELECT referrer, COUNT(*) AS events FROM site_app_events
     WHERE slug = ?1 AND app = 'analytics' AND ts >= ?2 AND referrer IS NOT NULL
     GROUP BY referrer ORDER BY events DESC LIMIT 10`,
  ).bind(slug, since).all<{ referrer: string | null; events: number }>();

  const countryRows = await env.DB.prepare(
    `SELECT country, COUNT(*) AS events FROM site_app_events
     WHERE slug = ?1 AND app = 'analytics' AND ts >= ?2 AND country IS NOT NULL
     GROUP BY country ORDER BY events DESC LIMIT 10`,
  ).bind(slug, since).all<{ country: string | null; events: number }>();

  return {
    slug,
    period: `${periodDays}d`,
    windowMs,
    events: totals?.events ?? 0,
    uniqueVisitors: totals?.uniques ?? 0,
    byDay: (dayRows.results ?? []).map((r) => ({ day: r.day, events: r.events, uniqueVisitors: r.uniques })),
    topPaths: pathRows.results ?? [],
    topReferrers: refRows.results ?? [],
    topCountries: countryRows.results ?? [],
  };
}
