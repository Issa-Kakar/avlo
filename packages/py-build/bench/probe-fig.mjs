// Figure-pipeline probe: real numpy+matplotlib mounts, Agg render vs PNG encode costs.
import './lib/ts-resolve.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = '/home/issak/dev/avlo';
const forkDir = process.argv.find((a) => a.startsWith('--fork='))?.split('=')[1] ?? join(repo, 'web/public/py-dev/fork');
const LOCK = JSON.parse(readFileSync(join(repo, 'packages/py-loader/build-lock.json'), 'utf8'));

// wasm-gc trampoline shim ON (measure the fixed world).
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

const asAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
for (const bundle of LOCK.sets['numpy+matplotlib']) {
  const tar = new Uint8Array(asAB(readFileSync(join(forkDir, `bundles/${bundle}.tar`))));
  const meta = parseTarMeta(tar);
  mountBundleTree(py.FS, meta.prefix, tar);
  for (const so of meta.loadOrder) await py._api.loadDynlib(`${meta.prefix}/${so}`);
}
py.runPython('import _avlo_runtime; _avlo_runtime.post_restore(); del _avlo_runtime');

const bench = `
import time, io, json
import numpy as np

t = {}
def timeit(name, fn, reps=3):
    best = 1e18
    for _ in range(reps):
        t0 = time.perf_counter(); fn(); t1 = time.perf_counter()
        best = min(best, t1 - t0)
    t[name] = round(best * 1000, 1)

# --- cold first-figure cost inside this process (imports + font/Agg init + render + encode)
f0 = time.perf_counter()
import matplotlib
import matplotlib.pyplot as plt
t['import_mpl_ms'] = round((time.perf_counter() - f0) * 1000, 1)

x = np.linspace(0, 10, 1000); y = np.sin(x)
def mk():
    fig, ax = plt.subplots()
    ax.plot(x, y); ax.set_title('probe'); ax.grid(True)
    return fig

f0 = time.perf_counter()
fig = mk(); b = io.BytesIO(); fig.savefig(b, format='png'); plt.close(fig)
t['first_plot_savefig_ms'] = round((time.perf_counter() - f0) * 1000, 1)

# --- steady state split: render vs encode
def render_only():
    fig = mk(); fig.canvas.draw(); fig.canvas.buffer_rgba(); plt.close(fig)
def savefig_total():
    fig = mk(); b = io.BytesIO(); fig.savefig(b, format='png'); plt.close(fig)
timeit('render_only_ms', render_only)
timeit('savefig_total_ms', savefig_total)

# --- encoder anatomy on the real rendered buffer
fig = mk(); fig.canvas.draw()
rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
plt.close(fig)
h, w = rgba.shape[0], rgba.shape[1]
t['fig_px'] = [w, h]

import _avlo_png, zlib
def enc():
    b = io.BytesIO(); _avlo_png.write_png(rgba, b)
timeit('avlo_png_full_ms', enc)

data = rgba.tobytes(); stride = w * 4
def scanlines():
    raw = bytearray()
    for yy in range(h):
        raw.append(0)
        raw += data[yy*stride:(yy+1)*stride]
    return bytes(raw)
timeit('scanline_copy_ms', lambda: scanlines())
raw = scanlines()
t['raw_mb'] = round(len(raw) / 1e6, 2)
for lvl in (9, 6, 1):
    timeit(f'zlib_l{lvl}_ms', lambda l=lvl: zlib.compress(raw, l))
    t[f'png_kb_l{lvl}'] = round(len(zlib.compress(raw, lvl)) / 1e3)

# --- big figure variant (dpi-scaled toward the 2048 cap)
def mk_big():
    fig, ax = plt.subplots(figsize=(12, 9), dpi=160)
    for k in range(8):
        ax.plot(x, np.sin(x + k * 0.4))
    ax.set_title('big'); ax.grid(True)
    return fig
f0 = time.perf_counter()
fig = mk_big(); b = io.BytesIO(); fig.savefig(b, format='png')
t['big_savefig_ms'] = round((time.perf_counter() - f0) * 1000, 1)
fig.canvas.draw()
big = np.asarray(fig.canvas.buffer_rgba()).copy(); plt.close(fig)
bh, bw = big.shape[0], big.shape[1]
t['big_px'] = [bw, bh]
bdata = big.tobytes(); bstride = bw * 4
braw = bytearray()
for yy in range(bh):
    braw.append(0); braw += bdata[yy*bstride:(yy+1)*bstride]
braw = bytes(braw)
timeit('big_zlib_l9_ms', lambda: zlib.compress(braw, 9))
timeit('big_zlib_l1_ms', lambda: zlib.compress(braw, 1))
t['big_png_kb_l9'] = round(len(zlib.compress(braw, 9)) / 1e3)
t['big_png_kb_l1'] = round(len(zlib.compress(braw, 1)) / 1e3)

result = json.dumps(t)
`;
py.runPython(bench);
console.log(py.runPython('result'));
process.exit(0);
