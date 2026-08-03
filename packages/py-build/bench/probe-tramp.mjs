// Trampoline / allocator / interrupt A-B probe against the SHIPPED fork glue.
// Usage: node probe-tramp.mjs [--shim] [--malloc=mimalloc] [--interrupt] [--label=X]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

const args = process.argv.slice(2);
// --fork=<dir> benches an unstaged build (e.g. packages/py-build/dist/raw).
const forkDir = resolve(args.find((a) => a.startsWith('--fork='))?.split('=')[1] ?? join(repo, 'web/public/py-dev/fork'));
const SHIM = args.includes('--shim');
const INTERRUPT = args.includes('--interrupt');
const MALLOC = args.find((a) => a.startsWith('--malloc='))?.split('=')[1];
const LABEL = args.find((a) => a.startsWith('--label='))?.split('=')[1] ?? 'cfg';

let shimCalls = 0;
if (SHIM) {
  // Extract the inner trampoline module hex VERBATIM from the CPython build tree.
  const src = readFileSync(
    join(repo, 'packages/py-build/.work/pyodide/cpython/build/Python-3.14.2/Python/emscripten_trampoline_wasm.c'),
    'utf8',
  );
  const hex = src.match(/hexStringToUTF8Array\("([0-9a-f]+)"\)/)[1];
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  globalThis.getWasmTrampolineModule = () => {
    shimCalls++;
    return new WebAssembly.Module(bytes);
  };
}

// Best-effort address extraction from the glue for a direct ptr readout.
const glueText = readFileSync(join(forkDir, 'pyodide.asm.mjs'), 'utf8');
const mPyRuntime = glueText.match(/[^A-Za-z0-9_$]__PyRuntime\s*=\s*(\d+)/);
const mOffset = glueText.match(/[^A-Za-z0-9_$]__PyEM_EMSCRIPTEN_TRAMPOLINE_OFFSET\s*=\s*(\d+)/);

const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
const env = { PYTHONHASHSEED: '0', HOME: '/home/pyodide' };
if (MALLOC) env.PYTHONMALLOC = MALLOC;

const t0 = performance.now();
const py = await loadPyodide({ indexURL: forkDir, packages: [], env });
const bootMs = Math.round(performance.now() - t0);

const M = py._module;

// Direct trampoline-ptr readout (if addresses were extractable).
let trampPtr = null;
try {
  const pyRuntimeAddr = mPyRuntime ? Number(mPyRuntime[1]) : (M.wasmExports?._PyRuntime?.value ?? null);
  const offAddr = mOffset ? Number(mOffset[1]) : (M.wasmExports?._PyEM_EMSCRIPTEN_TRAMPOLINE_OFFSET?.value ?? null);
  if (pyRuntimeAddr != null && offAddr != null) {
    const off = M.HEAP32[offAddr / 4];
    trampPtr = M.HEAP32[(pyRuntimeAddr + off) / 4];
  }
} catch {}

// Behavioral proof: count wasmTable.get calls during a trampoline-heavy loop.
const origGet = WebAssembly.Table.prototype.get;
let tableGets = 0;
WebAssembly.Table.prototype.get = function (...a) {
  tableGets++;
  return origGet.apply(this, a);
};
py.runPython('q=(1234567890).bit_length\nfor _ in range(10000): q()\ndel q');
WebAssembly.Table.prototype.get = origGet;

if (INTERRUPT) {
  const sab = new SharedArrayBuffer(64);
  py.setInterruptBuffer(new Uint8Array(sab));
}

const benchSrc = readFileSync(join(here, 'bench.py'), 'utf8');
const run = () => {
  py.runPython(benchSrc);
  return JSON.parse(py.runPython('result')).suite;
};
const run1 = run();
const run2 = run();

const heapMB = Math.round(M.HEAP8.length / 1e6);
console.log(
  JSON.stringify({
    label: LABEL,
    shim: SHIM,
    shimCalls,
    malloc: MALLOC ?? 'default',
    interrupt: INTERRUPT,
    bootMs,
    trampPtr,
    tableGetsPer10k: tableGets,
    heapMB,
    run1,
    run2,
  }),
);
process.exit(0);
