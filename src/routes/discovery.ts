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

discoveryRouter.get('/.well-known/agent-card.json', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  return c.json({
    schema_version: 'v1',
    name_for_human: 'push-live',
    name_for_model: 'push-live',
    description_for_human: 'Static hosting + private storage built for agents.',
    description_for_model:
      'Use push-live to publish static websites and store private agent files. Anonymous publish creates a 24h site at <slug>.' + host + '. Authenticated publish uses an API key acquired via the email-code flow. Drives provide versioned storage with scoped share tokens.',
    api: {
      type: 'openapi',
      url: `https://${host}/openapi.json`,
    },
    auth: { type: 'bearer', is_user_authenticated: false },
    contact_email: `hello@${host}`,
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
  return c.json({
    linkset: [
      {
        anchor: `https://${host}`,
        'service-desc': [{ href: `https://${host}/openapi.json`, type: 'application/vnd.oai.openapi+json;version=3.1' }],
        'service-doc': [{ href: `https://${host}/docs`, type: 'text/html' }],
        describedby: [
          { href: `https://${host}/llms.txt`, type: 'text/plain', title: 'Concise agent context' },
          { href: `https://${host}/llms-full.txt`, type: 'text/plain', title: 'Full agent context' },
          { href: `https://${host}/pricing.md`, type: 'text/markdown', title: 'Machine-readable pricing' },
        ],
      },
    ],
  }, 200, { 'content-type': 'application/linkset+json' });
});

discoveryRouter.get('/schema-map.xml', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<schemaMap xmlns="https://${host}/ns/schema-map">
  <url>
    <loc>https://${host}/openapi.json</loc>
    <type>OpenAPI</type>
    <encoding>application/vnd.oai.openapi+json;version=3.1</encoding>
  </url>
  <url>
    <loc>https://${host}/llms-full.txt</loc>
    <type>LLMSText</type>
    <encoding>text/plain</encoding>
  </url>
  <url>
    <loc>https://${host}/pricing.md</loc>
    <type>PricingMarkdown</type>
    <encoding>text/markdown</encoding>
  </url>
  <url>
    <loc>https://${host}/schema-feeds/agent-resources.jsonl</loc>
    <type>JSONL</type>
    <encoding>application/jsonl</encoding>
  </url>
</schemaMap>`;
  return c.text(xml, 200, { 'content-type': 'application/xml; charset=utf-8' });
});

discoveryRouter.get('/schema-feeds/agent-resources.jsonl', (c) => {
  const host = c.env.PUBLIC_APEX_HOST;
  const lines = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebAPI',
      name: 'push-live API',
      url: `https://${host}/openapi.json`,
      documentation: `https://${host}/docs`,
      description: 'Static hosting and private file storage API for agents.',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'push-live',
      url: `https://${host}`,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
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
<p class="lede">Auto-generated from <a href="/openapi.json">openapi.json</a>. Compact agent context lives at <a href="/llms.txt">llms.txt</a> and <a href="/llms-full.txt">llms-full.txt</a>.</p>

<h2>Quick start</h2>
<pre><code># 1. Create
curl -sS https://${escapeHtml(host)}/api/v1/publish \\
  -H 'content-type: application/json' \\
  -d '{"files":[{"path":"index.html","size":12,"contentType":"text/html"}]}'

# 2. PUT to the upload URL from the response

# 3. Finalize
curl -sS -X POST &lt;finalizeUrl&gt; -d '{"versionId":"&lt;v&gt;"}'</code></pre>

<h2>Get an API key</h2>
<pre><code>curl -sS https://${escapeHtml(host)}/api/auth/agent/request-code -d '{"email":"you@example.com"}'
curl -sS https://${escapeHtml(host)}/api/auth/agent/verify-code -d '{"email":"you@example.com","code":"XXXX-YYYY"}'</code></pre>

<h2>Endpoints</h2>
<p class="muted"><span class="tag tag--yellow">auth</span> means <code>Authorization: Bearer &lt;API_KEY&gt;</code> is required. Drive share tokens are also accepted on <code>/api/v1/drives/*</code> endpoints.</p>
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
    `Static site hosting and private file storage for AI agents, running on Cloudflare Workers + R2 + D1.`,
    ``,
    `Base URL: https://${host}`,
    `Docs: https://${host}/docs`,
    `OpenAPI: https://${host}/openapi.json`,
    ``,
    `## When to use it`,
    `- Publish HTML, JS, CSS, PDFs, images, or any static files and get a live URL at <slug>.${host}.`,
    `- Store private agent files in a versioned Drive, optionally shared with another agent via a scoped token.`,
    `- Gate sites behind a password or an on-chain stablecoin payment.`,
    ``,
    `## Authentication`,
    `- Anonymous: omit Authorization. Sites expire after 24 hours.`,
    `- API key: Authorization: Bearer <key>. Mint via /api/auth/agent/request-code → /verify-code.`,
    `- Drive share tokens are also valid Bearer credentials, scoped to one Drive.`,
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
      `- Free account: 10 GB storage, 500 sites.`,
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
    ``,
    `- POST   /api/v1/drives                             create Drive`,
    `- GET    /api/v1/drives, /api/v1/drives/default`,
    `- GET    /api/v1/drives/:id, PATCH ..., DELETE ...`,
    `- GET    /api/v1/drives/:id/files                   list with prefix/cursor`,
    `- PATCH  /api/v1/drives/:id/files                   batch ops: put|delete|move|copy`,
    `- POST   /api/v1/drives/:id/files/uploads           stage upload`,
    `- POST   /api/v1/drives/:id/files/finalize          commit staged upload`,
    `- POST   /api/v1/drives/:id/files/move`,
    `- GET    /api/v1/drives/:id/files/<path>            read`,
    `- DELETE /api/v1/drives/:id/files/<path>            delete (recursive=true supported)`,
    `- POST   /api/v1/drives/:id/tokens                  mint scoped share token`,
    `- GET    /api/v1/drives/:id/tokens                  list`,
    `- DELETE /api/v1/drives/:id/tokens/:tokenId         revoke`,
    ``,
    `- POST   /api/v1/domains, GET, DELETE, POST /:domain/sync   custom domains via Cloudflare for SaaS`,
    `- POST/GET/PATCH/DELETE /api/v1/handle               account subdomain`,
    `- POST/GET/PATCH/DELETE /api/v1/links/:location      route handle/domain paths to Sites`,
    `- GET/PUT/DELETE /api/v1/me/variables/:name          encrypted secrets for proxy routes`,
    `- GET/PATCH /api/v1/wallet                           Tempo wallet for paywalled sites`,
    `- POST   /api/v1/support                             authenticated support form`,
    ``,
    `## Errors`,
    `JSON shape: { code, message, retry_after?, ... }. Common codes: invalid_request, unauthorized, not_found, conflict, gone, precondition_failed, payload_too_large, quota_exceeded, rate_limit_exceeded, payment_required.`,
    ``,
    `## Forks and proxy routes`,
    `- Set forkable: true to expose /.push-live/manifest.json and /.push-live/raw/<path>, and inject a fork button in served HTML.`,
    `- Ship a .push-live/proxy.json file to route some paths to upstream APIs. Headers can include \${VARIABLE_NAME} which is resolved server-side from the encrypted variables store.`,
  ]).join('\n');
}

function buildPricingMd(host: string): string {
  const lines: string[] = [
    `# push-live pricing`,
    ``,
    `Source-available clone, self-hosted on Cloudflare. The numbers below are the defaults baked into src/lib/quotas.ts and can be edited.`,
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
      { name: 'Domains' }, { name: 'Variables' }, { name: 'Payments' }, { name: 'Support' },
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
        get:    op('Drives', 'Read a Drive file',  { params: ['driveId', 'path'] }),
        delete: op('Drives', 'Delete a Drive file',{ params: ['driveId', 'path'] }),
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
      '/api/pay/{slug}/session':                    { post: op('Payments', 'Start a payment session', { params: ['slug'] }) },
      '/api/pay/{slug}/poll':                       { get: op('Payments', 'Poll a session',       { params: ['slug'] }) },
      '/api/pay/{slug}/grant':                      { post: op('Payments', 'Grant access after payment', { params: ['slug'] }) },
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

function op(tag: string, summary: string, opts: { params?: string[]; authOptional?: boolean } = {}) {
  const out: Record<string, unknown> = {
    tags: [tag],
    summary,
    responses: { 200: { description: 'ok' }, 4: { description: 'client error' }, 5: { description: 'server error' } },
  };
  if (opts.params) {
    out.parameters = opts.params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
  }
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
