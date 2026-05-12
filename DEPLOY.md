# Deploying sloop

End-to-end Cloudflare deploy from a fresh repo. ~15 minutes if you already have a Cloudflare account.

## 0. Prereqs

- Cloudflare account (paid Workers plan recommended — `EMAIL` binding requires it)
- A domain pointed at Cloudflare DNS (used as the apex for `<slug>.<apex>` site URLs)
- `bun` installed locally
- A Cloudflare API token with: Workers Scripts (Edit), Workers KV (Edit), D1 (Edit), R2 (Edit), Custom Hostnames (Edit), Email Sending (Edit), DNS (Edit), Account Settings (Read)

## 1. Create Cloudflare resources

```bash
bunx wrangler login
bunx wrangler d1 create sloop-db          # → copy database_id
bunx wrangler kv namespace create KV         # → copy id
bunx wrangler r2 bucket create sloop-sites
```

Edit `wrangler.toml`:

- `[vars] PUBLIC_APEX_HOST` → your apex (e.g. `sloop.wtf`)
- `[vars] R2_ACCOUNT_ID` → your account id
- `[[d1_databases]] database_id` → the id from above
- `[[kv_namespaces]] id` → the id from above
- `[vars] SIGNING_KEY` → **rotate this**: `openssl rand -hex 32`

## 2. Configure secrets

```bash
# Required for production R2 presigning (skip for worker-direct fallback)
bunx wrangler secret put R2_ACCESS_KEY_ID
bunx wrangler secret put R2_SECRET_ACCESS_KEY

# For custom hostnames via Cloudflare for SaaS
bunx wrangler secret put CLOUDFLARE_API_TOKEN
bunx wrangler secret put CLOUDFLARE_ACCOUNT_ID

# Optional email fallback if EMAIL binding isn't set or fails
bunx wrangler secret put MAILCHANNELS_API_KEY    # or
bunx wrangler secret put RESEND_API_KEY
bunx wrangler secret put EMAIL_FROM              # "sloop <noreply@your.dom>"

# Required ONLY for paid sites with on-chain verification
bunx wrangler secret put TEMPO_RPC_URL
bunx wrangler secret put TEMPO_USDC_CONTRACT
bunx wrangler secret put TEMPO_USDC_DECIMALS     # default "6"
```

## 3. Verify email sender domain

Cloudflare Email Sending requires the sender domain (`EMAIL_FROM` or default `noreply@<apex>`) to be verified in the dashboard. Follow the prompts under **Email Sending → Verified addresses**.

## 4. Wildcard DNS for `<slug>.<apex>`

In the Cloudflare dashboard for your zone:

1. Add a CNAME record `*` → `<your-worker>.<account>.workers.dev` (proxied, orange cloud)
2. Add a Worker Custom Domain entry for `*.<apex>` pointing to the `sloop` worker

Without this wildcard, only the path-fallback `/s/<slug>/<path>` works.

## 5. Apply D1 migrations

```bash
bunx wrangler d1 migrations apply sloop-db --remote
```

This applies migrations 0001 through 0005, idempotently (Wrangler tracks state in a `d1_migrations` table).

## 6. Deploy the worker

```bash
bun install
bunx wrangler deploy
```

Or push to `main` and let `.github/workflows/deploy.yml` handle it — needs repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 7. Post-deploy smoke checks

```bash
HOST=https://<apex>

# Discovery
curl -s "$HOST/openapi.json" | jq '.openapi'         # → "3.1.0"
curl -s "$HOST/.well-known/agent.json" | jq '.capabilities | length'
curl -s "$HOST/llms.txt" | head -5
curl -s "$HOST/health"                                # → {"ok":true}

# Auth flow (requires verified sender domain)
curl -s -XPOST "$HOST/api/auth/agent/request-code" \
  -H 'content-type: application/json' \
  -d '{"email":"you@your.dom"}'

# Anonymous publish (no auth needed)
curl -s -XPOST "$HOST/api/v1/publish" \
  -H 'content-type: application/json' \
  -d '{"files":[{"path":"index.html","size":12,"contentType":"text/html"}]}'
```

## 8. CLI for ongoing use

```bash
export CLONEHN_HOST="https://<apex>"
bun run cli -- login              # email-code → ~/.sloop/credentials
bun run cli -- publish ./dist
bun run cli -- drive put ./notes.md notes.md
```

To install globally: `bun link` inside the repo, or pin to a fork and `bun add -g <fork>`.

## Custom domains for end users

Once users add their own domain via `POST /api/v1/domains` and pass Cloudflare's verification:

- The Workers for Platforms-style custom hostname becomes active in Cloudflare
- Routing is automatic through `links` rows + the `resolveLink` dispatcher in `src/index.ts`

## Rotation + maintenance

- `SIGNING_KEY` rotation invalidates all session cookies, encrypted variables, payment grants, and upload tickets. Plan accordingly.
- The cron in `wrangler.toml` (`*/10 * * * *`) runs `runCleanup`: expires anon sites, prunes pending/, GCs CAS, prunes drive history past plan retention.
- Trigger cleanup manually: `curl -X POST $HOST/__cleanup -H "authorization: Bearer $SIGNING_KEY"`.

## Costs

Per Cloudflare pricing as of 2026-05 (verify on their site):

- Workers Paid: $5/mo base, includes 10M requests, $0.30/M after
- R2: $0.015/GB-month storage, $0 egress, $4.50/M class-A ops, $0.36/M class-B ops
- D1: $5/mo on Workers Paid; 25 GB free, 50B reads/billing-period free
- KV: $0.50/M reads, $5/M writes — light usage in our hot path
- Email Sending: $0.20 per 1k messages on Workers Paid

A small instance under ~1k sites should cost ~$5–10/mo.

## Rollback

Wrangler keeps the last 10 deployments. Roll back via:

```bash
bunx wrangler rollback <deployment-id>
```

D1 migrations are forward-only — write a compensating migration if you need to revert schema changes.
