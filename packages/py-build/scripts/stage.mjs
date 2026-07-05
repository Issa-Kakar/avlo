#!/usr/bin/env node
// Stage the built artifacts for dev serving + regenerate the checked-in
// import-gate module. One entry point for "make the app see what I built".
//
//   node scripts/stage.mjs           # stage + write manifest + gen.ts
//   node scripts/stage.mjs --check   # drift gate: fails if anything on disk
//                                    # differs from what a stage would write
//                                    # (catches the restage ⇒ recapture rule:
//                                    # staged zip must equal the built zip)
//
// Staged tree (web/public/py-dev/fork/, gitignored):
//   pyodide.asm.js / pyodide.asm.wasm / pyodide.mjs / pyodide.js  (dist/raw)
//   package.json                       (boot crutch until fork patch 0006)
//   pyodide-lock.json                  (111-byte stub — dist/stage)
//   python_stdlib.zip                  (pruned zip — dist/stage)
//   bundles/<name>.tar                 (dist/stage/bundles)
//   manifest.json                      (generated here; field-compatible with
//                                       M3's R2 manifest)
// Checked-in codegen:
//   web/src/core/py/py-stdlib-modules.gen.ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');
const forkDir = join(repoRoot, 'web/public/py-dev/fork');
const genPath = join(repoRoot, 'web/src/core/py/py-stdlib-modules.gen.ts');
const check = process.argv.includes('--check');

const config = JSON.parse(readFileSync(join(pkgRoot, 'build.config.json'), 'utf8'));
const BUNDLES = Object.fromEntries(Object.entries(config.bundles).filter(([k]) => !k.startsWith('$')));
const SETS = config.sets;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- collect artifact bytes -------------------------------------------------
const ARTIFACTS = {
  'pyodide.asm.js': 'dist/raw/pyodide.asm.js',
  'pyodide.asm.wasm': 'dist/raw/pyodide.asm.wasm',
  'pyodide.mjs': 'dist/raw/pyodide.mjs',
  'pyodide.js': 'dist/raw/pyodide.js',
  'package.json': 'dist/raw/package.json',
  'pyodide-lock.json': 'dist/stage/pyodide-lock.json',
  'python_stdlib.zip': 'dist/stage/python_stdlib.zip',
};
const files = new Map(); // staged rel path -> Buffer
for (const [name, rel] of Object.entries(ARTIFACTS)) {
  const p = join(pkgRoot, rel);
  if (!existsSync(p)) {
    console.error(`missing ${rel} — build/pack it first`);
    process.exit(1);
  }
  files.set(name, readFileSync(p));
}
function parseTarMeta(buf) {
  const name = buf.toString('ascii', 0, 100).replace(/\0.*$/s, '');
  if (name !== 'meta.json') throw new Error(`first tar entry is ${JSON.stringify(name)}, want meta.json`);
  const size = Number.parseInt(buf.toString('ascii', 124, 136).replace(/\0.*$/s, ''), 8);
  return JSON.parse(buf.subarray(512, 512 + size).toString('utf8'));
}
const bundleMeta = {};
for (const b of Object.keys(BUNDLES)) {
  const p = join(pkgRoot, `dist/stage/bundles/${b}.tar`);
  if (!existsSync(p)) {
    console.error(`missing bundle ${b}.tar — pack-package.py first`);
    process.exit(1);
  }
  const buf = readFileSync(p);
  files.set(`bundles/${b}.tar`, buf);
  const meta = parseTarMeta(buf);
  bundleMeta[b] = { sha256: sha256(buf), size: buf.length, provides: meta.provides, requires: meta.requires };
}

// ---- allowlist inputs -------------------------------------------------------
const stdlibJson = JSON.parse(readFileSync(join(pkgRoot, 'dist/stage/stdlib-modules.json'), 'utf8'));
const builtins = JSON.parse(readFileSync(join(pkgRoot, 'dist/stage/builtin-modules.json'), 'utf8'));
// Tombstoned TOP-LEVEL stdlib names (ctypes, bz2, http, …) stay allowed —
// the runtime tombstone error beats a click-time refusal. Dotted keys
// (xml.sax) ride their shipped parent.
const tombstonedTops = stdlibJson.tombstoned.filter((k) => !k.includes('.'));
const stdlibModules = [...new Set([...stdlibJson.modules, ...builtins, ...tombstonedTops])].sort();

const pruneKeys = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => l.endsWith('/') || l.endsWith('.py'))
    .map((l) => l.replace(/\/$/, '').replace(/\.py$/, '').replaceAll('/', '.'))
    .filter((k) => k.split('.').every((seg) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)));
const tombstones = [...pruneKeys(join(pkgRoot, 'config/stdlib-prune.txt'))];
for (const f of readdirSync(join(pkgRoot, 'config/pkg-prune')).sort()) {
  if (f.endsWith('.txt')) tombstones.push(...pruneKeys(join(pkgRoot, 'config/pkg-prune', f)));
}
tombstones.sort();

// import root -> SMALLEST set key providing it (py-imports merges upward).
const packageToSet = {};
for (const [bundle, meta] of Object.entries(bundleMeta)) {
  const smallest = Object.entries(SETS)
    .filter(([, members]) => members.includes(bundle))
    .sort((a, b) => a[1].length - b[1].length)[0][0];
  for (const name of meta.provides) packageToSet[name] = smallest;
}

// ---- manifest + gen.ts ------------------------------------------------------
const manifest = {
  schema: 1,
  buildHash: 'dev',
  artifacts: Object.fromEntries(
    Object.keys(ARTIFACTS).map((name) => [name, { sha256: sha256(files.get(name)), size: files.get(name).length }]),
  ),
  bundles: bundleMeta,
  sets: SETS,
  stdlibModules,
  tombstones,
};
files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

const genSource = `// GENERATED by packages/py-build/scripts/stage.mjs — DO NOT EDIT.
// Inputs: dist/stage/stdlib-modules.json (pack-stdlib.py),
// dist/stage/builtin-modules.json (make-baseline.mjs), build.config.json,
// bundle tar metas. Drift gate: \`node scripts/stage.mjs --check\`.

/** Top-level importable names in the shipped runtime: pruned-stdlib zip
 * contents + the fork's true builtin_module_names. Tombstoned top-levels are
 * INCLUDED deliberately — the runtime's tombstone error is more precise than
 * a click-time refusal. */
export const STDLIB_MODULES: ReadonlySet<string> = new Set([
${stdlibModules.map((m) => `  ${JSON.stringify(m)},`).join('\n')}
]);

/** Import root -> the SMALLEST bundle-set key providing it (the click-time
 * gate merges upward across multiple roots). */
export const PACKAGE_TO_SET: Readonly<Record<string, string>> = {
${Object.entries(packageToSet)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join('\n')}
};

/** Package import roots the current artifact set actually provides. */
export const AVAILABLE_PACKAGES: ReadonlySet<string> = new Set(Object.keys(PACKAGE_TO_SET));

/** Set key -> member bundles, deps-first (mount order). Mirrors the packer
 * config; the click-time gate merges multi-package needs by bundle union. */
export const SET_BUNDLES: Readonly<Record<string, readonly string[]>> = {
${Object.entries(SETS)
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join('\n')}
};
`;

// ---- write or check ---------------------------------------------------------
let drift = 0;
const compare = (path, want) => {
  const ok = existsSync(path) && Buffer.compare(readFileSync(path), want) === 0;
  if (!ok) {
    console.error(`DRIFT ${path}`);
    drift++;
  }
};
if (check) {
  for (const [rel, buf] of files) compare(join(forkDir, rel), buf);
  compare(genPath, Buffer.from(genSource));
  console.log(drift ? `stage --check: ${drift} file(s) drifted — rerun stage.mjs` : 'stage --check: clean');
  process.exit(drift ? 1 : 0);
}
mkdirSync(join(forkDir, 'bundles'), { recursive: true });
for (const [rel, buf] of files) writeFileSync(join(forkDir, rel), buf);
writeFileSync(genPath, genSource);
console.log(`staged ${files.size} files -> ${forkDir}`);
console.log(`wrote ${genPath} (${stdlibModules.length} stdlib modules, ${Object.keys(packageToSet).length} package roots)`);
