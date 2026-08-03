import '/home/issak/dev/avlo/packages/py-build/scripts/lib/ts-resolve.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
const py = await loadPyodide({ indexURL: forkDir, packages: [], env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' } });
const asAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
for (const bundle of LOCK.sets['numpy+matplotlib']) {
  const tar = new Uint8Array(asAB(readFileSync(join(forkDir, `bundles/${bundle}.tar`))));
  const meta = parseTarMeta(tar);
  mountBundleTree(py.FS, meta.prefix, tar);
  for (const so of meta.loadOrder) await py._api.loadDynlib(`${meta.prefix}/${so}`);
}
py.runPython(`
import time, io, json, zlib
import numpy as np
import matplotlib; import matplotlib.pyplot as plt
x = np.linspace(0, 10, 1000)
fig, ax = plt.subplots(figsize=(12, 9), dpi=160)
for k in range(8): ax.plot(x, np.sin(x + k*0.4))
ax.set_title('big'); ax.grid(True)
fig.canvas.draw()
rgba = np.asarray(fig.canvas.buffer_rgba()).copy(); plt.close(fig)
h, w = rgba.shape[0], rgba.shape[1]
t = {'px': [w, h]}
def timeit(name, fn, reps=3):
    best = 1e18
    for _ in range(reps):
        t0 = time.perf_counter(); fn(); t1 = time.perf_counter()
        best = min(best, t1 - t0)
    t[name] = round(best * 1000, 1)
# filter 0 (None) raw
data = rgba.tobytes(); stride = w*4
raw0 = bytearray()
for yy in range(h): raw0.append(0); raw0 += data[yy*stride:(yy+1)*stride]
raw0 = bytes(raw0)
# filter 2 (Up) via numpy: delta rows, prepend filter byte 2
def build_up():
    d = rgba.astype(np.int16)
    d[1:] -= rgba[:-1].astype(np.int16)
    filt = (d & 0xFF).astype(np.uint8)
    rows = np.concatenate([np.full((h,1), 2, np.uint8), filt.reshape(h, stride)], axis=1)
    return rows.tobytes()
timeit('build_up_ms', build_up)
rawU = build_up()
def C(dat, lvl, strat):
    co = zlib.compressobj(lvl, zlib.DEFLATED, 15, 8, strat)
    return co.compress(dat) + co.flush()
for name, dat, lvl, strat in [
    ('f0_l1_default', raw0, 1, zlib.Z_DEFAULT_STRATEGY),
    ('f0_l1_rle',     raw0, 1, zlib.Z_RLE),
    ('f0_l6_default', raw0, 6, zlib.Z_DEFAULT_STRATEGY),
    ('fU_l1_default', rawU, 1, zlib.Z_DEFAULT_STRATEGY),
    ('fU_l1_rle',     rawU, 1, zlib.Z_RLE),
    ('fU_l6_default', rawU, 6, zlib.Z_DEFAULT_STRATEGY),
]:
    timeit(name + '_ms', lambda d=dat, l=lvl, s=strat: C(d, l, s))
    t[name + '_kb'] = round(len(C(dat, lvl, strat)) / 1e3)
result = json.dumps(t)
`);
console.log(py.runPython('result'));
process.exit(0);
