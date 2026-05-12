import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, AuthCtx } from '../types.ts';
import { auth, requireUser, errBody } from '../lib/auth.ts';
import { newSlug, newVersionId, newToken } from '../lib/ids.ts';
import { casKey, sha256Hex } from '../lib/hash.ts';
import { uploadUrlFor } from '../lib/r2-presign.ts';
import { userPlan, planFor, siteCount, totalStorageBytes, checkPublishRate, rateLimitResponse } from '../lib/quotas.ts';

type AppCtx = Context<{ Bindings: Env }>;

const FileSchema = z.object({
  path: z.string().min(1).max(1024).refine(
    (p) => !p.startsWith('/') && !p.includes('..') && !p.includes('\\'),
    'invalid path',
  ),
  size: z.number().int().min(0).max(5 * 1024 * 1024 * 1024),
  contentType: z.string().min(1).max(255),
  hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const PublishCreateSchema = z.object({
  files: z.array(FileSchema).min(1).max(5000),
  ttlSeconds: z.number().int().positive().nullable().optional(),
  viewer: z
    .object({
      title: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
      ogImagePath: z.string().max(1024).optional(),
    })
    .optional(),
  spaMode: z.boolean().optional(),
  forkable: z.boolean().optional(),
  claimToken: z.string().optional(),
});

const ANON_TTL_SECONDS = 24 * 60 * 60;

export const sitesRouter = new Hono<{ Bindings: Env }>();

sitesRouter.post('/api/v1/publish/from-drive', auth({ required: true }), publishFromDrive);
sitesRouter.post('/api/v1/publish', auth(), createOrUpdate(null));
sitesRouter.put('/api/v1/publish/:slug', auth(), createOrUpdate('update'));
sitesRouter.post('/api/v1/publish/:slug/finalize', auth(), finalize);
sitesRouter.post('/api/v1/publish/:slug/uploads/refresh', auth(), refreshUploads);
sitesRouter.post('/api/v1/publish/:slug/claim', auth({ required: true }), claim);
sitesRouter.patch('/api/v1/publish/:slug/metadata', auth({ required: true }), patchMetadata);
sitesRouter.post('/api/v1/publish/:slug/duplicate', auth({ required: true }), duplicateSite);
sitesRouter.get('/api/v1/publishes', auth({ required: true }), listSites);
sitesRouter.get('/api/v1/publish/:slug', auth({ required: true }), getSite);
sitesRouter.delete('/api/v1/publish/:slug', auth({ required: true }), deleteSite);

const MetadataPatchSchema = z.object({
  ttlSeconds: z.number().int().positive().nullable().optional(),
  viewer: z
    .object({
      title: z.string().max(200).nullable().optional(),
      description: z.string().max(500).nullable().optional(),
      ogImagePath: z.string().max(1024).nullable().optional(),
    })
    .optional(),
  password: z.string().min(1).max(200).nullable().optional(),
  price: z
    .object({
      amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
      currency: z.string().min(3).max(8),
      recipientAddress: z.string().optional(),
    })
    .nullable()
    .optional(),
  spaMode: z.boolean().optional(),
  forkable: z.boolean().optional(),
});

function createOrUpdate(mode: 'update' | null) {
  return async (c: AppCtx) => {
    const a = c.get('auth') as AuthCtx;
    const body = await c.req.json().catch(() => null);
    const parsed = PublishCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errBody('invalid_request', parsed.error.message), 400);
    }
    const { files, ttlSeconds, viewer, spaMode, forkable, claimToken } = parsed.data;
    const now = Date.now();
    const env = c.env;

    // ---- Plan-aware checks ----
    const plan = a.kind === 'user' ? await userPlan(env, a.userId) : planFor('anonymous');
    const rlKey = a.kind === 'user' ? `user:${a.userId}` : `ip:${c.req.header('cf-connecting-ip') ?? 'unknown'}`;
    const wait = await checkPublishRate(env, rlKey, plan.publishesPerHour);
    if (wait > 0) return rateLimitResponse(wait);

    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    for (const f of files) {
      if (f.size > plan.maxFileSiteBytes) {
        return c.json(errBody('payload_too_large', `File ${f.path} exceeds plan max size (${plan.maxFileSiteBytes} bytes)`), 413);
      }
    }

    if (a.kind === 'user' && mode === null) {
      const count = await siteCount(env, a.userId);
      if (count >= plan.maxSites) {
        return c.json(errBody('quota_exceeded', `Site limit reached for plan "${plan.name}" (${plan.maxSites})`), 402);
      }
      const used = await totalStorageBytes(env, a.userId);
      if (used + totalSize > plan.maxStorageBytes) {
        return c.json(errBody('quota_exceeded', `Storage quota exceeded (${used + totalSize} > ${plan.maxStorageBytes})`), 402);
      }
    }

    let slug: string;
    let owner_user_id: string | null = null;
    let anonymous: 0 | 1 = 0;
    let expires_at: number | null = null;

    if (mode === 'update') {
      const slugParam = c.req.param('slug');
      if (!slugParam) return c.json(errBody('invalid_request', 'slug required'), 400);
      slug = slugParam;
      const site = await env.DB.prepare(
        'SELECT slug, owner_user_id, anonymous FROM sites WHERE slug = ?1 AND status != ?2',
      )
        .bind(slug, 'deleted')
        .first<{ slug: string; owner_user_id: string | null; anonymous: number }>();
      if (!site) return c.json(errBody('not_found', 'Site not found'), 404);
      if (site.owner_user_id) {
        if (a.kind !== 'user' || a.userId !== site.owner_user_id) {
          return c.json(errBody('unauthorized', 'Not your site'), 403);
        }
        owner_user_id = site.owner_user_id;
      } else {
        // anonymous site: require valid claim token
        if (!claimToken) {
          return c.json(errBody('unauthorized', 'claimToken required for anonymous site'), 401);
        }
        const tokRow = await env.DB.prepare(
          'SELECT token_hash, expires_at FROM claim_tokens WHERE slug = ?1',
        )
          .bind(slug)
          .first<{ token_hash: string; expires_at: number }>();
        if (!tokRow || tokRow.expires_at < now) {
          return c.json(errBody('gone', 'Anonymous site expired'), 410);
        }
        if ((await sha256Hex(claimToken)) !== tokRow.token_hash) {
          return c.json(errBody('unauthorized', 'Invalid claimToken'), 401);
        }
        anonymous = 1;
        expires_at = tokRow.expires_at;
      }
    } else {
      // create
      slug = newSlug();
      // ensure unique
      for (let i = 0; i < 5; i++) {
        const existing = await env.DB.prepare('SELECT slug FROM sites WHERE slug = ?1')
          .bind(slug)
          .first();
        if (!existing) break;
        slug = newSlug();
      }
      if (a.kind === 'user') {
        owner_user_id = a.userId;
      } else {
        anonymous = 1;
        expires_at = now + ANON_TTL_SECONDS * 1000;
      }
    }

    // diff against previous version for hash-skip
    const prev = await env.DB.prepare(
      'SELECT current_version_id FROM sites WHERE slug = ?1',
    )
      .bind(slug)
      .first<{ current_version_id: string | null }>();
    const prevHashes = new Map<string, string>(); // path -> sha256
    if (prev?.current_version_id) {
      const rows = await env.DB.prepare(
        'SELECT path, sha256 FROM site_files WHERE version_id = ?1',
      )
        .bind(prev.current_version_id)
        .all<{ path: string; sha256: string }>();
      for (const r of rows.results ?? []) prevHashes.set(r.path, r.sha256);
    }

    const versionId = newVersionId();

    // Upsert site row (status pending until finalize)
    const ttlExpires = ttlSeconds != null && owner_user_id ? now + ttlSeconds * 1000 : expires_at;
    await env.DB.prepare(
      `INSERT INTO sites (slug, owner_user_id, status, anonymous, expires_at,
        spa_mode, forkable, viewer_title, viewer_description, viewer_og_image,
        client_header, created_at, updated_at)
       VALUES (?1, ?2, 'pending', ?3, ?4, COALESCE(?5, 0), COALESCE(?6, 0), ?7, ?8, ?9, ?10, ?11, ?11)
       ON CONFLICT(slug) DO UPDATE SET
         updated_at = ?11,
         spa_mode    = COALESCE(?5, spa_mode),
         forkable    = COALESCE(?6, forkable),
         viewer_title       = COALESCE(?7, viewer_title),
         viewer_description = COALESCE(?8, viewer_description),
         viewer_og_image    = COALESCE(?9, viewer_og_image),
         expires_at         = COALESCE(?4, expires_at)`,
    )
      .bind(
        slug,
        owner_user_id,
        anonymous,
        ttlExpires,
        spaMode ? 1 : null,
        forkable ? 1 : null,
        viewer?.title ?? null,
        viewer?.description ?? null,
        viewer?.ogImagePath ?? null,
        c.req.header('x-sloop-client') ?? null,
        now,
      )
      .run();

    await env.DB.prepare(
      'INSERT INTO site_versions (id, slug, status, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(versionId, slug, 'pending', now)
      .run();

    const fileInserts = env.DB.batch(
      files.map((f) =>
        env.DB.prepare(
          `INSERT INTO site_files (version_id, path, size, content_type, sha256)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).bind(versionId, f.path, f.size, f.contentType, f.hash ?? ''),
      ),
    );
    await fileInserts;

    // Compute upload list: only files whose hash is missing OR not present in prev OR not present in R2
    const uploads: Array<{ path: string; method: 'PUT'; url: string; headers: Record<string, string> }> = [];
    const skipped: string[] = [];
    const origin = new URL(c.req.url).origin;

    for (const f of files) {
      if (!f.hash) {
        // no hash provided: must upload to a per-version key (no de-dup)
        const key = `pending/${versionId}/${f.path}`;
        uploads.push({
          path: f.path,
          method: 'PUT',
          url: await uploadUrlFor(env, origin, key, f.contentType),
          headers: { 'Content-Type': f.contentType },
        });
        continue;
      }
      // Hash provided: can skip if R2 already has the CAS object
      const key = casKey(f.hash);
      const head = await env.SITES.head(key);
      if (head) {
        skipped.push(f.path);
        continue;
      }
      uploads.push({
        path: f.path,
        method: 'PUT',
        url: await uploadUrlFor(env, origin, key, f.contentType),
        headers: { 'Content-Type': f.contentType },
      });
    }

    const finalizeUrl = `${new URL(c.req.url).origin}/api/v1/publish/${slug}/finalize`;
    const siteUrl = `https://${slug}.${env.PUBLIC_APEX_HOST}/`;

    const resp: Record<string, unknown> = {
      slug,
      siteUrl,
      upload: {
        versionId,
        uploads,
        skipped,
        finalizeUrl,
        expiresInSeconds: 3600,
      },
    };

    if (anonymous && mode !== 'update') {
      const token = newToken(24);
      const tokenHash = await sha256Hex(token);
      await env.DB.prepare(
        `INSERT INTO claim_tokens (slug, token_hash, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(slug) DO UPDATE SET token_hash = ?2, expires_at = ?3`,
      )
        .bind(slug, tokenHash, expires_at!)
        .run();
      resp.claimToken = token;
      resp.claimUrl = `${new URL(c.req.url).origin}/claim?slug=${slug}&token=${token}`;
      resp.expiresAt = new Date(expires_at!).toISOString();
      resp.anonymous = true;
      resp.warning =
        'Save the claimToken and claimUrl now — they are shown only once. Share the claimUrl with the user to keep the site permanently.';
    }

    return c.json(resp, 200);
  };
}

async function refreshUploads(c: AppCtx) {
  const slug = c.req.param('slug');
  if (!slug) return c.json(errBody('invalid_request', 'slug required'), 400);
  const a = c.get('auth') as AuthCtx;

  const site = await c.env.DB.prepare(
    `SELECT owner_user_id, anonymous FROM sites WHERE slug = ?1 AND status != 'deleted'`,
  ).bind(slug).first<{ owner_user_id: string | null; anonymous: number }>();
  if (!site) return c.json(errBody('not_found', 'Site not found'), 404);
  if (site.owner_user_id) {
    if (a.kind !== 'user' || a.userId !== site.owner_user_id) {
      return c.json(errBody('unauthorized', 'Not your site'), 403);
    }
  }

  // Find newest pending version for this slug.
  const ver = await c.env.DB.prepare(
    `SELECT id FROM site_versions WHERE slug = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
  ).bind(slug).first<{ id: string }>();
  if (!ver) return c.json(errBody('not_found', 'No pending version'), 404);
  const versionId = ver.id;

  const rows = await c.env.DB.prepare(
    `SELECT path, content_type, sha256 FROM site_files WHERE version_id = ?1`,
  ).bind(versionId).all<{ path: string; content_type: string; sha256: string }>();
  const files = rows.results ?? [];

  const uploads: Array<{ path: string; method: 'PUT'; url: string; headers: Record<string, string> }> = [];
  const skipped: string[] = [];
  const origin = new URL(c.req.url).origin;
  for (const f of files) {
    const target = f.sha256 ? casKey(f.sha256) : `pending/${versionId}/${f.path}`;
    const exists = await c.env.SITES.head(target);
    if (exists) {
      skipped.push(f.path);
      continue;
    }
    uploads.push({
      path: f.path,
      method: 'PUT',
      url: await uploadUrlFor(c.env, origin, target, f.content_type),
      headers: { 'Content-Type': f.content_type },
    });
  }

  return c.json({
    versionId,
    uploads,
    skipped,
    finalizeUrl: `${origin}/api/v1/publish/${slug}/finalize`,
    expiresInSeconds: 3600,
  });
}

async function finalize(c: AppCtx) {
  const slug = c.req.param('slug');
  const body = await c.req.json().catch(() => null);
  const versionId = body?.versionId;
  if (typeof versionId !== 'string') {
    return c.json(errBody('invalid_request', 'versionId required'), 400);
  }
  const a = c.get('auth') as AuthCtx;
  const site = await c.env.DB.prepare(
    'SELECT slug, owner_user_id, current_version_id, anonymous FROM sites WHERE slug = ?1 AND status != ?2',
  )
    .bind(slug, 'deleted')
    .first<{ slug: string; owner_user_id: string | null; current_version_id: string | null; anonymous: number }>();
  if (!site) return c.json(errBody('not_found', 'Site not found'), 404);
  if (site.owner_user_id) {
    if (a.kind !== 'user' || a.userId !== site.owner_user_id) {
      return c.json(errBody('unauthorized', 'Not your site'), 403);
    }
  }
  const ver = await c.env.DB.prepare(
    'SELECT id, status FROM site_versions WHERE id = ?1 AND slug = ?2',
  )
    .bind(versionId, slug)
    .first<{ id: string; status: string }>();
  if (!ver) return c.json(errBody('not_found', 'Version not found'), 404);
  if (ver.status === 'live') {
    return c.json(errBody('conflict', 'Version already finalized'), 409);
  }

  // Promote pending-keyed files to CAS by streaming-copy (only those without hash)
  const files = await c.env.DB.prepare(
    'SELECT path, content_type, sha256 FROM site_files WHERE version_id = ?1',
  )
    .bind(versionId)
    .all<{ path: string; content_type: string; sha256: string }>();
  for (const f of files.results ?? []) {
    if (f.sha256) continue; // already CAS
    const srcKey = `pending/${versionId}/${f.path}`;
    const obj = await c.env.SITES.get(srcKey);
    if (!obj) {
      return c.json(
        errBody('precondition_failed', `Missing upload for ${f.path}`),
        412,
      );
    }
    const bytes = await obj.arrayBuffer();
    const sha = await sha256Hex(bytes);
    const dest = casKey(sha);
    if (!(await c.env.SITES.head(dest))) {
      await c.env.SITES.put(dest, bytes, {
        httpMetadata: { contentType: f.content_type },
      });
    }
    await c.env.DB.prepare(
      'UPDATE site_files SET sha256 = ?1 WHERE version_id = ?2 AND path = ?3',
    )
      .bind(sha, versionId, f.path)
      .run();
    await c.env.SITES.delete(srcKey);
  }

  // Verify every file's CAS object actually exists
  const verifyRows = await c.env.DB.prepare(
    'SELECT path, sha256 FROM site_files WHERE version_id = ?1',
  )
    .bind(versionId)
    .all<{ path: string; sha256: string }>();
  for (const r of verifyRows.results ?? []) {
    if (!(await c.env.SITES.head(casKey(r.sha256)))) {
      return c.json(
        errBody('precondition_failed', `Missing upload for ${r.path}`),
        412,
      );
    }
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE site_versions SET status = 'live', finalized_at = ?1 WHERE id = ?2`,
  )
    .bind(now, versionId)
    .run();
  const previousVersionId = site.current_version_id;
  if (previousVersionId) {
    await c.env.DB.prepare(
      `UPDATE site_versions SET status = 'superseded' WHERE id = ?1`,
    )
      .bind(previousVersionId)
      .run();
  }
  await c.env.DB.prepare(
    `UPDATE sites SET current_version_id = ?1, status = 'active', updated_at = ?2 WHERE slug = ?3`,
  )
    .bind(versionId, now, slug)
    .run();

  // Cache for fast serving
  await c.env.KV.put(`site:${slug}:version`, versionId);

  return c.json({
    success: true,
    slug,
    siteUrl: `https://${slug}.${c.env.PUBLIC_APEX_HOST}/`,
    previousVersionId,
    currentVersionId: versionId,
  });
}

async function listSites(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const rows = await c.env.DB.prepare(
    `SELECT slug, status, current_version_id, expires_at, spa_mode, forkable,
            viewer_title, viewer_description, created_at, updated_at
     FROM sites WHERE owner_user_id = ?1 AND status != 'deleted'
     ORDER BY updated_at DESC LIMIT 500`,
  )
    .bind(u.userId)
    .all();
  return c.json({ sites: rows.results ?? [] });
}

async function getSite(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const slug = c.req.param('slug');
  const site = await c.env.DB.prepare(
    `SELECT * FROM sites WHERE slug = ?1 AND owner_user_id = ?2 AND status != 'deleted'`,
  )
    .bind(slug, u.userId)
    .first();
  if (!site) return c.json(errBody('not_found', 'Site not found'), 404);
  const files = await c.env.DB.prepare(
    `SELECT path, size, content_type, sha256 FROM site_files WHERE version_id = ?1`,
  )
    .bind(site.current_version_id as string)
    .all();
  return c.json({
    site,
    siteUrl: `https://${slug}.${c.env.PUBLIC_APEX_HOST}/`,
    files: files.results ?? [],
  });
}

async function deleteSite(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const slug = c.req.param('slug');
  const res = await c.env.DB.prepare(
    `UPDATE sites SET status = 'deleted', updated_at = ?1 WHERE slug = ?2 AND owner_user_id = ?3`,
  )
    .bind(Date.now(), slug, u.userId)
    .run();
  if (res.meta.changes === 0) return c.json(errBody('not_found', 'Site not found'), 404);
  await c.env.KV.delete(`site:${slug}:version`);
  return c.json({ success: true });
}

const PublishFromDriveSchema = z.object({
  driveId: z.string().min(1),
  pathPrefix: z.string().max(1024).optional(),
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/).max(63).optional(),
  spaMode: z.boolean().optional(),
  forkable: z.boolean().optional(),
  password: z.string().min(1).max(200).optional(),
  viewer: z
    .object({
      title: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
      ogImagePath: z.string().max(1024).optional(),
    })
    .optional(),
});

async function publishFromDrive(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => null);
  const parsed = PublishFromDriveSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const p = parsed.data;

  // Verify drive ownership
  const drive = await c.env.DB.prepare(
    `SELECT id FROM drives WHERE id = ?1 AND owner_user_id = ?2 AND deleted_at IS NULL`,
  ).bind(p.driveId, u.userId).first();
  if (!drive) return c.json(errBody('not_found', 'Drive not found'), 404);

  const prefix = p.pathPrefix ?? '';
  const driveFiles = await c.env.DB.prepare(
    `SELECT path, size, content_type, sha256 FROM drive_files WHERE drive_id = ?1 AND path LIKE ?2`,
  ).bind(p.driveId, `${prefix}%`).all<{ path: string; size: number; content_type: string; sha256: string }>();
  const files = driveFiles.results ?? [];
  if (files.length === 0) return c.json(errBody('precondition_failed', 'No files to publish'), 412);

  // Pick or validate slug
  let slug = p.slug ?? newSlug();
  for (let i = 0; i < 5; i++) {
    const existing = await c.env.DB.prepare(`SELECT slug FROM sites WHERE slug = ?1`).bind(slug).first();
    if (!existing) break;
    if (p.slug) return c.json(errBody('conflict', 'Slug already taken'), 409);
    slug = newSlug();
  }

  const now = Date.now();
  const versionId = newVersionId();
  const passwordHash = p.password ? await sha256Hex(p.password) : null;

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO sites (slug, owner_user_id, status, current_version_id, anonymous,
        spa_mode, forkable, password_hash, viewer_title, viewer_description, viewer_og_image,
        created_at, updated_at)
       VALUES (?1, ?2, 'active', ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    ).bind(
      slug,
      u.userId,
      versionId,
      p.spaMode ? 1 : 0,
      p.forkable ? 1 : 0,
      passwordHash,
      p.viewer?.title ?? null,
      p.viewer?.description ?? null,
      p.viewer?.ogImagePath ?? null,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO site_versions (id, slug, status, created_at, finalized_at) VALUES (?1, ?2, 'live', ?3, ?3)`,
    ).bind(versionId, slug, now),
  ];
  for (const f of files) {
    const relPath = prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length).replace(/^\//, '') : f.path;
    if (!relPath) continue;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO site_files (version_id, path, size, content_type, sha256) VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(versionId, relPath, f.size, f.content_type, f.sha256),
    );
  }
  await c.env.DB.batch(stmts);
  await c.env.KV.put(`site:${slug}:version`, versionId);

  return c.json({
    slug,
    siteUrl: `https://${slug}.${c.env.PUBLIC_APEX_HOST}/`,
    currentVersionId: versionId,
    filesCount: files.length,
  });
}

async function patchMetadata(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const slug = c.req.param('slug');
  if (!slug) return c.json(errBody('invalid_request', 'slug required'), 400);
  const body = await c.req.json().catch(() => null);
  const parsed = MetadataPatchSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const m = parsed.data;

  const existing = await c.env.DB.prepare(
    `SELECT slug, forkable, password_hash, price_amount FROM sites WHERE slug = ?1 AND owner_user_id = ?2 AND status != 'deleted'`,
  )
    .bind(slug, u.userId)
    .first<{ slug: string; forkable: number; password_hash: string | null; price_amount: string | null }>();
  if (!existing) return c.json(errBody('not_found', 'Site not found'), 404);

  // Mutual exclusion: forkable vs password/price
  const wantsForkable = m.forkable === true;
  const wantsPassword = m.password != null && m.password !== '';
  const wantsPrice = m.price != null;
  if (wantsForkable && (wantsPassword || wantsPrice || existing.password_hash || existing.price_amount)) {
    return c.json(errBody('conflict', 'forkable conflicts with password or price'), 409);
  }
  if (wantsPassword && (existing.price_amount || wantsPrice)) {
    return c.json(errBody('conflict', 'password and price are mutually exclusive'), 409);
  }

  const updates: string[] = ['updated_at = ?1'];
  const binds: unknown[] = [Date.now()];
  let idx = 2;
  const set = (col: string, val: unknown) => {
    updates.push(`${col} = ?${idx}`);
    binds.push(val);
    idx++;
  };

  if (m.ttlSeconds !== undefined) {
    set('expires_at', m.ttlSeconds === null ? null : Date.now() + m.ttlSeconds * 1000);
  }
  if (m.viewer) {
    if (m.viewer.title !== undefined) set('viewer_title', m.viewer.title);
    if (m.viewer.description !== undefined) set('viewer_description', m.viewer.description);
    if (m.viewer.ogImagePath !== undefined) set('viewer_og_image', m.viewer.ogImagePath);
  }
  if (m.password !== undefined) {
    if (m.password === null || m.password === '') {
      set('password_hash', null);
    } else {
      set('password_hash', await sha256Hex(m.password));
      // Clearing price is implied by mutual exclusion
      set('price_amount', null);
      set('price_currency', null);
      set('price_recipient', null);
    }
  }
  if (m.price !== undefined) {
    if (m.price === null) {
      set('price_amount', null);
      set('price_currency', null);
      set('price_recipient', null);
    } else {
      set('price_amount', m.price.amount);
      set('price_currency', m.price.currency);
      set('price_recipient', m.price.recipientAddress ?? null);
      set('password_hash', null);
    }
  }
  if (m.spaMode !== undefined) set('spa_mode', m.spaMode ? 1 : 0);
  if (m.forkable !== undefined) set('forkable', m.forkable ? 1 : 0);

  binds.push(slug, u.userId);
  await c.env.DB.prepare(
    `UPDATE sites SET ${updates.join(', ')} WHERE slug = ?${idx} AND owner_user_id = ?${idx + 1}`,
  )
    .bind(...binds)
    .run();

  return c.json({ success: true, slug });
}

async function duplicateSite(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const sourceSlug = c.req.param('slug');
  if (!sourceSlug) return c.json(errBody('invalid_request', 'slug required'), 400);
  const body = (await c.req.json().catch(() => null)) as { viewer?: { title?: string; description?: string; ogImagePath?: string } } | null;

  const source = await c.env.DB.prepare(
    `SELECT * FROM sites WHERE slug = ?1 AND owner_user_id = ?2 AND status != 'deleted'`,
  )
    .bind(sourceSlug, u.userId)
    .first<Record<string, unknown>>();
  if (!source || !source.current_version_id) {
    return c.json(errBody('not_found', 'Source site not found'), 404);
  }

  // Pick unique new slug
  let newSlugStr = newSlug();
  for (let i = 0; i < 5; i++) {
    const exists = await c.env.DB.prepare('SELECT slug FROM sites WHERE slug = ?1')
      .bind(newSlugStr)
      .first();
    if (!exists) break;
    newSlugStr = newSlug();
  }

  const now = Date.now();
  const newVer = newVersionId();
  const viewer = body?.viewer ?? {};
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO sites (slug, owner_user_id, status, current_version_id, anonymous,
        spa_mode, forkable,
        viewer_title, viewer_description, viewer_og_image,
        created_at, updated_at)
       VALUES (?1, ?2, 'active', ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    ).bind(
      newSlugStr,
      u.userId,
      newVer,
      source.spa_mode ?? 0,
      source.forkable ?? 0,
      viewer.title ?? source.viewer_title ?? null,
      viewer.description ?? source.viewer_description ?? null,
      viewer.ogImagePath ?? source.viewer_og_image ?? null,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO site_versions (id, slug, status, created_at, finalized_at) VALUES (?1, ?2, 'live', ?3, ?3)`,
    ).bind(newVer, newSlugStr, now),
    c.env.DB.prepare(
      `INSERT INTO site_files (version_id, path, size, content_type, sha256)
       SELECT ?1, path, size, content_type, sha256 FROM site_files WHERE version_id = ?2`,
    ).bind(newVer, source.current_version_id),
  ]);

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM site_files WHERE version_id = ?1`,
  )
    .bind(newVer)
    .first<{ n: number }>();

  await c.env.KV.put(`site:${newSlugStr}:version`, newVer);

  return c.json({
    slug: newSlugStr,
    siteUrl: `https://${newSlugStr}.${c.env.PUBLIC_APEX_HOST}/`,
    sourceSlug,
    status: 'active',
    currentVersionId: newVer,
    filesCount: count?.n ?? 0,
  });
}

async function claim(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const slug = c.req.param('slug');
  const body = await c.req.json().catch(() => null);
  const token = body?.claimToken;
  if (typeof token !== 'string') {
    return c.json(errBody('invalid_request', 'claimToken required'), 400);
  }
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.slug, s.anonymous, s.owner_user_id, t.token_hash, t.expires_at
     FROM sites s LEFT JOIN claim_tokens t ON t.slug = s.slug
     WHERE s.slug = ?1 AND s.status != 'deleted'`,
  )
    .bind(slug)
    .first<{ slug: string; anonymous: number; owner_user_id: string | null; token_hash: string | null; expires_at: number | null }>();
  if (!row) return c.json(errBody('not_found', 'Site not found'), 404);
  if (row.owner_user_id) {
    return c.json(errBody('conflict', 'Site already claimed'), 409);
  }
  if (!row.token_hash || row.expires_at == null || row.expires_at < now) {
    return c.json(errBody('gone', 'Anonymous site expired'), 410);
  }
  if ((await sha256Hex(token)) !== row.token_hash) {
    return c.json(errBody('unauthorized', 'Invalid claimToken'), 401);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE sites SET owner_user_id = ?1, anonymous = 0, expires_at = NULL, updated_at = ?2 WHERE slug = ?3`,
    ).bind(u.userId, now, slug),
    c.env.DB.prepare(`DELETE FROM claim_tokens WHERE slug = ?1`).bind(slug),
  ]);
  return c.json({ success: true, slug });
}
