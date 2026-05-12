# sloop — codebase orientation

Static hosting + private file storage for agents, running entirely on Cloudflare Workers + R2 + D1 + KV. Source-available, written from scratch.

## Runtime stack

- **Cloudflare Workers** (Hono router) — entry: `src/index.ts`
- **R2** (`SITES` binding) — content-addressed blob store; key shape `cas/<2-byte prefix>/<sha256>`
- **D1** (`DB` binding) — metadata: users, sites, versions, files, drives, history, tokens, domains, handles, links, variables
- **KV** (`KV` binding) — hot lookups (slug→version), sign-in codes, rate-limit windows, payment sessions, link cache, CAS-GC cursor
- **Cloudflare Email Sending** (`EMAIL` binding) — preferred outbound transport; MailChannels / Resend / console fallback in that order
- **Cloudflare for SaaS** — custom-hostname provisioning when `CLOUDFLARE_API_TOKEN` is set

## Code layout

```
src/
  index.ts              entry, fetch + scheduled handlers, host-based dispatcher
  serve.ts              serves static sites: KV→D1 version resolve, password+payment gates, SPA mode, proxy passthrough, fork-button injection
  proxy.ts              .sloop/proxy.json → upstream fetch with ${VAR} interpolation
  cleanup.ts            scheduled job: expired anon sites, stale uploads, pending/ prune, CAS GC, history retention
  types.ts              Env interface
  routes/
    auth.ts             email-code → API key (IP-rate-limited)
    sites.ts            publish/finalize/refresh/claim/metadata/duplicate/from-drive
    drives.ts           CRUD + batch ops (put|delete|move|copy) + tokens + history read API
    account.ts          wallet, variables (encrypted), handles, domains (+ CF for SaaS), links, support
    pay.ts              402 flow: session → poll → grant; on-chain verify via chain-verify.ts
    pages.ts            /signin /claim /dashboard + CSRF on POSTs (browser surface)
    discovery.ts        /openapi.json, /llms.txt, /.well-known/*, /sitemap.xml, /robots.txt
  lib/
    auth.ts             Bearer middleware
    hash.ts             sha256, hmac, casKey helper
    ids.ts              slug / ULID generators
    session.ts          signed-cookie sessions for browser
    crypto.ts           AES-GCM for variables at rest
    quotas.ts           PLANS table + rate-limit + usage helpers
    r2-presign.ts       SigV4 presigned PUTs + worker-direct fallback ticket
    upload-ticket.ts    HMAC ticket for /__upload route
    cf-saas.ts          Cloudflare custom-hostnames API
    chain-verify.ts     EVM Transfer event verification (USDC/USDT/native)
    email.ts            transport cascade
    log.ts              structured request log
  ui/layout.ts          shell + base CSS for /signin /dashboard /claim /pricing /docs
  cli/sloop.ts        bun CLI: login / publish / list / delete / drive {...}
migrations/             0001 init, 0002 drives, 0003 routing, 0004 SaaS, 0005 history
scripts/smoke.sh        end-to-end harness (29+ scenarios), runs against `wrangler dev --local`
.github/workflows/      deploy on push to main, PR checks
```

## Key invariants

- **Content addressing**: every blob lives at `cas/<sha256>`. Sites + drives reference the sha. Hash-skip dedup at publish time; CAS GC reclaims unreferenced after a grace window.
- **Pending uploads**: stage → presigned/__upload → finalize. Pending versions live at `pending/<versionId>/<path>`; finalize promotes to CAS by re-hashing if the client didn't supply a hash.
- **Drive history**: every mutation snapshots the prior state at `prev.modified_at`. Tombstones inserted on delete/move-out. `GET /drives/:id/files/:path?at=<ms>` picks max(modified_at ≤ at) across live + history.
- **Auth modes**: anonymous (24h, IP-bucketed rate limit), API key (Bearer), drive share token (Bearer, scoped to a drive + optional path prefix).
- **CSRF**: scoped to `/signin /claim /dashboard/* /signout` (Origin/Referer must match Host). API routes use Bearer tokens, no CSRF needed.

## Local dev

```bash
bun install
bun run db:local                 # apply migrations
bun run dev                      # wrangler dev --local on :8787
bun run smoke                    # end-to-end harness
bun run typecheck
bun run cli -- whoami            # CLI against CLONEHN_HOST env var
```

The smoke harness wipes `.wrangler/state` first so each run is reproducible. Wrangler v4 wires the `EMAIL` binding even in local mode; the auth handler surfaces `devCode` in the response when the request comes from `127.0.0.1`/`localhost`.

## Deploy

See `DEPLOY.md`. GitHub Actions handles it end-to-end on push to `main`.

## Don't change without thinking

- The `cas/` key shape (used in two places, plus the cleanup GC parser)
- The drive history `modified_at` semantics (prior version's timestamp, not the snapshot recording time — the bug that ate one full cron tick)
- Hono router order in `drives.ts` — concrete routes (`/uploads`, `/finalize`, `/move`) must be registered before the `/files/*` wildcard
