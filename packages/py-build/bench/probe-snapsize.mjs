// Baked 'all' heap → compressibility (build-time-snapshot sizing) + bake timing split.
import '/home/issak/dev/avlo/packages/py-build/scripts/lib/ts-resolve.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync } from 'node:zlib';

const repo = '/home/issak/dev/avlo';
const forkDir = process.argv.find((a) => a.startsWith('--fork='))?.split('=')[1] ?? join(repo, 'web/public/py-dev/fork');
const LOCK = JSON.parse(readFileSync(join(repo, 'packages/py-loader/build-lock.json'), 'utf8'));
{
  const src = readFileSync(
    join(repo, 'packages/py-build/.work/pyodide/cpython/build/Python-3.14.2/Python/emscripten_trampoline_wasm.c'),
    'utf8',
  );
  const hex = src.match(/hexStringToUTF8Array\("([0-9a-f]+)"\)/)[1];
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  globalThis.getWasmTrampolineModule = () => new WebAssembly.Module(bytes);
}
const { mountBundleTree, parseTarMeta } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-mount.ts')).href);
const { freeDsoFileData } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-loader.ts')).href);
const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
const py = await loadPyodide({ indexURL: forkDir, packages: [], env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' } });
const asAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
for (const bundle of LOCK.sets['all']) {
  const tar = new Uint8Array(asAB(readFileSync(join(forkDir, `bundles/${bundle}.tar`))));
  const meta = parseTarMeta(tar);
  mountBundleTree(py.FS, meta.prefix, tar);
  for (const so of meta.loadOrder) await py._api.loadDynlib(`${meta.prefix}/${so}`);
}
py.runPython('import _avlo_runtime; _avlo_runtime.post_restore(); del _avlo_runtime');
const { freedBytes } = freeDsoFileData(py);

// Bake timing split (mirrors BUNDLE_IMPORTS)
const BAKE = {
  numpy: 'import numpy, numpy.random\n_ = numpy.random.get_state()\ndel _',
  dateutil: 'import dateutil',
  pytz: 'import pytz',
  pandas: 'import pandas',
  matplotlib: 'import matplotlib, matplotlib.pyplot',
  seaborn: 'import seaborn',
};
const bakeMs = {};
for (const [name, code] of Object.entries(BAKE)) {
  const t0 = performance.now();
  py.runPython(code);
  bakeMs[name] = Math.round(performance.now() - t0);
}
const t0 = performance.now();
py.runPython('import gc; gc.collect(); gc.collect()');
bakeMs.gc = Math.round(performance.now() - t0);

const heap = py._module.HEAP8.slice();
const heapMB = (heap.length / 1e6).toFixed(1);
const time = (fn) => {
  const t = performance.now();
  const r = fn();
  return [r, Math.round(performance.now() - t)];
};
const [q5, q5ms] = time(() => brotliCompressSync(heap, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }));
const [q9, q9ms] = time(() => brotliCompressSync(heap, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }));
const [gz, gzms] = time(() => gzipSync(heap, { level: 6 }));
const [, dq9ms] = time(() => brotliDecompressSync(q9));
console.log(
  JSON.stringify({
    heapMB,
    freedMB: Math.round(freedBytes / 1e6),
    bakeMs,
    br_q5: { mb: (q5.length / 1e6).toFixed(1), ms: q5ms },
    br_q9: { mb: (q9.length / 1e6).toFixed(1), ms: q9ms },
    gzip6: { mb: (gz.length / 1e6).toFixed(1), ms: gzms },
    br_q9_decompress_ms: dq9ms,
  }),
);
process.exit(0);
