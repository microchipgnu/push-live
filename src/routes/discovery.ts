import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { PLANS } from '../lib/quotas.ts';
import { escapeHtml, shell } from '../ui/layout.ts';

export const discoveryRouter = new Hono<{ Bindings: Env }>();

discoveryRouter.get('/robots.txt', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.text(
    `User-agent: *
Allow: /

Sitemap: https://${host}/sitemap.xml
`,
    200,
    { 'content-type': 'text/plain; charset=utf-8' },
  );
});

discoveryRouter.get('/sitemap.xml', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const today = new Date().toISOString().slice(0, 10);
  const paths = ['/', '/docs', '/pricing', '/signin', '/openapi.json', '/llms.txt', '/llms-full.txt', '/pricing.md'];
  const urls = paths.map((p) =>
    `  <url><loc>https://${host}${p}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq></url>`,
  ).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
  return c.text(xml, 200, { 'content-type': 'application/xml; charset=utf-8' });
});

discoveryRouter.get('/llms.txt', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.text(buildLlmsText(host, /* full */ false), 200, { 'content-type': 'text/plain; charset=utf-8' });
});

discoveryRouter.get('/llms-full.txt', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.text(buildLlmsText(host, /* full */ true), 200, { 'content-type': 'text/plain; charset=utf-8' });
});

discoveryRouter.get('/pricing.md', (c) => {
  return c.text(buildPricingMd(c.env.PUBLIC_APEX_HOST), 200, { 'content-type': 'text/markdown; charset=utf-8' });
});

discoveryRouter.get('/index.md', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.text(buildIndexMd(host), 200, { 'content-type': 'text/markdown; charset=utf-8' });
});

// Scoped agent contexts: docs-only and api-only slices. Faster for agents that
// only need one face of the surface area.
discoveryRouter.get('/docs/llms.txt', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.text(buildDocsLlms(host), 200, { 'content-type': 'text/plain; charset=utf-8' });
});

discoveryRouter.get('/api/llms.txt', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.text(buildApiLlms(host), 200, { 'content-type': 'text/plain; charset=utf-8' });
});

// Skill packaging surfaces. Stubs under push-live naming; the actual install
// channel is the curl-pipe one-liner from /install.sh.
discoveryRouter.get('/skill.md', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.text(buildSkillMd(host), 200, { 'content-type': 'text/markdown; charset=utf-8' });
});

discoveryRouter.get('/api/skill/version', (c) => {
  return c.json({
    name: 'push-live',
    version: '0.1.0',
    skill_url: `https://${c.env.PUBLIC_APEX_HOST}/skill.md`,
    updated_at: new Date().toISOString(),
  });
});

discoveryRouter.get('/.well-known/skills/index.json', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const base = `https://${host}`;
  return c.json({
    skills: [
      {
        id: 'push-live',
        name: 'push-live',
        version: '0.1.0',
        description: 'Publish static sites and store private files. Anonymous in 24h, permanent with a key.',
        skill_url: `${base}/skill.md`,
        version_url: `${base}/api/skill/version`,
        openapi_url: `${base}/openapi.json`,
        agent_card_url: `${base}/.well-known/agent-card.json`,
      },
    ],
  });
});

discoveryRouter.get('/install.sh', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const script = `#!/usr/bin/env bash
# push-live CLI bootstrap.
#   curl -fsSL https://${host}/install.sh | bash
set -euo pipefail
if command -v bun >/dev/null 2>&1; then
  bun add -g push-live-cli
elif command -v npm >/dev/null 2>&1; then
  npm i -g push-live-cli
else
  echo "Need bun or npm to install push-live-cli." >&2
  exit 1
fi
echo "Installed. Run: push-live login"
`;
  return c.text(script, 200, { 'content-type': 'text/x-shellscript; charset=utf-8' });
});

discoveryRouter.get('/icon.svg', (c) => c.text(BRAND_ICON_SVG, 200, { 'content-type': 'image/svg+xml; charset=utf-8' }));
discoveryRouter.get('/logo.png', (c) => c.text(BRAND_LOGO_SVG, 200, { 'content-type': 'image/svg+xml; charset=utf-8' }));

discoveryRouter.get('/terms', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.html(buildTermsHtml(host), 200);
});

discoveryRouter.get('/.well-known/agent.json', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.json({
    name: 'push-live',
    summary: 'Static site hosting and private file storage for agents, on Cloudflare.',
    base_url: `https://${host}`,
    docs_url: `https://${host}/docs`,
    openapi_url: `https://${host}/openapi.json`,
    auth: {
      anonymous: true,
      anonymous_ttl_seconds: 24 * 60 * 60,
      bearer: { header: 'Authorization', scheme: 'Bearer' },
      bootstrap: {
        request_code: `${`https://${host}`}/api/auth/agent/request-code`,
        verify_code: `${`https://${host}`}/api/auth/agent/verify-code`,
      },
    },
    capabilities: [
      { name: 'publish_site',  description: 'Upload static files and serve at <slug>.host.' },
      { name: 'store_files',   description: 'Versioned private cloud storage with scoped share tokens.' },
      { name: 'custom_domain', description: 'BYO domain via Cloudflare for SaaS.' },
      { name: 'paywall',       description: 'Stablecoin payment gate on any site.' },
      { name: 'proxy_routes',  description: 'Server-side API proxy with secret-variable interpolation.' },
    ],
  });
});

// A2A-shape agent card: protocolVersion + skills, the spec used by the
// agent-to-agent ecosystem (research/docs/agent-card.json). The legacy
// OpenAI-plugin shape lives at /.well-known/ai-plugin.json below.
discoveryRouter.get('/.well-known/agent-card.json', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const base = `https://${host}`;
  return c.json({
    protocolVersion: '0.3.0',
    name: 'push-live',
    description: 'Publish static sites and store private agent files. Anonymous in 24 hours, permanent with a key. Optional password / stablecoin paywall.',
    url: base,
    documentation: `${base}/docs`,
    openapi: `${base}/openapi.json`,
    contactEmail: `hello@${host}`,
    capabilities: {
      streaming: false,
      bearerAuth: true,
      anonymous: true,
    },
    auth: {
      type: 'bearer',
      bootstrap: {
        request_code: `${base}/api/auth/agent/request-code`,
        verify_code: `${base}/api/auth/agent/verify-code`,
      },
    },
    skills: [
      {
        id: 'publish_site',
        name: 'Publish a static site',
        description: 'Manifest → presigned uploads → finalize. Returns a live URL on <slug>.' + host + '.',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [`${base}/api/v1/publish`],
      },
      {
        id: 'store_files',
        name: 'Versioned private storage',
        description: 'CRUD with scoped share tokens, prefix listing, time-travel reads (?at=<unix_ms>), and per-file history.',
        inputModes: ['application/json', 'application/octet-stream'],
        outputModes: ['application/json', 'application/octet-stream'],
        examples: [`${base}/api/v1/drives`],
      },
      {
        id: 'custom_domain',
        name: 'Bring your own domain',
        description: 'Add a custom hostname and route paths to one or more Sites.',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'paywall',
        name: 'Stablecoin paywall',
        description: 'Gate any site with USDC. push-live observes the on-chain transfer; it never signs or holds keys.',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [`${base}/api/pay/{slug}/session`],
      },
      {
        id: 'proxy_routes',
        name: 'Variable-templated API proxy',
        description: 'Ship a .push-live/proxy.json that calls third-party APIs with server-side variables.',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
  });
});

discoveryRouter.get('/.well-known/ai-plugin.json', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.json({
    schema_version: 'v1',
    name_for_human: 'push-live',
    name_for_model: 'push-live',
    description_for_human: 'Static hosting + private storage built for agents.',
    description_for_model: 'Publish static sites and store private files on push-live. Anonymous publish works without an account; authenticated publish uses an API key.',
    auth: { type: 'user_http', authorization_type: 'bearer' },
    api: { type: 'openapi', url: `https://${host}/openapi.json` },
    logo_url: `https://${host}/logo.png`,
    contact_email: `hello@${host}`,
    legal_info_url: `https://${host}/terms`,
  });
});

discoveryRouter.get('/.well-known/api-catalog', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const base = `https://${host}`;
  return c.json({
    linkset: [
      {
        anchor: base,
        'service-desc': [{ href: `${base}/openapi.json`, type: 'application/vnd.oai.openapi+json;version=3.1' }],
        'service-doc': [{ href: `${base}/docs`, type: 'text/html' }],
        describedby: [
          { href: `${base}/llms.txt`, type: 'text/plain', title: 'Concise agent context' },
          { href: `${base}/llms-full.txt`, type: 'text/plain', title: 'Full agent context' },
          { href: `${base}/pricing.md`, type: 'text/markdown', title: 'Machine-readable pricing' },
          { href: `${base}/.well-known/agent.json`, type: 'application/json', title: 'Agent index' },
          { href: `${base}/.well-known/agent-card.json`, type: 'application/json', title: 'A2A agent card' },
          { href: `${base}/.well-known/ai-plugin.json`, type: 'application/json', title: 'Plugin manifest' },
        ],
        item: [
          { href: `${base}/api/v1/publish`, title: 'Sites — publish flow' },
          { href: `${base}/api/v1/drives`, title: 'Drives — versioned storage' },
          { href: `${base}/api/pay/{slug}/session`, title: 'Payments — start session' },
        ],
        alternate: [
          { href: `${base}/index.md`, type: 'text/markdown', title: 'Markdown homepage' },
          { href: `${base}/docs/llms.txt`, type: 'text/plain', title: 'Docs-only agent context' },
          { href: `${base}/api/llms.txt`, type: 'text/plain', title: 'API-only agent context' },
        ],
      },
    ],
  }, 200, { 'content-type': 'application/linkset+json' });
});

discoveryRouter.get('/schema-map.xml', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const entry = (loc: string, type: string, encoding: string) =>
    `  <url>\n    <loc>${loc}</loc>\n    <type>${type}</type>\n    <encoding>${encoding}</encoding>\n  </url>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<schemaMap xmlns="https://${host}/ns/schema-map">
${entry(`https://${host}/openapi.json`, 'OpenAPI', 'application/vnd.oai.openapi+json;version=3.1')}
${entry(`https://${host}/llms-full.txt`, 'LLMSText', 'text/plain')}
${entry(`https://${host}/pricing.md`, 'PricingMarkdown', 'text/markdown')}
${entry(`https://${host}/.well-known/agent.json`, 'AgentIndex', 'application/json')}
${entry(`https://${host}/.well-known/agent-card.json`, 'A2AAgentCard', 'application/json')}
${entry(`https://${host}/schema-feeds/agent-resources.jsonl`, 'JSONL', 'application/jsonl')}
</schemaMap>`;
  return c.text(xml, 200, { 'content-type': 'application/xml; charset=utf-8' });
});

discoveryRouter.get('/schema-feeds/agent-resources.jsonl', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const base = `https://${host}`;
  const lines = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebAPI',
      name: 'push-live API',
      url: `${base}/openapi.json`,
      documentation: `${base}/docs`,
      description: 'Static hosting and private file storage API for agents.',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'push-live',
      url: base,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'DataCatalog',
      name: 'push-live discovery surfaces',
      url: base,
      description: 'Machine-readable feeds describing the API, pricing, and skill.',
      dataset: [
        { '@type': 'Dataset', name: 'OpenAPI', distribution: { '@type': 'DataDownload', contentUrl: `${base}/openapi.json`, encodingFormat: 'application/vnd.oai.openapi+json;version=3.1' } },
        { '@type': 'Dataset', name: 'llms.txt', distribution: { '@type': 'DataDownload', contentUrl: `${base}/llms.txt`, encodingFormat: 'text/plain' } },
        { '@type': 'Dataset', name: 'llms-full.txt', distribution: { '@type': 'DataDownload', contentUrl: `${base}/llms-full.txt`, encodingFormat: 'text/plain' } },
        { '@type': 'Dataset', name: 'pricing.md', distribution: { '@type': 'DataDownload', contentUrl: `${base}/pricing.md`, encodingFormat: 'text/markdown' } },
        { '@type': 'Dataset', name: 'agent-card', distribution: { '@type': 'DataDownload', contentUrl: `${base}/.well-known/agent-card.json`, encodingFormat: 'application/json' } },
        { '@type': 'Dataset', name: 'skill', distribution: { '@type': 'DataDownload', contentUrl: `${base}/skill.md`, encodingFormat: 'text/markdown' } },
      ],
    },
  ];
  return c.text(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 200, {
    'content-type': 'application/jsonl; charset=utf-8',
  });
});

discoveryRouter.get('/openapi.json', (c) => {
  return c.json(buildOpenApi(c.env.PUBLIC_APEX_HOST));
});

// Public-readable: the same OpenAPI shape, but as a stable docs page that
// auto-tracks the spec so the two can't drift. Lives at /docs.
discoveryRouter.get('/docs', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.html(renderDocs(host));
});

function renderDocs(host: string): string {
  const spec = buildOpenApi(host) as {
    paths: Record<string, Record<string, { summary?: string; tags?: string[]; security?: unknown }>>;
    tags?: Array<{ name: string; description?: string }>;
  };
  // Group endpoints by tag.
  const byTag = new Map<string, Array<{ method: string; path: string; summary: string; auth: boolean }>>();
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags?.[0] ?? 'Other';
      const entry = { method: method.toUpperCase(), path: p, summary: op.summary ?? '', auth: !!op.security };
      const arr = byTag.get(tag) ?? [];
      arr.push(entry);
      byTag.set(tag, arr);
    }
  }
  const tagOrder = (spec.tags ?? []).map((t) => t.name);
  for (const t of byTag.keys()) if (!tagOrder.includes(t)) tagOrder.push(t);

  const renderRow = (e: { method: string; path: string; summary: string; auth: boolean }) => `
    <tr>
      <td><span class="method method--${e.method.toLowerCase()}">${e.method}</span></td>
      <td><code>${escapeHtml(e.path)}</code></td>
      <td>${escapeHtml(e.summary)}</td>
      <td class="right">${e.auth ? '<span class="tag tag--yellow">auth</span>' : ''}</td>
    </tr>`;

  const sections = tagOrder.map((tag) => {
    const rows = (byTag.get(tag) ?? []).map(renderRow).join('');
    if (!rows) return '';
    return `<section><h2 id="${tag.toLowerCase()}">${escapeHtml(tag)}</h2>
      <div class="card" style="padding:.4rem 1rem">
      <table><thead><tr><th>Method</th><th>Path</th><th>Summary</th><th class="right">Auth</th></tr></thead>
      <tbody>${rows}</tbody></table></div></section>`;
  }).join('');

  const docsExtra = `
.method{display:inline-block;font:600 11px/1 var(--mono);padding:.32em .55em;border-radius:4px;letter-spacing:.04em;min-width:3.6em;text-align:center}
.method--get{background:var(--pale-blue-bg);color:var(--pale-blue-fg)}
.method--post{background:var(--pale-green-bg);color:var(--pale-green-fg)}
.method--put{background:var(--pale-yellow-bg);color:var(--pale-yellow-fg)}
.method--patch{background:var(--pale-violet-bg);color:var(--pale-violet-fg)}
.method--delete{background:var(--pale-red-bg);color:var(--pale-red-fg)}
.toc{display:flex;flex-wrap:wrap;gap:.3rem .9rem;margin:1.4rem 0 2.5rem;padding-bottom:1.4rem;border-bottom:1px solid var(--rule);font-size:13px}
.toc a{color:var(--muted);text-decoration:none}
.toc a:hover{color:var(--ink)}
`;

  const body = `
<span class="eyebrow">API</span>
<h1>Reference.</h1>
<p class="lede">Auto-generated from <a href="/openapi.json">openapi.json</a>. Compact agent context lives at <a href="/llms.txt">llms.txt</a> and <a href="/llms-full.txt">llms-full.txt</a>; scoped contexts at <a href="/docs/llms.txt">/docs/llms.txt</a> and <a href="/api/llms.txt">/api/llms.txt</a>.</p>

<h2>Quick start</h2>
<pre><code># 1. Create
curl -sS https://${escapeHtml(host)}/api/v1/publish \\
  -H 'content-type: application/json' \\
  -d '{"files":[{"path":"index.html","size":12,"contentType":"text/html"}]}'

# 2. PUT to the upload URL from the response

# 3. Finalize
curl -sS -X POST &lt;finalizeUrl&gt; -d '{"versionId":"&lt;v&gt;"}'</code></pre>

<h2 id="auth">Get an API key</h2>
<pre><code>curl -sS https://${escapeHtml(host)}/api/auth/agent/request-code -d '{"email":"you@example.com"}'
curl -sS https://${escapeHtml(host)}/api/auth/agent/verify-code -d '{"email":"you@example.com","code":"XXXX-YYYY"}'</code></pre>
<p class="muted">All authenticated endpoints take <code>Authorization: Bearer &lt;API_KEY&gt;</code>. Drive share tokens are also accepted on <code>/api/v1/drives/*</code> routes, scoped to one drive and an optional path prefix. Pass an optional <code>X-Push-Live-Client</code> header to tag who is publishing.</p>

<h2 id="limits">Limits &amp; quotas</h2>
<p class="muted">Per-plan quotas — see <a href="/pricing.md">/pricing.md</a> for the machine-readable table.</p>
<ul>
  <li><strong>Anonymous</strong> · 250 MB max file · 60 publishes/hour/IP · 24 h site TTL · no drives.</li>
  <li><strong>Free</strong> · 10 GB storage · 500 sites · 500 MB max file · 1 drive · 1 custom domain · 7-day drive history.</li>
  <li><strong>Hobby</strong> · 500 GB storage · 1 000 sites · 2 GB max file · 5 drives · 5 domains · 30-day history.</li>
  <li><strong>Developer</strong> · 2 TB storage · unlimited sites · 2 GB max file · 10 drives · 20 domains · 90-day history.</li>
  <li><strong>Variables</strong> · 50 per account · 4 KB per value · optional <code>allowedUpstreams</code> allow-list.</li>
  <li><strong>Proxy</strong> · 10 MB per response · default 100 req/hr/IP per route; override with <code>rateLimit</code>.</li>
  <li><strong>Apps · Analytics</strong> · 0 / 10 k / 100 k / 1 M events per month per site · 60 hits/min/IP.</li>
</ul>

<h2 id="errors">Error envelope</h2>
<pre><code>{
  "error":    "Human-readable message",
  "code":     "rate_limit_exceeded",
  "message":  "Same as error",
  "docs_url": "/docs#limits",
  "retry_after": 30
}</code></pre>
<p class="muted">Common codes: <code>invalid_request</code>, <code>unauthorized</code>, <code>not_found</code>, <code>conflict</code>, <code>gone</code>, <code>precondition_failed</code>, <code>payload_too_large</code>, <code>quota_exceeded</code>, <code>rate_limit_exceeded</code>, <code>payment_required</code>. Every error includes a <code>docs_url</code> pointing back into this page.</p>

<h2 id="payments">Payments</h2>
<p class="muted">Site owners set a price + payout wallet; visitors pay that wallet directly. push-live never holds keys or signs transactions — it observes the on-chain transfer and grants access. Flow: <code>POST /api/pay/:slug/session</code> → visitor sends USDC to the returned address → <code>POST /api/pay/:slug/grant</code> with the txHash (or the browser-friendly <code>GET /api/pay/:slug/confirm</code> with <code>?session=&amp;tx=</code>).</p>

<h2 id="apps">Apps</h2>
<p class="muted">Server-side capabilities your hosted site can call from its own JS. Endpoints live at <code>/__pl/&lt;app&gt;/...</code> on the site's host (slug subdomain or custom domain). No SDK, no setup — fetch the URL.</p>
<p><strong>Analytics</strong> · count page hits and unique visitors per site. No external SDK; no cookies. Visitor identity is a per-day, per-site rotating hash so visits aren't linkable across days.</p>
<pre><code>// In your site's JS:
fetch('/__pl/analytics/hit', { method: 'POST', body: JSON.stringify({ path: location.pathname }) });

// Or as a beacon image (works without JS):
&lt;img src="/__pl/analytics/hit?path=/" width="1" height="1" alt=""&gt;</code></pre>
<p>Read the summary as the site owner:</p>
<pre><code>curl -sS https://${escapeHtml(host)}/api/v1/publish/&lt;slug&gt;/analytics?period=7d \\
  -H 'authorization: Bearer &lt;API_KEY&gt;'</code></pre>
<p class="muted">Caps per plan (events/month, per site): anonymous 0 · free 10 000 · hobby 100 000 · developer 1 000 000. Over-quota writes are silently dropped — the visitor never sees an error.</p>

<h2>Endpoints</h2>
<p class="muted"><span class="tag tag--yellow">auth</span> means a bearer token is required.</p>
<div class="toc">${tagOrder.filter((t) => byTag.has(t)).map((t) => `<a href="#${t.toLowerCase()}">${escapeHtml(t)}</a>`).join('')}</div>
${sections}
`;

  return shell('Docs · push-live', body, { extraStyle: docsExtra });
}

// ---------------- Builders (kept in this file to make them easy to edit) ----------------

function buildLlmsText(host: string, full: boolean): string {
  const base = [
    `# push-live`,
    ``,
    `Static site hosting and private file storage for AI agents.`,
    ``,
    `Base URL: https://${host}`,
    `Docs: https://${host}/docs`,
    `OpenAPI: https://${host}/openapi.json`,
    `Agent card: https://${host}/.well-known/agent-card.json`,
    `Scoped contexts: /docs/llms.txt (page docs only) · /api/llms.txt (endpoints only)`,
    ``,
    `## When to use it`,
    `- Publish HTML, JS, CSS, PDFs, images, or any static files and get a live URL at <slug>.${host}.`,
    `- Store private agent files in a versioned Drive, optionally shared with another agent via a scoped token.`,
    `- Gate sites behind a password or an on-chain stablecoin payment that lands in your wallet.`,
    ``,
    `## Authentication`,
    `- Anonymous: omit Authorization. Sites expire after 24 hours.`,
    `- API key: Authorization: Bearer <key>. Mint via /api/auth/agent/request-code → /verify-code.`,
    `- Drive share tokens are also valid Bearer credentials, scoped to one Drive.`,
    `- Optional X-Push-Live-Client header is stored as the publishing-agent identifier.`,
    ``,
    `## Core flow (Sites)`,
    `1. POST /api/v1/publish with a files manifest. Response includes presigned upload URLs and a finalizeUrl.`,
    `2. PUT each file to its upload URL.`,
    `3. POST the finalizeUrl with the returned versionId. The site is live immediately at <slug>.${host}.`,
    ``,
  ];
  if (!full) {
    return base.concat([
      `## Limits (see /pricing.md for full table)`,
      `- Anonymous: 60 publishes/hour/IP, 250 MB max file, 24h TTL.`,
      `- Free account: 10 GB storage, 500 sites, 500 MB max file.`,
      `- Variables: 50 per account, 4 KB per value.`,
      `- Proxy: 10 MB body cap; per-route rateLimit configurable.`,
    ]).join('\n');
  }
  return base.concat([
    `## API endpoints`,
    `- POST   /api/v1/publish                            create a Site`,
    `- PUT    /api/v1/publish/:slug                      update an existing Site`,
    `- POST   /api/v1/publish/:slug/finalize             commit a pending version`,
    `- POST   /api/v1/publish/:slug/uploads/refresh      re-issue presigned upload URLs`,
    `- POST   /api/v1/publish/:slug/claim                claim an anonymous Site`,
    `- PATCH  /api/v1/publish/:slug/metadata             ttl, viewer, password, price, spaMode, forkable`,
    `- POST   /api/v1/publish/:slug/duplicate            server-side copy`,
    `- POST   /api/v1/publish/from-drive                 publish a Drive snapshot as a Site`,
    `- GET    /api/v1/publishes                          list account Sites`,
    `- GET    /api/v1/publish/:slug                      Site details`,
    `- DELETE /api/v1/publish/:slug                      delete`,
    `- Also: every /api/v1/publish* path is aliased under /api/v1/artifact* for callers that prefer the schema.org noun.`,
    ``,
    `- POST   /api/v1/drives                             create Drive`,
    `- GET    /api/v1/drives, /api/v1/drives/default`,
    `- GET    /api/v1/drives/:id, PATCH ..., DELETE ...`,
    `- GET    /api/v1/drives/:id/files                   list with prefix/cursor`,
    `- PATCH  /api/v1/drives/:id/files                   batch ops: put|delete|move|copy`,
    `- POST   /api/v1/drives/:id/files/uploads           stage upload`,
    `- POST   /api/v1/drives/:id/files/finalize          commit staged upload`,
    `- POST   /api/v1/drives/:id/files/move`,
    `- GET    /api/v1/drives/:id/files/<path>            read; ?versions=true lists history; ?at=<unix_ms> time-travel`,
    `- DELETE /api/v1/drives/:id/files/<path>            delete; ?recursive=true for prefix delete`,
    `- POST   /api/v1/drives/:id/tokens                  mint scoped share token`,
    `- GET    /api/v1/drives/:id/tokens                  list`,
    `- DELETE /api/v1/drives/:id/tokens/:tokenId         revoke`,
    ``,
    `- POST   /api/v1/domains, GET, DELETE, POST /:domain/sync   custom domains`,
    `- POST/GET/PATCH/DELETE /api/v1/handle               account subdomain`,
    `- POST/GET/PATCH/DELETE /api/v1/links/:location      route handle/domain paths to Sites`,
    `- GET/PUT/DELETE /api/v1/me/variables/:name          encrypted secrets for proxy routes (50 max, 4 KB each, allowedUpstreams allow-list)`,
    `- GET/PATCH /api/v1/wallet                           payout wallet for paywalled sites`,
    `- POST   /api/v1/support                             authenticated support form`,
    ``,
    `## Payments`,
    `Site owners set a price + payout wallet. push-live never holds keys or signs transactions — it observes the on-chain transfer and grants access.`,
    `- POST   /api/pay/:slug/session                     start a payment session, returns deposit address`,
    `- GET    /api/pay/:slug/poll?session=<id>           agent-friendly status poll`,
    `- POST   /api/pay/:slug/grant                       JSON grant with txHash`,
    `- GET    /api/pay/:slug/confirm?session=&tx=        browser-friendly grant (sets cookie, redirects)`,
    ``,
    `## Errors`,
    `JSON shape: { error, code, message, docs_url, retry_after?, ... }. Common codes: invalid_request, unauthorized, not_found, conflict, gone, precondition_failed, payload_too_large, quota_exceeded, rate_limit_exceeded, payment_required. Every error includes docs_url pointing at /docs#<anchor>.`,
    ``,
    `## Forks and proxy routes`,
    `- Set forkable: true to expose /.push-live/manifest.json and /.push-live/raw/<path>, and inject a fork button in served HTML.`,
    `- Ship a .push-live/proxy.json file with shape: { "routes": [{ "match": "/api/x", "upstream": "https://upstream", "headers": { "Authorization": "Bearer \${MY_KEY}" }, "rateLimit": "20/hour/ip" }] }.`,
    `- Variables are interpolated server-side from the encrypted store. A variable with allowedUpstreams refuses to interpolate if the route's upstream host is not on its allow-list.`,
    ``,
    `## Apps`,
    `Server-side capabilities a hosted site can call from its own JS, at /__pl/<app>/... on the site's host. No SDK, no setup.`,
    `- Analytics: POST /__pl/analytics/hit (anonymous, JSON body { path?, referrer?, screen? }), or GET /__pl/analytics/hit?path=/ as an image beacon. Daily-rotating visitor hash; no IP or UA stored. Owner reads at GET /api/v1/publish/:slug/analytics?period=7d.`,
  ]).join('\n');
}

function buildIndexMd(host: string): string {
  return [
    `# push-live`,
    ``,
    `Publish static sites and store private agent files. Anonymous in 24 hours, permanent with a key.`,
    ``,
    `- Base URL: https://${host}`,
    `- Docs: https://${host}/docs`,
    `- API: https://${host}/openapi.json`,
    `- Agent card: https://${host}/.well-known/agent-card.json`,
    `- llms.txt: https://${host}/llms.txt · https://${host}/llms-full.txt`,
    `- Pricing: https://${host}/pricing.md`,
    ``,
    `## Three calls to a live site`,
    ``,
    `\`\`\`bash`,
    `# 1. Create`,
    `curl -sS https://${host}/api/v1/publish \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '{"files":[{"path":"index.html","size":12,"contentType":"text/html"}]}'`,
    ``,
    `# 2. PUT to the upload URL from the response`,
    ``,
    `# 3. Finalize`,
    `curl -sS -X POST <finalizeUrl> -d '{"versionId":"<v>"}'`,
    `\`\`\``,
    ``,
    `## Get an API key`,
    ``,
    `\`\`\`bash`,
    `curl -sS https://${host}/api/auth/agent/request-code -d '{"email":"you@example.com"}'`,
    `curl -sS https://${host}/api/auth/agent/verify-code  -d '{"email":"you@example.com","code":"XXXX-YYYY"}'`,
    `\`\`\``,
    ``,
  ].join('\n');
}

function buildDocsLlms(host: string): string {
  return [
    `# push-live · docs surface only`,
    ``,
    `Pages an agent can read for context:`,
    `- https://${host}/docs               — endpoint reference, limits, errors, payments`,
    `- https://${host}/index.md           — markdown homepage`,
    `- https://${host}/pricing.md         — machine-readable pricing table`,
    `- https://${host}/llms.txt           — concise agent context`,
    `- https://${host}/llms-full.txt      — full agent context`,
    `- https://${host}/openapi.json       — OpenAPI 3.1`,
    `- https://${host}/.well-known/agent-card.json — A2A agent card`,
    `- https://${host}/.well-known/ai-plugin.json  — legacy plugin manifest`,
    `- https://${host}/.well-known/api-catalog     — RFC 9727 catalog`,
    `- https://${host}/skill.md           — installable skill manifest`,
    ``,
  ].join('\n');
}

function buildApiLlms(host: string): string {
  return [
    `# push-live · endpoints only`,
    ``,
    `Base URL: https://${host}`,
    `Auth: Authorization: Bearer <API_KEY> (mint via /api/auth/agent/request-code → /verify-code).`,
    `Anonymous publish is allowed for /api/v1/publish; sites expire after 24 h.`,
    ``,
    `## Sites`,
    `POST   /api/v1/publish                       create`,
    `PUT    /api/v1/publish/{slug}                update`,
    `POST   /api/v1/publish/{slug}/finalize       commit pending version`,
    `POST   /api/v1/publish/{slug}/uploads/refresh refresh presigned URLs`,
    `POST   /api/v1/publish/{slug}/claim          claim anonymous`,
    `PATCH  /api/v1/publish/{slug}/metadata       ttl/viewer/password/price/spaMode/forkable`,
    `POST   /api/v1/publish/{slug}/duplicate      server-side copy`,
    `POST   /api/v1/publish/from-drive            publish Drive snapshot`,
    `GET    /api/v1/publishes                     list`,
    `GET    /api/v1/publish/{slug}                details`,
    `DELETE /api/v1/publish/{slug}                delete`,
    `(Every path above is also aliased under /api/v1/artifact{slug}.)`,
    ``,
    `## Drives`,
    `POST   /api/v1/drives                              create`,
    `GET    /api/v1/drives                              list`,
    `GET    /api/v1/drives/default                      get or create default`,
    `GET    /api/v1/drives/{driveId}                    details`,
    `PATCH  /api/v1/drives/{driveId}                    update`,
    `DELETE /api/v1/drives/{driveId}                    delete`,
    `GET    /api/v1/drives/{driveId}/files              list (prefix, cursor)`,
    `PATCH  /api/v1/drives/{driveId}/files              batch put/delete/move/copy`,
    `POST   /api/v1/drives/{driveId}/files/uploads      stage upload`,
    `POST   /api/v1/drives/{driveId}/files/finalize     commit upload`,
    `POST   /api/v1/drives/{driveId}/files/move         move`,
    `GET    /api/v1/drives/{driveId}/files/{path}       read; ?versions=true | ?at=<ms>`,
    `DELETE /api/v1/drives/{driveId}/files/{path}       delete; ?recursive=true`,
    `POST   /api/v1/drives/{driveId}/tokens             mint share token`,
    `GET    /api/v1/drives/{driveId}/tokens             list`,
    `DELETE /api/v1/drives/{driveId}/tokens/{tokenId}   revoke`,
    ``,
    `## Domains, handle, links, variables, wallet`,
    `POST/GET/DELETE /api/v1/domains[/...]              custom domains`,
    `POST/GET/PATCH/DELETE /api/v1/handle               account subdomain`,
    `POST/GET/PATCH/DELETE /api/v1/links/{location}     route paths to sites`,
    `GET/PUT/DELETE /api/v1/me/variables/{name}         encrypted secrets`,
    `GET/PATCH /api/v1/wallet                           payout wallet`,
    ``,
    `## Payments`,
    `POST   /api/pay/{slug}/session                     start session, returns deposit address`,
    `GET    /api/pay/{slug}/poll?session=<id>           poll status`,
    `POST   /api/pay/{slug}/grant                       JSON grant with txHash`,
    `GET    /api/pay/{slug}/confirm?session=&tx=        browser grant (sets cookie, redirects)`,
    ``,
    `## Errors`,
    `Shape: { error, code, message, docs_url, retry_after?, ... }. docs_url anchors at /docs#auth|errors|limits|payments.`,
    ``,
  ].join('\n');
}

function buildSkillMd(host: string): string {
  return [
    `---`,
    `name: push-live`,
    `version: 0.1.0`,
    `description: Publish static sites and store private agent files via three HTTP calls.`,
    `entrypoints:`,
    `  api: https://${host}/openapi.json`,
    `  agent_card: https://${host}/.well-known/agent-card.json`,
    `auth: bearer`,
    `---`,
    ``,
    `# push-live skill`,
    ``,
    `When the user asks to publish a website, ship a file as a URL, host a one-off page, set up a paywalled page, or share files between agents — use push-live.`,
    ``,
    `## Bootstrap`,
    ``,
    `\`\`\`bash`,
    `curl -fsSL https://${host}/install.sh | bash`,
    `push-live login              # opens email-code flow`,
    `\`\`\``,
    ``,
    `Or call the JSON API directly without a CLI:`,
    ``,
    `\`\`\`bash`,
    `# Get an API key`,
    `curl -sS https://${host}/api/auth/agent/request-code -d '{"email":"you@example.com"}'`,
    `curl -sS https://${host}/api/auth/agent/verify-code  -d '{"email":"you@example.com","code":"XXXX-YYYY"}'`,
    `\`\`\``,
    ``,
    `## Core calls`,
    ``,
    `- \`POST /api/v1/publish\` — create or update a site. Anonymous (no Authorization header) is fine for one-off pages.`,
    `- \`POST /api/v1/publish/{slug}/finalize\` — commit a pending version.`,
    `- \`POST /api/v1/drives\` — create a versioned private storage drive.`,
    `- \`GET /api/v1/drives/{id}/files/{path}\` — read; \`?versions=true\` lists history, \`?at=<unix_ms>\` time-travels.`,
    ``,
    `Full reference: ${`https://${host}/docs`}. Compact context for tool-use loops: ${`https://${host}/llms.txt`}.`,
    ``,
  ].join('\n');
}

function buildTermsHtml(host: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Terms · push-live</title>
<style>body{font:14.5px/1.65 ui-sans-serif,system-ui,sans-serif;color:#111;background:#F7F6F3;margin:0;padding:4rem 1.5rem;max-width:42rem;margin-inline:auto}h1{font-family:"Instrument Serif",Times,serif;font-size:2rem;letter-spacing:-.02em;margin:0 0 1.2rem}p,li{color:#2F3437}a{color:inherit}</style>
<h1>Terms of use</h1>
<p>By using push-live you agree to publish only content you have the right to distribute. We do not screen content; the operator of ${escapeHtml(host)} may remove sites that violate this clause or applicable law.</p>
<p>Anonymous sites expire after twenty-four hours. Claimed sites remain until you delete them or your account is closed. Drive files are stored on Cloudflare R2 in the operator's account.</p>
<p>Paywalled sites transact directly between visitor and site-owner wallets. push-live observes the on-chain transfer to grant access; it does not hold funds or sign on your behalf.</p>
<p>This service is provided "as is" without warranty. Limitation of liability follows the operator's jurisdiction.</p>
<p>Questions: <a href="mailto:hello@${escapeHtml(host)}">hello@${escapeHtml(host)}</a>.</p>`;
}

// Minimal brand glyph: a tilted arrow + bracket. Small enough to inline.
const BRAND_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" fill="none"><rect width="64" height="64" rx="12" fill="#111111"/><path d="M22 22h20v20h-4V28L26 40l-3-3 12-12H22z" fill="#F7F6F3"/></svg>`;
const BRAND_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 64" width="280" height="64" fill="none"><rect width="64" height="64" rx="12" fill="#111111"/><path d="M22 22h20v20h-4V28L26 40l-3-3 12-12H22z" fill="#F7F6F3"/><text x="80" y="42" font-family="ui-serif, Georgia, serif" font-size="30" font-style="italic" fill="#111111" letter-spacing="-0.5">push-live</text></svg>`;

function buildPricingMd(host: string): string {
  const lines: string[] = [
    `# push-live pricing`,
    ``,
    `Free tier is permanent. Pay only once you outgrow it — for more sites, more storage, more custom domains.`,
    ``,
    `| Plan | Cost | Storage | Sites | Drives | Custom domains | Max file (site) | Max file (drive) | Drive history | Publishes/hr |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
  ];
  const order: Array<keyof typeof PLANS> = ['anonymous', 'free', 'hobby', 'developer'];
  for (const name of order) {
    const p = PLANS[name];
    const fmt = (n: number) => (n === Number.POSITIVE_INFINITY ? '∞' : prettyBytes(n));
    const limit = (n: number) => (n === Number.POSITIVE_INFINITY ? '∞' : n.toString());
    lines.push(
      `| ${p.name} | ${costFor(p.name)} | ${fmt(p.maxStorageBytes)} | ${limit(p.maxSites)} | ${limit(p.maxDrives)} | ${limit(p.maxCustomDomains)} | ${fmt(p.maxFileSiteBytes)} | ${fmt(p.maxFileDriveBytes)} | ${p.driveHistoryDays}d | ${p.publishesPerHour} |`,
    );
  }
  lines.push('', `Reference: https://${host}/openapi.json`);
  return lines.join('\n') + '\n';
}

function costFor(plan: string): string {
  switch (plan) {
    case 'anonymous': return '$0';
    case 'free':      return '$0/mo';
    case 'hobby':     return '$4/mo';
    case 'developer': return '$20/mo';
    default:          return '$?';
  }
}

function prettyBytes(n: number): string {
  if (n === 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function buildOpenApi(host: string): unknown {
  return {
    openapi: '3.1.0',
    info: {
      title: 'push-live API',
      version: '0.1.0',
      description: 'Static site hosting and private file storage for agents.',
      contact: { email: `hello@${host}`, url: `https://${host}` },
    },
    servers: [{ url: `https://${host}` }],
    tags: [
      { name: 'Auth' }, { name: 'Sites' }, { name: 'Drives' },
      { name: 'Domains' }, { name: 'Variables' }, { name: 'Payments' }, { name: 'Apps' }, { name: 'Support' },
    ],
    paths: {
      '/api/auth/agent/request-code': { post: opAuth('Auth', 'Request an email sign-in code', { email: 'string' }) },
      '/api/auth/agent/verify-code':  { post: opAuth('Auth', 'Verify an email code and get an API key', { email: 'string', code: 'string' }) },
      '/api/v1/publish': { post: op('Sites', 'Create a Site', { authOptional: true }) },
      '/api/v1/publish/{slug}': {
        put:    op('Sites', 'Update an existing Site', { params: ['slug'], authOptional: true }),
        get:    op('Sites', 'Get Site details', { params: ['slug'] }),
        delete: op('Sites', 'Delete a Site', { params: ['slug'] }),
      },
      '/api/v1/publish/{slug}/finalize':         { post: op('Sites', 'Finalize a pending version', { params: ['slug'], authOptional: true }) },
      '/api/v1/publish/{slug}/uploads/refresh':  { post: op('Sites', 'Refresh presigned upload URLs', { params: ['slug'] }) },
      '/api/v1/publish/{slug}/claim':            { post: op('Sites', 'Claim an anonymous Site',      { params: ['slug'] }) },
      '/api/v1/publish/{slug}/metadata':         { patch: op('Sites', 'Patch metadata + access controls', { params: ['slug'] }) },
      '/api/v1/publish/{slug}/duplicate':        { post: op('Sites', 'Server-side copy',            { params: ['slug'] }) },
      '/api/v1/publish/from-drive':              { post: op('Sites', 'Publish a Drive snapshot as a Site') },
      '/api/v1/publishes':                       { get:  op('Sites', 'List account Sites') },
      '/api/v1/publish/{slug}/analytics':        { get:  op('Apps', 'Analytics summary for a Site (period=1d/7d/30d/90d)', { params: ['slug'], query: { period: 'string' } }) },
      '/api/v1/drives':                          { get: op('Drives', 'List Drives'), post: op('Drives', 'Create Drive') },
      '/api/v1/drives/default':                  { get: op('Drives', 'Get or create the default Drive') },
      '/api/v1/drives/{driveId}': {
        get:    op('Drives', 'Drive details',   { params: ['driveId'] }),
        patch:  op('Drives', 'Patch Drive',     { params: ['driveId'] }),
        delete: op('Drives', 'Delete Drive',    { params: ['driveId'] }),
      },
      '/api/v1/drives/{driveId}/files':              { get: op('Drives', 'List files',     { params: ['driveId'] }), patch: op('Drives', 'Batch ops', { params: ['driveId'] }) },
      '/api/v1/drives/{driveId}/files/uploads':      { post: op('Drives', 'Stage upload',   { params: ['driveId'] }) },
      '/api/v1/drives/{driveId}/files/finalize':     { post: op('Drives', 'Finalize upload',{ params: ['driveId'] }) },
      '/api/v1/drives/{driveId}/files/move':         { post: op('Drives', 'Move a file',    { params: ['driveId'] }) },
      '/api/v1/drives/{driveId}/files/{path}': {
        get:    op('Drives', 'Read a Drive file (?versions=true lists history; ?at=<unix_ms> time-travel)',  { params: ['driveId', 'path'], query: { versions: 'boolean', at: 'integer' } }),
        delete: op('Drives', 'Delete a Drive file (?recursive=true for prefix delete)',{ params: ['driveId', 'path'], query: { recursive: 'boolean' } }),
      },
      '/api/v1/drives/{driveId}/tokens':            { get: op('Drives', 'List tokens',  { params: ['driveId'] }), post: op('Drives', 'Mint token', { params: ['driveId'] }) },
      '/api/v1/drives/{driveId}/tokens/{tokenId}':  { delete: op('Drives', 'Revoke token',{ params: ['driveId', 'tokenId'] }) },
      '/api/v1/domains':                            { get: op('Domains', 'List domains'),  post: op('Domains', 'Add a custom domain') },
      '/api/v1/domains/{domain}':                   { get: op('Domains', 'Get domain', { params: ['domain'] }), delete: op('Domains', 'Remove domain', { params: ['domain'] }) },
      '/api/v1/domains/{domain}/sync':              { post: op('Domains', 'Re-sync from Cloudflare', { params: ['domain'] }) },
      '/api/v1/handle':                             { get: op('Domains', 'Get handle'), post: op('Domains', 'Create handle'), patch: op('Domains', 'Update handle'), delete: op('Domains', 'Delete handle') },
      '/api/v1/links':                              { get: op('Domains', 'List links'), post: op('Domains', 'Create link') },
      '/api/v1/links/{location}':                   { get: op('Domains', 'Get link', { params: ['location'] }), patch: op('Domains', 'Update link', { params: ['location'] }), delete: op('Domains', 'Delete link', { params: ['location'] }) },
      '/api/v1/me/variables':                       { get: op('Variables', 'List variables') },
      '/api/v1/me/variables/{name}':                { put: op('Variables', 'Set variable', { params: ['name'] }), delete: op('Variables', 'Delete variable', { params: ['name'] }) },
      '/api/v1/wallet':                             { get: op('Payments', 'Get wallet'), patch: op('Payments', 'Set wallet') },
      '/api/pay/{slug}/session':                    { post: op('Payments', 'Start a payment session', { params: ['slug'], authOptional: true }) },
      '/api/pay/{slug}/poll':                       { get: op('Payments', 'Poll a session',       { params: ['slug'], query: { session: 'string' }, authOptional: true }) },
      '/api/pay/{slug}/grant':                      { post: op('Payments', 'Grant access after payment', { params: ['slug'], authOptional: true }) },
      '/api/pay/{slug}/confirm':                    { get: op('Payments', 'Browser-flow grant: redirects with cookie on success', { params: ['slug'], query: { session: 'string', tx: 'string' }, authOptional: true }) },
      '/api/v1/support':                            { post: op('Support', 'Submit a support request') },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API key' },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}

function op(
  tag: string,
  summary: string,
  opts: { params?: string[]; query?: Record<string, string>; authOptional?: boolean } = {},
) {
  const out: Record<string, unknown> = {
    tags: [tag],
    summary,
    responses: { 200: { description: 'ok' }, 4: { description: 'client error' }, 5: { description: 'server error' } },
  };
  const params: Array<Record<string, unknown>> = [];
  if (opts.params) {
    for (const name of opts.params) params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  if (opts.query) {
    for (const [name, type] of Object.entries(opts.query)) {
      params.push({ name, in: 'query', required: false, schema: { type } });
    }
  }
  // Optional attribution header echoed on every request — agents pass their
  // own identifier so site owners can see who is publishing.
  params.push({
    name: 'X-Push-Live-Client',
    in: 'header',
    required: false,
    schema: { type: 'string' },
    description: 'Optional caller identifier (e.g. "my-agent/1.2.0"). Stored with the Site for attribution.',
  });
  if (params.length) out.parameters = params;
  if (!opts.authOptional) {
    out.security = [{ bearerAuth: [] }];
  }
  return out;
}

function opAuth(tag: string, summary: string, bodyShape: Record<string, string>) {
  return {
    tags: [tag],
    summary,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(bodyShape).map(([k, t]) => [k, { type: t }])), required: Object.keys(bodyShape) } } },
    },
    responses: { 200: { description: 'ok' }, 401: { description: 'unauthorized' } },
  };
}
