import type { Env } from '../types.ts';

// An "app" is a server-side capability that hosted sites can call from their
// own JS. Each one lives in src/apps/<name>.ts, exports an `App`, and is
// registered in src/apps/registry.ts.
//
// The shape is intentionally small: a single async handler that gets the
// site identity (slug + optional owner) and the request. The dispatcher in
// src/apps/registry.ts strips the /__pl/<id>/ prefix before calling.
export type App = {
  id: string;
  handle(ctx: AppContext): Promise<Response>;
};

export type AppContext = {
  env: Env;
  slug: string;
  ownerUserId: string | null;
  // Path within the app, e.g. "/hit". Always starts with "/".
  subPath: string;
  req: Request;
};

// Per-site app enablement. `apps_disabled` is stored as a JSON array of
// app ids on the sites table; NULL means use defaults (analytics on,
// nothing else). Anonymous sites bypass apps entirely.
export function parseDisabledApps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
  } catch { /* fall through */ }
  return [];
}

export function isAppEnabled(appsDisabled: string | null | undefined, appId: string): boolean {
  return !parseDisabledApps(appsDisabled).includes(appId);
}
