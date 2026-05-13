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
import { head, REVEAL_SCRIPT } from './ui/layout.ts';

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
    return withRequestLog(req, () => safeRoute(req, env, ctx));
  },
};

async function safeRoute(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await routeRequest(req, env, ctx);
  } catch (err) {
    logLine('error', {
      msg: 'unhandled',
      path: new URL(req.url).pathname,
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
    if (wantsHtml) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>500</title><style>body{font:14px/1.5 system-ui;padding:6rem 2rem;max-width:40rem;margin:auto;color:#1a1a1a}</style><h1>500 — something went wrong</h1><p>The server hit an error rendering this page. Please retry in a moment.</p>',
        { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
    return new Response(
      JSON.stringify({ error: 'internal error', code: 'internal_error' }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }
}

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

const LANDING_EXTRA = `
.hero{position:relative;padding:6rem 0 4rem;text-align:left;overflow:hidden}
.hero::before{content:"";position:absolute;inset:-10% -10% auto auto;width:42rem;height:42rem;pointer-events:none;background:radial-gradient(closest-side,rgba(225,243,254,.55),rgba(225,243,254,0) 70%);z-index:0;animation:drift 28s ease-in-out infinite alternate}
.hero::after{content:"";position:absolute;inset:auto auto -20% -10%;width:34rem;height:34rem;pointer-events:none;background:radial-gradient(closest-side,rgba(251,243,219,.4),rgba(251,243,219,0) 70%);z-index:0;animation:drift 36s ease-in-out infinite alternate-reverse}
.hero__inner{position:relative;z-index:1;max-width:42rem}
.hero h1{font-size:3.6rem;line-height:1;margin:.4rem 0 1.1rem;letter-spacing:-.025em}
.hero h1 em{font-style:italic;color:var(--muted);display:block}
.hero .lede{font-size:1.1rem;line-height:1.55;margin:0 0 1.8rem}
.hero__ctas{display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:2rem}
.hero__shortcut{display:flex;align-items:center;gap:.5rem;color:var(--muted);font:12.5px/1 var(--sans);flex-wrap:wrap}
.hero__shortcut .dot{width:3px;height:3px;border-radius:50%;background:var(--muted-soft)}

.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin:0 0 1.5rem}
.section-head h2{margin:0}
.section-head .muted{margin:0}

.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}
.step{background:var(--surface);border:1px solid var(--rule);border-radius:var(--radius);padding:1.5rem 1.5rem 1.25rem;display:flex;flex-direction:column;min-height:0}
.step__head{display:flex;align-items:center;gap:.55rem;margin-bottom:.4rem}
.step__n{font:500 11px/1 var(--mono);color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.step h3{margin:0 0 .9rem;font-size:1.1rem;font-family:var(--serif);letter-spacing:-.015em}
.step pre{flex:1;font-size:11.5px}

.bento{display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:minmax(150px,auto);gap:1rem}
.bento__cell{background:var(--surface);border:1px solid var(--rule);border-radius:var(--radius);padding:1.5rem 1.75rem;display:flex;flex-direction:column;gap:.4rem;transition:box-shadow 220ms ease,transform 220ms ease,border-color 220ms ease}
.bento__cell:hover{box-shadow:0 2px 14px rgba(17,17,17,.035);border-color:var(--rule-strong)}
.bento__cell h3{font-family:var(--sans);font-weight:600;font-size:.98rem;margin:0;letter-spacing:-.005em}
.bento__cell p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.6}
.bento__cell--wide{grid-column:span 2}
.bento__cell--tall{grid-row:span 2}
.bento__cell--accent{background:linear-gradient(180deg,var(--pale-blue-bg) 0%,var(--surface) 60%)}
.bento__tag{align-self:flex-start;margin-bottom:.2rem}

.tiers{display:grid;grid-template-columns:repeat(4,1fr);gap:.85rem}
.tier{background:var(--surface);border:1px solid var(--rule);border-radius:var(--radius);padding:1.4rem 1.3rem;display:flex;flex-direction:column;gap:.4rem}
.tier__name{font:600 13px/1 var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.tier__price{font:400 2rem/1 var(--serif);letter-spacing:-.02em;color:var(--ink);margin:.3rem 0 .4rem}
.tier__price span{font:500 12px/1 var(--sans);color:var(--muted);margin-left:.15rem}
.tier ul{list-style:none;padding:0;margin:.3rem 0 0;color:var(--muted);font-size:13px;line-height:1.85}
.tier ul li::before{content:"·";color:var(--muted-soft);margin-right:.5rem}

@keyframes drift{from{transform:translate3d(0,0,0)}to{transform:translate3d(-4%,3%,0)}}
@media (max-width:840px){
  .steps,.bento,.tiers{grid-template-columns:1fr}
  .bento__cell--wide,.bento__cell--tall{grid-column:auto;grid-row:auto}
  .hero h1{font-size:2.6rem}
}
`;

const LANDING_HTML = (host: string) => `<!doctype html>
<html lang="en"><head>${head('push-live — static hosting + private storage for agents', LANDING_EXTRA)}
<meta name="description" content="Three HTTP calls and your agent has a live site. Versioned drives, hash-skip deploys, password and paywall gates. Self-hosted on Cloudflare.">
</head>
<body>
<header class="nav"><div class="nav__inner">
  <a class="nav__brand" href="/">push<em>·</em>live</a>
  <div class="nav__links">
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
    <a href="/openapi.json">API</a>
    <a class="nav__cta" href="/signin">Sign in</a>
  </div>
</div></header>

<main class="wide">
  <section class="hero">
    <div class="hero__inner">
      <span class="eyebrow">Static hosting + private storage</span>
      <h1>Three calls.<em>One live site.</em></h1>
      <p class="lede">Your agent posts a manifest, uploads, and gets a live URL — anonymous for 24 hours or permanent with a key. Lock anything behind a password, or charge for it and take the payment straight to your wallet.</p>
      <div class="hero__ctas">
        <a class="btn" href="/signin">Mint an API key</a>
        <a class="btn btn--ghost" href="/docs">Read the docs</a>
      </div>
      <div class="hero__shortcut">
        <kbd>POST</kbd> /publish <span class="dot"></span>
        <kbd>PUT</kbd> upload URL <span class="dot"></span>
        <kbd>POST</kbd> /finalize <span class="dot"></span>
        <code>&lt;slug&gt;.${escapeHostForDisplay(host)}</code>
      </div>
    </div>
  </section>

  <section class="reveal" style="margin-top:5rem">
    <div class="section-head"><h2>The full flow, three calls.</h2><p class="muted">No SDK. No build step. Plain HTTP.</p></div>
    <div class="steps">
      <article class="step">
        <div class="step__head"><span class="step__n">01</span><span class="tag tag--blue">Create</span></div>
        <h3>Manifest in, presigned URLs out</h3>
<pre><code>POST /api/v1/publish
{
  "files": [
    { "path": "index.html",
      "size": 1234,
      "contentType": "text/html",
      "hash": "…" }
  ]
}</code></pre>
      </article>
      <article class="step">
        <div class="step__head"><span class="step__n">02</span><span class="tag tag--green">Upload</span></div>
        <h3>Upload in parallel</h3>
<pre><code>PUT &lt;upload.uploads[i].url&gt;
Content-Type: text/html
&lt;file bytes&gt;</code></pre>
      </article>
      <article class="step">
        <div class="step__head"><span class="step__n">03</span><span class="tag tag--yellow">Finalize</span></div>
        <h3>Atomic version flip</h3>
<pre><code>POST &lt;finalizeUrl&gt;
{ "versionId": "01J…" }

→ https://&lt;slug&gt;.${escapeHostForDisplay(host)}/</code></pre>
      </article>
    </div>
  </section>

  <section class="reveal" style="margin-top:5rem">
    <div class="section-head"><h2>What you actually get.</h2><p class="muted">Six primitives. Nothing else to learn.</p></div>
    <div class="bento">
      <article class="bento__cell bento__cell--wide bento__cell--accent">
        <span class="tag tag--blue bento__tag">Sites</span>
        <h3>Real URLs, not previews</h3>
        <p>HTML, JS, CSS, PDFs, fonts, video — served from <code>&lt;slug&gt;.${escapeHostForDisplay(host)}</code>, your own domain, or a path under your handle. SPA fallback, range requests, custom titles and OG images.</p>
      </article>
      <article class="bento__cell">
        <span class="tag tag--green bento__tag">Drives</span>
        <h3>Files only your agent sees</h3>
        <p>Private versioned storage. Share with another agent via a scoped token — read or write, single folder, expires.</p>
      </article>
      <article class="bento__cell">
        <span class="tag tag--violet bento__tag">Speed</span>
        <h3>Re-publish in milliseconds</h3>
        <p>Files that haven't changed don't upload twice. A five-hundred-file site updates as fast as its smallest diff.</p>
      </article>
      <article class="bento__cell">
        <span class="tag tag--yellow bento__tag">Gates</span>
        <h3>Password or paywall</h3>
        <p>Lock any site behind a password. Or charge for it — USDC lands in your wallet the moment a visitor pays.</p>
      </article>
      <article class="bento__cell">
        <span class="tag tag--red bento__tag">Proxy</span>
        <h3>Call APIs without leaking keys</h3>
        <p>Ship a <code>proxy.json</code> and your site can call third-party APIs with secrets you keep on push-live, never in your code.</p>
      </article>
      <article class="bento__cell">
        <span class="tag bento__tag">Agent-readable</span>
        <h3>Discoverable on its own</h3>
        <p>An <code>llms.txt</code>, OpenAPI, and <code>agent.json</code> ship out of the box. Your agent finds the endpoints, knows the auth shape, and reads the prices — no scraping.</p>
      </article>
    </div>
  </section>

  <section class="reveal" style="margin-top:5rem">
    <div class="section-head"><h2>Plans.</h2><a class="muted" href="/pricing">Full table →</a></div>
    <div class="tiers">
      <article class="tier">
        <div class="tier__name">Anonymous</div>
        <div class="tier__price">$0</div>
        <ul><li>24 h sites</li><li>250 MB max file</li><li>60 publishes / hour</li></ul>
      </article>
      <article class="tier">
        <div class="tier__name">Free</div>
        <div class="tier__price">$0</div>
        <ul><li>10 GB storage</li><li>500 sites</li><li>1 drive, 1 domain</li></ul>
      </article>
      <article class="tier">
        <div class="tier__name">Hobby</div>
        <div class="tier__price">$4<span>/mo</span></div>
        <ul><li>500 GB storage</li><li>1 000 sites</li><li>5 drives, 5 domains</li></ul>
      </article>
      <article class="tier">
        <div class="tier__name">Developer</div>
        <div class="tier__price">$20<span>/mo</span></div>
        <ul><li>2 TB storage</li><li>Unlimited sites</li><li>10 drives, 20 domains</li></ul>
      </article>
    </div>
  </section>
</main>

<footer>
  <a href="/docs">Docs</a> · <a href="/pricing">Pricing</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a>
</footer>
<script>${REVEAL_SCRIPT}</script>
</body></html>`;

function escapeHostForDisplay(host: string): string {
  return host.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
}
