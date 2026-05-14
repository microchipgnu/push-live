#!/usr/bin/env node
// AEO readiness static checks. Runs pure builders + grep-style assertions on
// the source so we can verify AEO signals are in place without spinning up
// wrangler dev. Run via:  node scripts/aeo-check.mjs
//
// For the live-server checks (hosted-site sidecars on a real published site),
// see the AEO section in scripts/smoke.sh.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let fail = 0;
function ok(label) {
  process.stdout.write(`[32m✓[0m ${label}\n`);
}
function bad(label, detail) {
  process.stdout.write(`[31m✘[0m ${label}\n`);
  if (detail) process.stdout.write(`   ${detail}\n`);
  fail++;
}
function assert(cond, label, detail) {
  cond ? ok(label) : bad(label, detail);
}

const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// --- 1. /robots.txt: AI crawler directives ---
const discovery = read('src/routes/discovery.ts');
for (const ua of ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Web', 'anthropic-ai', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'Bytespider', 'CCBot']) {
  assert(discovery.includes(`'${ua}'`), `robots.txt allows ${ua}`);
}
assert(discovery.includes('export const AI_CRAWLERS'), 'AI_CRAWLERS is exported (reusable by hosted-site sidecars)');
assert(discovery.includes('export function buildRobotsTxt'), 'buildRobotsTxt is exported');

// --- 2. Sitemap includes AEO discovery paths ---
for (const path of ['/llms.txt', '/llms-full.txt', '/docs.md', '/index.md', '/pricing.md', '/.well-known/agent-card.json', '/skill.md']) {
  assert(discovery.includes(`'${path}'`), `sitemap includes ${path}`);
}

// --- 3. /docs.md exists and is non-trivial ---
assert(discovery.includes(`discoveryRouter.get('/docs.md'`), 'discoveryRouter handles /docs.md');
assert(discovery.includes('function buildDocsMd'), 'buildDocsMd function defined');
assert(discovery.match(/buildDocsMd\(host\)/), '/docs.md handler calls buildDocsMd');

// --- 4. Inline JSON-LD on landing and docs ---
const index = read('src/index.ts');
assert(index.includes("'@type': 'Organization'"), 'landing has Organization JSON-LD');
assert(index.includes("'@type': 'WebSite'"), 'landing has WebSite JSON-LD');
assert(index.includes("'@type': 'SoftwareApplication'"), 'landing has SoftwareApplication JSON-LD');
assert(index.includes('jsonLd'), 'landing wires jsonLd through head()');

assert(discovery.includes("'@type': 'TechArticle'"), 'docs has TechArticle JSON-LD');
assert(discovery.includes("'@type': 'FAQPage'"), 'docs has FAQPage JSON-LD');
assert(discovery.includes("'@type': 'BreadcrumbList'"), 'docs has BreadcrumbList JSON-LD');

// --- 5. head() emits the AEO meta tags ---
const layout = read('src/ui/layout.ts');
for (const m of ['<meta name="description"', '<link rel="canonical"', '<meta property="og:title"', '<meta property="og:type"', '<meta property="og:image"', '<meta name="twitter:card"', '<meta name="twitter:title"', '<meta name="robots"', 'application/ld+json']) {
  assert(layout.includes(m), `head() emits ${m}`);
}

// --- 6. Hosted-site sidecar wiring ---
const serve = read('src/serve.ts');
assert(serve.includes("import { isAeoSidecarPath, maybeServeAeoSidecar } from './lib/aeo.ts'"), 'serve.ts imports AEO sidecar helpers');
assert(serve.match(/if \(req\.method === 'GET' && isAeoSidecarPath\(pathname\)\)/), 'serve.ts intercepts AEO sidecar paths');
// Order check: sidecars must run before the password gate.
const sidecarIdx = serve.indexOf('isAeoSidecarPath(pathname)');
const pwIdx = serve.indexOf('site.password_hash');
const payIdx = serve.indexOf('site.price_amount');
assert(sidecarIdx > 0 && sidecarIdx < pwIdx, 'AEO sidecars run before password gate', `sidecarIdx=${sidecarIdx} pwIdx=${pwIdx}`);
assert(sidecarIdx > 0 && sidecarIdx < payIdx, 'AEO sidecars run before payment gate', `sidecarIdx=${sidecarIdx} payIdx=${payIdx}`);

// --- 7. aeo.ts handles all required sidecar paths ---
const aeo = read('src/lib/aeo.ts');
for (const p of ["'/robots.txt'", "'/sitemap.xml'", "'/llms.txt'", "'/llms-full.txt'", "'/.well-known/agent-card.json'"]) {
  assert(aeo.includes(p), `aeo.ts handles ${p}`);
}
assert(aeo.includes(".md'") || aeo.includes("'.md'"), 'aeo.ts handles .md mirrors');
assert(aeo.includes('AI_CRAWLERS'), 'aeo.ts reuses AI_CRAWLERS from discovery');
assert(/buildSiteRobots/.test(aeo), 'aeo.ts builds per-site robots.txt');
assert(/buildSiteSitemap/.test(aeo), 'aeo.ts builds per-site sitemap.xml');
assert(/buildSiteLlms/.test(aeo), 'aeo.ts builds per-site llms.txt');
assert(/buildSiteLlmsFull/.test(aeo), 'aeo.ts builds per-site llms-full.txt');
assert(/buildSiteAgentCard/.test(aeo), 'aeo.ts builds per-site agent-card.json');
assert(/htmlToMarkdown/.test(aeo), 'aeo.ts has htmlToMarkdown extractor');

// --- 8. Owner-uploaded files win (sidecar overrides) ---
assert(/lookupFile\(env, versionId, stripLeadingSlash\(pathname\)\)/.test(aeo), 'owner-uploaded file at the same path always overrides auto-sidecar');

// --- 9. Gated sites don't auto-leak full content ---
assert(/if \(gated\)[\s\S]*?return text/.test(aeo) || /\[Full content omitted/.test(aeo), 'gated sites do not auto-serve full llms-full.txt');
assert(/if \(gated\) return null/.test(aeo) || /gated[\s\S]*?\.md/.test(aeo), 'gated sites do not auto-serve .md mirrors');

// --- 10. Pure-function spot checks (runtime) ---
// We can't import the TS files directly without a runtime that strips types,
// but we can test the htmlToMarkdown shape via a regex-based reimplementation.
// At minimum verify the strings the implementation emits.
// In the TS source, the triple backticks for the fence are escaped (\`\`\`)
// inside a backtick template — check for that escaped form.
assert(/\\`\\`\\`/.test(aeo), 'htmlToMarkdown emits fenced code blocks');
assert(/## Pages/.test(aeo), 'llms.txt has a Pages section');
assert(/Auto-generated by push-live/.test(aeo), 'per-site robots.txt is labeled as auto-generated and overridable');

if (fail > 0) {
  process.stdout.write(`\n[31m${fail} check(s) failed[0m\n`);
  process.exit(1);
}
process.stdout.write(`\n[32mAll AEO static checks passed.[0m\n`);
