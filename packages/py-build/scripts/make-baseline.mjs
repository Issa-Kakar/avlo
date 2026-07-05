#!/usr/bin/env node
// Build dist/baseline.snap — the shared interpreter+stdlib snapshot every
// client restores from. Runs the SAME engine family (V8) that restores it.
//
//   node scripts/make-baseline.mjs [--repro] [--stdlib <zip>] [--out <file>]
//
// Determinism (the runtime-side replacement for the dropped fork patch 0008):
// crypto.getRandomValues is replaced with a fixed-seed xorshift for the
// capture boot (drain count logged), and PYTHONHASHSEED=0 rides the env so
// hash randomization is off in the baked heap. --repro builds twice and
// hard-fails unless the two snapshots are byte-identical (G0).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { entropyDraws, installDeterministicEnv } from './lib/det-env.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const indexDir = resolve(pkgRoot, opt('--index', 'dist/raw'));
const stdlibZip = resolve(pkgRoot, opt('--stdlib', 'dist/stage/python_stdlib.zip'));
const outFile = resolve(pkgRoot, opt('--out', 'dist/baseline.snap'));
if (!existsSync(stdlibZip)) {
  // A silent fallback to the raw zip would bake the WRONG stdlib into the
  // baseline (restage ⇒ recapture rule) — refuse instead.
  console.error(`staged stdlib zip missing: ${stdlibZip} — run pack:stdlib first`);
  process.exit(1);
}
const warmups = readFileSync(join(pkgRoot, 'config/baseline-imports.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

// --- snapshot container parsing (mirror of web/src/dev/py-spike-snap.ts) ---
function parseMeta(bytes) {
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, 12);
  if (u32[0] !== 0x706e7300) throw new Error('bad snapshot magic');
  const json = new TextDecoder().decode(bytes.subarray(48, 48 + u32[2]));
  return JSON.parse(json).avlo;
}

async function buildOnce(label) {
  installDeterministicEnv();
  const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
  const stdLibURL = pathToFileURL(stdlibZip).href;
  const py = await loadPyodide({
    indexURL: indexDir,
    stdLibURL,
    packages: [],
    env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
    _makeSnapshot: true,
  });
  if (py.runPython('import sys; sys.flags.hash_randomization') !== 0) {
    throw new Error('hash randomization still on — PYTHONHASHSEED env not applied');
  }
  for (const m of warmups) py.runPython(`import ${m}`);
  // Quiesce: two GC passes; nothing else is live in a fresh Node boot.
  py.runPython('import gc; gc.collect(); gc.collect()');
  const snap = py.makeMemorySnapshot();
  const meta = parseMeta(snap);
  if (meta?.snapshotType !== 'baseline' || meta.dso.loadOrder.length !== 0) {
    throw new Error(`unexpected meta: ${JSON.stringify(meta)}`);
  }
  const sha = createHash('sha256').update(snap).digest('hex');
  console.log(
    `[${label}] ${(snap.length / 1e6).toFixed(1)} MB, heapSize ${meta.heapSize}, ${entropyDraws()} entropy draws, sha256 ${sha.slice(0, 16)}…`,
  );
  return { snap: snap.slice(), sha, stdLibURL };
}

const a = await buildOnce('build');
if (args.includes('--repro')) {
  const b = await buildOnce('repro');
  if (a.sha !== b.sha) {
    console.error('!!! G0 FAIL: snapshots differ across identical builds');
    process.exit(1);
  }
  console.log('G0 OK: byte-identical across two builds');
}

// Restore-verify in this same process: the snapshot must boot and the warmup
// set must be present without re-import.
{
  const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
  const py = await loadPyodide({
    indexURL: indexDir,
    stdLibURL: a.stdLibURL,
    packages: [],
    env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
    _loadSnapshot: a.snap.buffer,
  });
  if (py.runPython('1 + 1') !== 2) throw new Error('restore-verify: arithmetic');
  if (py.runPython('import sys; "re" in sys.modules') !== true) {
    throw new Error('restore-verify: warmup modules missing');
  }
  console.log(`restore-verify OK (python ${py.runPython('import sys; sys.version.split()[0]')})`);

  // D9: the fork's TRUE builtin module set — merged with stdlib-modules.json
  // by stage.mjs into the generated click-time allowlist.
  const builtins = JSON.parse(py.runPython('import sys, json; json.dumps(sorted(sys.builtin_module_names))'));
  const builtinsFile = join(pkgRoot, 'dist/stage/builtin-modules.json');
  writeFileSync(builtinsFile, `${JSON.stringify(builtins, null, 2)}\n`);
  console.log(`wrote ${builtinsFile} (${builtins.length} builtins)`);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, a.snap);
console.log(`wrote ${outFile}`);
