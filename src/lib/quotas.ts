import type { Env } from '../types.ts';
import { errBody } from './auth.ts';

export type Plan = {
  name: string;
  maxStorageBytes: number;
  maxSites: number;            // Infinity = unlimited
  maxDrives: number;
  maxCustomDomains: number;
  maxFileSiteBytes: number;
  maxFileDriveBytes: number;
  driveHistoryDays: number;
  publishesPerHour: number;
};

export const PLANS: Record<string, Plan> = {
  anonymous: {
    name: 'anonymous',
    maxStorageBytes: 0,                             // anonymous is temporary; no permanent quota
    maxSites: 0,
    maxDrives: 0,
    maxCustomDomains: 0,
    maxFileSiteBytes: 250 * 1024 * 1024,
    maxFileDriveBytes: 0,
    driveHistoryDays: 0,
    publishesPerHour: 60,
  },
  free: {
    name: 'free',
    maxStorageBytes: 10 * 1024 ** 3,
    maxSites: 500,
    maxDrives: 1,
    maxCustomDomains: 1,
    maxFileSiteBytes: 500 * 1024 * 1024,
    maxFileDriveBytes: 500 * 1024 * 1024,
    driveHistoryDays: 7,
    publishesPerHour: 60,
  },
  hobby: {
    name: 'hobby',
    maxStorageBytes: 500 * 1024 ** 3,
    maxSites: 1000,
    maxDrives: 5,
    maxCustomDomains: 5,
    maxFileSiteBytes: 2 * 1024 ** 3,
    maxFileDriveBytes: 500 * 1024 * 1024,
    driveHistoryDays: 30,
    publishesPerHour: 200,
  },
  developer: {
    name: 'developer',
    maxStorageBytes: 2 * 1024 ** 4,
    maxSites: Number.POSITIVE_INFINITY,
    maxDrives: 10,
    maxCustomDomains: 20,
    maxFileSiteBytes: 2 * 1024 ** 3,
    maxFileDriveBytes: 500 * 1024 * 1024,
    driveHistoryDays: 90,
    publishesPerHour: 200,
  },
};

export function planFor(name: string | null | undefined): Plan {
  return PLANS[name ?? 'free'] ?? PLANS.free;
}

export async function userPlan(env: Env, userId: string): Promise<Plan> {
  const row = await env.DB.prepare('SELECT plan FROM users WHERE id = ?1').bind(userId).first<{ plan: string }>();
  return planFor(row?.plan);
}

/**
 * Sliding-window publish rate limit using KV with second-resolution buckets.
 * Returns the seconds the caller must wait before retrying, or 0 if OK.
 */
export async function checkPublishRate(env: Env, key: string, perHour: number): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 3600;
  const kvKey = `rl:publish:${key}`;
  const raw = await env.KV.get(kvKey);
  let stamps: number[] = [];
  if (raw) {
    try { stamps = JSON.parse(raw) as number[]; } catch { stamps = []; }
  }
  stamps = stamps.filter((t) => t > windowStart);
  if (stamps.length >= perHour) {
    return Math.max(1, (stamps[0] + 3600) - now);
  }
  stamps.push(now);
  await env.KV.put(kvKey, JSON.stringify(stamps), { expirationTtl: 3700 });
  return 0;
}

export function rateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify(errBody('rate_limit_exceeded', 'Publish rate exceeded', { retry_after: retryAfter })),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
    },
  );
}

export async function siteCount(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sites WHERE owner_user_id = ?1 AND status != 'deleted'`,
  ).bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function driveCount(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM drives WHERE owner_user_id = ?1 AND deleted_at IS NULL`,
  ).bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function totalStorageBytes(env: Env, userId: string): Promise<number> {
  // Sum of unique CAS objects owned by user's live sites + drive files.
  // Approximation: sum site_files for current versions + drive_files. Not de-duped
  // across users, but that's fine for per-user quota accounting.
  const a = await env.DB.prepare(
    `SELECT COALESCE(SUM(sf.size), 0) AS n
     FROM sites s JOIN site_files sf ON sf.version_id = s.current_version_id
     WHERE s.owner_user_id = ?1 AND s.status != 'deleted'`,
  ).bind(userId).first<{ n: number }>();
  const b = await env.DB.prepare(
    `SELECT COALESCE(SUM(df.size), 0) AS n
     FROM drives d JOIN drive_files df ON df.drive_id = d.id
     WHERE d.owner_user_id = ?1 AND d.deleted_at IS NULL`,
  ).bind(userId).first<{ n: number }>();
  return (a?.n ?? 0) + (b?.n ?? 0);
}
