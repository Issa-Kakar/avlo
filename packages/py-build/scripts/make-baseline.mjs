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
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const indexDir = resolve(pkgRoot, opt('--index', 'dist/raw'));
const stdlibZip = resolve(pkgRoot, opt('--stdlib', 'dist/stage/python_stdlib.zip'));
const outFile = resolve(pkgRoot, opt('--out', 'dist/baseline.snap'));
const warmups = readFileSync(join(pkgRoot, 'config/baseline-imports.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

// --- deterministic environment ----------------------------------------------
// Three nondeterminism sources reach the heap during a capture boot (found by
// byte-diffing two builds): (1) entropy — in Node, Emscripten's initRandomFill
// prefers require('crypto').randomFillSync over webcrypto, so BOTH get seeded
// stand-ins; (2) Date.now — MEMFS stamps every node (stdlib zip mtime lands in
// zipimport's heap cache); (3) performance.now — clock_gettime anchors.
let draws = 0;
function installDeterministicEnv() {
  let s = 0x9e3779b9 >>> 0;
  const next = () => {
    s ^= (s << 13) >>> 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    s >>>= 0;
    return s;
  };
  const fill = (view) => {
    draws++;
    const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < u8.length; i++) u8[i] = next() & 0xff;
    return view;
  };
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    configurable: true,
    value: fill,
  });
  const nodeCrypto = createRequire(import.meta.url)('crypto');
  nodeCrypto.randomFillSync = (buf, offset, size) => {
    const view = offset !== undefined ? new Uint8Array(buf.buffer ?? buf, offset, size ?? buf.length - offset) : buf;
    fill(view);
    return buf;
  };
  nodeCrypto.randomBytes = (n) => fill(Buffer.alloc(n));
  let fakeNow = 1_750_000_000_000; // fixed epoch; +1 ms per call
  Date.now = () => (fakeNow += 1);
  let perf = 0;
  performance.now = () => (perf += 0.1);
}

// --- snapshot container parsing (mirror of web/src/dev/py-spike-snap.ts) ---
function parseMeta(bytes) {
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, 12);
  if (u32[0] !== 0x706e7300) throw new Error('bad snapshot magic');
  const json = new TextDecoder().decode(bytes.subarray(48, 48 + u32[2]));
  return JSON.parse(json).avlo;
}

async function buildOnce(label) {
  installDeterministicEnv();
  draws = 0;
  const { loadPyodide } = await import(pathToFileURL(join(indexDir, 'pyodide.mjs')).href);
  const stdLibURL = existsSync(stdlibZip) ? pathToFileURL(stdlibZip).href : pathToFileURL(join(indexDir, 'python_stdlib.zip')).href;
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
    `[${label}] ${(snap.length / 1e6).toFixed(1)} MB, heapSize ${meta.heapSize}, ${draws} entropy draws, sha256 ${sha.slice(0, 16)}…`,
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
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, a.snap);
console.log(`wrote ${outFile}`);
