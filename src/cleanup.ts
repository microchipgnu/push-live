import type { Env } from './types.ts';
import { PLANS, planFor } from './lib/quotas.ts';

// Time budgets used by the scheduled handler.
const STALE_UPLOAD_AGE_MS = 60 * 60 * 1000;        // 1h
const EXPIRED_BATCH_SIZE = 200;                     // per scheduled tick
const STALE_PENDING_R2_AGE_MS = 24 * 60 * 60 * 1000; // 24h for unreferenced pending/
const CAS_GC_GRACE_MS = 60 * 60 * 1000;            // don't GC CAS objects uploaded in last hour
const CAS_GC_PAGE_SIZE = 500;                       // R2 list per tick
const CAS_CURSOR_KV_KEY = 'cleanup:cas:cursor';

export type CleanupReport = {
  expiredSites: number;
  expiredVersions: number;
  staleUploads: number;
  prunedR2Objects: number;
  casScanned: number;
  casOrphansPruned: number;
  prunedHistory: number;
};

export async function runCleanup(env: Env): Promise<CleanupReport> {
  const now = Date.now();
  const report: CleanupReport = {
    expiredSites: 0,
    expiredVersions: 0,
    staleUploads: 0,
    prunedR2Objects: 0,
    casScanned: 0,
    casOrphansPruned: 0,
    prunedHistory: 0,
  };

  // 1) Mark expired anonymous (or TTL'd) sites as deleted.
  const expired = await env.DB.prepare(
    `SELECT slug, current_version_id FROM sites
     WHERE expires_at IS NOT NULL AND expires_at < ?1 AND status != 'deleted'
     LIMIT ?2`,
  ).bind(now, EXPIRED_BATCH_SIZE).all<{ slug: string; current_version_id: string | null }>();

  for (const s of expired.results ?? []) {
    await env.DB.prepare(`UPDATE sites SET status = 'deleted' WHERE slug = ?1`).bind(s.slug).run();
    await env.KV.delete(`site:${s.slug}:version`);
    report.expiredSites++;
  }

  // 2) Mark site_versions for deleted sites as superseded (frees space when R2 pruned later).
  const versionsRes = await env.DB.prepare(
    `UPDATE site_versions SET status = 'superseded'
     WHERE status = 'pending' AND created_at < ?1`,
  ).bind(now - STALE_UPLOAD_AGE_MS).run();
  report.expiredVersions = versionsRes.meta.changes ?? 0;

  // 3) Drop stale drive_uploads (their presigned URL/ticket has expired anyway).
  const uploadsRes = await env.DB.prepare(
    `DELETE FROM drive_uploads WHERE created_at < ?1`,
  ).bind(now - STALE_UPLOAD_AGE_MS).run();
  report.staleUploads = uploadsRes.meta.changes ?? 0;

  // 4) Best-effort R2 prune for unreferenced pending/ keys.
  //    Listing R2 by prefix is bounded by truncate=1000 so we do at most one
  //    page per tick to stay well under the 30s scheduled budget.
  try {
    const listing = await env.SITES.list({ prefix: 'pending/', limit: 1000 });
    for (const obj of listing.objects) {
      const versionId = obj.key.split('/')[1];
      if (!versionId) continue;
      const ver = await env.DB.prepare(
        `SELECT status FROM site_versions WHERE id = ?1`,
      ).bind(versionId).first<{ status: string }>();
      const tooOld = obj.uploaded ? obj.uploaded.getTime() < now - STALE_PENDING_R2_AGE_MS : true;
      if (!ver || ver.status === 'live' || ver.status === 'superseded' || tooOld) {
        await env.SITES.delete(obj.key);
        report.prunedR2Objects++;
      }
    }
  } catch (e) {
    console.error('[cleanup] r2 pending prune failed', e);
  }

  // 5) CAS garbage collection. Walks one page of cas/ per tick (cursor in KV)
  //    and deletes objects with no live references AND outside the grace
  //    window. Refs come from current site_files + drive_files rows.
  try {
    const cursor = (await env.KV.get(CAS_CURSOR_KV_KEY)) ?? undefined;
    const listing = await env.SITES.list({ prefix: 'cas/', limit: CAS_GC_PAGE_SIZE, cursor });

    // Filter out objects within the grace window upfront.
    const candidates = listing.objects.filter(
      (o) => !o.uploaded || o.uploaded.getTime() < now - CAS_GC_GRACE_MS,
    );
    report.casScanned = candidates.length;

    if (candidates.length > 0) {
      const shas = candidates.map((o) => extractSha(o.key)).filter((s): s is string => !!s);
      // Resolve which sha256s are still referenced.
      const referenced = new Set<string>();
      const CHUNK = 100;  // keep IN-list well under D1's parameter cap
      for (let i = 0; i < shas.length; i += CHUNK) {
        const slice = shas.slice(i, i + CHUNK);
        const placeholders = slice.map((_, idx) => `?${idx + 1}`).join(',');
        const a = await env.DB.prepare(
          `SELECT DISTINCT sha256 FROM site_files WHERE sha256 IN (${placeholders})`,
        ).bind(...slice).all<{ sha256: string }>();
        for (const r of a.results ?? []) referenced.add(r.sha256);
        const b = await env.DB.prepare(
          `SELECT DISTINCT sha256 FROM drive_files WHERE sha256 IN (${placeholders})`,
        ).bind(...slice).all<{ sha256: string }>();
        for (const r of b.results ?? []) referenced.add(r.sha256);
      }

      for (const obj of candidates) {
        const sha = extractSha(obj.key);
        if (!sha || referenced.has(sha)) continue;
        await env.SITES.delete(obj.key);
        report.casOrphansPruned++;
      }
    }

    // Advance the cursor or reset when we've finished a full pass.
    if (listing.truncated && listing.cursor) {
      await env.KV.put(CAS_CURSOR_KV_KEY, listing.cursor, { expirationTtl: 7 * 24 * 3600 });
    } else {
      await env.KV.delete(CAS_CURSOR_KV_KEY);
    }
  } catch (e) {
    console.error('[cleanup] cas gc failed', e);
  }

  // 6) Prune drive_file_history rows past per-plan retention.
  try {
    const userPlans = await env.DB.prepare(`SELECT id, plan FROM users`).all<{ id: string; plan: string }>();
    for (const u of userPlans.results ?? []) {
      const days = planFor(u.plan).driveHistoryDays;
      if (!days) continue;
      const cutoff = now - days * 24 * 60 * 60 * 1000;
      const res = await env.DB.prepare(
        `DELETE FROM drive_file_history WHERE owner_user_id = ?1 AND modified_at < ?2`,
      ).bind(u.id, cutoff).run();
      report.prunedHistory += res.meta.changes ?? 0;
    }
  } catch (e) {
    console.error('[cleanup] history prune failed', e);
  }
  void PLANS; // silence unused-import warning on stripped builds

  return report;
}

function extractSha(key: string): string | null {
  // cas/<2-byte prefix>/<sha256>
  const parts = key.split('/');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'cas') return null;
  if (!/^[0-9a-f]{64}$/.test(parts[2])) return null;
  return parts[2];
}
