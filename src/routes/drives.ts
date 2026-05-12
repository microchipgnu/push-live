import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, AuthCtx } from '../types.ts';
import { auth, requireUser, errBody } from '../lib/auth.ts';
import { newId, newToken, newVersionId } from '../lib/ids.ts';
import { casKey, sha256Hex } from '../lib/hash.ts';
import { uploadUrlFor } from '../lib/r2-presign.ts';
import { userPlan, driveCount } from '../lib/quotas.ts';

type AppCtx = Context<{ Bindings: Env }>;

export const drivesRouter = new Hono<{ Bindings: Env }>();

drivesRouter.get('/api/v1/drives', auth({ required: true }), listDrives);
drivesRouter.post('/api/v1/drives', auth({ required: true }), createDrive);
drivesRouter.get('/api/v1/drives/default', auth({ required: true }), getDefaultDrive);
drivesRouter.get('/api/v1/drives/:driveId', driveAuth('read'), getDrive);
drivesRouter.patch('/api/v1/drives/:driveId', driveAuth('write'), patchDrive);
drivesRouter.delete('/api/v1/drives/:driveId', driveAuth('write'), deleteDrive);

drivesRouter.get('/api/v1/drives/:driveId/files', driveAuth('read'), listDriveFiles);
drivesRouter.patch('/api/v1/drives/:driveId/files', driveAuth('write'), batchDriveFiles);
drivesRouter.post('/api/v1/drives/:driveId/files/uploads', driveAuth('write'), stageDriveUpload);
drivesRouter.post('/api/v1/drives/:driveId/files/finalize', driveAuth('write'), finalizeDriveUpload);
drivesRouter.post('/api/v1/drives/:driveId/files/move', driveAuth('write'), moveDriveFile);
drivesRouter.get('/api/v1/drives/:driveId/files/*', driveAuth('read'), readDriveFile);
drivesRouter.delete('/api/v1/drives/:driveId/files/*', driveAuth('write'), deleteDriveFile);

drivesRouter.get('/api/v1/drives/:driveId/tokens', driveAuth('write', { needManage: true }), listDriveTokens);
drivesRouter.post('/api/v1/drives/:driveId/tokens', driveAuth('write', { needManage: true }), createDriveToken);
drivesRouter.delete('/api/v1/drives/:driveId/tokens/:tokenId', driveAuth('write', { needManage: true }), revokeDriveToken);

// ------------ Auth middleware specialized for drive access ------------
function driveAuth(need: 'read' | 'write', opts: { needManage?: boolean } = {}) {
  return async (c: AppCtx, next: () => Promise<void>) => {
    const driveId = c.req.param('driveId');
    if (!driveId) return c.json(errBody('invalid_request', 'driveId required'), 400);
    const header = c.req.header('authorization');
    if (!header) return c.json(errBody('unauthorized', 'Token required'), 401);
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return c.json(errBody('unauthorized', 'Malformed Authorization header'), 401);
    const token = m[1].trim();
    const hash = await sha256Hex(token);

    // Owner via API key?
    const apiKey = await c.env.DB.prepare(
      'SELECT user_id FROM api_keys WHERE token_hash = ?1',
    )
      .bind(hash)
      .first<{ user_id: string }>();
    if (apiKey) {
      const drive = await c.env.DB.prepare(
        'SELECT id FROM drives WHERE id = ?1 AND owner_user_id = ?2 AND deleted_at IS NULL',
      )
        .bind(driveId, apiKey.user_id)
        .first();
      if (!drive) return c.json(errBody('not_found', 'Drive not found'), 404);
      c.set('auth', { kind: 'user', userId: apiKey.user_id, apiKeyId: '' });
      c.set('driveScope', { driveId, perms: 'write', pathPrefix: null, manageTokens: true } as DriveScope);
      return next();
    }

    // Drive share token?
    const dt = await c.env.DB.prepare(
      `SELECT id, drive_id, owner_user_id, perms, path_prefix, manage_tokens, expires_at, revoked_at
       FROM drive_tokens WHERE token_hash = ?1`,
    )
      .bind(hash)
      .first<{ id: string; drive_id: string; owner_user_id: string; perms: string; path_prefix: string | null; manage_tokens: number; expires_at: number | null; revoked_at: number | null }>();
    if (!dt || dt.drive_id !== driveId || dt.revoked_at) {
      return c.json(errBody('unauthorized', 'Invalid token'), 401);
    }
    if (dt.expires_at && dt.expires_at < Date.now()) {
      return c.json(errBody('unauthorized', 'Token expired'), 401);
    }
    if (need === 'write' && dt.perms !== 'write') {
      return c.json(errBody('unauthorized', 'Write permission required'), 403);
    }
    if (opts.needManage && !dt.manage_tokens) {
      return c.json(errBody('unauthorized', 'manageTokens required'), 403);
    }
    c.set('auth', { kind: 'user', userId: dt.owner_user_id, apiKeyId: '' });
    c.set('driveScope', {
      driveId: dt.drive_id,
      perms: dt.perms as 'read' | 'write',
      pathPrefix: dt.path_prefix,
      manageTokens: dt.manage_tokens === 1,
    } as DriveScope);
    return next();
  };
}

type DriveScope = {
  driveId: string;
  perms: 'read' | 'write';
  pathPrefix: string | null;
  manageTokens: boolean;
};

declare module 'hono' {
  interface ContextVariableMap {
    driveScope: DriveScope;
  }
}

function checkPathScope(scope: DriveScope, path: string): boolean {
  if (!scope.pathPrefix) return true;
  return path === scope.pathPrefix || path.startsWith(scope.pathPrefix.endsWith('/') ? scope.pathPrefix : scope.pathPrefix + '/');
}

// ------------ Drive CRUD ------------
const DriveCreateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  isDefault: z.boolean().optional(),
});

async function listDrives(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const rows = await c.env.DB.prepare(
    `SELECT id, name, description, is_default, created_at, updated_at
     FROM drives WHERE owner_user_id = ?1 AND deleted_at IS NULL
     ORDER BY is_default DESC, created_at ASC`,
  )
    .bind(u.userId)
    .all();
  return c.json({ drives: rows.results ?? [] });
}

async function createDrive(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const parsed = DriveCreateSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const { name = 'My Drive', description, isDefault } = parsed.data;
  const plan = await userPlan(c.env, u.userId);
  const count = await driveCount(c.env, u.userId);
  if (count >= plan.maxDrives) {
    return c.json(errBody('quota_exceeded', `Drive limit reached for plan "${plan.name}" (${plan.maxDrives})`), 402);
  }
  const id = newId('drv');
  const now = Date.now();
  if (isDefault) {
    await c.env.DB.prepare(
      `UPDATE drives SET is_default = 0 WHERE owner_user_id = ?1`,
    )
      .bind(u.userId)
      .run();
  }
  await c.env.DB.prepare(
    `INSERT INTO drives (id, owner_user_id, name, description, is_default, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(id, u.userId, name, description ?? null, isDefault ? 1 : 0, now)
    .run();
  return c.json({ id, name, description: description ?? null, isDefault: !!isDefault });
}

async function getDefaultDrive(c: AppCtx) {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  let drive = await c.env.DB.prepare(
    `SELECT id, name, description, is_default FROM drives
     WHERE owner_user_id = ?1 AND is_default = 1 AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(u.userId)
    .first<{ id: string; name: string; description: string | null; is_default: number }>();
  if (!drive) {
    const id = newId('drv');
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO drives (id, owner_user_id, name, is_default, created_at, updated_at)
       VALUES (?1, ?2, 'My Drive', 1, ?3, ?3)`,
    )
      .bind(id, u.userId, now)
      .run();
    drive = { id, name: 'My Drive', description: null, is_default: 1 };
  }
  return c.json({
    id: drive.id,
    name: drive.name,
    description: drive.description,
    isDefault: true,
  });
}

async function getDrive(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const d = await c.env.DB.prepare(
    `SELECT id, name, description, is_default, created_at, updated_at FROM drives WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(driveId)
    .first();
  if (!d) return c.json(errBody('not_found', 'Drive not found'), 404);
  return c.json(d);
}

async function patchDrive(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const body = (await c.req.json().catch(() => null)) as { name?: string; description?: string; isDefault?: boolean } | null;
  if (!body) return c.json(errBody('invalid_request', 'body required'), 400);
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const sets: string[] = ['updated_at = ?1'];
  const binds: unknown[] = [Date.now()];
  let i = 2;
  if (body.name !== undefined) { sets.push(`name = ?${i}`); binds.push(body.name); i++; }
  if (body.description !== undefined) { sets.push(`description = ?${i}`); binds.push(body.description); i++; }
  if (body.isDefault === true) {
    await c.env.DB.prepare(`UPDATE drives SET is_default = 0 WHERE owner_user_id = ?1`).bind(u.userId).run();
    sets.push(`is_default = 1`);
  }
  binds.push(driveId);
  await c.env.DB.prepare(`UPDATE drives SET ${sets.join(', ')} WHERE id = ?${i}`).bind(...binds).run();
  return c.json({ id: driveId });
}

async function deleteDrive(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  await c.env.DB.prepare(
    `UPDATE drives SET deleted_at = ?1 WHERE id = ?2`,
  )
    .bind(Date.now(), driveId)
    .run();
  return c.json({ success: true });
}

// ------------ Drive files ------------
const StageUploadSchema = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  contentType: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  ifMatch: z.string().optional(),
  ifNoneMatch: z.string().optional(),
});

async function listDriveFiles(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const scope = c.get('driveScope');
  const url = new URL(c.req.url);
  const prefix = url.searchParams.get('prefix') ?? '';
  const cursor = url.searchParams.get('cursor');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 200);
  const effPrefix = scope.pathPrefix ?? prefix;
  const rows = await c.env.DB.prepare(
    `SELECT path, size, content_type, sha256, etag, modified_at, modified_by
     FROM drive_files WHERE drive_id = ?1 AND path LIKE ?2 ${cursor ? 'AND path > ?4' : ''}
     ORDER BY path ASC LIMIT ?3`,
  )
    .bind(driveId, `${effPrefix}%`, limit, ...(cursor ? [cursor] : []))
    .all();
  const files = rows.results ?? [];
  const nextCursor = files.length === limit ? (files[files.length - 1] as { path: string }).path : null;
  return c.json({ files, cursor: nextCursor });
}

async function stageDriveUpload(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const scope = c.get('driveScope');
  const body = await c.req.json().catch(() => null);
  const parsed = StageUploadSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const f = parsed.data;
  if (!checkPathScope(scope, f.path)) {
    return c.json(errBody('unauthorized', 'Path outside token scope'), 403);
  }
  const a = c.get('auth') as AuthCtx;
  if (a.kind === 'user') {
    const plan = await userPlan(c.env, a.userId);
    if (f.size > plan.maxFileDriveBytes) {
      return c.json(errBody('payload_too_large', `File exceeds plan max drive file size (${plan.maxFileDriveBytes} bytes)`), 413);
    }
  }

  // Concurrency preconditions
  if (f.ifMatch || f.ifNoneMatch) {
    const existing = await c.env.DB.prepare(
      `SELECT etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
    ).bind(driveId, f.path).first<{ etag: string }>();
    if (f.ifNoneMatch === '*' && existing) {
      return c.json(errBody('precondition_failed', 'File exists'), 412);
    }
    if (f.ifMatch && existing?.etag !== f.ifMatch) {
      return c.json(errBody('precondition_failed', 'ETag mismatch'), 412);
    }
  }

  const uploadId = newId('up');
  await c.env.DB.prepare(
    `INSERT INTO drive_uploads (id, drive_id, path, size, content_type, sha256, if_match, if_none_match, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(uploadId, driveId, f.path, f.size, f.contentType, f.sha256 ?? null, f.ifMatch ?? null, f.ifNoneMatch ?? null, Date.now())
    .run();

  // Where the client uploads to
  const r2Key = f.sha256 ? casKey(f.sha256) : `drive-pending/${driveId}/${uploadId}`;
  const origin = new URL(c.req.url).origin;
  // Hash-skip: if CAS object already exists, no upload needed
  let url: string | null = null;
  if (f.sha256) {
    const exists = await c.env.SITES.head(r2Key);
    if (!exists) {
      url = await uploadUrlFor(c.env, origin, r2Key, f.contentType);
    }
  } else {
    url = await uploadUrlFor(c.env, origin, r2Key, f.contentType);
  }

  return c.json({
    uploadId,
    method: url ? 'PUT' : null,
    url,
    headers: url ? { 'Content-Type': f.contentType } : null,
    skipped: !url,
    expiresInSeconds: 3600,
  });
}

async function finalizeDriveUpload(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const scope = c.get('driveScope');
  const body = (await c.req.json().catch(() => null)) as { uploadId?: string; path?: string } | null;
  if (!body?.uploadId) return c.json(errBody('invalid_request', 'uploadId required'), 400);
  const u = await c.env.DB.prepare(
    `SELECT id, path, size, content_type, sha256, if_match, if_none_match
     FROM drive_uploads WHERE id = ?1 AND drive_id = ?2`,
  )
    .bind(body.uploadId, driveId)
    .first<{ id: string; path: string; size: number; content_type: string; sha256: string | null; if_match: string | null; if_none_match: string | null }>();
  if (!u) return c.json(errBody('not_found', 'Upload not found'), 404);
  const targetPath = body.path ?? u.path;
  if (!checkPathScope(scope, targetPath)) {
    return c.json(errBody('unauthorized', 'Path outside token scope'), 403);
  }

  // Re-check preconditions
  const existing = await c.env.DB.prepare(
    `SELECT etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
  ).bind(driveId, targetPath).first<{ etag: string }>();
  if (u.if_none_match === '*' && existing) {
    return c.json(errBody('precondition_failed', 'File exists'), 412);
  }
  if (u.if_match && existing?.etag !== u.if_match) {
    return c.json(errBody('precondition_failed', 'ETag mismatch'), 412);
  }

  // Resolve final sha256
  let sha = u.sha256;
  if (!sha) {
    const srcKey = `drive-pending/${driveId}/${u.id}`;
    const obj = await c.env.SITES.get(srcKey);
    if (!obj) return c.json(errBody('precondition_failed', 'Missing upload'), 412);
    const bytes = await obj.arrayBuffer();
    sha = await sha256Hex(bytes);
    const dest = casKey(sha);
    if (!(await c.env.SITES.head(dest))) {
      await c.env.SITES.put(dest, bytes, { httpMetadata: { contentType: u.content_type } });
    }
    await c.env.SITES.delete(srcKey);
  } else {
    if (!(await c.env.SITES.head(casKey(sha)))) {
      return c.json(errBody('precondition_failed', 'Missing upload'), 412);
    }
  }

  const etag = sha;
  const now = Date.now();
  const a = c.get('auth') as AuthCtx;
  const modifiedBy = a.kind === 'user' ? a.userId : null;

  await c.env.DB.prepare(
    `INSERT INTO drive_files (drive_id, path, size, content_type, sha256, etag, modified_by, modified_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(drive_id, path) DO UPDATE SET
       size = ?3, content_type = ?4, sha256 = ?5, etag = ?6, modified_by = ?7, modified_at = ?8`,
  )
    .bind(driveId, targetPath, u.size, u.content_type, sha, etag, modifiedBy, now)
    .run();

  await c.env.DB.prepare(`DELETE FROM drive_uploads WHERE id = ?1`).bind(u.id).run();

  return c.json({
    file: { path: targetPath, size: u.size, contentType: u.content_type, sha256: sha, etag, modifiedAt: now },
  });
}

async function readDriveFile(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const scope = c.get('driveScope');
  const url = new URL(c.req.url);
  const prefix = `/api/v1/drives/${driveId}/files/`;
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!checkPathScope(scope, path)) {
    return c.json(errBody('unauthorized', 'Path outside token scope'), 403);
  }

  // ?versions=true → return the history log for this path (live + tombstones).
  if (url.searchParams.get('versions') === 'true') {
    const rows = await c.env.DB.prepare(
      `SELECT size, content_type, sha256, etag, modified_by, modified_at, op
       FROM drive_file_history WHERE drive_id = ?1 AND path = ?2
       ORDER BY modified_at DESC LIMIT 200`,
    ).bind(driveId, path).all();
    const live = await c.env.DB.prepare(
      `SELECT size, content_type, sha256, etag, modified_by, modified_at FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
    ).bind(driveId, path).first();
    return c.json({ live, history: rows.results ?? [] });
  }

  // ?at=<unix_ms> → serve the version that was live at that moment.
  // Compare against the union of live + history rows on modified_at.
  const atParam = url.searchParams.get('at');
  if (atParam) {
    const at = parseInt(atParam, 10);
    if (!Number.isFinite(at)) return c.json(errBody('invalid_request', 'at must be epoch ms'), 400);
    const live = await c.env.DB.prepare(
      `SELECT size, content_type, sha256, etag, modified_at FROM drive_files WHERE drive_id = ?1 AND path = ?2 AND modified_at <= ?3`,
    ).bind(driveId, path, at).first<{ size: number; content_type: string; sha256: string; etag: string; modified_at: number }>();
    const historyRow = await c.env.DB.prepare(
      `SELECT size, content_type, sha256, etag, modified_at, op FROM drive_file_history
       WHERE drive_id = ?1 AND path = ?2 AND modified_at <= ?3
       ORDER BY modified_at DESC LIMIT 1`,
    ).bind(driveId, path, at).first<{ size: number | null; content_type: string | null; sha256: string | null; etag: string | null; modified_at: number; op: string }>();
    // Pick whichever row has the greatest modified_at.
    const winner = !live ? historyRow
      : !historyRow ? live
      : (live.modified_at >= historyRow.modified_at ? live : historyRow);
    if (!winner) return c.json(errBody('not_found', 'No file at that timestamp'), 404);
    if (!winner.sha256) return c.json(errBody('not_found', 'File was deleted before that timestamp'), 404);
    return serveDriveBlob(c, {
      size: winner.size ?? 0,
      content_type: winner.content_type ?? 'application/octet-stream',
      sha256: winner.sha256,
      etag: winner.etag ?? winner.sha256,
      modified_at: winner.modified_at,
    });
  }

  const file = await c.env.DB.prepare(
    `SELECT path, size, content_type, sha256, etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
  )
    .bind(driveId, path)
    .first<{ path: string; size: number; content_type: string; sha256: string; etag: string }>();
  if (!file) return c.json(errBody('not_found', 'File not found'), 404);
  return serveDriveBlob(c, file);
}

async function serveDriveBlob(c: AppCtx, file: { size: number; content_type: string; sha256: string; etag: string; modified_at?: number }) {
  const obj = await c.env.SITES.get(casKey(file.sha256));
  if (!obj) return c.json(errBody('internal_error', 'Missing storage object'), 502);
  return new Response(obj.body, {
    headers: {
      'content-type': file.content_type,
      'content-length': String(file.size),
      etag: `"${file.etag}"`,
    },
  });
}

async function deleteDriveFile(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const scope = c.get('driveScope');
  const url = new URL(c.req.url);
  const prefix = `/api/v1/drives/${driveId}/files/`;
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!checkPathScope(scope, path)) {
    return c.json(errBody('unauthorized', 'Path outside token scope'), 403);
  }
  const recursive = url.searchParams.get('recursive') === 'true';
  if (recursive) {
    await c.env.DB.prepare(
      `DELETE FROM drive_files WHERE drive_id = ?1 AND (path = ?2 OR path LIKE ?3)`,
    )
      .bind(driveId, path, `${path}/%`)
      .run();
  } else {
    const ifMatch = c.req.header('if-match');
    if (ifMatch) {
      const file = await c.env.DB.prepare(
        `SELECT etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
      ).bind(driveId, path).first<{ etag: string }>();
      if (file && file.etag !== ifMatch) {
        return c.json(errBody('precondition_failed', 'ETag mismatch'), 412);
      }
    }
    await c.env.DB.prepare(
      `DELETE FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
    )
      .bind(driveId, path)
      .run();
  }
  return c.json({ success: true });
}

// ------------ Batch + move ------------
const BatchOpSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('put'),
    path: z.string().min(1).max(1024),
    uploadId: z.string().min(1).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    contentType: z.string().max(255).optional(),
    size: z.number().int().min(0).optional(),
    ifMatch: z.string().optional(),
    ifNoneMatch: z.string().optional(),
  }),
  z.object({
    type: z.literal('delete'),
    path: z.string().min(1).max(1024),
    recursive: z.boolean().optional(),
    ifMatch: z.string().optional(),
  }),
  z.object({
    type: z.literal('move'),
    from: z.string().min(1).max(1024),
    to: z.string().min(1).max(1024),
    ifMatch: z.string().optional(),
    overwriteIfMatch: z.string().optional(),
  }),
  z.object({
    type: z.literal('copy'),
    from: z.string().min(1).max(1024),
    to: z.string().min(1).max(1024),
    ifNoneMatch: z.string().optional(),
  }),
]);

const BatchSchema = z.object({
  baseVersionId: z.string().optional(),
  ops: z.array(BatchOpSchema).min(1).max(500),
});

async function batchDriveFiles(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const scope = c.get('driveScope');
  const body = await c.req.json().catch(() => null);
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);

  const a = c.get('auth') as AuthCtx;
  const modifiedBy = a.kind === 'user' ? a.userId : null;
  const now = Date.now();
  const results: Array<Record<string, unknown>> = [];

  // Resolve the drive owner once; history rows need owner_user_id for
  // per-plan retention pruning in the cleanup cron.
  const ownerRow = await c.env.DB.prepare(`SELECT owner_user_id FROM drives WHERE id = ?1`).bind(driveId).first<{ owner_user_id: string }>();
  const ownerId = ownerRow?.owner_user_id ?? '';

  for (const op of parsed.data.ops) {
    if ('path' in op && !checkPathScope(scope, op.path)) {
      results.push({ op: op.type, path: (op as { path: string }).path, error: 'path outside scope' });
      continue;
    }
    if (op.type === 'move' || op.type === 'copy') {
      if (!checkPathScope(scope, op.from) || !checkPathScope(scope, op.to)) {
        results.push({ op: op.type, error: 'path outside scope' });
        continue;
      }
    }

    try {
      if (op.type === 'put') {
        results.push(await applyPut(c.env, driveId, ownerId, op, modifiedBy, now));
      } else if (op.type === 'delete') {
        results.push(await applyDelete(c.env, driveId, ownerId, op, modifiedBy, now));
      } else if (op.type === 'move') {
        results.push(await applyMove(c.env, driveId, ownerId, op, modifiedBy, now));
      } else if (op.type === 'copy') {
        results.push(await applyCopy(c.env, driveId, ownerId, op, modifiedBy, now));
      }
    } catch (e) {
      results.push({ op: op.type, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({ results });
}

// Snapshot the current state of a (drive, path) into history before it changes.
// History rows carry the *prior* version's modified_at — that's when that
// version was the live one. A point-in-time query at time T returns the row
// with the largest modified_at ≤ T. For deletes/moves, additionally insert a
// tombstone at `now` so queries after the delete return 404.
async function snapshotPrior(
  env: Env,
  driveId: string,
  ownerId: string,
  path: string,
  op: string,
  now: number,
  modifiedBy: string | null,
  opts: { tombstone?: boolean } = {},
) {
  const prev = await env.DB.prepare(
    `SELECT size, content_type, sha256, etag, modified_at FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
  ).bind(driveId, path).first<{ size: number; content_type: string; sha256: string; etag: string; modified_at: number }>();
  if (prev) {
    await env.DB.prepare(
      `INSERT INTO drive_file_history (drive_id, owner_user_id, path, size, content_type, sha256, etag, modified_by, modified_at, op)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(driveId, ownerId, path, prev.size, prev.content_type, prev.sha256, prev.etag, modifiedBy, prev.modified_at, op).run();
  }
  if (opts.tombstone) {
    await env.DB.prepare(
      `INSERT INTO drive_file_history (drive_id, owner_user_id, path, size, content_type, sha256, etag, modified_by, modified_at, op)
       VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, ?4, ?5, 'tombstone')`,
    ).bind(driveId, ownerId, path, modifiedBy, now).run();
  }
}

async function applyPut(env: Env, driveId: string, ownerId: string, op: { path: string; uploadId?: string; sha256?: string; contentType?: string; size?: number; ifMatch?: string; ifNoneMatch?: string }, modifiedBy: string | null, now: number) {
  const existing = await env.DB.prepare(
    `SELECT etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
  ).bind(driveId, op.path).first<{ etag: string }>();
  if (op.ifNoneMatch === '*' && existing) throw new Error('exists');
  if (op.ifMatch && existing?.etag !== op.ifMatch) throw new Error('etag mismatch');

  let sha = op.sha256;
  let contentType = op.contentType;
  let size = op.size;
  if (op.uploadId) {
    const u = await env.DB.prepare(
      `SELECT path, size, content_type, sha256 FROM drive_uploads WHERE id = ?1 AND drive_id = ?2`,
    ).bind(op.uploadId, driveId).first<{ path: string; size: number; content_type: string; sha256: string | null }>();
    if (!u) throw new Error('upload not found');
    sha = sha ?? u.sha256 ?? undefined;
    contentType = contentType ?? u.content_type;
    size = size ?? u.size;
    if (!sha) {
      const srcKey = `drive-pending/${driveId}/${op.uploadId}`;
      const obj = await env.SITES.get(srcKey);
      if (!obj) throw new Error('missing upload bytes');
      const bytes = await obj.arrayBuffer();
      sha = await sha256Hex(bytes);
      const dest = casKey(sha);
      if (!(await env.SITES.head(dest))) {
        await env.SITES.put(dest, bytes, { httpMetadata: { contentType } });
      }
      await env.SITES.delete(srcKey);
    }
    await env.DB.prepare(`DELETE FROM drive_uploads WHERE id = ?1`).bind(op.uploadId).run();
  }
  if (!sha) throw new Error('sha256 required (provide directly or via uploadId)');
  if (!(await env.SITES.head(casKey(sha)))) throw new Error('storage object missing');

  await snapshotPrior(env, driveId, ownerId, op.path, 'put', now, modifiedBy);
  await env.DB.prepare(
    `INSERT INTO drive_files (drive_id, path, size, content_type, sha256, etag, modified_by, modified_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)
     ON CONFLICT(drive_id, path) DO UPDATE SET
       size = ?3, content_type = ?4, sha256 = ?5, etag = ?5, modified_by = ?6, modified_at = ?7`,
  ).bind(driveId, op.path, size ?? 0, contentType ?? 'application/octet-stream', sha, modifiedBy, now).run();
  return { op: 'put', path: op.path, etag: sha };
}

async function applyDelete(env: Env, driveId: string, ownerId: string, op: { path: string; recursive?: boolean; ifMatch?: string }, modifiedBy: string | null, now: number) {
  if (op.ifMatch) {
    const file = await env.DB.prepare(`SELECT etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`).bind(driveId, op.path).first<{ etag: string }>();
    if (!file || file.etag !== op.ifMatch) throw new Error('etag mismatch');
  }
  if (op.recursive) {
    // Snapshot every doomed path before bulk delete.
    const doomed = await env.DB.prepare(
      `SELECT path FROM drive_files WHERE drive_id = ?1 AND (path = ?2 OR path LIKE ?3)`,
    ).bind(driveId, op.path, `${op.path}/%`).all<{ path: string }>();
    for (const r of doomed.results ?? []) {
      await snapshotPrior(env, driveId, ownerId, r.path, 'delete', now, modifiedBy, { tombstone: true });
    }
    await env.DB.prepare(`DELETE FROM drive_files WHERE drive_id = ?1 AND (path = ?2 OR path LIKE ?3)`)
      .bind(driveId, op.path, `${op.path}/%`).run();
  } else {
    await snapshotPrior(env, driveId, ownerId, op.path, 'delete', now, modifiedBy, { tombstone: true });
    await env.DB.prepare(`DELETE FROM drive_files WHERE drive_id = ?1 AND path = ?2`).bind(driveId, op.path).run();
  }
  return { op: 'delete', path: op.path };
}

async function applyMove(env: Env, driveId: string, ownerId: string, op: { from: string; to: string; ifMatch?: string; overwriteIfMatch?: string }, modifiedBy: string | null, now: number) {
  const src = await env.DB.prepare(
    `SELECT size, content_type, sha256, etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
  ).bind(driveId, op.from).first<{ size: number; content_type: string; sha256: string; etag: string }>();
  if (!src) throw new Error('source not found');
  if (op.ifMatch && src.etag !== op.ifMatch) throw new Error('source etag mismatch');
  const dst = await env.DB.prepare(`SELECT etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`).bind(driveId, op.to).first<{ etag: string }>();
  if (dst && !op.overwriteIfMatch) throw new Error('destination exists');
  if (dst && op.overwriteIfMatch && dst.etag !== op.overwriteIfMatch) throw new Error('destination etag mismatch');

  await snapshotPrior(env, driveId, ownerId, op.from, 'move_out', now, modifiedBy, { tombstone: true });
  if (dst) await snapshotPrior(env, driveId, ownerId, op.to, 'move_in', now, modifiedBy);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO drive_files (drive_id, path, size, content_type, sha256, etag, modified_by, modified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)
       ON CONFLICT(drive_id, path) DO UPDATE SET
         size = ?3, content_type = ?4, sha256 = ?5, etag = ?5, modified_by = ?6, modified_at = ?7`,
    ).bind(driveId, op.to, src.size, src.content_type, src.sha256, modifiedBy, now),
    env.DB.prepare(`DELETE FROM drive_files WHERE drive_id = ?1 AND path = ?2`).bind(driveId, op.from),
  ]);
  return { op: 'move', from: op.from, to: op.to, etag: src.etag };
}

async function applyCopy(env: Env, driveId: string, ownerId: string, op: { from: string; to: string; ifNoneMatch?: string }, modifiedBy: string | null, now: number) {
  const src = await env.DB.prepare(
    `SELECT size, content_type, sha256, etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`,
  ).bind(driveId, op.from).first<{ size: number; content_type: string; sha256: string; etag: string }>();
  if (!src) throw new Error('source not found');
  const dst = await env.DB.prepare(`SELECT etag FROM drive_files WHERE drive_id = ?1 AND path = ?2`).bind(driveId, op.to).first<{ etag: string }>();
  if (op.ifNoneMatch === '*' && dst) throw new Error('destination exists');

  if (dst) await snapshotPrior(env, driveId, ownerId, op.to, 'copy_in', now, modifiedBy);
  await env.DB.prepare(
    `INSERT INTO drive_files (drive_id, path, size, content_type, sha256, etag, modified_by, modified_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)
     ON CONFLICT(drive_id, path) DO UPDATE SET
       size = ?3, content_type = ?4, sha256 = ?5, etag = ?5, modified_by = ?6, modified_at = ?7`,
  ).bind(driveId, op.to, src.size, src.content_type, src.sha256, modifiedBy, now).run();
  return { op: 'copy', from: op.from, to: op.to, etag: src.etag };
}

const MoveSchema = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
  ifMatch: z.string().optional(),
  overwriteIfMatch: z.string().optional(),
});

async function moveDriveFile(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const scope = c.get('driveScope');
  const body = await c.req.json().catch(() => null);
  const parsed = MoveSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  if (!checkPathScope(scope, parsed.data.from) || !checkPathScope(scope, parsed.data.to)) {
    return c.json(errBody('unauthorized', 'Path outside token scope'), 403);
  }
  const a = c.get('auth') as AuthCtx;
  const modifiedBy = a.kind === 'user' ? a.userId : null;
  const owner = await c.env.DB.prepare(`SELECT owner_user_id FROM drives WHERE id = ?1`).bind(driveId).first<{ owner_user_id: string }>();
  try {
    const result = await applyMove(c.env, driveId, owner?.owner_user_id ?? '', parsed.data, modifiedBy, Date.now());
    return c.json({ file: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes('not found') ? 404 : msg.includes('etag') ? 412 : 409;
    return c.json(errBody('conflict', msg), status);
  }
}

// ------------ Tokens ------------
const TokenCreateSchema = z.object({
  perms: z.enum(['read', 'write']).optional(),
  manageTokens: z.boolean().optional(),
  pathPrefix: z.string().max(1024).optional(),
  ttl: z.number().int().positive().optional(),
  label: z.string().max(120).optional(),
});

async function listDriveTokens(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const rows = await c.env.DB.prepare(
    `SELECT id, prefix, perms, path_prefix, label, expires_at, revoked_at, created_at
     FROM drive_tokens WHERE drive_id = ?1 ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(driveId)
    .all();
  return c.json({ tokens: rows.results ?? [] });
}

async function createDriveToken(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const parsed = TokenCreateSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const t = parsed.data;
  const token = `sld_${newToken(28)}`;
  const tokenHash = await sha256Hex(token);
  const id = newId('tok');
  const expiresAt = t.ttl ? Date.now() + t.ttl * 1000 : null;
  await c.env.DB.prepare(
    `INSERT INTO drive_tokens (id, drive_id, owner_user_id, token_hash, prefix, perms, path_prefix, manage_tokens, label, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      driveId,
      u.userId,
      tokenHash,
      token.slice(0, 12),
      t.perms ?? 'read',
      t.pathPrefix ?? null,
      t.manageTokens ? 1 : 0,
      t.label ?? null,
      expiresAt,
      Date.now(),
    )
    .run();
  return c.json({
    id,
    token,
    perms: t.perms ?? 'read',
    pathPrefix: t.pathPrefix ?? null,
    expiresAt,
    warning: 'Save this token now. It is shown only once.',
  });
}

async function revokeDriveToken(c: AppCtx) {
  const driveId = c.req.param('driveId')!;
  const tokenId = c.req.param('tokenId')!;
  const res = await c.env.DB.prepare(
    `UPDATE drive_tokens SET revoked_at = ?1 WHERE id = ?2 AND drive_id = ?3 AND revoked_at IS NULL`,
  ).bind(Date.now(), tokenId, driveId).run();
  if ((res.meta.changes ?? 0) === 0) {
    return c.json(errBody('not_found', 'Token not found or already revoked'), 404);
  }
  return c.json({ success: true, id: tokenId });
}

