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
//   pyodide.asm.mjs / pyodide.asm.wasm / pyodide.mjs  (dist/raw; patch 0006
//                                       dropped the pyodide.js/package.json/
//                                       pyodide-lock.json boot crutch; 314
//                                       renamed the asm glue to .mjs)
//   python_stdlib.zip                  (pruned zip — dist/stage)
//   bundles/<name>.tar                 (dist/stage/bundles)
//   (no snapshot artifacts: snapshots are client-captured, OPFS-only)
//   manifest.json                      (generated here; field-compatible with
//                                       M3's R2 manifest)
// Checked-in codegen:
//   web/src/core/py/py-stdlib-modules.gen.ts
//   web/src/core/py/pyodide-fork.gen.d.ts (dist/raw/pyodide.d.ts — app-side
//                                         fork types; NOT part of buildHash)
//   packages/py-loader/build-lock.json   (the committed app↔artifact coupling;
//                                         restage ⇒ new buildHash ⇒ reseed R2
//                                         (publish.mjs) + commit the lock)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'pyodide.asm.mjs': 'dist/raw/pyodide.asm.mjs',
  'pyodide.asm.wasm': 'dist/raw/pyodide.asm.wasm',
  'pyodide.mjs': 'dist/raw/pyodide.mjs',
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
// Prestage liveness gate: the built glue must carry the emsdk dsoBaseHook
// (P2 snapshot replay — a silently-unpatched dylink layer fails only at
// runtime, hours downstream) and the dynload surface 0006's side-effect
// import anchors (esbuild would tree-shake API.loadDynlib without it).
for (const marker of ['snapshot DSO table drift', 'loadDynlib']) {
  if (!files.get('pyodide.asm.mjs').includes(marker)) {
    console.error(`built glue is missing "${marker}" — rebuild with the full patch queue (run-build.mjs)`);
    process.exit(1);
  }
}
// Wasm-gc trampoline liveness: the glue must DEFINE getWasmTrampolineModule
// (call site + EM_JS definition ⇒ ≥2 occurrences). One occurrence = the
// archive member never linked (the MAIN_MODULE=2 lazy-archive regression the
// 0001 `-Wl,-u` exists for) and every METH_* call pays a JS round-trip.
{
  const n = files.get('pyodide.asm.mjs').toString('utf8').split('getWasmTrampolineModule').length - 1;
  if (n < 2) {
    console.error(
      `built glue has ${n} occurrence(s) of getWasmTrampolineModule (need call site + definition) — the wasm-gc trampoline is dead; check patch 0001's -Wl,-u,__em_js__getWasmTrampolineModule`,
    );
    process.exit(1);
  }
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

// ---- build-lock -------------------------------------------------------------
// buildHash = 16-hex truncated sha256 over canonical (recursively key-sorted)
// JSON of the slim sha tables — deterministic for identical artifact bytes.
// The committed lock is the supervisor's ONLY artifact source of truth (no
// boot-time manifest fetch); manifest.json stays the R2 completion marker +
// provides/requires superset.
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
const artifactTable = Object.fromEntries(
  Object.keys(ARTIFACTS).map((name) => [name, { sha256: sha256(files.get(name)), size: files.get(name).length }]),
);
const bundleTable = Object.fromEntries(Object.entries(bundleMeta).map(([b, m]) => [b, { sha256: m.sha256, size: m.size }]));
const buildHash = sha256(canonical({ artifacts: artifactTable, bundles: bundleTable, sets: SETS })).slice(0, 16);
const buildLockPath = join(repoRoot, 'packages/py-loader/build-lock.json');
const buildLockBytes = Buffer.from(
  `${JSON.stringify({ schema: 1, buildHash, artifacts: artifactTable, bundles: bundleTable, sets: SETS }, null, 2)}\n`,
);

// ---- manifest + gen.ts ------------------------------------------------------
const manifest = {
  schema: 1,
  buildHash,
  artifacts: artifactTable,
  bundles: bundleMeta,
  sets: SETS,
  stdlibModules,
  tombstones,
};
files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

// Emit biome-shaped source (single quotes, unquoted identifier keys) so the
// pre-commit formatter is a no-op and --check's byte-compare holds.
const q = (s) => `'${s}'`;
const key = (s) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : q(s));
const arr = (v) => `[${v.map(q).join(', ')}]`;
const genSource = `// GENERATED by packages/py-build/scripts/stage.mjs — DO NOT EDIT.
// Inputs: dist/stage/stdlib-modules.json (pack-stdlib.py),
// dist/stage/builtin-modules.json (dump-builtins.mjs), build.config.json,
// bundle tar metas. Drift gate: \`node scripts/stage.mjs --check\`.

/** Set keys the runtime can boot: 'stdlib' plus the configured bundle sets.
 * THE PySetKey — py-protocol re-exports this union, so the type can never
 * lag the set tables again. */
export type PySetKey = 'stdlib' | ${Object.keys(SETS).map(q).join(' | ')};

/** Top-level importable names in the shipped runtime: pruned-stdlib zip
 * contents + the fork's true builtin_module_names. Tombstoned top-levels are
 * INCLUDED deliberately — the runtime's tombstone error is more precise than
 * a click-time refusal. */
export const STDLIB_MODULES: ReadonlySet<string> = new Set([
${stdlibModules.map((m) => `  ${q(m)},`).join('\n')}
]);

/** Import root -> the SMALLEST bundle-set key providing it (the click-time
 * gate merges upward across multiple roots). Frozen: consumed by the
 * supervisor worker and main thread alike — never reshapeable at runtime. */
export const PACKAGE_TO_SET: Readonly<Record<string, Exclude<PySetKey, 'stdlib'>>> = Object.freeze({
${Object.entries(packageToSet)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([k, v]) => `  ${key(k)}: ${q(v)},`)
  .join('\n')}
});

/** Package import roots the current artifact set actually provides. */
export const AVAILABLE_PACKAGES: ReadonlySet<string> = new Set(Object.keys(PACKAGE_TO_SET));

/** Set key -> member bundles, deps-first (mount order). Mirrors the packer
 * config; the click-time gate merges multi-package needs by bundle union. */
export const SET_BUNDLES: Readonly<Record<Exclude<PySetKey, 'stdlib'>, readonly string[]>> = Object.freeze({
${Object.entries(SETS)
  .map(([k, v]) => `  ${key(k)}: Object.freeze(${arr(v)}),`)
  .join('\n')}
});
`;

// ---- fork public types (pyodide-fork.gen.d.ts) ------------------------------
// dist/raw/pyodide.d.ts staged for app-side typing (py-loader's Pyodide);
// checked in + drift-gated like the gen.ts, deliberately NEVER hashed into
// buildHash — types carry no runtime bytes. One deterministic transform:
// drop the emitted `node:stream/web` import (its two ReadableStream/
// WritableStream refs sit on the unused Socket surface and lib.dom's
// globals cover them — the web tsconfig has no node types).
const dtsGenPath = join(repoRoot, 'web/src/core/py/pyodide-fork.gen.d.ts');
const dtsRawPath = join(pkgRoot, 'dist/raw/pyodide.d.ts');
if (!existsSync(dtsRawPath)) {
  console.error('missing dist/raw/pyodide.d.ts — rebuild (run-build.mjs) first');
  process.exit(1);
}
const nodeStreamImport = "import { ReadableStream, WritableStream } from 'node:stream/web';\n";
const dtsRaw = readFileSync(dtsRawPath, 'utf8');
if (!dtsRaw.includes(nodeStreamImport)) {
  console.error('dist/raw/pyodide.d.ts: the node:stream/web import to strip is gone — dts emission changed, re-derive this transform');
  process.exit(1);
}
const dtsSource = `// GENERATED by packages/py-build/scripts/stage.mjs from dist/raw/pyodide.d.ts — DO NOT EDIT.
// The fork's emitted public types (patch 0009 declares _module/_api + the
// Module runtime exports). Drift gate: \`node scripts/stage.mjs --check\`.
${dtsRaw.replace(nodeStreamImport, '')}`;

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
  compare(dtsGenPath, Buffer.from(dtsSource));
  compare(buildLockPath, buildLockBytes);
  console.log(drift ? `stage --check: ${drift} file(s) drifted — rerun stage.mjs` : 'stage --check: clean');
  process.exit(drift ? 1 : 0);
}
mkdirSync(join(forkDir, 'bundles'), { recursive: true });
for (const [rel, buf] of files) writeFileSync(join(forkDir, rel), buf);
// Prune strays — the fork dir is gitignored, so a dropped artifact (e.g. the
// pre-0006 boot crutch) would otherwise linger unseen by --check forever.
for (const dir of ['', 'bundles/']) {
  for (const entry of readdirSync(join(forkDir, dir || '.'), { withFileTypes: true })) {
    if (entry.isFile() && !files.has(dir + entry.name)) {
      rmSync(join(forkDir, dir, entry.name));
      console.log(`pruned stray ${dir}${entry.name}`);
    }
  }
}
writeFileSync(genPath, genSource);
writeFileSync(dtsGenPath, dtsSource);
writeFileSync(buildLockPath, buildLockBytes);
console.log(`staged ${files.size} files -> ${forkDir}`);
console.log(`wrote ${genPath} (${stdlibModules.length} stdlib modules, ${Object.keys(packageToSet).length} package roots)`);
console.log(`wrote ${buildLockPath} (buildHash ${buildHash})`);
