import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types.ts';
import { sitesRouter } from './routes/sites.ts';
import { authRouter } from './routes/auth.ts';
import { drivesRouter } from './routes/drives.ts';
import { accountRouter } from './routes/account.ts';
import { pagesRouter } from './routes/pages.ts';
import { payRouter } from './routes/pay.ts';
import { discoveryRouter } from './routes/discovery.ts';
import { serveSite } from './serve.ts';
import { verifyTicket } from './lib/upload-ticket.ts';
import { runCleanup } from './cleanup.ts';
import { withRequestLog, logLine } from './lib/log.ts';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'x-push-live-client'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));

app.get('/', (c) =>
  c.html(LANDING_HTML(c.env.PUBLIC_APEX_HOST)),
);

app.get('/health', (c) => c.json({ ok: true }));

// Internal: trigger cleanup synchronously. Useful for tests and on-demand
// admin runs. Requires the SIGNING_KEY as a Bearer token so it's not public.
app.post('/__cleanup', async (c) => {
  const auth = c.req.header('authorization');
  if (auth !== `Bearer ${c.env.SIGNING_KEY}`) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await runCleanup(c.env));
});

app.route('/', authRouter);
app.route('/', sitesRouter);
app.route('/', drivesRouter);
app.route('/', accountRouter);
app.route('/', pagesRouter);
app.route('/', payRouter);
app.route('/', discoveryRouter);

app.notFound((c) => c.json({ error: 'not found', code: 'not_found' }, 404));
app.onError((err, c) => {
  logLine('error', {
    msg: 'unhandled',
    path: new URL(c.req.url).pathname,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ error: 'internal error', code: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500);
});

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCleanup(env).then(
        (r) => logLine('info', { msg: 'cleanup', ...r }),
        (e) => logLine('error', { msg: 'cleanup_failed', err: e instanceof Error ? e.message : String(e) }),
      ),
    );
  },

  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withRequestLog(req, () => routeRequest(req, env, ctx));
  },
};

async function routeRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    const apex = env.PUBLIC_APEX_HOST.toLowerCase();

    // Worker-direct upload endpoint (used when no R2 presign credentials are configured).
    if (url.pathname.startsWith('/__upload/') && (req.method === 'PUT' || req.method === 'POST')) {
      const ticket = decodeURIComponent(url.pathname.slice('/__upload/'.length));
      const t = await verifyTicket(env.SIGNING_KEY, ticket);
      if (!t) return new Response('Invalid or expired upload ticket', { status: 401 });
      const body = await req.arrayBuffer();
      if (body.byteLength > t.maxSize) return new Response('Body exceeds maxSize', { status: 413 });
      await env.SITES.put(t.key, body, { httpMetadata: { contentType: t.contentType } });
      return new Response(null, { status: 200, headers: { etag: `"${body.byteLength}"` } });
    }

    // Path-based serve works on any host (apex, dev, custom domain without link)
    const pathSlug = /^\/s\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
    if (pathSlug) return serveSite(env, pathSlug[1], pathSlug[2] ?? '/', req);

    // 1) Apex host (or dev host) serves the API + landing
    if (host === apex || host === `www.${apex}` || host === '127.0.0.1' || host === 'localhost') {
      return app.fetch(req, env, ctx);
    }

    // 2) <slug>.<apex>/... — direct slug subdomain
    if (host.endsWith(`.${apex}`)) {
      const slug = host.slice(0, -1 - apex.length);
      if (slug && !slug.includes('.')) {
        // Could be a handle subdomain — try handle lookup before slug fallback
        const linked = await resolveLink(env, slug, url.pathname);
        if (linked) return serveSite(env, linked.slug, linked.remainingPath, req);
        return serveSite(env, slug, url.pathname, req);
      }
    }

    // 3) Custom domain: <domain>/<path>
    const linked = await resolveLink(env, host, url.pathname);
    if (linked) return serveSite(env, linked.slug, linked.remainingPath, req);

    return app.fetch(req, env, ctx);
}

async function resolveLink(
  env: Env,
  hostOrHandle: string,
  pathname: string,
): Promise<{ slug: string; remainingPath: string } | null> {
  // Walk from most-specific to least-specific mount path.
  const segments = pathname.split('/').filter(Boolean);
  for (let i = segments.length; i >= 0; i--) {
    const mount = '/' + segments.slice(0, i).join('/') + (i === 0 ? '' : '/');
    const location = `${hostOrHandle}${mount === '/' ? '/' : mount}`;
    const cached = await env.KV.get(`link:${location}`);
    if (cached) {
      const remaining = '/' + segments.slice(i).join('/');
      return { slug: cached, remainingPath: remaining || '/' };
    }
    const row = await env.DB.prepare(
      `SELECT slug FROM links WHERE location = ?1 LIMIT 1`,
    ).bind(location).first<{ slug: string }>();
    if (row) {
      await env.KV.put(`link:${location}`, row.slug, { expirationTtl: 600 });
      const remaining = '/' + segments.slice(i).join('/');
      return { slug: row.slug, remainingPath: remaining || '/' };
    }
  }
  return null;
}

const LANDING_HTML = (host: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>push-live — static hosting + private storage for agents</title>
<meta name="description" content="Instant static hosting and versioned file storage built for AI agents. Self-hosted on Cloudflare.">
<style>
:root{--bg:#fff;--ink:#0a0a0a;--muted:#52525b;--rule:#e4e4e7;--accent:#0b0b0c;--soft:#fafafa}
*{box-sizing:border-box}
body{font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:var(--bg);margin:0}
header{position:sticky;top:0;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--rule);z-index:10}
header .row{max-width:64rem;margin:0 auto;padding:.85rem 1.5rem;display:flex;justify-content:space-between;align-items:center}
header a{color:var(--ink);text-decoration:none;font-size:14px}
header .brand{font-weight:600;letter-spacing:-.01em}
header nav a{margin-left:1.4rem;color:var(--muted)}
header nav a:hover{color:var(--ink)}
header .cta{margin-left:1.4rem;background:var(--ink);color:#fff;padding:.45rem .85rem;border-radius:4px;font-weight:500}
section{max-width:64rem;margin:0 auto;padding:0 1.5rem}
.hero{padding:5rem 1.5rem 4rem;text-align:center}
.hero h1{font:600 2.6rem/1.05 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.035em;margin:0 0 1rem}
.hero .sub{font-size:1.05rem;color:var(--muted);max-width:36rem;margin:0 auto 2rem}
.hero .ctas{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;margin-bottom:3rem}
.btn{display:inline-block;padding:.7rem 1.2rem;border-radius:4px;text-decoration:none;font-size:14px;font-weight:500;border:0;cursor:pointer}
.btn.primary{background:var(--ink);color:#fff}
.btn.ghost{background:#fff;color:var(--ink);border:1px solid var(--rule)}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;max-width:56rem;margin:0 auto;text-align:left}
.step{background:var(--soft);border:1px solid var(--rule);border-radius:6px;padding:1.25rem}
.step .n{color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.step h3{font-size:.95rem;margin:.3rem 0 .75rem;font-weight:600}
.step pre{margin:0;background:var(--accent);color:#fafafa;padding:.85rem;border-radius:4px;font:12px/1.55 ui-monospace,Menlo,monospace;overflow-x:auto}
.features{padding:4rem 1.5rem;border-top:1px solid var(--rule)}
.features h2{font-size:1.4rem;letter-spacing:-.02em;margin:0 0 .4rem;text-align:center}
.features .lede{text-align:center;color:var(--muted);margin:0 0 2.5rem}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.2rem}
.feat{padding:1.25rem 1.4rem;border:1px solid var(--rule);border-radius:6px}
.feat h4{margin:0 0 .35rem;font-size:.95rem;font-weight:600}
.feat p{margin:0;color:var(--muted);font-size:13.5px}
.pricing{padding:4rem 1.5rem;border-top:1px solid var(--rule);text-align:center}
.pricing h2{font-size:1.4rem;letter-spacing:-.02em;margin:0 0 1.5rem}
.tier-row{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;max-width:56rem;margin:0 auto}
.tier{padding:1.3rem 1rem;border:1px solid var(--rule);border-radius:6px}
.tier .name{font-weight:600;font-size:.95rem}
.tier .price{font:600 1.5rem ui-monospace,Menlo,monospace;margin:.5rem 0;letter-spacing:-.02em}
.tier .feat-list{color:var(--muted);font-size:12.5px;text-align:left;margin:.75rem 0 0;padding:0;list-style:none;line-height:1.7}
footer{border-top:1px solid var(--rule);padding:2.5rem 1.5rem;color:var(--muted);font-size:13px;text-align:center;margin-top:4rem}
footer a{color:var(--muted);margin:0 .6rem}
code{font:13px ui-monospace,Menlo,monospace;background:#f4f4f5;padding:.1em .35em;border-radius:3px}
@media (max-width: 720px){
  .steps,.grid,.tier-row{grid-template-columns:1fr}
  .hero h1{font-size:2rem}
}
</style></head>
<body>
<header><div class="row">
  <a class="brand" href="/">push-live</a>
  <nav>
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
    <a href="/openapi.json">API</a>
    <a class="cta" href="/signin">Sign in</a>
  </nav>
</div></header>

<section class="hero">
  <h1>Static hosting + private storage,<br>built for agents.</h1>
  <p class="sub">Three HTTP calls and your agent has a live site at <code>&lt;slug&gt;.${host}</code>. Anonymous in 24h, permanent with a key. Self-hosted on Cloudflare Workers + R2 + D1.</p>
  <div class="ctas">
    <a class="btn primary" href="/signin">Mint an API key</a>
    <a class="btn ghost" href="/docs">Read the docs</a>
  </div>

  <div class="steps">
    <div class="step">
      <div class="n">01 · Create</div>
      <h3>Manifest → presigned URLs</h3>
<pre>POST /api/v1/publish
{
  "files": [
    { "path": "index.html",
      "size": 1234,
      "contentType": "text/html",
      "hash": "..." }
  ]
}</pre>
    </div>
    <div class="step">
      <div class="n">02 · Upload</div>
      <h3>Direct to R2, in parallel</h3>
<pre>PUT &lt;upload.uploads[i].url&gt;
Content-Type: text/html
&lt;file bytes&gt;</pre>
    </div>
    <div class="step">
      <div class="n">03 · Finalize</div>
      <h3>Atomic version flip</h3>
<pre>POST &lt;finalizeUrl&gt;
{ "versionId": "01J..." }

→ https://&lt;slug&gt;.${host}/</pre>
    </div>
  </div>
</section>

<section class="features">
  <h2>What you get</h2>
  <p class="lede">Static hosting + private file storage built for agents. Runs entirely on your Cloudflare account.</p>
  <div class="grid">
    <div class="feat"><h4>Sites</h4><p>Static HTML/JS/CSS/PDF/assets at <code>slug.${host}</code> or a custom domain via Cloudflare for SaaS.</p></div>
    <div class="feat"><h4>Drives</h4><p>Versioned private storage with scoped share tokens — read/write, path-prefixed, TTL'd.</p></div>
    <div class="feat"><h4>Hash-skip deploys</h4><p>SHA-256 content addressing means unchanged files are skipped on re-publish.</p></div>
    <div class="feat"><h4>Password &amp; paywall</h4><p>Gate any site with a password or an on-chain stablecoin payment. 402 + session flow for agents.</p></div>
    <div class="feat"><h4>Proxy routes</h4><p>Ship a <code>proxy.json</code>; <code>\${VAR}</code> values are pulled from an encrypted variables store at request time.</p></div>
    <div class="feat"><h4>Agent-native</h4><p>Anonymous publish, email-code key flow, <code>llms.txt</code>, OpenAPI, agent.json — discoverable end-to-end.</p></div>
  </div>
</section>

<section class="pricing">
  <h2>Plans <a href="/pricing" style="font-size:13px;color:var(--muted);font-weight:400;text-decoration:none;letter-spacing:0">→ full table</a></h2>
  <div class="tier-row">
    <div class="tier">
      <div class="name">Anonymous</div>
      <div class="price">$0</div>
      <ul class="feat-list"><li>24h sites</li><li>250 MB max file</li><li>60 publishes/hour</li></ul>
    </div>
    <div class="tier">
      <div class="name">Free</div>
      <div class="price">$0</div>
      <ul class="feat-list"><li>10 GB storage</li><li>500 sites</li><li>1 drive, 1 domain</li></ul>
    </div>
    <div class="tier">
      <div class="name">Hobby</div>
      <div class="price">$4<span style="font-size:12px;color:var(--muted)">/mo</span></div>
      <ul class="feat-list"><li>500 GB storage</li><li>1000 sites</li><li>5 drives, 5 domains</li></ul>
    </div>
    <div class="tier">
      <div class="name">Developer</div>
      <div class="price">$20<span style="font-size:12px;color:var(--muted)">/mo</span></div>
      <ul class="feat-list"><li>2 TB storage</li><li>Unlimited sites</li><li>10 drives, 20 domains</li></ul>
    </div>
  </div>
</section>

<footer>
  <a href="/docs">Docs</a> · <a href="/pricing">Pricing</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a><br>
  <small>Source-available · Cloudflare Workers + R2 + D1.</small>
</footer>
</body></html>`;
