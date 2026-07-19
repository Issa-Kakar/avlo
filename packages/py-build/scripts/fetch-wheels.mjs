#!/usr/bin/env node
// Fetch the pinned recipes wheels into .cache/wheels/ (gitignored), verifying
// every byte against the sha256 pins in build.config.json.
//
//   node scripts/fetch-wheels.mjs [--stamp] [--only name[,name...]]
//
// --stamp re-resolves {version, file, sha256} for every configured wheel name
// from the stock release lock (dist/raw/pyodide-lock.json — the recipes
// release asset, present after any fork build), preserves traceOnly flags,
// and rewrites recipes.wheels. Pins are frozen until the next explicit
// --stamp; a version drift between config and lock without --stamp is an
// error, not a silent re-pin. Wheels pinned with a `url` (PyPI universal
// wheels absent from the stock lock, e.g. seaborn) are outside --stamp's
// authority: they are skipped by the restamp AND the drift guard, and their
// download goes straight to the pinned url — the sha256 pin is what makes
// any source provenance-equivalent.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(pkgRoot, 'build.config.json');
const lockPath = join(pkgRoot, 'dist/raw/pyodide-lock.json');
const cacheDir = join(pkgRoot, '.cache/wheels');
const args = process.argv.slice(2);
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? new Set(args[i + 1].split(',')) : null;
})();

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const wheels = config.recipes.wheels;
const names = Object.keys(wheels).filter((n) => !n.startsWith('$') && (!only || only.has(n)));

// The stock full lock is the pin source for --stamp and the drift guard.
// Auto-fetch from the CDN mirror when absent or from a different pyodide
// release — dist/raw goes stale across toolchain jumps until the first fork
// build, and the fork's own emitted lock (if any) must never clobber this
// full one, so provenance lives here, not in build.sh's copy list.
const lockIsCurrent = () => {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')).info?.version === config.pyodide.tag;
  } catch {
    return false;
  }
};
if (!lockIsCurrent()) {
  const url = `${config.recipes.mirror}/pyodide-lock.json`;
  process.stdout.write(`lock    fetching stock ${config.pyodide.tag} lock ... `);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, Buffer.from(await res.arrayBuffer()));
  console.log('ok');
}

const lockEntry = (lock, name) => lock.packages[name] ?? lock.packages[name.replace(/-/g, '_')];

if (args.includes('--stamp')) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const name of names) {
    if (wheels[name].url) {
      console.log(`skip    ${name} (url-pinned, not in the stock lock)`);
      continue;
    }
    const e = lockEntry(lock, name);
    if (!e) throw new Error(`--stamp: ${name} not in ${lockPath}`);
    const prev = wheels[name];
    if (prev.version && prev.version !== e.version) {
      console.warn(`!! ${name}: version pin ${prev.version} -> ${e.version} (lock)`);
    }
    wheels[name] = { version: e.version, file: e.file_name, sha256: e.sha256, ...(prev.traceOnly ? { traceOnly: true } : {}) };
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`stamped ${names.length} wheel pins from the stock lock`);
}

// Drift guard: pins must agree with the lock we built against.
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const name of names) {
    if (wheels[name].url) continue; // url pins are deliberately outside the lock's authority
    const e = lockEntry(lock, name);
    if (e && e.sha256 !== wheels[name].sha256) {
      throw new Error(`${name}: config sha256 disagrees with the stock lock — rerun with --stamp deliberately`);
    }
  }
}

mkdirSync(cacheDir, { recursive: true });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let fetched = 0;
for (const name of names) {
  const { file, sha256: want } = wheels[name];
  if (!file || !want) throw new Error(`${name}: unpinned (run --stamp first)`);
  const dest = join(cacheDir, file);
  if (existsSync(dest) && sha256(readFileSync(dest)) === want) {
    console.log(`ok      ${file}`);
    continue;
  }
  // Release asset first (canonical), then the CDN mirror; url pins go straight
  // to their source — the sha256 pin below makes every source
  // provenance-equivalent.
  const bases = [config.recipes.base, config.recipes.mirror].filter(Boolean);
  const sources = wheels[name].url ? [wheels[name].url] : bases.map((base) => `${base}/${file}`);
  process.stdout.write(`fetch   ${file} ... `);
  let buf = null;
  let lastErr = null;
  for (const source of sources) {
    const res = await fetch(source, { redirect: 'follow' });
    if (res.ok) {
      buf = Buffer.from(await res.arrayBuffer());
      break;
    }
    lastErr = `${source}: HTTP ${res.status}`;
  }
  if (!buf) throw new Error(lastErr ?? `${file}: no sources`);
  const got = sha256(buf);
  if (got !== want) throw new Error(`${file}: sha256 mismatch\n  want ${want}\n  got  ${got}`);
  writeFileSync(dest, buf);
  fetched++;
  console.log(`${(buf.length / 1e6).toFixed(1)} MB ok`);
}
console.log(`wheels: ${names.length} pinned, ${fetched} fetched, cache ${cacheDir}`);
