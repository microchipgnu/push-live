import type { Env } from '../types.ts';
import type { App } from './types.ts';
import { analyticsApp } from './analytics.ts';

// One line per app. Order doesn't matter; the path's <id> segment picks
// the handler.
const APPS: Record<string, App> = {
  [analyticsApp.id]: analyticsApp,
};

export function appIds(): string[] {
  return Object.keys(APPS);
}

// Dispatch a /__pl/<app>/<rest> request to the matching app. Returns null
// when the path doesn't look like an app route so the caller can fall
// through to normal file serving.
export async function dispatchApp(
  env: Env,
  slug: string,
  ownerUserId: string | null,
  pathname: string,
  req: Request,
): Promise<Response | null> {
  const m = /^\/__pl\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const [, id, rest] = m;
  const app = APPS[id];
  if (!app) {
    return jsonError('not_found', `App "${id}" is not available. Known apps: ${appIds().join(', ') || '(none)'}.`, 404);
  }
  return app.handle({ env, slug, ownerUserId, subPath: rest ?? '/', req });
}

export function jsonError(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message, code, message, docs_url: `/docs#apps` }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}
