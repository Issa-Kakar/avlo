#!/usr/bin/env node
// Publish the staged py artifacts to R2 under their build-lock hash prefix.
//
//   node scripts/publish.mjs [--local|--remote] [--dry-run]   (--local default)
//
// Local seeds the dev miniflare R2 simulator (pnpm py:seed); remote publishes
// to the real avlo-py bucket. Invariant enforced by the preflight: RESTAGE ⇒
// RESEED — every uploaded byte is re-hashed against the committed build-lock,
// so a stale dist/ or a stale lock refuses loudly instead of serving a mix.
//
// Upload plan: every lock artifact + bundle tar, each with its .br sibling,
// then manifest.json strictly LAST — an aborted upload leaves an incomplete
// prefix WITHOUT its completion marker, which the probe treats as unpublished.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const dryRun = args.includes('--dry-run');
const BUCKET = 'avlo-py';

const lock = JSON.parse(readFileSync(join(repoRoot, 'packages/py-loader/build-lock.json'), 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Raw source locations (the .br siblings live beside them — they never reach fork/).
const SOURCES = {
  'pyodide.asm.js': 'dist/raw/pyodide.asm.js',
  'pyodide.asm.wasm': 'dist/raw/pyodide.asm.wasm',
  'pyodide.mjs': 'dist/raw/pyodide.mjs',
  'python_stdlib.zip': 'dist/stage/python_stdlib.zip',
  'baseline.snap': 'dist/baseline.snap',
};
// NOTE: contentType has no fallback — an unmapped extension would pass the
// literal string "undefined" to `wrangler --content-type`.
const MIME = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.tar': 'application/x-tar',
  '.snap': 'application/octet-stream',
};
const contentType = (file) => MIME[file.slice(file.lastIndexOf('.'))];

// ---- preflight: restage ⇒ reseed ---------------------------------------------
const uploads = []; // { key, path, contentType, encoding? }
const preflight = (name, rel, want) => {
  const p = join(pkgRoot, rel);
  if (!existsSync(p)) {
    console.error(`missing ${rel} — build/stage first`);
    process.exit(1);
  }
  const buf = readFileSync(p);
  if (buf.length !== want.size || sha256(buf) !== want.sha256) {
    console.error(`${rel} drifted from build-lock (restage ⇒ reseed: rerun stage.mjs, commit the lock, reseed)`);
    process.exit(1);
  }
  const brPath = `${p}.br`;
  if (!existsSync(brPath)) {
    console.error(`missing ${rel}.br — run compress.mjs`);
    process.exit(1);
  }
  if (statSync(brPath).mtimeMs < statSync(p).mtimeMs) {
    console.error(`${rel}.br is OLDER than its source — run compress.mjs`);
    process.exit(1);
  }
  const keyBase = name.endsWith('.tar') ? `${lock.buildHash}/bundles/${name}` : `${lock.buildHash}/${name}`;
  uploads.push({ key: keyBase, path: p, contentType: contentType(name) });
  uploads.push({ key: `${keyBase}.br`, path: brPath, contentType: contentType(name), encoding: 'br' });
};
for (const [name, rel] of Object.entries(SOURCES)) preflight(name, rel, lock.artifacts[name]);
for (const [b, want] of Object.entries(lock.bundles)) preflight(`${b}.tar`, `dist/stage/bundles/${b}.tar`, want);

const manifestPath = join(repoRoot, 'web/public/py-dev/fork/manifest.json');
if (!existsSync(manifestPath)) {
  console.error('staged manifest.json missing — run stage.mjs');
  process.exit(1);
}
const manifestBytes = readFileSync(manifestPath);
if (JSON.parse(manifestBytes.toString('utf8')).buildHash !== lock.buildHash) {
  console.error('staged manifest.json buildHash != build-lock — rerun stage.mjs');
  process.exit(1);
}
uploads.push({ key: `${lock.buildHash}/manifest.json`, path: manifestPath, contentType: 'application/json' });

// ---- wrangler invocation -------------------------------------------------------
// --local: --persist-to must be ABSOLUTE and must NOT include the trailing /v3 —
// wrangler appends it, landing in the exact tree dev-miniflare reads
// (.wrangler/state/v3). --remote: config supplies the account context.
const modeArgs = remote
  ? ['--remote', '--config', join(repoRoot, 'workers/py/wrangler.jsonc')]
  : ['--local', '--persist-to', join(repoRoot, '.wrangler/state')];
const wr = (cmd, opts = {}) => execFileSync('npx', ['wrangler', 'r2', 'object', ...cmd, ...modeArgs], { cwd: repoRoot, ...opts });

if (remote && !dryRun) {
  // Divergence refusal: one probe of the completion marker.
  let existing = null;
  try {
    existing = wr(['get', `${BUCKET}/${lock.buildHash}/manifest.json`, '--pipe'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    /* absent → publish */
  }
  if (existing !== null) {
    if (Buffer.compare(existing, manifestBytes) === 0) {
      console.log(`already published: ${lock.buildHash} (manifest byte-identical)`);
      process.exit(0);
    }
    console.error(`HASH BUG: ${lock.buildHash}/manifest.json exists remotely with DIFFERENT bytes — same hash must mean same artifacts`);
    process.exit(1);
  }
}

for (const u of uploads) {
  const flags = ['--file', u.path, '--content-type', u.contentType, ...(u.encoding ? ['--content-encoding', u.encoding] : [])];
  console.log(`${dryRun ? '[dry-run] ' : ''}put ${BUCKET}/${u.key}${u.encoding ? ' (br)' : ''}`);
  if (!dryRun) wr(['put', `${BUCKET}/${u.key}`, ...flags], { stdio: ['ignore', 'ignore', 'inherit'] });
}
console.log(`${dryRun ? '[dry-run] ' : ''}published ${uploads.length} keys under ${lock.buildHash} (${remote ? 'remote' : 'local'})`);
