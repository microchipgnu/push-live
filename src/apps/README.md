# Apps

Server-side capabilities that hosted sites can call from their own JS.
Each app lives in one file under this directory and is wired up in
`registry.ts`.

The endpoint shape is always `/__pl/<app-id>/<sub-path>` on the site's
own host (slug subdomain or custom domain). The dispatcher strips
`/__pl/<id>/` and hands the rest to the app.

## Adding a new app

1. Create `src/apps/<id>.ts` exporting an `App`:
   ```ts
   import type { App } from './types.ts';

   export const fooApp: App = {
     id: 'foo',
     async handle({ env, slug, ownerUserId, subPath, req }) {
       if (req.method === 'POST' && subPath === '/bar') { /* ... */ }
       return new Response('not found', { status: 404 });
     },
   };
   ```
2. Register it in `src/apps/registry.ts` (one line).
3. If the app needs storage, add a `migrations/000N_apps_<id>.sql`.
4. If the app meters usage, add a quota field to `src/lib/quotas.ts`
   and enforce it inside the handler.
5. Document it in `src/routes/discovery.ts` (`/docs` + `/llms-full.txt`).

## Conventions

- **Auth.** Apps run on slug subdomains, so the caller is the site
  itself (anonymous from push-live's perspective). For owner-only
  operations (reading aggregated data), expose a separate
  `/api/v1/publish/:slug/<app>/...` route in `src/routes/sites.ts` that
  uses the existing bearer middleware. Don't try to authenticate the
  visitor inside an app.
- **Origin check.** Public write endpoints should verify `Origin`
  matches the request host so other sites can't post to your meter.
- **Rate limits.** Use a KV-backed sliding window keyed by IP + slug.
  See `analytics.ts` for the pattern.
- **Quotas.** Quota field name lives in `src/lib/quotas.ts`. Treat
  over-quota as a soft drop (return 204) so abusive callers can't probe
  whether they're rate-limited or quota-blocked.
- **Privacy.** Never store raw IP or User-Agent. Hash with a daily salt
  so visitor IDs are stable within a day and unlinkable across days.
