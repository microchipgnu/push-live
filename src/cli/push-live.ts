#!/usr/bin/env bun
// Tiny CLI for push-live. Single file, runs under Bun. No deps.
//   push-live login                   email-code flow → ~/.push-live/credentials
//   push-live publish <dir>           upload a directory, finalize, print site URL
//   push-live update <slug> <dir>     update an existing site (incremental)
//   push-live list                    your sites
//   push-live delete <slug>           delete a site
//   push-live whoami                  current API host + key prefix

import { readdir, stat, readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const DEFAULT_HOST = process.env.PUSH_LIVE_HOST ?? 'https://push-live.com';
const CRED_PATH = join(homedir(), '.push-live', 'credentials');

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'login':                                 return login();
    case 'publish':                               return publish(rest[0]);
    case 'update':                                return publish(rest[1], rest[0]);
    case 'list':                                  return list();
    case 'delete':                                return del(rest[0]);
    case 'whoami':                                return whoami();
    case 'drive':                                 return drive(rest);
    case 'export':                                return exportAll(rest);
    case 'import':                                return importAll(rest[0]);
    case 'help': case '--help': case '-h': case undefined: return help();
    default:
      console.error(`unknown command: ${cmd}`);
      help();
      process.exit(2);
  }
}

async function drive(args: string[]) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':                                  return driveList();
    case 'ls':                                    return driveLs(rest[0] ?? '');
    case 'cat':                                   return driveCat(rest[0]);
    case 'put':                                   return drivePut(rest[0], rest[1]);
    case 'rm':                                    return driveRm(rest[0]);
    case 'sync':                                  return driveSync(rest);
    case 'token':                                 return driveToken(rest);
    case undefined: case 'help':                  return driveHelp();
    default:
      console.error(`unknown drive subcommand: ${sub}`);
      driveHelp();
      process.exit(2);
  }
}

function driveHelp() {
  console.log(`push-live drive <subcommand>

  list                                List drives
  ls [prefix]                         List files in the default drive
  cat <path>                          Stream a file to stdout
  put <local> <remote>                Upload a file
  rm <path>                           Delete a file (use trailing / for prefix)
  sync <local-dir> <remote-prefix>    Incremental upload (skip unchanged). Flags: --delete
  token [opts]                        Mint a share token. Flags: --write --prefix <p> --ttl <sec>
`);
}

async function driveSync(args: string[]) {
  let localDir: string | undefined;
  let remotePrefix: string | undefined;
  let withDelete = false;
  for (const a of args) {
    if (a === '--delete') withDelete = true;
    else if (!localDir) localDir = a;
    else if (!remotePrefix) remotePrefix = a;
  }
  if (!localDir || !remotePrefix) fail('usage: push-live drive sync <local-dir> <remote-prefix> [--delete]');
  if (!remotePrefix.endsWith('/')) remotePrefix += '/';

  const key = await readApiKey();
  if (!key) fail('No API key. Run `push-live login`.');
  const driveId = await defaultDriveId(key);
  const root = resolve(localDir);
  const st = await stat(root).catch(() => null);
  if (!st || !st.isDirectory()) fail(`not a directory: ${root}`);

  // 1. Hash everything locally.
  const localFiles = await walk(root);
  const local = new Map<string, { abs: string; size: number; sha: string; contentType: string }>();
  for (const abs of localFiles) {
    const buf = await readFile(abs);
    const sha = await sha256Hex(buf);
    const rel = relative(root, abs).split(sep).join('/');
    local.set(remotePrefix + rel, { abs, size: buf.length, sha, contentType: contentTypeFor(abs) });
  }

  // 2. Pull remote listing under prefix (paginated).
  const remote = new Map<string, { sha256: string }>();
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ prefix: remotePrefix, ...(cursor ? { cursor } : {}) });
    const r = await api('GET', `/api/v1/drives/${driveId}/files?${qs}`, key) as {
      files?: Array<{ path: string; sha256: string }>;
      cursor?: string | null;
    };
    for (const f of r.files ?? []) remote.set(f.path, { sha256: f.sha256 });
    cursor = r.cursor ?? null;
  } while (cursor);

  // 3. Diff.
  const toPut: Array<{ path: string; spec: { abs: string; size: number; sha: string; contentType: string } }> = [];
  let unchanged = 0;
  for (const [path, spec] of local) {
    const r = remote.get(path);
    if (r && r.sha256 === spec.sha) {
      unchanged++;
    } else {
      toPut.push({ path, spec });
    }
  }
  const toDelete = withDelete ? [...remote.keys()].filter((p) => !local.has(p)) : [];

  console.error(`Sync: ${toPut.length} upload(s), ${toDelete.length} delete(s), ${unchanged} unchanged.`);
  if (toPut.length === 0 && toDelete.length === 0) {
    console.error('Up to date.');
    return;
  }

  // 4. Stage + upload bytes for changed files (CAS dedup handles hash collisions).
  const ops: Array<Record<string, unknown>> = [];
  for (const { path, spec } of toPut) {
    const stage = await api('POST', `/api/v1/drives/${driveId}/files/uploads`, key, {
      path, size: spec.size, contentType: spec.contentType, sha256: spec.sha,
    }) as { uploadId: string; url: string | null };
    if (stage.url) {
      const bytes = await readFile(spec.abs);
      const body = new Uint8Array(bytes.byteLength); body.set(bytes);
      const up = await fetch(stage.url, { method: 'PUT', headers: { 'content-type': spec.contentType }, body });
      if (!up.ok) fail(`upload ${path}: ${up.status}`);
    }
    ops.push({ type: 'put', path, uploadId: stage.uploadId, sha256: spec.sha, contentType: spec.contentType, size: spec.size });
  }
  for (const path of toDelete) {
    ops.push({ type: 'delete', path });
  }

  // 5. One atomic batch op.
  if (ops.length > 0) {
    const r = await api('PATCH', `/api/v1/drives/${driveId}/files`, key, { ops }) as { results?: Array<{ error?: string; path?: string }> };
    const errors = (r.results ?? []).filter((x) => x.error);
    if (errors.length > 0) {
      console.error(`Sync completed with ${errors.length} error(s):`);
      for (const e of errors) console.error(`  ${e.path}: ${e.error}`);
      process.exit(1);
    }
  }
  console.error('Done.');
}

async function defaultDriveId(key: string): Promise<string> {
  const r = await api('GET', '/api/v1/drives/default', key) as { id?: string };
  if (!r.id) fail('no default drive');
  return r.id;
}

async function driveList() {
  const key = await readApiKey();
  if (!key) fail('No API key. Run `push-live login`.');
  const r = await api('GET', '/api/v1/drives', key) as { drives?: Array<{ id: string; name: string; is_default?: number }> };
  for (const d of r.drives ?? []) {
    console.log(`${d.id.padEnd(36)}  ${d.name}${d.is_default ? '  (default)' : ''}`);
  }
}

async function driveLs(prefix: string) {
  const key = await readApiKey();
  if (!key) fail('No API key.');
  const id = await defaultDriveId(key);
  let cursor: string | null = null;
  let total = 0;
  do {
    const qs = new URLSearchParams({ prefix, ...(cursor ? { cursor } : {}) });
    const r = await api('GET', `/api/v1/drives/${id}/files?${qs}`, key) as {
      files?: Array<{ path: string; size: number; modified_at: number; sha256: string }>;
      cursor?: string | null;
    };
    for (const f of r.files ?? []) {
      console.log(`${pad(f.size, 10)}  ${new Date(f.modified_at).toISOString().slice(0,10)}  ${f.path}`);
      total++;
    }
    cursor = r.cursor ?? null;
  } while (cursor);
  if (total === 0) console.log('(empty)');
}

async function driveCat(path: string | undefined) {
  if (!path) fail('usage: push-live drive cat <path>');
  const key = await readApiKey();
  if (!key) fail('No API key.');
  const id = await defaultDriveId(key);
  const r = await fetch(`${DEFAULT_HOST}/api/v1/drives/${id}/files/${encodePath(path)}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!r.ok) fail(`drive cat: ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  stdout.write(buf);
}

async function drivePut(local: string | undefined, remote: string | undefined) {
  if (!local || !remote) fail('usage: push-live drive put <local> <remote>');
  const key = await readApiKey();
  if (!key) fail('No API key.');
  const id = await defaultDriveId(key);
  const bytes = await readFile(local);
  const sha = await sha256Hex(bytes);
  const stage = await api('POST', `/api/v1/drives/${id}/files/uploads`, key, {
    path: remote,
    size: bytes.length,
    contentType: contentTypeFor(local),
    sha256: sha,
  }) as { uploadId: string; url: string | null; skipped?: boolean };
  if (stage.url) {
    const view = new Uint8Array(bytes.byteLength);
    view.set(bytes);
    const up = await fetch(stage.url, { method: 'PUT', headers: { 'content-type': contentTypeFor(local) }, body: view });
    if (!up.ok) fail(`upload: ${up.status} ${await up.text()}`);
  }
  await api('PATCH', `/api/v1/drives/${id}/files`, key, {
    ops: [{ type: 'put', path: remote, uploadId: stage.uploadId, sha256: sha, size: bytes.length, contentType: contentTypeFor(local) }],
  });
  console.log(`Uploaded ${remote} (${bytes.length} bytes)${stage.skipped ? ' [de-duped]' : ''}`);
}

async function driveRm(path: string | undefined) {
  if (!path) fail('usage: push-live drive rm <path>');
  const key = await readApiKey();
  if (!key) fail('No API key.');
  const id = await defaultDriveId(key);
  const url = path.endsWith('/')
    ? `/api/v1/drives/${id}/files/${encodePath(path)}?recursive=true`
    : `/api/v1/drives/${id}/files/${encodePath(path)}`;
  await api('DELETE', url, key);
  console.log(`Deleted ${path}`);
}

async function driveToken(args: string[]) {
  const key = await readApiKey();
  if (!key) fail('No API key.');
  const id = await defaultDriveId(key);
  const body: Record<string, unknown> = { perms: 'read' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') body.perms = 'write';
    else if (args[i] === '--prefix') body.pathPrefix = args[++i];
    else if (args[i] === '--ttl') body.ttl = parseInt(args[++i], 10);
    else if (args[i] === '--label') body.label = args[++i];
  }
  const r = await api('POST', `/api/v1/drives/${id}/tokens`, key, body) as { token: string; id: string };
  console.log(r.token);
  console.error(`(token id: ${r.id})`);
}

type BackupSite = {
  slug: string;
  spaMode: boolean;
  forkable: boolean;
  viewerTitle: string | null;
  viewerDescription: string | null;
  files: Array<{ path: string; size: number; contentType: string; sha256: string; base64: string }>;
};

type BackupDrive = {
  id: string;
  name: string;
  isDefault: boolean;
  files: Array<{ path: string; size: number; contentType: string; sha256: string; base64: string }>;
};

type Backup = {
  format: 'push-live-backup-v1';
  exportedAt: string;
  host: string;
  user: { email?: string; plan?: string; wallet?: string | null };
  handle?: string | null;
  sites: BackupSite[];
  drives: BackupDrive[];
  variableNames: string[];     // names only — values intentionally not exported
};

async function exportAll(args: string[]) {
  const key = await readApiKey();
  if (!key) fail('No API key. Run `push-live login`.');
  let outPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outPath = args[++i];
  }

  console.error(`Exporting from ${DEFAULT_HOST}…`);

  const drivesResp = await api('GET', '/api/v1/drives', key) as { drives?: Array<{ id: string; name: string; is_default?: number }> };
  const sitesResp = await api('GET', '/api/v1/publishes', key) as { sites?: Array<{ slug: string; spa_mode?: number; forkable?: number; viewer_title?: string; viewer_description?: string }> };
  const handleResp = await api('GET', '/api/v1/handle', key) as { handle?: string | null };
  const walletResp = await api('GET', '/api/v1/wallet', key) as { address?: string | null };
  const varsResp = await api('GET', '/api/v1/me/variables', key) as { variables?: Array<{ name: string }> };

  const sites: BackupSite[] = [];
  for (const s of sitesResp.sites ?? []) {
    console.error(`  site ${s.slug}…`);
    const detail = await api('GET', `/api/v1/publish/${s.slug}`, key) as {
      site: { viewer_title?: string | null; viewer_description?: string | null; spa_mode?: number; forkable?: number };
      files: Array<{ path: string; size: number; content_type: string; sha256: string }>;
    };
    const files: BackupSite['files'] = [];
    for (const f of detail.files ?? []) {
      const bytes = await fetchCasBytes(key, 'site', s.slug, f.path);
      files.push({ path: f.path, size: f.size, contentType: f.content_type, sha256: f.sha256, base64: bytesToBase64(bytes) });
    }
    sites.push({
      slug: s.slug,
      spaMode: !!detail.site?.spa_mode,
      forkable: !!detail.site?.forkable,
      viewerTitle: detail.site?.viewer_title ?? null,
      viewerDescription: detail.site?.viewer_description ?? null,
      files,
    });
  }

  const drives: BackupDrive[] = [];
  for (const d of drivesResp.drives ?? []) {
    console.error(`  drive ${d.id}…`);
    const files: BackupDrive['files'] = [];
    let cursor: string | null = null;
    do {
      const qs = cursor ? `?cursor=${cursor}` : '';
      const r = await api('GET', `/api/v1/drives/${d.id}/files${qs}`, key) as {
        files?: Array<{ path: string; size: number; content_type: string; sha256: string }>;
        cursor?: string | null;
      };
      for (const f of r.files ?? []) {
        const bytes = await fetchCasBytes(key, 'drive', d.id, f.path);
        files.push({ path: f.path, size: f.size, contentType: f.content_type, sha256: f.sha256, base64: bytesToBase64(bytes) });
      }
      cursor = r.cursor ?? null;
    } while (cursor);
    drives.push({ id: d.id, name: d.name, isDefault: !!d.is_default, files });
  }

  const backup: Backup = {
    format: 'push-live-backup-v1',
    exportedAt: new Date().toISOString(),
    host: DEFAULT_HOST,
    user: { wallet: walletResp.address ?? null },
    handle: handleResp.handle ?? null,
    sites,
    drives,
    variableNames: (varsResp.variables ?? []).map((v) => v.name),
  };

  const json = JSON.stringify(backup, null, 2);
  if (outPath) {
    await writeFile(outPath, json);
    console.error(`Wrote ${json.length} bytes to ${outPath}.`);
  } else {
    stdout.write(json);
  }
}

async function fetchCasBytes(key: string | null, kind: 'site' | 'drive', id: string, path: string): Promise<Uint8Array> {
  if (kind === 'site') {
    // Public-served path — auth required only for password/payment-gated sites; agents using export own the site so the cookie isn't an issue here. Hit the served URL.
    const host = new URL(DEFAULT_HOST).host;
    const apex = host.replace(/^[^.]+\./, ''); // crude but works for <slug>.<apex>
    void apex;
    const r = await fetch(`${DEFAULT_HOST}/s/${id}/${encodePath(path)}`);
    if (!r.ok) fail(`fetch site ${id}/${path}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const r = await fetch(`${DEFAULT_HOST}/api/v1/drives/${id}/files/${encodePath(path)}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  if (!r.ok) fail(`fetch drive ${id}/${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAll(file: string | undefined) {
  if (!file) fail('usage: push-live import <backup.json>');
  const key = await readApiKey();
  if (!key) fail('No API key. Run `push-live login`.');
  const raw = await readFile(file, 'utf8');
  const backup = JSON.parse(raw) as Backup;
  if (backup.format !== 'push-live-backup-v1') fail(`unknown backup format: ${backup.format}`);
  console.error(`Importing into ${DEFAULT_HOST}…`);

  if (backup.user?.wallet) {
    await api('PATCH', '/api/v1/wallet', key, { address: backup.user.wallet });
  }
  if (backup.handle) {
    try { await api('POST', '/api/v1/handle', key, { handle: backup.handle }); } catch {}
  }

  // Sites — recreate each via /publish with hashes so dedupe kicks in for files we already have.
  for (const s of backup.sites) {
    console.error(`  site ${s.slug}…`);
    const manifest = s.files.map((f) => ({ path: f.path, size: f.size, contentType: f.contentType, hash: f.sha256 }));
    const created = await api('POST', '/api/v1/publish', key, {
      files: manifest, spaMode: s.spaMode, forkable: s.forkable,
      viewer: { title: s.viewerTitle ?? undefined, description: s.viewerDescription ?? undefined },
    }) as {
      slug?: string;
      upload?: { versionId: string; uploads: Array<{ path: string; url: string; headers: Record<string, string> }>; skipped?: string[]; finalizeUrl: string };
    };
    if (!created.upload) fail('publish failed');
    for (const u of created.upload.uploads) {
      const f = s.files.find((x) => x.path === u.path);
      if (!f) continue;
      const bytes = base64ToBytes(f.base64);
      const body = new Uint8Array(bytes.byteLength); body.set(bytes);
      const up = await fetch(u.url, { method: 'PUT', headers: u.headers, body });
      if (!up.ok) fail(`upload ${u.path}: ${up.status}`);
    }
    await fetch(created.upload.finalizeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ versionId: created.upload.versionId }),
    });
  }

  // Drives — create each, then per-file stage + finalize.
  for (const d of backup.drives) {
    console.error(`  drive ${d.name} (${d.files.length} files)…`);
    let driveId: string;
    if (d.isDefault) {
      driveId = (await api('GET', '/api/v1/drives/default', key) as { id: string }).id;
    } else {
      driveId = (await api('POST', '/api/v1/drives', key, { name: d.name }) as { id: string }).id;
    }
    for (const f of d.files) {
      const stage = await api('POST', `/api/v1/drives/${driveId}/files/uploads`, key, {
        path: f.path, size: f.size, contentType: f.contentType, sha256: f.sha256,
      }) as { uploadId: string; url: string | null };
      if (stage.url) {
        const bytes = base64ToBytes(f.base64);
        const body = new Uint8Array(bytes.byteLength); body.set(bytes);
        const up = await fetch(stage.url, { method: 'PUT', headers: { 'content-type': f.contentType }, body });
        if (!up.ok) fail(`drive upload ${f.path}: ${up.status}`);
      }
      await api('PATCH', `/api/v1/drives/${driveId}/files`, key, {
        ops: [{ type: 'put', path: f.path, uploadId: stage.uploadId, sha256: f.sha256, contentType: f.contentType, size: f.size }],
      });
    }
  }

  if (backup.variableNames.length > 0) {
    console.error(`\nNote: ${backup.variableNames.length} variable name(s) were exported but their values are not (backups never include secrets). Re-set with \`push-live\` admin tooling or:`);
    for (const n of backup.variableNames) console.error(`  PUT /api/v1/me/variables/${n}`);
  }
  console.error('Done.');
}

function pad(n: number, w: number): string {
  const s = String(n);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function help() {
  console.log(`push-live CLI

Commands:
  login                       Mint an API key via email code, save to ~/.push-live/credentials
  publish <dir>               Publish a directory as a new site
  update <slug> <dir>         Re-publish a directory to an existing site
  list                        List your sites
  delete <slug>               Delete a site
  drive <subcommand>          list | ls | cat | put | rm | sync | token
  export [--out file.json]    Dump sites + drives to a single JSON
  import <file.json>          Restore from a previous export
  whoami                      Show current host + key prefix

Env:
  PUSH_LIVE_HOST                API host (default: ${DEFAULT_HOST})
  PUSH_LIVE_API_KEY             API key (otherwise read from ~/.push-live/credentials)
`);
}

async function readApiKey(): Promise<string | null> {
  if (process.env.PUSH_LIVE_API_KEY) return process.env.PUSH_LIVE_API_KEY.trim();
  try {
    return (await readFile(CRED_PATH, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function writeApiKey(key: string) {
  await mkdir(join(homedir(), '.push-live'), { recursive: true });
  await writeFile(CRED_PATH, key + '\n', 'utf8');
  await chmod(CRED_PATH, 0o600);
}

async function whoami() {
  const key = await readApiKey();
  console.log(`host: ${DEFAULT_HOST}`);
  console.log(`key:  ${key ? key.slice(0, 12) + '…' : '(not set — run `push-live login`)'}`);
}

async function login() {
  const rl = createInterface({ input: stdin, output: stdout });
  const email = (await rl.question('Email: ')).trim().toLowerCase();
  if (!email.includes('@')) { rl.close(); fail('invalid email'); }
  const req = await api('POST', '/api/auth/agent/request-code', null, { email });
  if (req.devCode) console.log(`(dev) code: ${req.devCode}`);
  else console.log('Sent a code to your email.');
  const code = (await rl.question('Code: ')).trim();
  rl.close();
  const verify = await api('POST', '/api/auth/agent/verify-code', null, { email, code });
  if (!verify.apiKey) fail(`verify failed: ${JSON.stringify(verify)}`);
  await writeApiKey(verify.apiKey);
  console.log(`Saved key to ${CRED_PATH}.`);
}

async function list() {
  const key = await readApiKey();
  if (!key) fail('No API key. Run `push-live login` first.');
  const r = await api('GET', '/api/v1/publishes', key);
  const sites = (r.sites ?? []) as Array<{ slug: string; viewer_title?: string }>;
  for (const s of sites) {
    console.log(`${s.slug.padEnd(28)}  ${s.viewer_title ?? ''}`);
  }
}

async function del(slug: string | undefined) {
  if (!slug) fail('usage: push-live delete <slug>');
  const key = await readApiKey();
  if (!key) fail('No API key. Run `push-live login` first.');
  await api('DELETE', `/api/v1/publish/${slug}`, key);
  console.log(`Deleted ${slug}.`);
}

async function publish(dir: string | undefined, existingSlug?: string) {
  if (!dir) fail(existingSlug ? 'usage: push-live update <slug> <dir>' : 'usage: push-live publish <dir>');
  const key = await readApiKey();
  const root = resolve(dir);
  const st = await stat(root).catch(() => null);
  if (!st || !st.isDirectory()) fail(`not a directory: ${root}`);

  const files = await walk(root);
  if (files.length === 0) fail('no files to publish');
  console.log(`Scanning ${files.length} file(s)…`);

  const manifest: Array<{ path: string; size: number; contentType: string; hash: string; abs: string }> = [];
  for (const f of files) {
    const buf = await readFile(f);
    const hash = await sha256Hex(buf);
    manifest.push({
      path: relative(root, f).split(sep).join('/'),
      size: buf.length,
      contentType: contentTypeFor(f),
      hash,
      abs: f,
    });
  }

  const url = existingSlug ? `/api/v1/publish/${existingSlug}` : '/api/v1/publish';
  const method = existingSlug ? 'PUT' : 'POST';
  const body = { files: manifest.map(({ abs: _abs, ...rest }) => rest) };
  const created = await api(method, url, key, body);
  if (!created.upload) fail(`unexpected response: ${JSON.stringify(created)}`);
  const versionId: string = created.upload.versionId;
  const slug = created.slug ?? existingSlug ?? '';
  const finalizeUrl: string = created.upload.finalizeUrl;
  const uploads: Array<{ path: string; url: string; headers: Record<string, string> }> = created.upload.uploads;
  const skipped: string[] = created.upload.skipped ?? [];

  console.log(`Site ${slug}: ${uploads.length} upload(s), ${skipped.length} de-duped.`);

  await Promise.all(uploads.map(async (u) => {
    const m = manifest.find((x) => x.path === u.path);
    if (!m) return;
    const bytes = await readFile(m.abs);
    // Copy into a fresh ArrayBuffer so the body type satisfies fetch's BodyInit
    // (Node's Buffer/ArrayBufferLike isn't quite BufferSource).
    const view = new Uint8Array(bytes.byteLength);
    view.set(bytes);
    const r = await fetch(u.url, { method: 'PUT', headers: u.headers, body: view });
    if (!r.ok) fail(`upload ${u.path} failed: ${r.status} ${await r.text()}`);
  }));

  const fin = await fetch(finalizeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ versionId }),
  });
  if (!fin.ok) fail(`finalize failed: ${fin.status} ${await fin.text()}`);

  console.log(`\n→ ${created.siteUrl}`);
  if (created.claimUrl) {
    console.log(`\nAnonymous site (24h expiry). Save this claim URL to keep it permanently:`);
    console.log(`  ${created.claimUrl}`);
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.git') || e.name === 'node_modules' || e.name === '.DS_Store') continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out.sort();
}

async function sha256Hex(buf: Uint8Array): Promise<string> {
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  const out = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function contentTypeFor(path: string): string {
  const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm':  'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt':  'text/plain; charset=utf-8',
    '.md':   'text/markdown; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.ico':  'image/x-icon',
    '.pdf':  'application/pdf',
    '.mp4':  'video/mp4',
    '.webm': 'video/webm',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.wasm': 'application/wasm',
    '.xml':  'application/xml; charset=utf-8',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function api(method: string, path: string, key: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${DEFAULT_HOST}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!r.ok) {
    fail(`${method} ${path} → ${r.status}: ${(json as { message?: string }).message ?? text}`);
  }
  return json as Record<string, unknown> & { upload?: { versionId: string; uploads: Array<{ path: string; url: string; headers: Record<string, string> }>; skipped?: string[]; finalizeUrl: string }; siteUrl?: string; slug?: string; sites?: unknown[]; claimUrl?: string; apiKey?: string; devCode?: string };
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
