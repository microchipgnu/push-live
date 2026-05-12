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
      <td>${costFor(p.name)}</td>
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
<h1>Pricing</h1>
<p>Self-hosted on Cloudflare. These tiers are baked into <code class="code">src/lib/quotas.ts</code> — edit to fit your offering.</p>
<div class="card">
<table>
<thead><tr><th>Plan</th><th>Cost</th><th>Storage</th><th>Sites</th><th>Drives</th><th>Domains</th><th>Max file</th><th>History</th><th>Publishes</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
<p class="muted">Machine-readable: <a href="/pricing.md">/pricing.md</a> · <a href="/openapi.json">/openapi.json</a></p>`;
  return c.html(shell('Pricing · sloop', body));
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
  return c.html(shell('Sign in · sloop', renderSignin(step, email, err)));
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
    `SELECT slug, status, expires_at, spa_mode, forkable, viewer_title, updated_at
     FROM sites WHERE owner_user_id = ?1 AND status != 'deleted'
     ORDER BY updated_at DESC LIMIT 200`,
  ).bind(userId).all();
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

  return c.html(shell(`Dashboard · sloop`, renderDashboard({
    user,
    handle: handle?.handle ?? null,
    sites: (sites.results ?? []) as Site[],
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
  return c.html(shell('New API key · sloop', `
    <h1>New API key</h1>
    <p>Save this now — it won't be shown again.</p>
    <pre class="code" style="background:#0b0b0c;color:#fafafa;padding:1rem;border-radius:6px;overflow-x:auto">${escapeHtml(token)}</pre>
    <p><a class="btn" href="/dashboard">Back to dashboard</a></p>
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
    return c.html(shell('Claim site · sloop', `<h1>Missing slug or token</h1>
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
  return c.html(shell('Claim site · sloop', renderClaim({ slug, token, expiresIn, signedIn: !!userId, apex: c.env.PUBLIC_APEX_HOST }), { user: userId ?? null }));
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
type Site = { slug: string; status: string; expires_at: number | null; spa_mode: number; forkable: number; viewer_title: string | null; updated_at: number };
type ApiKeyRow = { prefix: string; label: string | null; created_at: number; last_used: number | null };
type DriveRow  = { id: string; name: string; is_default: number; created_at: number };
type VarRow    = { name: string; pin_origin: string | null; updated_at: number };
type DomainRow = { domain: string; status: string; ssl_status: string | null; created_at: number };

function renderSignin(step: 'email' | 'code', email: string, err?: string): string {
  if (step === 'email') {
    return `
<h1>Sign in</h1>
<p>Enter your email and we'll send you a one-time code.</p>
${err ? `<div class="alert error">${escapeHtml(err)}</div>` : ''}
<form method="post" class="card" style="max-width:24rem">
  <input type="hidden" name="action" value="request">
  <label style="display:block;margin-bottom:.4rem;font-size:13px">Email</label>
  <input type="email" name="email" autofocus required value="${escapeHtml(email)}">
  <button type="submit" style="margin-top:.8rem;width:100%">Send code</button>
</form>`;
  }
  return `
<h1>Enter your code</h1>
<p>We emailed a code to <strong>${escapeHtml(email)}</strong>.</p>
${err === 'invalid' ? `<div class="alert error">Invalid code.</div>` : ''}
${err === 'expired' ? `<div class="alert error">Code expired. Request a new one.</div>` : ''}
<form method="post" class="card" style="max-width:24rem">
  <input type="hidden" name="action" value="verify">
  <input type="hidden" name="email" value="${escapeHtml(email)}">
  <label style="display:block;margin-bottom:.4rem;font-size:13px">Code</label>
  <input type="text" name="code" autofocus required style="letter-spacing:.1em">
  <button type="submit" style="margin-top:.8rem;width:100%">Verify</button>
</form>
<p style="margin-top:1rem"><a href="/signin">← Use a different email</a></p>`;
}

function renderDashboard(data: {
  user: { email: string; plan: string; wallet: string | null };
  handle: string | null;
  sites: Site[];
  keys: ApiKeyRow[];
  drives: DriveRow[];
  variables: VarRow[];
  domains: DomainRow[];
  apex: string;
}): string {
  const sitesRows = data.sites.length === 0
    ? `<tr><td colspan="4" class="muted">No sites yet. Publish one with <code class="code">POST /api/v1/publish</code>.</td></tr>`
    : data.sites.map((s) => `
        <tr>
          <td><a href="https://${escapeHtml(s.slug)}.${escapeHtml(data.apex)}/" target="_blank">${escapeHtml(s.slug)}</a> ${s.spa_mode ? `<span class="muted">spa</span>` : ''} ${s.forkable ? `<span class="muted">fork</span>` : ''}</td>
          <td>${escapeHtml(s.viewer_title ?? '')}</td>
          <td class="muted">${new Date(s.updated_at).toISOString().slice(0,10)}</td>
          <td style="text-align:right">
            <form method="post" action="/dashboard/sites/${encodeURIComponent(s.slug)}/delete" style="display:inline" onsubmit="return confirm('Delete ${escapeHtml(s.slug)}?')">
              <button class="btn danger secondary" type="submit" style="background:#fff;color:#dc2626;border:1px solid #fecaca">Delete</button>
            </form>
          </td>
        </tr>`).join('');
  const keysRows = data.keys.length === 0
    ? `<tr><td colspan="3" class="muted">No API keys yet.</td></tr>`
    : data.keys.map((k) => `
        <tr><td class="code">${escapeHtml(k.prefix)}…</td><td>${escapeHtml(k.label ?? '')}</td><td class="muted">${new Date(k.created_at).toISOString().slice(0,10)}</td></tr>`).join('');
  const drivesRows = data.drives.length === 0
    ? `<tr><td colspan="3" class="muted">No drives. Create one with <code class="code">POST /api/v1/drives</code>.</td></tr>`
    : data.drives.map((d) => `
        <tr><td><code class="code">${escapeHtml(d.id)}</code></td><td>${escapeHtml(d.name)}${d.is_default ? ' <span class="muted">(default)</span>' : ''}</td><td class="muted">${new Date(d.created_at).toISOString().slice(0,10)}</td></tr>`).join('');
  const varsRows = data.variables.length === 0
    ? `<tr><td colspan="3" class="muted">No variables.</td></tr>`
    : data.variables.map((v) => `
        <tr><td class="code">${escapeHtml(v.name)}</td><td class="muted">${escapeHtml(v.pin_origin ?? '')}</td><td class="muted">${new Date(v.updated_at).toISOString().slice(0,10)}</td></tr>`).join('');
  const domainsRows = data.domains.length === 0
    ? `<tr><td colspan="4" class="muted">No custom domains.</td></tr>`
    : data.domains.map((d) => `
        <tr><td>${escapeHtml(d.domain)}</td><td>${escapeHtml(d.status)}</td><td>${escapeHtml(d.ssl_status ?? '')}</td><td class="muted">${new Date(d.created_at).toISOString().slice(0,10)}</td></tr>`).join('');

  return `
<h1>Dashboard</h1>
<p class="muted">${escapeHtml(data.user.email)} · plan: ${escapeHtml(data.user.plan)}${data.handle ? ` · handle: <code class="code">${escapeHtml(data.handle)}</code>` : ''}${data.user.wallet ? ` · wallet: <code class="code">${escapeHtml(data.user.wallet.slice(0,6))}…${escapeHtml(data.user.wallet.slice(-4))}</code>` : ''}</p>

<div class="card">
<h2 style="margin-top:0">Sites</h2>
<table><thead><tr><th>Slug</th><th>Title</th><th>Updated</th><th></th></tr></thead><tbody>${sitesRows}</tbody></table>
</div>

<div class="card">
<h2 style="margin-top:0">Drives</h2>
<table><thead><tr><th>ID</th><th>Name</th><th>Created</th></tr></thead><tbody>${drivesRows}</tbody></table>
<form method="post" action="/dashboard/drives" class="row" style="margin-top:1rem">
  <input type="text" name="name" placeholder="Drive name" style="flex:1;max-width:18rem">
  <label class="muted" style="font-size:12px"><input type="checkbox" name="isDefault"> default</label>
  <button type="submit">Create</button>
</form>
</div>

<div class="card">
<h2 style="margin-top:0">Domains</h2>
<table><thead><tr><th>Domain</th><th>Status</th><th>SSL</th><th>Added</th></tr></thead><tbody>${domainsRows}</tbody></table>
<form method="post" action="/dashboard/domains" class="row" style="margin-top:1rem">
  <input type="text" name="domain" placeholder="example.com" style="flex:1;max-width:18rem">
  <button type="submit">Add</button>
</form>
<p class="muted" style="font-size:12px;margin-top:.4rem">For SSL + edge routing, use <code class="code">POST /api/v1/domains</code> with <code class="code">CLOUDFLARE_API_TOKEN</code> configured.</p>
</div>

<div class="card">
<h2 style="margin-top:0">Variables</h2>
<p class="muted" style="font-size:12px;margin-bottom:.6rem">Encrypted at rest. Referenced as <code class="code">\${NAME}</code> in <code class="code">.sloop/proxy.json</code>.</p>
<table><thead><tr><th>Name</th><th>Pinned origin</th><th>Updated</th></tr></thead><tbody>${varsRows}</tbody></table>
<form method="post" action="/dashboard/variables" class="row" style="margin-top:1rem">
  <input type="text" name="name" placeholder="UPSTREAM_KEY" style="flex:1;max-width:18rem" pattern="[A-Z][A-Z0-9_]*">
  <input type="text" name="value" placeholder="value" style="flex:1;max-width:18rem">
  <button type="submit">Set</button>
</form>
</div>

<div class="card">
<h2 style="margin-top:0">Wallet</h2>
<p class="muted" style="margin-bottom:.6rem">${data.user.wallet ? `Connected: <code class="code">${escapeHtml(data.user.wallet)}</code>` : `Not connected — required to gate sites with a stablecoin paywall.`}</p>
<form method="post" action="/dashboard/wallet" class="row">
  <input type="text" name="address" placeholder="0x…" value="${escapeHtml(data.user.wallet ?? '')}" style="flex:1;max-width:24rem;font:13px ui-monospace,Menlo,monospace">
  <button type="submit">Save</button>
</form>
</div>

<div class="card">
<h2 style="margin-top:0">API keys</h2>
<table><thead><tr><th>Prefix</th><th>Label</th><th>Created</th></tr></thead><tbody>${keysRows}</tbody></table>
<form method="post" action="/dashboard/keys" style="margin-top:1rem" class="row">
  <input type="text" name="label" placeholder="Label (e.g. laptop, ci)" style="flex:1;max-width:18rem">
  <button type="submit">Mint key</button>
</form>
</div>`;
}

function renderClaim(data: { slug: string; token: string; expiresIn: number | null; signedIn: boolean; apex: string }): string {
  const minutes = data.expiresIn != null ? Math.round(data.expiresIn / 60000) : null;
  return `
<h1>Claim site</h1>
<p>Claiming <a href="https://${escapeHtml(data.slug)}.${escapeHtml(data.apex)}/" target="_blank"><code class="code">${escapeHtml(data.slug)}</code></a> removes its 24h expiry and moves it to your account.</p>
${minutes != null ? `<p class="muted">Expires in ~${minutes} minutes if unclaimed.</p>` : ''}
<form method="post" class="card" style="max-width:28rem">
  <input type="hidden" name="slug" value="${escapeHtml(data.slug)}">
  <input type="hidden" name="token" value="${escapeHtml(data.token)}">
  <button type="submit">${data.signedIn ? 'Claim now' : 'Sign in & claim'}</button>
</form>`;
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
