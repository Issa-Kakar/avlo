#!/usr/bin/env node
// Corpus runner. Parent: one CHILD PROCESS per corpus group — fresh
// interpreter per group and bounded RAM (9GB WSL2 host; pandas+mpl in one
// process would compound). Child: boots the fork on the staged stdlib,
// mounts the group's bundle set from dist/stage/bundles/*.tar (the REAL
// artifacts — same 512-byte meta parse + tarfile.extractall + loadDynlib
// order the product runtime uses), then runs every sample in a fresh
// namespace. Samples are self-asserting; any exception fails.
//
//   node scripts/run-corpus.mjs [--index dist/raw] [--stdlib dist/stage/python_stdlib.zip] [--group numpy]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng } from './lib/png.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const indexDir = resolve(pkgRoot, opt('--index', 'dist/raw'));
const stdlibZip = resolve(pkgRoot, opt('--stdlib', 'dist/stage/python_stdlib.zip'));
const groupArg = opt('--group', null);
const corpusDir = join(pkgRoot, 'corpus');
const bundleDir = join(pkgRoot, 'dist/stage/bundles');

const config = JSON.parse(readFileSync(join(pkgRoot, 'build.config.json'), 'utf8'));
const SETS = config.sets;
// corpus group -> set key ('basic' and 'sqlite' run on the bare stdlib —
// sqlite3 went static in the 314 main module, so its group needs no tars).
const GROUP_SET = {
  basic: null,
  sqlite: null,
  numpy: 'numpy',
  pandas: 'numpy+pandas',
  mpl: 'numpy+matplotlib',
  all: 'all',
  seaborn: 'all',
};

// ---------------------------------------------------------------- parent
if (!groupArg) {
  const groups = readdirSync(corpusDir)
    .filter((g) => statSync(join(corpusDir, g)).isDirectory())
    .sort();
  let failed = 0;
  for (const g of groups) {
    if (!(g in GROUP_SET)) {
      console.error(`SKIP ${g}: no set mapping in run-corpus.mjs GROUP_SET`);
      failed++;
      continue;
    }
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--group', g, '--index', indexDir, '--stdlib', stdlibZip], {
      stdio: 'inherit',
    });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `corpus: ${failed} group(s) FAILED` : 'corpus: all groups pass');
  process.exit(failed ? 1 : 0);
}

// ----------------------------------------------------------------- child
if (!existsSync(stdlibZip)) {
  console.error(`staged stdlib zip missing: ${stdlibZip} — run pack:stdlib first`);
  process.exit(1);
}
const setKey = GROUP_SET[groupArg];
const bundles = setKey ? SETS[setKey] : [];
for (const b of bundles) {
  if (!existsSync(join(bundleDir, `${b}.tar`))) {
    console.error(`FAIL ${groupArg}: bundle missing: ${b}.tar — run pack-package.py first`);
    process.exit(1);
  }
}

const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
const py = await loadPyodide({
  indexURL: indexDir,
  stdLibURL: pathToFileURL(stdlibZip).href,
  packages: [],
  env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
});

// meta.json is the FIRST ustar entry by construction (D2): name at byte 0,
// size as octal at 124, payload at 512 — one header parse, no tar library.
function parseTarMeta(buf) {
  const name = buf.toString('ascii', 0, 100).replace(/\0.*$/s, '');
  if (name !== 'meta.json') throw new Error(`first tar entry is ${JSON.stringify(name)}, want meta.json`);
  const size = Number.parseInt(buf.toString('ascii', 124, 136).replace(/\0.*$/s, ''), 8);
  return JSON.parse(buf.subarray(512, 512 + size).toString('utf8'));
}

// pyodide's sysconfig joins base '/' -> '//lib/…'; normpath keeps the
// POSIX-special leading double slash, so collapse it by hand.
const derivedPrefix = py.runPython('import sysconfig; "/" + sysconfig.get_paths()["purelib"].lstrip("/")');
for (const b of bundles) {
  const buf = readFileSync(join(bundleDir, `${b}.tar`));
  const meta = parseTarMeta(buf);
  if (meta.prefix !== derivedPrefix) {
    throw new Error(`${b}: meta.prefix ${meta.prefix} != interpreter site-packages ${derivedPrefix}`);
  }
  py.FS.writeFile('/tmp/_avlo_bundle.tar', new Uint8Array(buf));
  py.runPython(
    `import tarfile, os
with tarfile.open('/tmp/_avlo_bundle.tar') as _t:
    _t.extractall(${JSON.stringify(meta.prefix)}, members=[m for m in _t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_avlo_bundle.tar')`,
  );
  for (const so of meta.loadOrder) {
    await py._api.loadDynlib(`${meta.prefix}/${so}`);
  }
  console.log(`mounted ${b} (${meta.counts.files} files, ${meta.counts.so} DSOs)`);
}
if (bundles.length > 0) {
  // Mirror the executor contract: post_restore (⊃ ensure_tzpath) runs after
  // mounts, before user code — pandas 3 rides zoneinfo for every tz op.
  py.runPython('import _avlo_runtime; _avlo_runtime.ensure_tzpath()');
}

const hasMpl = bundles.includes('matplotlib');
if (hasMpl) {
  // Font gates ride matplotlib's logger: 'generated new fontManager' (INFO)
  // means the BAKED fontlist.json was not consumed; 'findfont' (WARNING)
  // means the subset faces miss a requested family/glyph set.
  py.runPython(
    `import logging
_avlo_mpl_logs = []
class _AvloLogTap(logging.Handler):
    def emit(self, record):
        _avlo_mpl_logs.append(record.getMessage())
_mpl_logger = logging.getLogger('matplotlib')
_mpl_logger.addHandler(_AvloLogTap(level=logging.INFO))
_mpl_logger.setLevel(logging.INFO)`,
  );
}

const samples = readdirSync(join(corpusDir, groupArg))
  .filter((f) => f.endsWith('.py'))
  .sort()
  .map((f) => ({ name: `${groupArg}/${f}`, source: readFileSync(join(corpusDir, groupArg, f), 'utf8') }));

let failed = 0;
for (const s of samples) {
  try {
    // Fresh namespace per sample, mirroring the run harness contract.
    py.runPython(
      `import builtins\n_g = {'__name__': '__main__', '__builtins__': builtins}\nexec(compile(${JSON.stringify(s.source)}, ${JSON.stringify(s.name)}, 'exec'), _g)`,
    );
    console.log(`PASS ${s.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${s.name}\n${String(err?.message ?? err).slice(0, 2000)}`);
  }
}
if (hasMpl) {
  const logs = JSON.parse(py.runPython('import json; json.dumps(_avlo_mpl_logs)'));
  for (const line of logs) {
    if (/generated new fontManager/.test(line)) {
      console.error('FAIL font gate: baked fontlist.json was NOT consumed (fontManager rebuilt)');
      failed++;
    }
    if (/findfont/.test(line)) {
      console.error(`FAIL font gate: ${line}`);
      failed++;
    }
  }
  // Decode every PNG the samples produced — real pixels, not just magic bytes.
  let outFiles = [];
  try {
    outFiles = py.FS.readdir('/tmp/corpus-out').filter((f) => f.endsWith('.png'));
  } catch {
    /* no output dir — no figure samples ran */
  }
  for (const f of outFiles) {
    const png = decodePng(Buffer.from(py.FS.readFile(`/tmp/corpus-out/${f}`)));
    const { width, height, channels, pixels } = png;
    const counts = new Map();
    for (let i = 0; i < pixels.length; i += channels) {
      const key = pixels[i] | (pixels[i + 1] << 8) | (pixels[i + 2] << 16);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const total = width * height;
    const top = Math.max(...counts.values());
    const ok = width > 0 && height > 0 && counts.size >= 2 && top / total < 0.99;
    if (!ok) {
      console.error(`FAIL png gate ${f}: ${width}x${height}, ${counts.size} colors, dominant ${((top / total) * 100).toFixed(1)}%`);
      failed++;
    } else {
      console.log(`png ok ${f}: ${width}x${height}, ${counts.size} colors, dominant ${((top / total) * 100).toFixed(1)}%`);
    }
  }
}

console.log(`${groupArg}: ${samples.length - failed}/${samples.length} pass`);
process.exit(failed ? 1 : 0);
