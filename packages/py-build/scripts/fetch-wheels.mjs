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
// error, not a silent re-pin.
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

const lockEntry = (lock, name) => lock.packages[name] ?? lock.packages[name.replace(/-/g, '_')];

if (args.includes('--stamp')) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const name of names) {
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
  // Release asset first (canonical), then the CDN mirror — the sha256 pin
  // below makes either source provenance-equivalent.
  const bases = [config.recipes.base, config.recipes.mirror].filter(Boolean);
  process.stdout.write(`fetch   ${file} ... `);
  let buf = null;
  let lastErr = null;
  for (const base of bases) {
    const res = await fetch(`${base}/${file}`, { redirect: 'follow' });
    if (res.ok) {
      buf = Buffer.from(await res.arrayBuffer());
      break;
    }
    lastErr = `${base}/${file}: HTTP ${res.status}`;
  }
  if (!buf) throw new Error(lastErr ?? `${file}: no sources`);
  const got = sha256(buf);
  if (got !== want) throw new Error(`${file}: sha256 mismatch\n  want ${want}\n  got  ${got}`);
  writeFileSync(dest, buf);
  fetched++;
  console.log(`${(buf.length / 1e6).toFixed(1)} MB ok`);
}
console.log(`wheels: ${names.length} pinned, ${fetched} fetched, cache ${cacheDir}`);
