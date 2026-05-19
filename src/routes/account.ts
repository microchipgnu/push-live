import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types.ts';
import { auth, requireUser, errBody } from '../lib/auth.ts';
import { newId } from '../lib/ids.ts';
import { encryptValue } from '../lib/crypto.ts';
import { addCustomHostname, getCustomHostname, deleteCustomHostname } from '../lib/cf-saas.ts';
import { casKey } from '../lib/hash.ts';

type AppCtx = Context<{ Bindings: Env }>;

export const accountRouter = new Hono<{ Bindings: Env }>();

// ------------ Wallet ------------
accountRouter.get('/api/v1/wallet', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const row = await c.env.DB.prepare(`SELECT wallet FROM users WHERE id = ?1`).bind(u.userId).first<{ wallet: string | null }>();
  return c.json({ address: row?.wallet ?? null });
});

accountRouter.patch('/api/v1/wallet', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = (await c.req.json().catch(() => null)) as { address?: string | null } | null;
  if (!body || body.address === undefined) return c.json(errBody('invalid_request', 'address required'), 400);
  if (body.address !== null) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      return c.json(errBody('invalid_request', 'address must be 0x + 40 hex'), 400);
    }
  }
  await c.env.DB.prepare(`UPDATE users SET wallet = ?1 WHERE id = ?2`).bind(body.address, u.userId).run();
  return c.json({ address: body.address });
});

// ------------ Variables (encrypted at rest) ------------
// Values are capped at 4 KB and accounts hold at most 50 variables; both
// keep proxy abuse contained. `allowedUpstreams` is the modern allow-list
// (array of hostnames, wildcards permitted). `pinToUpstreamOrigin` is the
// legacy single-hostname form, kept for older callers.
const VARIABLE_VALUE_MAX_BYTES = 4 * 1024;
const VARIABLE_COUNT_MAX = 50;
const VarSetSchema = z.object({
  value: z.string().min(1).max(VARIABLE_VALUE_MAX_BYTES),
  pinToUpstreamOrigin: z.string().max(255).optional(),
  allowedUpstreams: z.array(z.string().max(255)).max(20).optional(),
});

accountRouter.get('/api/v1/me/variables', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const rows = await c.env.DB.prepare(
    `SELECT name, pin_origin, updated_at FROM variables WHERE owner_user_id = ?1 ORDER BY name`,
  ).bind(u.userId).all<{ name: string; pin_origin: string | null; updated_at: number }>();
  const variables = (rows.results ?? []).map((r) => ({
    name: r.name,
    allowedUpstreams: parseAllowedUpstreams(r.pin_origin),
    updated_at: r.updated_at,
  }));
  return c.json({ variables, count: variables.length, limit: VARIABLE_COUNT_MAX });
});

function parseAllowedUpstreams(raw: string | null): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    } catch { /* legacy single-origin form */ }
  }
  return [trimmed];
}

accountRouter.put('/api/v1/me/variables/:name', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const name = c.req.param('name');
  if (!name || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
    return c.json(errBody('invalid_request', 'name must match [A-Z][A-Z0-9_]*'), 400);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = VarSetSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);

  // Enforce per-account variable count. Skip the check on overwrite (same name
  // already exists) so updates don't count against quota.
  const existing = await c.env.DB.prepare(
    `SELECT 1 AS hit FROM variables WHERE owner_user_id = ?1 AND name = ?2`,
  ).bind(u.userId, name).first<{ hit: number }>();
  if (!existing) {
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM variables WHERE owner_user_id = ?1`,
    ).bind(u.userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= VARIABLE_COUNT_MAX) {
      return c.json(errBody('quota_exceeded', `Variable limit reached (${VARIABLE_COUNT_MAX}). Delete one before adding another.`), 402);
    }
  }

  // Encode allowedUpstreams as JSON in the pin_origin column. Legacy
  // pinToUpstreamOrigin maps to a single-entry list for forward compatibility.
  const allow = parsed.data.allowedUpstreams ?? (parsed.data.pinToUpstreamOrigin ? [parsed.data.pinToUpstreamOrigin] : []);
  const pinOrigin = allow.length > 0 ? JSON.stringify(allow) : null;

  const enc = await encryptValue(c.env.SIGNING_KEY, parsed.data.value);
  await c.env.DB.prepare(
    `INSERT INTO variables (owner_user_id, name, value_encrypted, pin_origin, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(owner_user_id, name) DO UPDATE SET value_encrypted = ?3, pin_origin = ?4, updated_at = ?5`,
  )
    .bind(u.userId, name, enc, pinOrigin, Date.now())
    .run();
  return c.json({ name, allowedUpstreams: allow });
});

accountRouter.delete('/api/v1/me/variables/:name', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const name = c.req.param('name');
  if (!name) return c.json(errBody('invalid_request', 'name required'), 400);
  const force = c.req.query('force') === 'true';

  if (!force) {
    const usedBy = await findVariableUsage(c.env, u.userId, name);
    if (usedBy.length > 0) {
      return c.json(
        errBody('conflict', `Variable ${name} is referenced by ${usedBy.length} site(s). Pass ?force=true to delete anyway.`, {
          usedBy,
        }),
        409,
      );
    }
  }

  await c.env.DB.prepare(`DELETE FROM variables WHERE owner_user_id = ?1 AND name = ?2`).bind(u.userId, name).run();
  return c.json({ success: true, force });
});

async function findVariableUsage(env: Env, userId: string, varName: string): Promise<string[]> {
  // Sites that ship a proxy.json in their current live version.
  const rows = await env.DB.prepare(
    `SELECT s.slug, sf.sha256
     FROM sites s JOIN site_files sf ON sf.version_id = s.current_version_id
     WHERE s.owner_user_id = ?1 AND s.status != 'deleted' AND sf.path = '.push-live/proxy.json'`,
  ).bind(userId).all<{ slug: string; sha256: string }>();
  const out: string[] = [];
  const needle = new RegExp(`\\$\\{${escapeRegex(varName)}\\}`);
  for (const r of rows.results ?? []) {
    const obj = await env.SITES.get(casKey(r.sha256));
    if (!obj) continue;
    const text = await obj.text();
    if (needle.test(text)) out.push(r.slug);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------ Handle ------------
const HandleSchema = z.object({
  handle: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional(),
  username: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional(),
});

accountRouter.get('/api/v1/handle', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const row = await c.env.DB.prepare(`SELECT handle FROM handles WHERE owner_user_id = ?1`).bind(u.userId).first<{ handle: string }>();
  return c.json({ handle: row?.handle ?? null });
});

accountRouter.post('/api/v1/handle', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => null);
  const parsed = HandleSchema.safeParse(body);
  if (!parsed.success || !(parsed.data.handle || parsed.data.username)) {
    return c.json(errBody('invalid_request', 'handle required'), 400);
  }
  const handle = (parsed.data.handle ?? parsed.data.username)!;
  const taken = await c.env.DB.prepare(`SELECT handle FROM handles WHERE handle = ?1`).bind(handle).first();
  if (taken) return c.json(errBody('conflict', 'Handle already taken'), 409);
  try {
    await c.env.DB.prepare(
      `INSERT INTO handles (handle, owner_user_id, created_at) VALUES (?1, ?2, ?3)`,
    ).bind(handle, u.userId, Date.now()).run();
  } catch (e) {
    return c.json(errBody('conflict', 'You already have a handle'), 409);
  }
  return c.json({ handle });
});

accountRouter.patch('/api/v1/handle', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => null);
  const parsed = HandleSchema.safeParse(body);
  if (!parsed.success || !(parsed.data.handle || parsed.data.username)) {
    return c.json(errBody('invalid_request', 'handle required'), 400);
  }
  const handle = (parsed.data.handle ?? parsed.data.username)!;
  const taken = await c.env.DB.prepare(`SELECT owner_user_id FROM handles WHERE handle = ?1`).bind(handle).first<{ owner_user_id: string }>();
  if (taken && taken.owner_user_id !== u.userId) {
    return c.json(errBody('conflict', 'Handle already taken'), 409);
  }
  await c.env.DB.prepare(`DELETE FROM handles WHERE owner_user_id = ?1`).bind(u.userId).run();
  await c.env.DB.prepare(
    `INSERT INTO handles (handle, owner_user_id, created_at) VALUES (?1, ?2, ?3)`,
  ).bind(handle, u.userId, Date.now()).run();
  return c.json({ handle });
});

accountRouter.delete('/api/v1/handle', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  await c.env.DB.prepare(`DELETE FROM handles WHERE owner_user_id = ?1`).bind(u.userId).run();
  return c.json({ success: true });
});

// ------------ Domains ------------
const DomainCreateSchema = z.object({
  domain: z.string().regex(/^([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i).max(253),
});

accountRouter.get('/api/v1/domains', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const rows = await c.env.DB.prepare(
    `SELECT domain, status, ssl_status, created_at, verified_at FROM domains WHERE owner_user_id = ?1 ORDER BY created_at DESC`,
  ).bind(u.userId).all();
  return c.json({ domains: rows.results ?? [] });
});

accountRouter.post('/api/v1/domains', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => null);
  const parsed = DomainCreateSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const domain = parsed.data.domain.toLowerCase();

  const existing = await c.env.DB.prepare(`SELECT owner_user_id, cf_hostname_id FROM domains WHERE domain = ?1`)
    .bind(domain).first<{ owner_user_id: string; cf_hostname_id: string | null }>();
  if (existing && existing.owner_user_id !== u.userId) {
    return c.json(errBody('conflict', 'Domain already registered'), 409);
  }

  // Provision via Cloudflare for SaaS — required for SSL + edge routing.
  // If CF_SAAS_API_TOKEN is unset we fall back to a verification stub so
  // the dashboard flow still works in local dev.
  let cfHostnameId: string | null = existing?.cf_hostname_id ?? null;
  let records: Array<{ type: string; name: string; value: string }> = [];
  let cfStatus: string = 'pending';
  let cfSslStatus: string | null = 'pending';

  if (c.env.CF_SAAS_API_TOKEN && c.env.CLOUDFLARE_ZONE_ID) {
    try {
      if (!cfHostnameId) {
        const created = await addCustomHostname(c.env, domain);
        cfHostnameId = created.id;
        records = created.ownership_records;
        cfStatus = created.status;
        cfSslStatus = created.ssl_status ?? 'pending';
      } else {
        const fresh = await getCustomHostname(c.env, cfHostnameId);
        records = fresh.ownership_records;
        cfStatus = fresh.status;
        cfSslStatus = fresh.ssl_status ?? 'pending';
      }
    } catch (e) {
      return c.json(errBody('upstream_error', `Cloudflare provisioning failed: ${e instanceof Error ? e.message : 'unknown'}`), 502);
    }
  } else {
    // Dev fallback: store a synthetic TXT record so the response shape is stable.
    records = [{
      type: 'TXT',
      name: `_push-live-challenge.${domain}`,
      value: newId('verify').slice(0, 32),
    }];
  }

  await c.env.DB.prepare(
    `INSERT INTO domains (domain, owner_user_id, status, verification, ssl_status, cf_hostname_id, cf_ownership_records, cf_last_synced, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(domain) DO UPDATE SET
       status = ?3, ssl_status = ?5, cf_hostname_id = ?6, cf_ownership_records = ?7, cf_last_synced = ?8`,
  ).bind(
    domain,
    u.userId,
    cfStatus,
    records[0]?.value ?? null,
    cfSslStatus,
    cfHostnameId,
    JSON.stringify(records),
    Date.now(),
    Date.now(),
  ).run();

  return c.json({
    domain,
    status: cfStatus,
    ssl_status: cfSslStatus,
    cf_hostname_id: cfHostnameId,
    instructions: records,
  });
});

// On-demand re-sync: agents can poll this to learn when SSL goes active.
accountRouter.post('/api/v1/domains/:domain/sync', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const domain = c.req.param('domain');
  const row = await c.env.DB.prepare(
    `SELECT cf_hostname_id FROM domains WHERE domain = ?1 AND owner_user_id = ?2`,
  ).bind(domain, u.userId).first<{ cf_hostname_id: string | null }>();
  if (!row) return c.json(errBody('not_found', 'Domain not found'), 404);
  if (!row.cf_hostname_id) return c.json(errBody('precondition_failed', 'No Cloudflare hostname id; reprovision via POST /api/v1/domains'), 412);
  if (!c.env.CF_SAAS_API_TOKEN) return c.json(errBody('precondition_failed', 'CF_SAAS_API_TOKEN not configured'), 412);
  try {
    const fresh = await getCustomHostname(c.env, row.cf_hostname_id);
    await c.env.DB.prepare(
      `UPDATE domains SET status = ?1, ssl_status = ?2, cf_ownership_records = ?3, cf_last_synced = ?4 WHERE domain = ?5`,
    ).bind(fresh.status, fresh.ssl_status ?? null, JSON.stringify(fresh.ownership_records), Date.now(), domain).run();
    return c.json({
      domain,
      status: fresh.status,
      ssl_status: fresh.ssl_status,
      verification_errors: fresh.verification_errors,
      instructions: fresh.ownership_records,
    });
  } catch (e) {
    return c.json(errBody('upstream_error', `Sync failed: ${e instanceof Error ? e.message : 'unknown'}`), 502);
  }
});

accountRouter.get('/api/v1/domains/:domain', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const domain = c.req.param('domain');
  const row = await c.env.DB.prepare(
    `SELECT domain, status, ssl_status, verification, created_at, verified_at FROM domains WHERE domain = ?1 AND owner_user_id = ?2`,
  ).bind(domain, u.userId).first();
  if (!row) return c.json(errBody('not_found', 'Domain not found'), 404);
  return c.json(row);
});

accountRouter.delete('/api/v1/domains/:domain', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const domain = c.req.param('domain');
  const row = await c.env.DB.prepare(
    `SELECT cf_hostname_id FROM domains WHERE domain = ?1 AND owner_user_id = ?2`,
  ).bind(domain, u.userId).first<{ cf_hostname_id: string | null }>();
  if (row?.cf_hostname_id && c.env.CF_SAAS_API_TOKEN) {
    try { await deleteCustomHostname(c.env, row.cf_hostname_id); }
    catch (e) { console.error('[domains] cf delete failed', e); }
  }
  await c.env.DB.prepare(`DELETE FROM domains WHERE domain = ?1 AND owner_user_id = ?2`).bind(domain, u.userId).run();
  return c.json({ success: true });
});

// ------------ Links ------------
const LinkCreateSchema = z.object({
  slug: z.string().min(1),
  location: z.string().optional(),
  mount_path: z.string().optional(),
  domain: z.string().optional(),
  namespace_id: z.string().optional(),
});

accountRouter.get('/api/v1/links', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const rows = await c.env.DB.prepare(
    `SELECT id, location, domain, mount_path, slug, created_at FROM links WHERE owner_user_id = ?1 ORDER BY created_at DESC`,
  ).bind(u.userId).all();
  return c.json({ links: rows.results ?? [] });
});

accountRouter.post('/api/v1/links', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => null);
  const parsed = LinkCreateSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const l = parsed.data;

  // Verify slug ownership
  const site = await c.env.DB.prepare(
    `SELECT slug FROM sites WHERE slug = ?1 AND owner_user_id = ?2 AND status != 'deleted'`,
  ).bind(l.slug, u.userId).first();
  if (!site) return c.json(errBody('not_found', 'Site not found'), 404);

  // Determine location
  let location: string;
  if (l.domain) {
    const dom = await c.env.DB.prepare(
      `SELECT domain FROM domains WHERE domain = ?1 AND owner_user_id = ?2 AND status = 'active'`,
    ).bind(l.domain, u.userId).first();
    if (!dom) return c.json(errBody('not_found', 'Active domain not found'), 404);
    location = `${l.domain}${l.mount_path ?? '/'}`;
  } else {
    const h = await c.env.DB.prepare(`SELECT handle FROM handles WHERE owner_user_id = ?1`).bind(u.userId).first<{ handle: string }>();
    if (!h) return c.json(errBody('precondition_failed', 'Set a handle first'), 412);
    location = `${h.handle}${l.mount_path ?? '/'}`;
  }
  if (l.location && l.location !== location) {
    location = l.location;
  }

  const id = newId('lnk');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO links (id, owner_user_id, location, domain, mount_path, slug, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(location) DO UPDATE SET slug = ?6, updated_at = ?7`,
  ).bind(id, u.userId, location, l.domain ?? null, l.mount_path ?? '/', l.slug, now).run();
  await c.env.KV.put(`link:${location}`, l.slug, { expirationTtl: 86400 });
  return c.json({ id, location, slug: l.slug, domain: l.domain ?? null, mount_path: l.mount_path ?? '/' });
});

const LinkPatchSchema = z.object({
  slug: z.string().min(1),
  domain: z.string().optional(),
  namespace_id: z.string().optional(),
});

accountRouter.patch('/api/v1/links/:location{.+}', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const location = decodeURIComponent(c.req.param('location') ?? '');
  const body = await c.req.json().catch(() => null);
  const parsed = LinkPatchSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  // Verify the new slug belongs to the same user.
  const site = await c.env.DB.prepare(
    `SELECT slug FROM sites WHERE slug = ?1 AND owner_user_id = ?2 AND status != 'deleted'`,
  ).bind(parsed.data.slug, u.userId).first();
  if (!site) return c.json(errBody('not_found', 'Target site not found'), 404);
  const res = await c.env.DB.prepare(
    `UPDATE links SET slug = ?1, updated_at = ?2 WHERE location = ?3 AND owner_user_id = ?4`,
  ).bind(parsed.data.slug, Date.now(), location, u.userId).run();
  if ((res.meta.changes ?? 0) === 0) return c.json(errBody('not_found', 'Link not found'), 404);
  await c.env.KV.put(`link:${location}`, parsed.data.slug, { expirationTtl: 86400 });
  return c.json({ location, slug: parsed.data.slug });
});

accountRouter.get('/api/v1/links/:location{.+}', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const location = decodeURIComponent(c.req.param('location') ?? '');
  const row = await c.env.DB.prepare(
    `SELECT id, location, domain, mount_path, slug, created_at FROM links WHERE location = ?1 AND owner_user_id = ?2`,
  ).bind(location, u.userId).first();
  if (!row) return c.json(errBody('not_found', 'Link not found'), 404);
  return c.json(row);
});

const SupportSchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(10_000),
});

accountRouter.post('/api/v1/support', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => null);
  const parsed = SupportSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(u.userId).first<{ email: string }>();
  // Store + optionally email. We log + fire-and-forget; KV TTL keeps memory bounded.
  const id = newId('sup');
  const payload = {
    id,
    userId: u.userId,
    email: user?.email,
    subject: parsed.data.subject,
    message: parsed.data.message,
    receivedAt: Date.now(),
  };
  await c.env.KV.put(`support:${id}`, JSON.stringify(payload), { expirationTtl: 90 * 24 * 3600 });
  console.log('[support]', JSON.stringify(payload));
  if (c.env.EMAIL && user?.email) {
    c.executionCtx.waitUntil(
      c.env.EMAIL.send({
        to: c.env.EMAIL_FROM ?? `support@${c.env.PUBLIC_APEX_HOST}`,
        from: c.env.EMAIL_FROM ?? `noreply@${c.env.PUBLIC_APEX_HOST}`,
        subject: `[support] ${parsed.data.subject}`,
        text: `From: ${user.email}\nUser: ${u.userId}\n\n${parsed.data.message}`,
      }).catch((e) => console.error('[support] email failed', e)),
    );
  }
  return c.json({ id, success: true });
});

accountRouter.delete('/api/v1/links/:location{.+}', auth({ required: true }), async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const location = decodeURIComponent(c.req.param('location') ?? '');
  await c.env.DB.prepare(`DELETE FROM links WHERE location = ?1 AND owner_user_id = ?2`).bind(location, u.userId).run();
  await c.env.KV.delete(`link:${location}`);
  return c.json({ success: true });
});
