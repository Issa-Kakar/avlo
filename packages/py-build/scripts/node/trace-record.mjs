#!/usr/bin/env node
// Import-tracer RECORD mode (G3) — the fork-boot half of `avlo-build trace`
// (check/propose live in the CLI; this stays Node by language policy: it
// boots pyodide.mjs).
//
//   node scripts/node/trace-record.mjs [--group numpy]
//
// Runs every package corpus group over UNPRUNED trees -> .cache/trace/*.json.
// Boots the fork on the RAW (unpruned) stdlib, installs the observe-only
// recorder (trace-imports.py), writes the overlay modules + the group's
// UNPRUNED wheel trees (.cache/unpruned/<wheel>/ — pack-bundles --unpruned;
// patched but nothing removed, INCLUDING traceOnly pillow/fonttools for
// mpl-family groups so residual PIL sites succeed and get caught), loads every
// .so, then runs the group's corpus samples. Samples marked `# trace: skip`
// (deliberate pruned-module probes) are excluded. One child process per group
// (RAM-bounded, mirroring the pytest corpus lane's boot-per-group).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const config = JSON.parse(readFileSync(join(pkgRoot, 'build.config.json'), 'utf8'));
const BUNDLES = Object.fromEntries(Object.entries(config.bundles).filter(([k]) => !k.startsWith('$')));
const SETS = config.sets;
// site-packages prefix follows the toolchain pin — never hardcode the minor.
const PY_MM = config.toolchain.python.split('.').slice(0, 2).join('.');
const PREFIX = `/lib/python${PY_MM}/site-packages`;
const corpusDir = join(pkgRoot, 'corpus');
const traceDir = join(pkgRoot, '.cache/trace');
const unprunedRoot = join(pkgRoot, '.cache/unpruned');

// Package groups only — 'basic' tests the PRUNED artifact's own behavior and
// 'sqlite' rides the bare stdlib since 314 made _sqlite3 static (no package
// tree to trace).
const GROUP_SET = { numpy: 'numpy+pandas', pandas: 'numpy+pandas', mpl: 'numpy+matplotlib', all: 'all', seaborn: 'all' };
const setWheels = (setKey) => SETS[setKey].flatMap((b) => BUNDLES[b]);

const groupArg = opt('--group', null);

if (!groupArg) {
  const groups = readdirSync(corpusDir)
    .filter((g) => statSync(join(corpusDir, g)).isDirectory() && g in GROUP_SET)
    .sort();
  let failed = 0;
  for (const g of groups) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--group', g], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `trace: ${failed} group(s) FAILED` : `trace: all groups recorded -> ${traceDir}`);
  process.exit(failed ? 1 : 0);
}

// child: one group
const setKey = GROUP_SET[groupArg];
const wheels = setWheels(setKey);
// mpl-family groups also mount the traceOnly wheels so residual PIL/fontTools
// sites RESOLVE (and are caught by `trace check`) instead of failing silently.
if (setKey.includes('matplotlib') || setKey === 'all') wheels.push('pillow', 'fonttools');
for (const w of wheels) {
  if (!existsSync(join(unprunedRoot, w))) {
    console.error(`FAIL ${groupArg}: unpruned tree missing for ${w} — run \`avlo-build pack-bundles --unpruned\` first`);
    process.exit(1);
  }
}

const indexDir = join(pkgRoot, 'dist/raw');
const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
const py = await loadPyodide({
  indexURL: indexDir,
  // RAW stdlib — unpruned trees all the way down, so stdlib needs get traced
  // against stdlib-prune.txt too.
  stdLibURL: pathToFileURL(join(indexDir, 'python_stdlib.zip')).href,
  packages: [],
  env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
});
py.runPython(readFileSync(join(pkgRoot, 'scripts/node/trace-imports.py'), 'utf8'));

// Overlay modules (the raw stdlib lacks them; patched mpl needs _avlo_png).
for (const f of readdirSync(join(pkgRoot, 'overlay/stdlib')).sort()) {
  if (f.endsWith('.py')) py.FS.writeFile(`${PREFIX}/${f}`, readFileSync(join(pkgRoot, 'overlay/stdlib', f)));
}

const sos = [];
for (const w of wheels) {
  const root = join(unprunedRoot, w);
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
// Mirror the executor contract: ensure_tzpath after mounts, before samples
// (pandas 3 rides zoneinfo for every tz op).
py.runPython('import _avlo_runtime; _avlo_runtime.ensure_tzpath()');
console.log(`${groupArg}: mounted ${wheels.join(', ')} (${sos.length} DSOs)`);

const samples = readdirSync(join(corpusDir, groupArg))
  .filter((f) => f.endsWith('.py'))
  .sort()
  .map((f) => ({ name: `${groupArg}/${f}`, source: readFileSync(join(corpusDir, groupArg, f), 'utf8') }));

let failed = 0;
for (const s of samples) {
  if (/^#\s*trace:\s*skip/m.test(s.source)) {
    console.log(`SKIP ${s.name} (trace: skip)`);
    continue;
  }
  try {
    py.runPython(
      `import builtins\n_g = {'__name__': '__main__', '__builtins__': builtins}\nexec(compile(${JSON.stringify(s.source)}, ${JSON.stringify(s.name)}, 'exec'), _g)`,
    );
    console.log(`PASS ${s.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${s.name}\n${String(err?.message ?? err).slice(0, 1500)}`);
  }
}
mkdirSync(traceDir, { recursive: true });
const dump = JSON.parse(py.runPython('_avlo_trace_dump()'));
writeFileSync(join(traceDir, `${groupArg}.json`), `${JSON.stringify(dump, null, 2)}\n`);
console.log(`${groupArg}: ${dump.loaded.length} loaded / ${dump.attempted.length} attempted -> ${groupArg}.json`);
process.exit(failed ? 1 : 0);
