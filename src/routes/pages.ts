import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types.ts';
import { errBody } from '../lib/auth.ts';
import { newId, newToken } from '../lib/ids.ts';
import { sha256Hex } from '../lib/hash.ts';
import { sendCodeEmail } from '../lib/email.ts';
import { readSession, issueSessionCookie, clearSessionCookie } from '../lib/session.ts';
import { shell, escapeHtml } from '../ui/layout.ts';
import { PLANS } from '../lib/quotas.ts';
import { encryptValue } from '../lib/crypto.ts';
import { parseDisabledApps } from '../apps/types.ts';

export const pagesRouter = new Hono<{ Bindings: Env }>();

// CSRF: any non-GET form post to a page route must come from the same origin.
// Pairs with our SameSite=Lax session cookie — even Lax permits top-level
// navigations, so an external form POST could still be issued; this check
// stops it. Scoped to the page routes only so JSON API callers (no browser
// cookie) aren't affected.
const csrf: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const origin = c.req.header('origin');
  const referer = c.req.header('referer');
  const host = c.req.header('host');
  if (!host) return c.text('missing host', 400);
  const expected = `://${host}`;
  const sourceUrl = origin ?? referer ?? '';
  if (!sourceUrl.includes(expected)) return c.text('csrf check failed', 403);
  return next();
};

pagesRouter.use('/signin', csrf);
pagesRouter.use('/claim', csrf);
pagesRouter.use('/dashboard/*', csrf);
pagesRouter.use('/signout', csrf);

// ---------------- Marketing: pricing + docs ----------------
pagesRouter.get('/pricing', (c) => {
  const rows = (['anonymous', 'free', 'hobby', 'developer'] as const).map((name) => {
    const p = PLANS[name];
    const fmt = (n: number) => (n === Number.POSITIVE_INFINITY ? '∞' : prettyBytes(n));
    const limit = (n: number) => (n === Number.POSITIVE_INFINITY ? '∞' : String(n));
    return `<tr>
      <td><strong>${escapeHtml(p.name)}</strong></td>
      <td><code>${costFor(p.name)}</code></td>
      <td>${fmt(p.maxStorageBytes)}</td>
      <td>${limit(p.maxSites)}</td>
      <td>${limit(p.maxDrives)}</td>
      <td>${limit(p.maxCustomDomains)}</td>
      <td>${fmt(p.maxFileSiteBytes)}</td>
      <td>${p.driveHistoryDays}d</td>
      <td>${p.publishesPerHour}/h</td>
    </tr>`;
  }).join('');
  const body = `
<span class="eyebrow">Plans</span>
<h1>Pricing.</h1>
<p class="lede">The free tier is permanent. Pay only once you outgrow it — for more sites, more storage, more custom domains.</p>
<div class="card" style="overflow-x:auto">
<table>
<thead><tr><th>Plan</th><th>Cost</th><th>Storage</th><th>Sites</th><th>Drives</th><th>Domains</th><th>Max file</th><th>History</th><th>Publishes</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
<p class="muted">Machine-readable: <a href="/pricing.md">/pricing.md</a> · <a href="/openapi.json">/openapi.json</a></p>`;
  return c.html(shell('Pricing · push-live', body));
});

// /docs is now generated from OpenAPI in src/routes/discovery.ts so it can't drift.

function costFor(plan: string): string {
  return plan === 'anonymous' ? '$0' : plan === 'free' ? '$0/mo' : plan === 'hobby' ? '$4/mo' : plan === 'developer' ? '$20/mo' : '$?';
}
function prettyBytes(n: number): string {
  if (n === 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

// ---------------- Sign in ----------------
pagesRouter.get('/signin', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (userId) return c.redirect('/dashboard');
  const step = c.req.query('step') === 'code' ? 'code' : 'email';
  const email = c.req.query('email') ?? '';
  const err = c.req.query('err');
  return c.html(shell('Sign in · push-live', renderSignin(step, email, err)));
});

pagesRouter.post('/signin', async (c) => {
  const form = await c.req.formData();
  const action = String(form.get('action') ?? '');
  const email = String(form.get('email') ?? '').toLowerCase().trim();

  if (action === 'request' || !action) {
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
      return c.redirect(`/signin?err=${encodeURIComponent('Enter a valid email')}`);
    }
    const code = generateCode();
    const codeHash = await sha256Hex(code);
    await c.env.KV.put(
      `auth:code:${email}`,
      JSON.stringify({ hash: codeHash, attempts: 0, createdAt: Date.now() }),
      { expirationTtl: 600 },
    );
    c.executionCtx.waitUntil(sendCodeEmail(c.env, email, code));
    return c.redirect(`/signin?step=code&email=${encodeURIComponent(email)}`);
  }

  if (action === 'verify') {
    const code = String(form.get('code') ?? '').replace(/\s+/g, '').toUpperCase();
    const raw = await c.env.KV.get(`auth:code:${email}`);
    if (!raw) return c.redirect(`/signin?step=code&email=${encodeURIComponent(email)}&err=expired`);
    const rec = JSON.parse(raw) as { hash: string; attempts: number };
    if (rec.attempts >= 5 || (await sha256Hex(code)) !== rec.hash) {
      await c.env.KV.put(`auth:code:${email}`, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }), { expirationTtl: 600 });
      return c.redirect(`/signin?step=code&email=${encodeURIComponent(email)}&err=invalid`);
    }
    await c.env.KV.delete(`auth:code:${email}`);

    let user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: string }>();
    if (!user) {
      const id = newId('usr');
      await c.env.DB.prepare('INSERT INTO users (id, email, plan, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(id, email, 'free', Date.now())
        .run();
      user = { id };
    }

    const cookie = await issueSessionCookie(c.env, user.id);
    const next = String(form.get('next') ?? '/dashboard');
    return new Response(null, { status: 302, headers: { location: next, 'set-cookie': cookie } });
  }

  return c.redirect('/signin');
});

pagesRouter.post('/signout', (c) =>
  new Response(null, { status: 302, headers: { location: '/', 'set-cookie': clearSessionCookie() } }),
);

// ---------------- Dashboard ----------------
pagesRouter.get('/dashboard', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const user = await c.env.DB.prepare('SELECT id, email, plan, wallet FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ id: string; email: string; plan: string; wallet: string | null }>();
  if (!user) return new Response(null, { status: 302, headers: { location: '/signin', 'set-cookie': clearSessionCookie() } });

  const sites = await c.env.DB.prepare(
    `SELECT slug, status, expires_at, spa_mode, forkable, viewer_title, updated_at, apps_disabled
     FROM sites WHERE owner_user_id = ?1 AND status != 'deleted'
     ORDER BY updated_at DESC LIMIT 200`,
  ).bind(userId).all();
  // Pull 7-day analytics counts in one shot — cheaper than N per-site queries.
  // Split by client_kind so the dashboard can show agent vs browser visits.
  const since7d = Date.now() - 7 * 86_400_000;
  const eventsRows = await c.env.DB.prepare(
    `SELECT e.slug,
            COALESCE(e.client_kind, 'browser') AS kind,
            COUNT(*) AS events,
            COUNT(DISTINCT e.visitor_hash) AS uniques
     FROM site_app_events e
     INNER JOIN sites s ON s.slug = e.slug
     WHERE s.owner_user_id = ?1 AND e.app = 'analytics' AND e.ts >= ?2
     GROUP BY e.slug, kind`,
  ).bind(userId, since7d).all<{ slug: string; kind: string; events: number; uniques: number }>();
  const eventsBySlug = new Map<string, { events: number; uniques: number; byKind: { browser: number; agent: number; bot: number; unknown: number } }>();
  for (const r of eventsRows.results ?? []) {
    let bucket = eventsBySlug.get(r.slug);
    if (!bucket) {
      bucket = { events: 0, uniques: 0, byKind: { browser: 0, agent: 0, bot: 0, unknown: 0 } };
      eventsBySlug.set(r.slug, bucket);
    }
    bucket.events += r.events;
    bucket.uniques = Math.max(bucket.uniques, r.uniques);    // approximate; close enough at this granularity
    if (r.kind === 'browser' || r.kind === 'agent' || r.kind === 'bot' || r.kind === 'unknown') {
      bucket.byKind[r.kind] += r.events;
    }
  }
  const handle = await c.env.DB.prepare('SELECT handle FROM handles WHERE owner_user_id = ?1').bind(userId).first<{ handle: string }>();
  const keys = await c.env.DB.prepare(
    'SELECT prefix, label, created_at, last_used FROM api_keys WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20',
  ).bind(userId).all();
  const drives = await c.env.DB.prepare(
    'SELECT id, name, is_default, created_at FROM drives WHERE owner_user_id = ?1 AND deleted_at IS NULL ORDER BY created_at',
  ).bind(userId).all();
  const variables = await c.env.DB.prepare(
    'SELECT name, pin_origin, updated_at FROM variables WHERE owner_user_id = ?1 ORDER BY name',
  ).bind(userId).all();
  const domains = await c.env.DB.prepare(
    'SELECT domain, status, ssl_status, created_at FROM domains WHERE owner_user_id = ?1 ORDER BY created_at DESC',
  ).bind(userId).all();

  return c.html(shell(`Dashboard · push-live`, renderDashboard({
    user,
    handle: handle?.handle ?? null,
    sites: (sites.results ?? []) as Site[],
    siteAnalytics: eventsBySlug,
    keys: (keys.results ?? []) as ApiKeyRow[],
    drives: (drives.results ?? []) as DriveRow[],
    variables: (variables.results ?? []) as VarRow[],
    domains: (domains.results ?? []) as DomainRow[],
    apex: c.env.PUBLIC_APEX_HOST,
  }), { user: user.email }));
});

pagesRouter.post('/dashboard/keys', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const form = await c.req.formData();
  const label = String(form.get('label') ?? '').slice(0, 120) || 'dashboard';
  const token = `slp_${newToken(28)}`;
  const tokenHash = await sha256Hex(token);
  const keyId = newId('key');
  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, token_hash, prefix, label, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(keyId, userId, tokenHash, token.slice(0, 12), label, Date.now())
    .run();
  return c.html(shell('New API key · push-live', `
    <span class="eyebrow">API key</span>
    <h1>One-time reveal.</h1>
    <p class="lede">Save this now — we don't keep a copy. It won't be shown again.</p>
    <div class="card" style="padding:1rem 1.25rem">
      <pre><code>${escapeHtml(token)}</code></pre>
    </div>
    <p><a class="btn btn--ghost" href="/dashboard">← Back to dashboard</a></p>
  `, { user: 'signed in' }));
});

pagesRouter.post('/dashboard/drives', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const form = await c.req.formData();
  const name = String(form.get('name') ?? '').slice(0, 120) || 'My Drive';
  const isDefault = form.get('isDefault') === 'on';
  const id = newId('drv');
  if (isDefault) {
    await c.env.DB.prepare(`UPDATE drives SET is_default = 0 WHERE owner_user_id = ?1`).bind(userId).run();
  }
  await c.env.DB.prepare(
    `INSERT INTO drives (id, owner_user_id, name, is_default, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  ).bind(id, userId, name, isDefault ? 1 : 0, Date.now()).run();
  return c.redirect('/dashboard');
});

pagesRouter.post('/dashboard/variables', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const form = await c.req.formData();
  const name = String(form.get('name') ?? '').toUpperCase();
  const value = String(form.get('value') ?? '');
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || !value) return c.redirect('/dashboard');
  const enc = await encryptValue(c.env.SIGNING_KEY, value);
  await c.env.DB.prepare(
    `INSERT INTO variables (owner_user_id, name, value_encrypted, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(owner_user_id, name) DO UPDATE SET value_encrypted = ?3, updated_at = ?4`,
  ).bind(userId, name, enc, Date.now()).run();
  return c.redirect('/dashboard');
});

pagesRouter.post('/dashboard/variables/:name/delete', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const name = c.req.param('name');
  await c.env.DB.prepare(`DELETE FROM variables WHERE owner_user_id = ?1 AND name = ?2`).bind(userId, name).run();
  return c.redirect('/dashboard');
});

pagesRouter.post('/dashboard/wallet', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const form = await c.req.formData();
  const raw = String(form.get('address') ?? '').trim();
  const address = raw === '' ? null : raw;
  if (address !== null && !/^0x[0-9a-fA-F]{40}$/.test(address)) return c.redirect('/dashboard');
  await c.env.DB.prepare(`UPDATE users SET wallet = ?1 WHERE id = ?2`).bind(address, userId).run();
  return c.redirect('/dashboard');
});

pagesRouter.post('/dashboard/domains', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const form = await c.req.formData();
  const domain = String(form.get('domain') ?? '').toLowerCase().trim();
  if (!/^([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i.test(domain)) return c.redirect('/dashboard');
  // Best-effort: create the row; CF provisioning is opt-in via the JSON API.
  await c.env.DB.prepare(
    `INSERT INTO domains (domain, owner_user_id, status, created_at) VALUES (?1, ?2, 'pending', ?3)
     ON CONFLICT(domain) DO NOTHING`,
  ).bind(domain, userId, Date.now()).run();
  return c.redirect('/dashboard');
});

pagesRouter.post('/dashboard/domains/:domain/delete', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const domain = c.req.param('domain');
  await c.env.DB.prepare(`DELETE FROM domains WHERE domain = ?1 AND owner_user_id = ?2`).bind(domain, userId).run();
  return c.redirect('/dashboard');
});

pagesRouter.post('/dashboard/sites/:slug/apps/:app/:action', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const slug = c.req.param('slug');
  const app = c.req.param('app');
  const action = c.req.param('action');
  if (action !== 'enable' && action !== 'disable') return c.redirect('/dashboard');
  // Load current disabled set, mutate, write back. Cheap — owners flip this rarely.
  const row = await c.env.DB.prepare(
    `SELECT apps_disabled FROM sites WHERE slug = ?1 AND owner_user_id = ?2 AND status != 'deleted'`,
  ).bind(slug, userId).first<{ apps_disabled: string | null }>();
  if (!row) return c.redirect('/dashboard');
  const set = new Set(parseDisabledApps(row.apps_disabled));
  if (action === 'disable') set.add(app); else set.delete(app);
  const next = set.size === 0 ? null : JSON.stringify([...set]);
  await c.env.DB.prepare(
    `UPDATE sites SET apps_disabled = ?1, updated_at = ?2 WHERE slug = ?3 AND owner_user_id = ?4`,
  ).bind(next, Date.now(), slug, userId).run();
  // KV cache holds the version id only — the apps_disabled lookup re-hits D1,
  // so no invalidation needed.
  return c.redirect('/dashboard');
});

pagesRouter.post('/dashboard/sites/:slug/delete', async (c) => {
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) return c.redirect('/signin');
  const slug = c.req.param('slug');
  await c.env.DB.prepare(`UPDATE sites SET status = 'deleted' WHERE slug = ?1 AND owner_user_id = ?2`)
    .bind(slug, userId)
    .run();
  await c.env.KV.delete(`site:${slug}:version`);
  return c.redirect('/dashboard');
});

// ---------------- Claim ----------------
pagesRouter.get('/claim', async (c) => {
  const slug = c.req.query('slug');
  const token = c.req.query('token');
  if (!slug || !token) {
    return c.html(shell('Claim site · push-live', `<h1>Missing slug or token</h1>
<p>Use the <code>claimUrl</code> returned when the site was first published.</p>`), 400);
  }
  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  const site = await c.env.DB.prepare(
    `SELECT slug, owner_user_id, expires_at FROM sites WHERE slug = ?1 AND status != 'deleted'`,
  ).bind(slug).first<{ slug: string; owner_user_id: string | null; expires_at: number | null }>();
  if (!site) return c.html(shell('Claim site', `<h1>Site not found</h1>`), 404);
  if (site.owner_user_id) {
    return c.html(shell('Claim site', `<h1>Already claimed</h1><p>This site is no longer anonymous.</p>`));
  }
  const expiresIn = site.expires_at ? Math.max(0, site.expires_at - Date.now()) : null;
  return c.html(shell('Claim site · push-live', renderClaim({ slug, token, expiresIn, signedIn: !!userId, apex: c.env.PUBLIC_APEX_HOST }), { user: userId ?? null }));
});

pagesRouter.post('/claim', async (c) => {
  const form = await c.req.formData();
  const slug = String(form.get('slug') ?? '');
  const token = String(form.get('token') ?? '');
  if (!slug || !token) return c.redirect('/claim');

  const userId = await readSession(c.env, c.req.header('cookie') ?? null);
  if (!userId) {
    return c.redirect(`/signin?next=${encodeURIComponent(`/claim?slug=${slug}&token=${token}`)}`);
  }

  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.owner_user_id, t.token_hash, t.expires_at
     FROM sites s LEFT JOIN claim_tokens t ON t.slug = s.slug
     WHERE s.slug = ?1 AND s.status != 'deleted'`,
  ).bind(slug).first<{ owner_user_id: string | null; token_hash: string | null; expires_at: number | null }>();

  if (!row) return c.html(shell('Claim', `<h1>Site not found</h1>`), 404);
  if (row.owner_user_id) return c.redirect('/dashboard');
  if (!row.token_hash || row.expires_at == null || row.expires_at < now) {
    return c.html(shell('Claim', `<h1>Site expired</h1>`), 410);
  }
  if ((await sha256Hex(token)) !== row.token_hash) {
    return c.html(shell('Claim', `<h1>Invalid token</h1>`), 401);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE sites SET owner_user_id = ?1, anonymous = 0, expires_at = NULL, updated_at = ?2 WHERE slug = ?3`,
    ).bind(userId, now, slug),
    c.env.DB.prepare(`DELETE FROM claim_tokens WHERE slug = ?1`).bind(slug),
  ]);
  return c.redirect('/dashboard');
});

// ---------------- Renderers ----------------
type Site = { slug: string; status: string; expires_at: number | null; spa_mode: number; forkable: number; viewer_title: string | null; updated_at: number; apps_disabled: string | null };
type ApiKeyRow = { prefix: string; label: string | null; created_at: number; last_used: number | null };
type DriveRow  = { id: string; name: string; is_default: number; created_at: number };
type VarRow    = { name: string; pin_origin: string | null; updated_at: number };
type DomainRow = { domain: string; status: string; ssl_status: string | null; created_at: number };

function renderSignin(step: 'email' | 'code', email: string, err?: string): string {
  if (step === 'email') {
    return `
<div style="max-width:24rem">
<span class="eyebrow">Sign in</span>
<h1>Welcome back.</h1>
<p class="lede">Enter your email and we'll send a one-time code. No password, no provider.</p>
${err ? `<div class="alert error">${escapeHtml(err)}</div>` : ''}
<form method="post" class="card stack-sm">
  <input type="hidden" name="action" value="request">
  <label class="label" for="signin-email">Email</label>
  <input id="signin-email" type="email" name="email" autofocus required value="${escapeHtml(email)}" placeholder="you@example.com">
  <button type="submit" class="btn btn--block" style="margin-top:.8rem">Send code</button>
</form>
</div>`;
  }
  return `
<div style="max-width:24rem">
<span class="eyebrow">One more step</span>
<h1>Check your inbox.</h1>
<p class="lede">We emailed a code to <strong>${escapeHtml(email)}</strong>. It expires in ten minutes.</p>
${err === 'invalid' ? `<div class="alert error">That code didn't match. Try again.</div>` : ''}
${err === 'expired' ? `<div class="alert error">Code expired. Request a new one.</div>` : ''}
<form method="post" class="card stack-sm">
  <input type="hidden" name="action" value="verify">
  <input type="hidden" name="email" value="${escapeHtml(email)}">
  <label class="label" for="signin-code">Code</label>
  <input id="signin-code" type="text" name="code" autofocus required autocomplete="one-time-code" style="font-family:var(--mono);letter-spacing:.15em;text-align:center;font-size:16px" placeholder="XXXX-XXXX">
  <button type="submit" class="btn btn--block" style="margin-top:.8rem">Verify</button>
</form>
<p style="margin-top:1rem;font-size:13px"><a href="/signin">← Use a different email</a></p>
</div>`;
}

type SiteAnalytics = { events: number; uniques: number; byKind: { browser: number; agent: number; bot: number; unknown: number } };

function renderDashboard(data: {
  user: { email: string; plan: string; wallet: string | null };
  handle: string | null;
  sites: Site[];
  siteAnalytics: Map<string, SiteAnalytics>;
  keys: ApiKeyRow[];
  drives: DriveRow[];
  variables: VarRow[];
  domains: DomainRow[];
  apex: string;
}): string {
  const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const sitesRows = data.sites.length === 0
    ? `<tr><td colspan="4" class="muted">No sites yet. Publish one with <code>POST /api/v1/publish</code>.</td></tr>`
    : data.sites.map((s) => `
        <tr>
          <td>
            <a href="https://${escapeHtml(s.slug)}.${escapeHtml(data.apex)}/" target="_blank" rel="noopener">${escapeHtml(s.slug)}</a>
            ${s.spa_mode ? `<span class="tag tag--violet" style="margin-left:.4rem">spa</span>` : ''}
            ${s.forkable ? `<span class="tag tag--green" style="margin-left:.3rem">fork</span>` : ''}
          </td>
          <td>${escapeHtml(s.viewer_title ?? '')}</td>
          <td class="muted">${dateOnly(s.updated_at)}</td>
          <td class="right">
            <form method="post" action="/dashboard/sites/${encodeURIComponent(s.slug)}/delete" style="display:inline" onsubmit="return confirm('Delete ${escapeHtml(s.slug)}?')">
              <button class="btn btn--danger btn--sm" type="submit">Delete</button>
            </form>
          </td>
        </tr>`).join('');
  const keysRows = data.keys.length === 0
    ? `<tr><td colspan="3" class="muted">No API keys yet.</td></tr>`
    : data.keys.map((k) => `
        <tr><td><code>${escapeHtml(k.prefix)}…</code></td><td>${escapeHtml(k.label ?? '')}</td><td class="muted">${dateOnly(k.created_at)}</td></tr>`).join('');
  const drivesRows = data.drives.length === 0
    ? `<tr><td colspan="3" class="muted">No drives. Create one with <code>POST /api/v1/drives</code>.</td></tr>`
    : data.drives.map((d) => `
        <tr><td><code>${escapeHtml(d.id)}</code></td><td>${escapeHtml(d.name)}${d.is_default ? ` <span class="tag tag--blue" style="margin-left:.3rem">default</span>` : ''}</td><td class="muted">${dateOnly(d.created_at)}</td></tr>`).join('');
  const varsRows = data.variables.length === 0
    ? `<tr><td colspan="3" class="muted">No variables.</td></tr>`
    : data.variables.map((v) => `
        <tr><td><code>${escapeHtml(v.name)}</code></td><td class="muted">${escapeHtml(v.pin_origin ?? '')}</td><td class="muted">${dateOnly(v.updated_at)}</td></tr>`).join('');
  const domainStatusTag = (status: string) => {
    if (status === 'active' || status === 'verified') return `<span class="tag tag--green">${escapeHtml(status)}</span>`;
    if (status === 'pending') return `<span class="tag tag--yellow">${escapeHtml(status)}</span>`;
    return `<span class="tag">${escapeHtml(status)}</span>`;
  };
  const domainsRows = data.domains.length === 0
    ? `<tr><td colspan="4" class="muted">No custom domains.</td></tr>`
    : data.domains.map((d) => `
        <tr><td><code>${escapeHtml(d.domain)}</code></td><td>${domainStatusTag(d.status)}</td><td class="muted">${escapeHtml(d.ssl_status ?? '')}</td><td class="muted">${dateOnly(d.created_at)}</td></tr>`).join('');

  const walletShort = data.user.wallet
    ? `${escapeHtml(data.user.wallet.slice(0, 6))}…${escapeHtml(data.user.wallet.slice(-4))}`
    : null;

  return `
<span class="eyebrow">Dashboard</span>
<h1>${escapeHtml(data.user.email)}</h1>
<div class="cluster" style="margin:0 0 2rem;color:var(--muted);font-size:13px">
  <span class="tag tag--blue">${escapeHtml(data.user.plan)}</span>
  ${data.handle ? `<span>handle <code>${escapeHtml(data.handle)}</code></span>` : ''}
  ${walletShort ? `<span>wallet <code>${walletShort}</code></span>` : ''}
</div>

<div class="card">
<h2>Sites</h2>
<table><thead><tr><th>Slug</th><th>Title</th><th>Updated</th><th class="right"></th></tr></thead><tbody>${sitesRows}</tbody></table>
</div>

${renderAppsCard(data)}

<div class="card">
<h2>Drives</h2>
<table><thead><tr><th>ID</th><th>Name</th><th>Created</th></tr></thead><tbody>${drivesRows}</tbody></table>
<form method="post" action="/dashboard/drives" class="row" style="margin-top:1.2rem">
  <input type="text" name="name" placeholder="Drive name" style="flex:1;max-width:18rem">
  <label class="cluster muted" style="font-size:12.5px"><input type="checkbox" name="isDefault"> default</label>
  <button type="submit">Create</button>
</form>
</div>

<div class="card">
<h2>Domains</h2>
<table><thead><tr><th>Domain</th><th>Status</th><th>SSL</th><th>Added</th></tr></thead><tbody>${domainsRows}</tbody></table>
<form method="post" action="/dashboard/domains" class="row" style="margin-top:1.2rem">
  <input type="text" name="domain" placeholder="example.com" style="flex:1;max-width:18rem">
  <button type="submit">Add</button>
</form>
<p class="muted" style="margin-top:.6rem">For SSL + edge routing, hit <code>POST /api/v1/domains</code> with <code>CF_SAAS_API_TOKEN</code> set.</p>
</div>

<div class="card">
<h2>Variables</h2>
<p class="muted">Encrypted at rest. Referenced as <code>\${NAME}</code> in <code>.push-live/proxy.json</code>.</p>
<table><thead><tr><th>Name</th><th>Pinned origin</th><th>Updated</th></tr></thead><tbody>${varsRows}</tbody></table>
<form method="post" action="/dashboard/variables" class="row" style="margin-top:1.2rem">
  <input type="text" name="name" placeholder="UPSTREAM_KEY" style="flex:1;max-width:18rem" pattern="[A-Z][A-Z0-9_]*">
  <input type="text" name="value" placeholder="value" style="flex:1;max-width:18rem">
  <button type="submit">Set</button>
</form>
</div>

<div class="card">
<h2>Wallet</h2>
<p class="muted">${data.user.wallet ? `Connected at <code>${escapeHtml(data.user.wallet)}</code>` : `Not connected — required to gate sites with a stablecoin paywall.`}</p>
<form method="post" action="/dashboard/wallet" class="row" style="margin-top:.4rem">
  <input type="text" name="address" placeholder="0x…" value="${escapeHtml(data.user.wallet ?? '')}" style="flex:1;max-width:24rem;font-family:var(--mono);font-size:13px">
  <button type="submit">Save</button>
</form>
</div>

<div class="card">
<h2>API keys</h2>
<table><thead><tr><th>Prefix</th><th>Label</th><th>Created</th></tr></thead><tbody>${keysRows}</tbody></table>
<form method="post" action="/dashboard/keys" class="row" style="margin-top:1.2rem">
  <input type="text" name="label" placeholder="Label (e.g. laptop, ci)" style="flex:1;max-width:18rem">
  <button type="submit">Mint key</button>
</form>
</div>`;
}

function renderAppsCard(data: {
  sites: Site[];
  siteAnalytics: Map<string, SiteAnalytics>;
  apex: string;
}): string {
  if (data.sites.length === 0) return '';

  const rows = data.sites.map((s) => {
    const analytics = data.siteAnalytics.get(s.slug)
      ?? { events: 0, uniques: 0, byKind: { browser: 0, agent: 0, bot: 0, unknown: 0 } };
    const disabled = parseDisabledApps(s.apps_disabled).includes('analytics');
    const toggleAction = disabled ? 'enable' : 'disable';
    const toggleLabel = disabled ? 'Enable' : 'Disable';
    const { browser, agent, bot } = analytics.byKind;
    const breakdown = analytics.events === 0
      ? `<span class="muted">no events yet</span>`
      : `<span class="cluster" style="gap:.5rem;flex-wrap:wrap">
          <strong>${analytics.events.toLocaleString()}</strong>
          <span class="muted">7 d ·</span>
          <span class="tag tag--blue">browser ${browser.toLocaleString()}</span>
          <span class="tag tag--violet">agent ${agent.toLocaleString()}</span>
          ${bot > 0 ? `<span class="tag tag--yellow">bot ${bot.toLocaleString()}</span>` : ''}
        </span>`;
    return `
      <tr>
        <td><a href="https://${escapeHtml(s.slug)}.${escapeHtml(data.apex)}/" target="_blank" rel="noopener">${escapeHtml(s.slug)}</a></td>
        <td>${disabled ? `<span class="tag">disabled</span>` : breakdown}</td>
        <td class="right">
          <form method="post" action="/dashboard/sites/${encodeURIComponent(s.slug)}/apps/analytics/${toggleAction}" style="display:inline">
            <button class="btn ${disabled ? '' : 'btn--ghost'} btn--sm" type="submit">${toggleLabel}</button>
          </form>
        </td>
      </tr>`;
  }).join('');

  return `
<div class="card">
<h2>Apps</h2>
<p class="muted" style="margin:0 0 1rem">Analytics auto-injects a tiny beacon into served HTML and counts agents server-side (so HTTP-only callers don't slip past). Disable per site to opt out — endpoint stops accepting hits, beacon is no longer injected.</p>
<table><thead><tr><th>Slug</th><th>Analytics (7 d)</th><th class="right"></th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
}

function renderClaim(data: { slug: string; token: string; expiresIn: number | null; signedIn: boolean; apex: string }): string {
  const minutes = data.expiresIn != null ? Math.round(data.expiresIn / 60000) : null;
  return `
<div style="max-width:32rem">
<span class="eyebrow">Claim</span>
<h1>Make it permanent.</h1>
<p class="lede">Claiming <a href="https://${escapeHtml(data.slug)}.${escapeHtml(data.apex)}/" target="_blank"><code>${escapeHtml(data.slug)}</code></a> removes its 24-hour expiry and moves it to your account.</p>
${minutes != null ? `<p class="muted">Expires in about ${minutes} minute${minutes === 1 ? '' : 's'} if unclaimed.</p>` : ''}
<form method="post" class="card">
  <input type="hidden" name="slug" value="${escapeHtml(data.slug)}">
  <input type="hidden" name="token" value="${escapeHtml(data.token)}">
  <button type="submit" class="btn btn--block">${data.signedIn ? 'Claim now' : 'Sign in &amp; claim'}</button>
</form>
</div>`;
}

function generateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 8; i++) {
    s += alphabet[bytes[i] % alphabet.length];
    if (i === 3) s += '-';
  }
  return s;
}
