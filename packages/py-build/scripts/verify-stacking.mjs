#!/usr/bin/env node
// G-P3.0 — capture-after-restore ("stacking") probe, the one snapshot path the
// browser spike never exercised (its stacked capture rode a FRESH boot).
// Proves the production per-set generation flow end-to-end under Node:
//
//   boot A: _loadSnapshot(baseline) + _makeSnapshot:true
//           → mount sqlite3+numpy tars (canonical 'numpy' set order)
//           → loadDynlib per meta.loadOrder → set imports (numpy.random baked)
//           → gc×2 → makeMemorySnapshot()  (must be snapshotType:'stacked')
//   boot B: _loadSnapshot(stacked) + _preRestoreHook (production port)
//           → numpy present without re-import, lazy submodule import works
//           → blit probe: HEAP8 reset image → globals/modules gone, numpy lives
//
// GREEN ⇒ generation boots may stack on a restored baseline.
// RED   ⇒ generation boots fall back to cold + _makeSnapshot (spike-proven).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexDir = join(pkgRoot, 'dist/raw');
const stdLibURL = pathToFileURL(join(pkgRoot, 'dist/stage/python_stdlib.zip')).href;
const baselinePath = join(pkgRoot, 'dist/baseline.snap');
const SET_TARS = ['sqlite3', 'numpy']; // build.config.json sets.numpy — deps-first, sqlite3 rides first

const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function parseTarMeta(bytes) {
  const td = new TextDecoder();
  const name = td.decode(bytes.subarray(0, 100)).replace(/\0.*$/s, '');
  if (name !== 'meta.json') throw new Error(`meta.json not first tar entry: ${name}`);
  const size = Number.parseInt(td.decode(bytes.subarray(124, 136)).trim(), 8);
  return JSON.parse(td.decode(bytes.subarray(512, 512 + size)));
}

function parseMeta(bytes) {
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, 12);
  if (u32[0] !== 0x706e7300) throw new Error('bad snapshot magic');
  return JSON.parse(new TextDecoder().decode(bytes.subarray(48, 48 + u32[2]))).avlo;
}

async function mountBundle(py, tarName) {
  const bytes = readFileSync(join(pkgRoot, `dist/stage/bundles/${tarName}.tar`));
  const meta = parseTarMeta(bytes);
  py.FS.writeFile('/tmp/_b.tar', bytes);
  py.runPython(`import os, tarfile
with tarfile.open('/tmp/_b.tar') as _t:
    _t.extractall(${JSON.stringify(meta.prefix)}, members=[m for m in _t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_b.tar')
del _t`);
  for (const so of meta.loadOrder) await py._api.loadDynlib(`${meta.prefix}/${so}`);
  return meta;
}

/** Spike walkTree: parent-first dirs, files with mtimes + fresh byte copies. */
function walkTree(FS, root) {
  const dirs = [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.shift();
    dirs.push(dir);
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const path = `${dir}/${name}`;
      const st = FS.stat(path);
      if (FS.isDir(st.mode)) stack.push(path);
      else {
        const m = st.mtime;
        files.push({ path, mtimeMs: m instanceof Date ? m.getTime() : Number(m), bytes: FS.readFile(path).slice() });
      }
    }
  }
  return { root, dirs, files };
}

/** Production _preRestoreHook (py-loader.ts port target). */
function makePreRestoreHook(tree) {
  return (avlo, Module) => {
    const { API, FS } = Module;
    API.setDsoLoadInfo(avlo.dso);
    for (const d of tree.dirs) {
      try {
        FS.mkdirTree(d);
      } catch {
        /* exists */
      }
    }
    const byPath = new Map();
    const byBase = new Map();
    for (const f of tree.files) {
      FS.writeFile(f.path, f.bytes);
      FS.utime(f.path, f.mtimeMs, f.mtimeMs);
      byPath.set(f.path, f.bytes);
      byBase.set(f.path.split('/').pop(), f.bytes);
    }
    for (const name of avlo.dso.loadOrder) {
      const buf = byPath.get(name) ?? byBase.get(name.split('/').pop());
      if (!buf) throw new Error(`replay: no bytes for DSO ${name}`);
      API.loadDynlibReplay(name, buf);
    }
    API.restoreDsoHandles(avlo.dsoHandles);
    API.dsoReplayDone();
  };
}

const assert = (cond, label) => {
  if (!cond) {
    console.error(`!!! G-P3.0 RED: ${label}`);
    process.exit(1);
  }
  console.log(`  ok: ${label}`);
};

const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
const bootOpts = { indexURL: indexDir, stdLibURL, packages: [], env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' } };

// ---- boot A: restore baseline WITH capture armed ----
let t = performance.now();
const pyA = await loadPyodide({ ...bootOpts, _loadSnapshot: toAB(readFileSync(baselinePath)), _makeSnapshot: true });
console.log(`[A] baseline restore + _makeSnapshot boot: ${(performance.now() - t).toFixed(0)} ms`);
assert(pyA.runPython('1 + 1') === 2, 'A: arithmetic after restore');
assert(pyA.runPython('import sys; "re" in sys.modules') === true, 'A: baseline warmups present');

t = performance.now();
let soCount = 0;
let sitePackages = '';
for (const tar of SET_TARS) {
  const meta = await mountBundle(pyA, tar);
  soCount += meta.loadOrder.length;
  sitePackages = meta.prefix;
}
console.log(`[A] mounted ${SET_TARS.join('+')} (${soCount} DSOs): ${(performance.now() - t).toFixed(0)} ms`);

pyA.runPython('import sqlite3');
pyA.runPython('import numpy, numpy.random\n_ = numpy.random.get_state()'); // numpy 2.x: bake the global RandomState (G8R)
assert(Number(pyA.runPython('float(numpy.ones(4).sum())')) === 4, 'A: numpy works pre-capture');
pyA.runPython('import gc; gc.collect(); gc.collect()');

t = performance.now();
const stacked = pyA.makeMemorySnapshot().slice();
const captureMs = performance.now() - t;
const meta = parseMeta(stacked);
console.log(
  `[A] stacked capture: ${(stacked.length / 1e6).toFixed(1)} MB in ${captureMs.toFixed(0)} ms — meta {${meta?.snapshotType}, loadOrder ${meta?.dso.loadOrder.length}, handles ${Object.keys(meta?.dsoHandles ?? {}).length}}`,
);
assert(meta?.snapshotType === 'stacked', 'A: snapshotType is stacked');
assert(meta.dso.loadOrder.length === soCount, `A: loadOrder covers all ${soCount} DSOs`);

t = performance.now();
const tree = walkTree(pyA.FS, sitePackages);
console.log(
  `[A] walked ${tree.files.length} files / ${(tree.files.reduce((n, f) => n + f.bytes.length, 0) / 1e6).toFixed(1)} MB: ${(performance.now() - t).toFixed(0)} ms`,
);

// ---- boot B: restore the stacked snapshot via the production hook ----
t = performance.now();
const pyB = await loadPyodide({ ...bootOpts, _loadSnapshot: stacked.buffer, _preRestoreHook: makePreRestoreHook(tree) });
console.log(`[B] stacked restore boot: ${(performance.now() - t).toFixed(0)} ms`);
assert(pyB.runPython('import sys; "numpy" in sys.modules') === true, 'B: numpy present without re-import');
assert(Number(pyB.runPython('import numpy; float(numpy.ones(4).sum())')) === 4, 'B: numpy works after restore');
assert(pyB.runPython('import numpy.testing; numpy.testing is not None') === true, 'B: lazy submodule import works');
assert(
  pyB.runPython('import sqlite3; sqlite3.connect(":memory:").execute("select 41+1").fetchone()[0]') === 42,
  'B: sqlite3 works after restore',
);

// ---- blit probe: production reset flow (resetImage at ready-point) ----
const Module = pyB._module;
const resetImage = Module.HEAP8.slice();
pyB.runPython('blit_probe = 12345');
pyB.runPython('import fractions; fractions.Fraction(1, 2)');
t = performance.now();
Module.HEAP8.set(resetImage);
if (Module.HEAP8.length > resetImage.length) Module.HEAP8.fill(0, resetImage.length);
const blitMs = performance.now() - t;
pyB.runPython('import importlib, linecache; importlib.invalidate_caches(); linecache.clearcache()');
assert(pyB.runPython('"blit_probe" not in globals()') === true, 'B: blit erased globals');
assert(pyB.runPython('import sys; "fractions" not in sys.modules') === true, 'B: blit erased module import');
assert(Number(pyB.runPython('import numpy; float(numpy.ones(4).sum())')) === 4, 'B: numpy lives after blit');
console.log(`[B] blit reset: ${blitMs.toFixed(1)} ms for ${(resetImage.length / 1e6).toFixed(1)} MB`);

console.log('G-P3.0 GREEN: capture-after-restore + hook replay + blit all verified');
