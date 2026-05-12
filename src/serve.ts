import type { Env } from './types.ts';
import { casKey, sha256Hex } from './lib/hash.ts';
import { tryProxyRoute } from './proxy.ts';
import { verifyGrantToken, loadSitePrice } from './routes/pay.ts';

const NOT_FOUND_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title>
<style>body{font:14px/1.5 system-ui;padding:6rem 2rem;max-width:40rem;margin:auto;color:#1a1a1a}</style></head>
<body><h1>404 — not found</h1><p>This site exists but no file matched this path.</p></body></html>`;

const PASSWORD_FORM_HTML = (slug: string, error?: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Protected · ${escapeHtml(slug)}</title>
<style>
body{font:14px/1.5 system-ui;background:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0}
.box{background:#fff;border:1px solid #e5e5e5;padding:2rem;max-width:24rem;width:100%;border-radius:6px}
input{width:100%;padding:.6rem;border:1px solid #d4d4d8;border-radius:4px;font-size:14px;box-sizing:border-box}
button{margin-top:.75rem;width:100%;padding:.6rem;background:#18181b;color:#fff;border:0;border-radius:4px;cursor:pointer}
.err{color:#b91c1c;margin-top:.5rem;font-size:13px}
h1{margin:0 0 .5rem;font-size:1rem}
p{margin:0 0 1rem;color:#52525b;font-size:13px}
</style></head><body><form class="box" method="post"><h1>Password required</h1>
<p>Enter the password to view this site.</p>
<input type="password" name="password" autofocus required>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
<button type="submit">Unlock</button></form></body></html>`;

const FORK_BUTTON_SNIPPET = (host: string, slug: string) => `
<style id="__sl_fork_style">
#__sl_fork{position:fixed;right:14px;bottom:14px;z-index:2147483647;font:13px ui-sans-serif,system-ui,sans-serif}
#__sl_fork button{background:#18181b;color:#fff;border:0;padding:8px 12px;border-radius:6px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12)}
#__sl_fork small{display:block;margin-top:4px;color:#fff;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:4px}
#__sl_fork[hidden]{display:none}
</style>
<div id="__sl_fork"><button type="button" onclick="(async()=>{const p=\`Fork this site: download every file listed at https://${host}/s/${slug}/.sloop/manifest.json (raw download base: https://${host}/s/${slug}/.sloop/raw/), then ask the user what to change before re-publishing via sloop.\`;try{await navigator.clipboard.writeText(p);this.textContent='Copied — paste into your agent';}catch(e){prompt('Copy this prompt',p);}})()">Fork this site</button></div>
`;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type SiteRow = {
  current_version_id: string | null;
  status: string;
  expires_at: number | null;
  spa_mode: number;
  forkable: number;
  password_hash: string | null;
  price_amount: string | null;
  viewer_title: string | null;
  viewer_description: string | null;
  viewer_og_image: string | null;
  owner_user_id: string | null;
};

export async function serveSite(
  env: Env,
  slug: string,
  pathname: string,
  req: Request,
): Promise<Response> {
  const site = await loadSite(env, slug);
  if (!site || site.status === 'deleted' || !site.current_version_id) {
    return new Response('Site not found', { status: 404 });
  }
  if (site.expires_at && site.expires_at < Date.now()) {
    return new Response('Site expired', { status: 410 });
  }
  const versionId = site.current_version_id;

  // ----- Fork helpers -----
  if (pathname === '/.sloop/manifest.json') {
    if (!site.forkable) return new Response('Not forkable', { status: 404 });
    return serveManifest(env, slug, versionId);
  }
  if (pathname.startsWith('/.sloop/raw/')) {
    if (!site.forkable) return new Response('Not forkable', { status: 404 });
    const path = pathname.slice('/.sloop/raw/'.length);
    return serveRawFile(env, versionId, path);
  }

  // ----- Payment gate -----
  let paymentGrantCookie: string | null = null;
  if (site.price_amount) {
    const url = new URL(req.url);
    const queryGrant = url.searchParams.get('__sl_grant');
    let granted = false;
    if (queryGrant && (await verifyGrantToken(env, slug, queryGrant))) {
      granted = true;
      // Set the cookie on the eventual served response so subsequent loads of
      // unrelated assets (without the query param) also pass the gate.
      paymentGrantCookie = `sl_pay_${slug}=${queryGrant}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
    } else {
      const cookie = parseCookies(req.headers.get('cookie'))[`sl_pay_${slug}`];
      granted = cookie ? await verifyGrantToken(env, slug, cookie) : false;
    }
    if (!granted) return paymentRequiredResponse(env, slug, req);
  }

  // ----- Proxy routes (.sloop/proxy.json) -----
  const proxied = await tryProxyRoute(env, slug, versionId, site.owner_user_id, pathname, req);
  if (proxied) return proxied;

  // ----- Password gate -----
  if (site.password_hash) {
    const cookie = parseCookies(req.headers.get('cookie'))[`sl_pw_${slug}`];
    const cookieOk = cookie === site.password_hash.slice(0, 32);
    if (!cookieOk) {
      if (req.method === 'POST') {
        const form = await req.formData();
        const submitted = String(form.get('password') ?? '');
        if ((await sha256Hex(submitted)) === site.password_hash) {
          const headers = new Headers({ location: req.url });
          headers.append(
            'set-cookie',
            `sl_pw_${slug}=${site.password_hash.slice(0, 32)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
          );
          return new Response(null, { status: 302, headers });
        }
        return htmlResponse(PASSWORD_FORM_HTML(slug, 'Incorrect password'), 401);
      }
      return htmlResponse(PASSWORD_FORM_HTML(slug), 401);
    }
  }

  // ----- Resolve file -----
  let path = pathname.replace(/^\/+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';

  let file = await lookupFile(env, versionId, path);
  if (!file && !path.endsWith('.html') && !path.includes('.')) {
    file = await lookupFile(env, versionId, `${path}/index.html`);
  }
  if (!file && site.spa_mode) {
    file = await lookupFile(env, versionId, 'index.html');
  }
  if (!file) {
    // Auto file viewer / directory listing fallback. The original docs promise
    // this rather than a 404 when a site has no index.html at the requested path.
    return renderAutoViewer(env, slug, versionId, site, pathname, paymentGrantCookie);
  }

  // Conditional GET: if the client sent matching If-None-Match, skip the body.
  const ifNoneMatch = req.headers.get('if-none-match');
  const etag = `"${file.sha256}"`;
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    const headers = new Headers({ etag, 'cache-control': 'public, max-age=60' });
    if (paymentGrantCookie) headers.append('set-cookie', paymentGrantCookie);
    return new Response(null, { status: 304, headers });
  }

  // HEAD: same headers, no body, no R2 fetch.
  if (req.method === 'HEAD') {
    const headers = new Headers({
      'content-type': file.content_type,
      'content-length': String(file.size),
      'cache-control': 'public, max-age=60',
      etag,
      'accept-ranges': 'bytes',
    });
    if (paymentGrantCookie) headers.append('set-cookie', paymentGrantCookie);
    return new Response(null, { status: 200, headers });
  }

  // Range request: ask R2 only for the slice the client wants.
  const rangeHeader = req.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, file.size) : null;

  const obj = await env.SITES.get(casKey(file.sha256), range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!obj) return new Response('Missing storage object', { status: 502 });

  const isHtml = file.content_type.includes('text/html');
  if (isHtml && site.forkable && !range) {
    const html = await obj.text();
    const injected = injectForkButton(html, env.PUBLIC_APEX_HOST, slug);
    const headers = new Headers({
      'content-type': file.content_type,
      'cache-control': 'public, max-age=60',
      etag,
      'accept-ranges': 'bytes',
    });
    if (paymentGrantCookie) headers.append('set-cookie', paymentGrantCookie);
    return new Response(injected, { headers });
  }

  const status = range ? 206 : 200;
  const length = range ? range.end - range.start + 1 : file.size;
  const headers = new Headers({
    'content-type': file.content_type,
    'content-length': String(length),
    'cache-control': 'public, max-age=60',
    etag,
    'accept-ranges': 'bytes',
  });
  if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${file.size}`);
  if (paymentGrantCookie) headers.append('set-cookie', paymentGrantCookie);
  return new Response(obj.body, { status, headers });
}

function etagMatches(ifNoneMatch: string, current: string): boolean {
  if (ifNoneMatch.trim() === '*') return true;
  for (const tag of ifNoneMatch.split(',')) {
    if (tag.trim().replace(/^W\//, '') === current) return true;
  }
  return false;
}

// Parse a simple `bytes=start-end` or `bytes=start-` Range header. Returns
// null on multi-range, malformed, or out-of-bounds — caller falls back to 200.
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === '') {
    // suffix range: bytes=-N → last N bytes
    if (endStr === '') return null;
    const n = parseInt(endStr, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  if (end >= size) end = size - 1;
  return { start, end };
}

async function loadSite(env: Env, slug: string): Promise<SiteRow | null> {
  const versionId = await env.KV.get(`site:${slug}:version`);
  if (versionId) {
    const row = await env.DB.prepare(
      `SELECT status, expires_at, spa_mode, forkable, password_hash, price_amount, viewer_title, viewer_description, viewer_og_image, owner_user_id
       FROM sites WHERE slug = ?1`,
    )
      .bind(slug)
      .first<Omit<SiteRow, 'current_version_id'>>();
    if (!row) return null;
    return { ...row, current_version_id: versionId };
  }
  const row = await env.DB.prepare(
    `SELECT current_version_id, status, expires_at, spa_mode, forkable, password_hash, price_amount, viewer_title, viewer_description, viewer_og_image, owner_user_id
     FROM sites WHERE slug = ?1`,
  )
    .bind(slug)
    .first<SiteRow>();
  if (row?.current_version_id) {
    await env.KV.put(`site:${slug}:version`, row.current_version_id, { expirationTtl: 300 });
  }
  return row;
}

async function lookupFile(env: Env, versionId: string, path: string) {
  return env.DB.prepare(
    `SELECT path, size, content_type, sha256 FROM site_files WHERE version_id = ?1 AND path = ?2`,
  )
    .bind(versionId, path)
    .first<{ path: string; size: number; content_type: string; sha256: string }>();
}

async function renderAutoViewer(
  env: Env,
  slug: string,
  versionId: string,
  site: SiteRow,
  pathname: string,
  paymentGrantCookie: string | null,
): Promise<Response> {
  const prefix = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const likePrefix = prefix ? `${prefix}/%` : '%';
  const rows = await env.DB.prepare(
    `SELECT path, size, content_type FROM site_files
     WHERE version_id = ?1 AND path LIKE ?2
     ORDER BY path ASC`,
  ).bind(versionId, likePrefix).all<{ path: string; size: number; content_type: string }>();
  const files = rows.results ?? [];
  if (files.length === 0) {
    return htmlResponse(NOT_FOUND_HTML, 404);
  }

  // Group immediate children: any path with another slash after the prefix becomes a folder entry.
  type Entry = { name: string; href: string; kind: 'file' | 'folder'; size?: number; contentType?: string };
  const folders = new Set<string>();
  const filesHere: Entry[] = [];
  const depth = prefix ? prefix.split('/').length : 0;
  for (const f of files) {
    const segs = f.path.split('/');
    if (segs.length === depth + 1) {
      const name = segs[segs.length - 1];
      filesHere.push({
        name,
        href: '/' + f.path,
        kind: 'file',
        size: f.size,
        contentType: f.content_type,
      });
    } else if (segs.length > depth + 1) {
      folders.add(segs[depth]);
    }
  }

  const entries: Entry[] = [
    ...[...folders].sort().map((n) => ({ name: n + '/', href: (prefix ? '/' + prefix : '') + '/' + n + '/', kind: 'folder' as const })),
    ...filesHere.sort((a, b) => a.name.localeCompare(b.name)),
  ];

  const title = site.viewer_title?.trim() || slug;
  const description = site.viewer_description?.trim() || '';
  const ogImage = site.viewer_og_image?.trim();
  const ogUrl = ogImage ? `/${ogImage.replace(/^\/+/, '')}` : null;
  const upHref = prefix ? '/' + prefix.split('/').slice(0, -1).join('/') + (prefix.includes('/') ? '/' : '') : null;

  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=30' });
  if (paymentGrantCookie) headers.append('set-cookie', paymentGrantCookie);

  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}${prefix ? ` / ${escapeHtml(prefix)}` : ''}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
<meta property="og:title" content="${escapeHtml(title)}">
${description ? `<meta property="og:description" content="${escapeHtml(description)}">` : ''}
${ogUrl ? `<meta property="og:image" content="${escapeHtml(ogUrl)}">` : ''}
<style>
:root{--ink:#0a0a0a;--muted:#71717a;--rule:#e4e4e7;--soft:#fafafa}
*{box-sizing:border-box}
body{font:14.5px/1.55 ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:#fff;margin:0}
main{max-width:48rem;margin:0 auto;padding:3rem 1.5rem 5rem}
h1{font-size:1.4rem;letter-spacing:-.02em;margin:0 0 .25rem}
p.desc{color:var(--muted);margin:0 0 .8rem}
.crumbs{color:var(--muted);font-size:13px;margin-bottom:1.5rem}
.crumbs code{font:13px ui-monospace,Menlo,monospace;background:var(--soft);padding:.1em .3em;border-radius:3px}
.cover{margin:1rem 0 2rem;max-width:100%;border:1px solid var(--rule);border-radius:6px}
ul.list{list-style:none;padding:0;margin:0;border:1px solid var(--rule);border-radius:6px;overflow:hidden}
ul.list li{display:flex;align-items:center;gap:.8rem;padding:.55rem .9rem;border-bottom:1px solid var(--rule)}
ul.list li:last-child{border-bottom:0}
ul.list li:hover{background:var(--soft)}
ul.list a{color:var(--ink);text-decoration:none;flex:1;font:14px ui-monospace,Menlo,monospace}
ul.list .size{color:var(--muted);font:12px ui-monospace,Menlo,monospace}
.icon{width:14px;color:var(--muted);text-align:center}
footer{margin-top:2rem;color:var(--muted);font-size:12px}
</style></head><body><main>
<h1>${escapeHtml(title)}</h1>
${description ? `<p class="desc">${escapeHtml(description)}</p>` : ''}
${prefix ? `<p class="crumbs">in <code>/${escapeHtml(prefix)}/</code> · <a href="/">root</a>${upHref && upHref !== '/' ? ` · <a href="${escapeHtml(upHref)}">up</a>` : ''}</p>` : ''}
${ogUrl ? `<img class="cover" src="${escapeHtml(ogUrl)}" alt="">` : ''}
<ul class="list">${entries.map((e) => `
  <li>
    <span class="icon">${e.kind === 'folder' ? '▸' : '·'}</span>
    <a href="${escapeHtml(e.href)}">${escapeHtml(e.name)}</a>
    ${e.size != null ? `<span class="size">${prettyBytes(e.size)}</span>` : ''}
  </li>`).join('')}</ul>
<footer>${files.length} item(s) · served by sloop</footer>
</main></body></html>`;

  return new Response(body, { headers });
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function serveManifest(env: Env, slug: string, versionId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT path, size, content_type, sha256 FROM site_files WHERE version_id = ?1 ORDER BY path`,
  )
    .bind(versionId)
    .all<{ path: string; size: number; content_type: string; sha256: string }>();
  const files = rows.results ?? [];

  // Extract required variables from any proxy.json
  const proxyFile = files.find((f) => f.path === '.sloop/proxy.json');
  let requiredVariables: Array<{ name: string; upstream?: string }> = [];
  if (proxyFile) {
    const obj = await env.SITES.get(casKey(proxyFile.sha256));
    if (obj) {
      try {
        const proxy = JSON.parse(await obj.text()) as { routes?: Array<{ upstream?: string; headers?: Record<string, string> }> };
        const seen = new Set<string>();
        for (const route of proxy.routes ?? []) {
          for (const v of Object.values(route.headers ?? {})) {
            for (const m of v.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) {
              if (!seen.has(m[1])) {
                seen.add(m[1]);
                requiredVariables.push({ name: m[1], upstream: route.upstream });
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return new Response(
    JSON.stringify({
      slug,
      versionId,
      files: files.map((f) => ({
        path: f.path,
        size: f.size,
        contentType: f.content_type,
        sha256: f.sha256,
      })),
      rawUrlPattern: `/s/${slug}/.sloop/raw/{path}`,
      requiredVariables,
    }, null, 2),
    {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
    },
  );
}

async function serveRawFile(env: Env, versionId: string, path: string): Promise<Response> {
  const file = await lookupFile(env, versionId, path);
  if (!file) return new Response('Not found', { status: 404 });
  const obj = await env.SITES.get(casKey(file.sha256));
  if (!obj) return new Response('Missing storage object', { status: 502 });
  return new Response(obj.body, {
    headers: {
      'content-type': file.content_type,
      'content-length': String(file.size),
      etag: `"${file.sha256}"`,
    },
  });
}

function injectForkButton(html: string, host: string, slug: string): string {
  const snippet = FORK_BUTTON_SNIPPET(host, slug);
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx < 0) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function paymentRequiredResponse(env: Env, slug: string, req: Request): Promise<Response> {
  const price = await loadSitePrice(env, slug);
  if (!price) return new Response('Payment required (price unavailable)', { status: 402 });
  const accept = req.headers.get('accept') ?? '';
  const apiHost = `https://${env.PUBLIC_APEX_HOST}`;
  const body = {
    error: 'payment_required',
    code: 'payment_required',
    price: { amount: price.amount, currency: price.currency, recipientAddress: price.recipient },
    paymentSession: {
      createUrl: `${apiHost}/api/pay/${slug}/session`,
      pollUrl: `${apiHost}/api/pay/${slug}/poll`,
      grantUrl: `${apiHost}/api/pay/${slug}/grant`,
    },
  };
  if (accept.includes('text/html') && !accept.includes('application/json')) {
    return new Response(paywallPage(slug, price, apiHost), {
      status: 402,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function paywallPage(slug: string, price: { amount: string; currency: string; recipient: string }, apiHost: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Payment required · ${escapeHtml(slug)}</title>
<style>
body{font:14px/1.5 system-ui;background:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem}
.box{background:#fff;border:1px solid #e5e5e5;padding:2rem;max-width:28rem;width:100%;border-radius:8px}
h1{font-size:1.1rem;margin:0 0 .8rem}
.amount{font:600 2rem ui-monospace,Menlo,monospace;margin:.5rem 0}
.label{color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-top:1rem}
code{font:13px ui-monospace,Menlo,monospace;background:#f4f4f5;padding:.2em .4em;border-radius:3px;word-break:break-all;display:inline-block;max-width:100%}
button{margin-top:1.2rem;padding:.6rem 1.1rem;border:0;background:#18181b;color:#fff;border-radius:5px;font-size:14px;cursor:pointer}
small{color:#71717a;display:block;margin-top:1rem;font-size:12px}
</style></head><body>
<div class="box">
<h1>Pay to view ${escapeHtml(slug)}</h1>
<div class="amount">${escapeHtml(price.amount)} ${escapeHtml(price.currency)}</div>
<div class="label">Send to</div>
<code>${escapeHtml(price.recipient)}</code>
<button id="start">Start payment session</button>
<div id="status" style="margin-top:1rem"></div>
<small>After paying, this page will reload with access.</small>
</div>
<script>
const slug = ${JSON.stringify(slug)};
const apiHost = ${JSON.stringify(apiHost)};
document.getElementById('start').addEventListener('click', async () => {
  const r = await fetch(apiHost + '/api/pay/' + slug + '/session', { method: 'POST' });
  const s = await r.json();
  const status = document.getElementById('status');
  status.textContent = 'Session ' + s.sessionId + ' open. Memo: ' + s.memo + ' · Polling…';
  const stop = setInterval(async () => {
    const p = await fetch(s.pollUrl).then(r => r.json());
    if (p.status === 'granted') {
      clearInterval(stop);
      location.href = '/?__sl_grant=' + (p.grantToken || '');
    } else if (p.status === 'expired') {
      clearInterval(stop);
      status.textContent = 'Session expired. Reload to retry.';
    }
  }, 3000);
});
</script>
</body></html>`;
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}
