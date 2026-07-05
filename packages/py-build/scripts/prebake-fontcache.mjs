#!/usr/bin/env node
// D8: bake matplotlib's font cache into the staged tree. Invoked by
// pack-package.py between staging and tar-ing the matplotlib bundle (also
// usable standalone between --stage-only and --tar-only).
//
// Boots the fork (deterministic-env kit — same discipline as make-baseline)
// on the staged stdlib, mounts the STAGED trees of matplotlib's whole
// dependency set from .cache/stage/, imports matplotlib.font_manager (which
// finds no fontlist.json, builds a fresh FontManager over the subset faces,
// and json_dumps it to site-packages/matplotlib/fontlist.json — this wheel's
// _load_fontmanager already reads that package-local path), reads the result
// back, canonical-JSON post-processes it, and writes it into the staged tree.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDeterministicEnv } from './lib/det-env.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stageRoot = join(pkgRoot, '.cache/stage');
const PREFIX = '/lib/python3.13/site-packages';
// matplotlib's mount closure (pandas not needed to import font_manager).
const MOUNT = ['numpy', 'dateutil', 'pytz', 'mpl-deps', 'matplotlib'];

for (const b of MOUNT) {
  if (!existsSync(join(stageRoot, b))) {
    console.error(`prebake: staged tree missing: ${b} — pack it first (deps-first order)`);
    process.exit(1);
  }
}
const stdlibZip = join(pkgRoot, 'dist/stage/python_stdlib.zip');
if (!existsSync(stdlibZip)) {
  console.error('prebake: staged stdlib zip missing — run pack:stdlib first');
  process.exit(1);
}

installDeterministicEnv();
const indexDir = join(pkgRoot, 'dist/raw');
const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
const py = await loadPyodide({
  indexURL: indexDir,
  stdLibURL: pathToFileURL(stdlibZip).href,
  packages: [],
  env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
});

const sos = [];
for (const b of MOUNT) {
  const root = join(stageRoot, b);
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) {
        py.FS.mkdirTree(`${PREFIX}/${r}`);
        walk(p, r);
      } else {
        py.FS.writeFile(`${PREFIX}/${r}`, readFileSync(p));
        if (r.endsWith('.so')) sos.push(r);
      }
    }
  };
  walk(root, '');
}
sos.sort();
for (const so of sos) await py._api.loadDynlib(`${PREFIX}/${so}`);

// The wheel SHIPS a 39-face fontlist.json (pyodide-recipes prebake) — stale
// for the subset tree. Drop it so _load_fontmanager rebuilds over the faces
// that actually ship, then json_dumps the fresh list to the same path.
py.runPython(`import os
try:
    os.remove('${PREFIX}/matplotlib/fontlist.json')
except FileNotFoundError:
    pass`);
py.runPython('import matplotlib.font_manager');
const rawList = py.FS.readFile(`${PREFIX}/matplotlib/fontlist.json`, { encoding: 'utf8' });
const parsed = JSON.parse(rawList);
if (!parsed._version || !Array.isArray(parsed.ttflist) || parsed.ttflist.length === 0) {
  throw new Error(`prebake: implausible fontlist: ${rawList.slice(0, 200)}`);
}
const fontsCfg = JSON.parse(readFileSync(join(pkgRoot, 'build.config.json'), 'utf8')).fonts;
const faces = new Set([...fontsCfg.faces, ...fontsCfg.keepUnsubset]);
for (const e of parsed.ttflist) {
  const base = e.fname.split('/').pop();
  if (!faces.has(base)) throw new Error(`prebake: unexpected face in fontlist: ${e.fname}`);
}
// canonical JSON: sorted keys, compact — byte-stable across bakes.
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
writeFileSync(join(stageRoot, 'matplotlib/matplotlib/fontlist.json'), canonical(parsed));
console.log(`prebake: fontlist.json baked (${parsed.ttflist.length} faces)`);
