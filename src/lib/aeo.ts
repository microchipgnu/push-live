// Per-site AEO sidecar endpoints.
//
// When a published site doesn't include its own /robots.txt, /sitemap.xml,
// /llms.txt, /llms-full.txt, /.well-known/agent-card.json, or /<path>.md,
// we serve an auto-generated version derived from the site's file manifest.
// If the owner DID include any of these in their publish, their file wins —
// these helpers are only called as a fallback.
//
// AEO sidecars run before the password/payment gate so that AI crawlers can
// still discover that the site exists. They never include gated content;
// /llms-full.txt for gated sites returns a short notice instead of the body.

import type { Env } from '../types.ts';
import { casKey } from './hash.ts';
import { AI_CRAWLERS } from '../routes/discovery.ts';

const SIDECAR_FIXED = new Set([
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
  '/llms-full.txt',
  '/.well-known/agent-card.json',
]);

const LLMS_FULL_MAX_BYTES = 200 * 1024; // 200 KB cap on auto-generated body
const LLMS_FULL_MAX_FILES = 50;

export function isAeoSidecarPath(pathname: string): boolean {
  if (SIDECAR_FIXED.has(pathname)) return true;
  if (pathname.endsWith('.md')) return true;
  return false;
}

type SiteMeta = {
  viewer_title: string | null;
  viewer_description: string | null;
  password_hash: string | null;
  price_amount: string | null;
};

type FileRow = { path: string; sha256: string; content_type: string; size: number };

export async function maybeServeAeoSidecar(
  env: Env,
  slug: string,
  versionId: string,
  site: SiteMeta,
  pathname: string,
  apexHost: string,
  req: Request,
): Promise<Response | null> {
  // Always let the user override by including their own file at this path.
  const own = await lookupFile(env, versionId, stripLeadingSlash(pathname));
  if (own) return await serveOwn(env, own);

  // baseUrl must reflect how the site is actually reached. On a slug
  // subdomain or custom domain that's just https://<host>. Under the
  // /s/<slug>/ preview path it has to include that prefix or every URL
  // we emit (sitemap entries, llms.txt page list, agent-card discovery
  // links) points at the apex root instead of the site.
  const url = new URL(req.url);
  const origPath = url.pathname;
  const pathPrefix = origPath.endsWith(pathname)
    ? origPath.slice(0, origPath.length - pathname.length)
    : '';
  const baseUrl = `https://${url.host}${pathPrefix}`;
  const gated = !!(site.password_hash || site.price_amount);

  if (pathname === '/robots.txt') {
    return text(buildSiteRobots(baseUrl), 'text/plain; charset=utf-8');
  }
  if (pathname === '/sitemap.xml') {
    const files = await listHtmlFiles(env, versionId);
    return text(buildSiteSitemap(baseUrl, files), 'application/xml; charset=utf-8');
  }
  if (pathname === '/llms.txt') {
    const files = await listHtmlFiles(env, versionId);
    return text(buildSiteLlms(baseUrl, site, files, gated), 'text/plain; charset=utf-8');
  }
  if (pathname === '/llms-full.txt') {
    if (gated) {
      return text(
        buildSiteLlms(baseUrl, site, [], gated) + `\n\n[Full content omitted — this site is access-gated. Visit ${baseUrl}/ to authenticate.]\n`,
        'text/plain; charset=utf-8',
      );
    }
    const files = await listHtmlFiles(env, versionId);
    const body = await buildSiteLlmsFull(env, baseUrl, site, files);
    return text(body, 'text/plain; charset=utf-8');
  }
  if (pathname === '/.well-known/agent-card.json') {
    return json(buildSiteAgentCard(baseUrl, slug, apexHost, site));
  }
  if (pathname.endsWith('.md')) {
    // Try to mirror /foo.md ← /foo.html  or  /foo/index.md ← /foo/index.html
    if (gated) return null; // gated sites: don't auto-leak markdown twins
    const stem = pathname.slice(0, -3); // drop ".md"
    const candidates = stem.endsWith('/')
      ? [stem + 'index.html']
      : [stem + '.html', stem + '/index.html'];
    for (const c of candidates) {
      const f = await lookupFile(env, versionId, stripLeadingSlash(c));
      if (f && f.content_type.includes('text/html')) {
        const obj = await env.SITES.get(casKey(f.sha256));
        if (!obj) return null;
        const html = await obj.text();
        return text(htmlToMarkdown(html, baseUrl + pathname.replace(/\.md$/, '')), 'text/markdown; charset=utf-8');
      }
    }
    return null;
  }
  return null;
}

// --- helpers ---

function stripLeadingSlash(s: string): string {
  return s.replace(/^\/+/, '');
}

async function lookupFile(env: Env, versionId: string, path: string): Promise<FileRow | null> {
  const row = await env.DB.prepare(
    `SELECT path, sha256, content_type, size FROM site_files WHERE version_id = ? AND path = ?`,
  )
    .bind(versionId, path)
    .first<FileRow>();
  return row ?? null;
}

async function serveOwn(env: Env, file: FileRow): Promise<Response> {
  const obj = await env.SITES.get(casKey(file.sha256));
  if (!obj) return new Response('Missing storage object', { status: 502 });
  return new Response(obj.body, {
    headers: {
      'content-type': file.content_type,
      'cache-control': 'public, max-age=300',
      etag: `"${file.sha256}"`,
    },
  });
}

async function listHtmlFiles(env: Env, versionId: string): Promise<FileRow[]> {
  // HTML pages only — sitemap and llms.txt enumerate pages, not assets.
  const rs = await env.DB.prepare(
    `SELECT path, sha256, content_type, size FROM site_files
     WHERE version_id = ? AND content_type LIKE 'text/html%'
     ORDER BY path ASC`,
  )
    .bind(versionId)
    .all<FileRow>();
  return rs.results ?? [];
}

function text(body: string, contentType: string): Response {
  return new Response(body, {
    headers: { 'content-type': contentType, 'cache-control': 'public, max-age=300' },
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

function buildSiteRobots(baseUrl: string): string {
  const allowBlocks = AI_CRAWLERS.map((ua) => `User-agent: ${ua}\nAllow: /\n`).join('\n');
  return `# Auto-generated by push-live. Override by including your own /robots.txt.
${allowBlocks}
User-agent: *
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
`;
}

function buildSiteSitemap(baseUrl: string, files: FileRow[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls = files
    .map((f) => htmlPathToUrlPath(f.path))
    .filter((u, i, a) => a.indexOf(u) === i)
    .map(
      (u) =>
        `  <url><loc>${escapeXml(baseUrl + u)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq></url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

function htmlPathToUrlPath(path: string): string {
  // "index.html" → "/", "about.html" → "/about", "foo/index.html" → "/foo/"
  let p = '/' + path;
  if (p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length);
  else if (p.endsWith('.html')) p = p.slice(0, -'.html'.length);
  return p;
}

function buildSiteLlms(baseUrl: string, site: SiteMeta, files: FileRow[], gated: boolean): string {
  const title = site.viewer_title ?? hostnameFrom(baseUrl);
  const desc = site.viewer_description ?? 'Hosted on push-live.';
  const lines = [
    `# ${title}`,
    ``,
    desc,
    ``,
    `Base URL: ${baseUrl}`,
    `Sitemap: ${baseUrl}/sitemap.xml`,
    `Agent card: ${baseUrl}/.well-known/agent-card.json`,
  ];
  if (gated) {
    lines.push(``, `Access-gated: yes. Authenticate at ${baseUrl}/ before crawling.`);
    return lines.join('\n') + '\n';
  }
  if (files.length) {
    lines.push(``, `## Pages`);
    for (const f of files.slice(0, 200)) {
      lines.push(`- ${baseUrl}${htmlPathToUrlPath(f.path)} (markdown: ${baseUrl}${htmlPathToUrlPath(f.path).replace(/\/$/, '') || ''}/index.md)`);
    }
  }
  return lines.join('\n') + '\n';
}

async function buildSiteLlmsFull(env: Env, baseUrl: string, site: SiteMeta, files: FileRow[]): Promise<string> {
  const head = buildSiteLlms(baseUrl, site, files, false);
  const chunks: string[] = [head, '', '## Full content', ''];
  let bytes = chunks.reduce((n, c) => n + c.length, 0);
  for (const f of files.slice(0, LLMS_FULL_MAX_FILES)) {
    const urlPath = htmlPathToUrlPath(f.path);
    chunks.push(`---`, `# ${baseUrl}${urlPath}`, ``);
    const obj = await env.SITES.get(casKey(f.sha256));
    if (!obj) continue;
    const html = await obj.text();
    const md = htmlToMarkdown(html, baseUrl + urlPath);
    chunks.push(md);
    chunks.push(``);
    bytes += md.length + 40;
    if (bytes > LLMS_FULL_MAX_BYTES) {
      chunks.push(`[Truncated — limit ${LLMS_FULL_MAX_BYTES} bytes reached.]`);
      break;
    }
  }
  return chunks.join('\n');
}

function buildSiteAgentCard(baseUrl: string, slug: string, apexHost: string, site: SiteMeta): unknown {
  return {
    name: site.viewer_title ?? slug,
    description: site.viewer_description ?? `${slug} — published on push-live.`,
    url: baseUrl,
    slug,
    hosted_by: { name: 'push-live', url: `https://${apexHost}` },
    discovery: {
      sitemap: `${baseUrl}/sitemap.xml`,
      llms_txt: `${baseUrl}/llms.txt`,
      llms_full_txt: `${baseUrl}/llms-full.txt`,
      robots_txt: `${baseUrl}/robots.txt`,
    },
    capabilities: {
      // Populated as the apps subsystem grows. Today only analytics is
      // registered; future apps (comments, posts, etc.) advertise here.
      apps: [],
    },
    access: {
      gated: !!(site.password_hash || site.price_amount),
      payment: site.price_amount ? { currency: 'USDC' } : null,
    },
  };
}

function hostnameFrom(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

// Tiny HTML → markdown converter. Strips script/style/nav/header/footer,
// prefers <main> if present, converts headings/paragraphs/links/lists/code.
// Not a faithful renderer — just good enough for AI consumption.
export function htmlToMarkdown(html: string, _canonicalUrl?: string): string {
  // Prefer <main>...</main> if present.
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  let body = mainMatch ? mainMatch[1] : html;

  // Strip non-content blocks.
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Headings
  body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, t) => `\n\n${'#'.repeat(Number(lvl))} ${stripTags(t).trim()}\n`);

  // Lists
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${stripTags(t).trim()}\n`);
  body = body.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

  // Code blocks
  body = body.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_m, t) => `\n\`\`\`\n${decodeEntities(t).trim()}\n\`\`\`\n`);
  body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t) => `\n\`\`\`\n${decodeEntities(stripTags(t)).trim()}\n\`\`\`\n`);
  body = body.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${decodeEntities(stripTags(t))}\``);

  // Inline emphasis
  body = body
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t) => `**${stripTags(t).trim()}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t) => `*${stripTags(t).trim()}*`);

  // Links
  body = body.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `[${stripTags(t).trim()}](${href})`);

  // Paragraphs and line breaks
  body = body.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  body = body.replace(/<br\s*\/?>/gi, '\n');

  // Drop any remaining tags.
  body = stripTags(body);

  // Decode entities and collapse whitespace.
  body = decodeEntities(body);
  body = body
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return body + '\n';
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}
