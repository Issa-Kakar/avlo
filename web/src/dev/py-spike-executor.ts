/**
 * P0 spike — EXECUTOR worker (nested: spawned by py-spike-supervisor).
 *
 * P0-A (stock /py-dev/): fresh boot with `_makeSnapshot`, capture, restore,
 * synchronous exec, interrupt-buffer cancellation.
 *
 * P0-B (fork /py-dev/fork/): numpy DSO record (manual loadDynlib of every
 * wheel .so — the emsdk dsoBaseHook records memory/table bases), stacked
 * snapshot capture, restore in a fresh worker via `_preRestoreHook(avlo,
 * Module)` (MEMFS tree rebuild + JS-side DSO re-instantiation at recorded
 * bases BEFORE the heap overwrite), and an in-place blit reset preview.
 *
 * Dev-only. Deleted (or kept as a harness) once core/py lands.
 */

import { type AvloSnapshotMeta, type FsTree, parseSnapshotHeader, treeTransferables } from './py-spike-snap';

interface BootMsg {
  t: 'boot';
  mode: 'fresh' | 'snapshot';
  dist: 'stock' | 'fork';
  snapshot?: ArrayBuffer;
  /** Site-packages MEMFS tree for stacked restores (rebuilt inside the hook). */
  tree?: FsTree;
  /** G9 negative test: replay DSOs in the wrong order — must throw. */
  rotate?: boolean;
  interruptSab: SharedArrayBuffer;
}
interface ExecMsg {
  t: 'exec';
  id: number;
  code: string;
}
interface CaptureMsg {
  t: 'capture';
  slot: 'baseline' | 'stacked';
}
type InMsg = BootMsg | ExecMsg | CaptureMsg | { t: 'numpy-record' } | { t: 'blit-test' };

const BUNDLE_URL = '/py-dev/fork/bundles/numpy.tar';

/** meta.json is the FIRST ustar entry by construction (pack-package D2):
 * name at byte 0, octal size at 124, payload at 512 — one header parse. */
function parseTarMeta(buf: Uint8Array): { prefix: string; loadOrder: string[] } {
  const ascii = (from: number, to: number) => new TextDecoder().decode(buf.subarray(from, to)).replace(/\0.*$/s, '');
  const name = ascii(0, 100);
  if (name !== 'meta.json') throw new Error(`first tar entry is ${JSON.stringify(name)}, want meta.json`);
  const size = Number.parseInt(ascii(124, 136), 8);
  return JSON.parse(new TextDecoder().decode(buf.subarray(512, 512 + size)));
}

// biome-ignore lint/suspicious/noExplicitAny: stock/fork pyodide has no bundled types here
let pyodide: any = null;
// biome-ignore lint/suspicious/noExplicitAny: Emscripten Module captured by the restore hook
let emModule: any = null;
/** Heap image of the restored snapshot — the blit-reset source. */
let resetImage: Uint8Array | null = null;
let interruptSabRef: SharedArrayBuffer | null = null;

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Every Python snippet in this spike returns primitives/JSON strings ONLY —
 * a live PyProxy at capture time aborts serializeHiwireState. */
function runJson<T>(code: string): T {
  return JSON.parse(pyodide.runPython(code)) as T;
}

// biome-ignore lint/suspicious/noExplicitAny: Emscripten FS is untyped here
function walkTree(FS: any, root: string): FsTree {
  const dirs: string[] = [];
  const files: FsTree['files'] = [];
  const walk = (dir: string): void => {
    for (const name of FS.readdir(dir) as string[]) {
      if (name === '.' || name === '..') continue;
      const path = `${dir}/${name}`;
      const st = FS.stat(path);
      if (FS.isDir(st.mode)) {
        dirs.push(path); // parent-first: sequential mkdir on restore just works
        walk(path);
      } else if (FS.isFile(st.mode)) {
        const bytes = (FS.readFile(path) as Uint8Array).slice();
        files.push({
          path,
          mtimeMs: st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime),
          bytes: bytes.buffer as ArrayBuffer,
        });
      }
    }
  };
  walk(root);
  return { root, dirs, files };
}

/**
 * The restore contract (workerd order, enforced by fork patch 0007):
 * runs inside API.restoreSnapshot AFTER memory pre-grow, BEFORE the heap
 * overwrite. MEMFS contents live in JS objects OUTSIDE the wasm heap, so the
 * tree writes survive the overwrite; the heap only carries Python's importlib
 * belief about those files — rebuilt byte-identical (mtimes included, or
 * source-pyc validation would drift).
 */
function makePreRestoreHook(tree: FsTree, rotate: boolean) {
  // biome-ignore lint/suspicious/noExplicitAny: Module is Emscripten-internal
  return (avlo: AvloSnapshotMeta, Module: any): void => {
    emModule = Module;
    const API = Module.API;
    const FS = Module.FS;
    API.setDsoLoadInfo(avlo.dso);
    for (const d of tree.dirs) {
      try {
        FS.mkdirTree(d);
      } catch {
        /* exists */
      }
    }
    const byPath = new Map<string, ArrayBuffer>();
    const byBase = new Map<string, ArrayBuffer>();
    for (const f of tree.files) {
      FS.writeFile(f.path, new Uint8Array(f.bytes));
      FS.utime(f.path, f.mtimeMs, f.mtimeMs);
      byPath.set(f.path, f.bytes);
      byBase.set(f.path.split('/').pop() ?? f.path, f.bytes);
    }
    let order = avlo.dso.loadOrder;
    if (rotate && order.length > 1) order = [...order.slice(1), order[0]];
    for (const name of order) {
      const buf = byPath.get(name) ?? byBase.get(name.split('/').pop() ?? name);
      if (!buf) throw new Error(`replay: no bytes for DSO ${name}`);
      API.loadDynlibReplay(name, new Uint8Array(buf));
    }
    API.restoreDsoHandles(avlo.dsoHandles);
    API.dsoReplayDone();
  };
}

async function boot(m: BootMsg): Promise<void> {
  const indexURL = m.dist === 'fork' ? '/py-dev/fork/' : '/py-dev/';
  interruptSabRef = m.interruptSab;
  const t0 = performance.now();
  // Non-literal specifier: opaque to the typechecker AND to Vite's bundler —
  // resolved at runtime against the dev-served /py-dev/ dir.
  const mod = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  const t1 = performance.now();
  try {
    if (m.mode === 'snapshot') {
      const snapBytes = new Uint8Array(m.snapshot as ArrayBuffer);
      pyodide = await mod.loadPyodide({
        indexURL,
        packages: [],
        _loadSnapshot: m.snapshot,
        ...(m.tree ? { _preRestoreHook: makePreRestoreHook(m.tree, m.rotate === true) } : {}),
      });
      resetImage = snapBytes.subarray(parseSnapshotHeader(snapBytes).payloadOffset);
    } else {
      pyodide = await mod.loadPyodide({ indexURL, packages: [], _makeSnapshot: true });
    }
  } catch (err) {
    post({ t: 'boot-error', error: String((err as Error)?.stack ?? err) });
    return;
  }
  pyodide.setInterruptBuffer(new Uint8Array(m.interruptSab));
  const zipHash = await sha256Hex(await (await fetch(`${indexURL}python_stdlib.zip`)).arrayBuffer());
  post({
    t: 'ready',
    mode: m.mode,
    dist: m.dist,
    zipHash,
    importMs: t1 - t0,
    bootMs: performance.now() - t1,
  });
}

/** G6.5 + G7 — mount the REAL numpy.tar bundle (M2 artifact): single-header
 * meta parse, tarfile extract, then eager-load every .so per meta.loadOrder
 * (the dsoBaseHook records each base), import numpy, then read back the whole
 * site-packages tree (INCLUDING import-generated __pycache__ pycs — the heap's
 * importlib state references them) for byte-identical restore. */
async function numpyRecord(): Promise<void> {
  const tarBytes = new Uint8Array(await (await fetch(BUNDLE_URL)).arrayBuffer());
  const meta = parseTarMeta(tarBytes);
  pyodide.FS.writeFile('/tmp/_avlo_bundle.tar', tarBytes);
  const { sp } = runJson<{ sp: string }>(`
import json, os, sys, tarfile
sp = next(p for p in sys.path if p.endswith('site-packages'))
with tarfile.open('/tmp/_avlo_bundle.tar') as t:
    t.extractall(sp, members=[m for m in t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_avlo_bundle.tar')
json.dumps({'sp': sp})
`);
  if (sp !== meta.prefix) throw new Error(`meta.prefix ${meta.prefix} != interpreter site-packages ${sp}`);
  const sos = meta.loadOrder.map((r) => `${meta.prefix}/${r}`);
  const api = pyodide._api;
  // G6.5 — hook liveness in isolation before the full pipeline
  await api.loadDynlib(sos[0]);
  const g65LoadOrderLen = api.getDsoLoadInfo().loadOrder.length as number;
  for (const so of sos.slice(1)) await api.loadDynlib(so);
  const { sum } = runJson<{ sum: number }>(`
import gc, json, numpy
import numpy.random  # deferred in numpy 2.x — bake the seeded global RandomState
_ = numpy.random.get_state()
s = float(numpy.ones(4).sum())
gc.collect(); gc.collect()
json.dumps({'sum': s})
`);
  const loadOrderLen = api.getDsoLoadInfo().loadOrder.length as number;
  const tree = walkTree(pyodide.FS, sp);
  const treeBytes = tree.files.reduce((n, f) => n + f.bytes.byteLength, 0);
  post(
    {
      t: 'numpy-recorded',
      soCount: sos.length,
      g65LoadOrderLen,
      loadOrderLen,
      sum,
      treeFiles: tree.files.length,
      treeBytes,
      tree,
    },
    treeTransferables(tree),
  );
}

/** Blit-reset preview (P3 mechanism): overwrite the heap prefix with the
 * restored snapshot image, zero the tail, rerun post-restore fixups — per-run
 * isolation without a worker respawn. Sound because DSO instances/table
 * entries are engine-side, their in-heap state returns with the blit, and the
 * JS↔heap proxy state at post-blit equals post-restore (primitive-only runs). */
function blitTest(): void {
  if (!emModule || !resetImage) {
    post({ t: 'blit-result', ok: false, error: 'no Module/resetImage held' });
    return;
  }
  pyodide.runPython('blit_probe = 12345');
  const fractionsOk = String(pyodide.runPython('import fractions; str(fractions.Fraction(1,2))'));
  const heapBefore = emModule.HEAP8.length as number;
  const t0 = performance.now();
  emModule.HEAP8.set(resetImage);
  if (emModule.HEAP8.length > resetImage.length) {
    emModule.HEAP8.fill(0, resetImage.length);
  }
  const blitMs = performance.now() - t0;
  if (interruptSabRef) pyodide.setInterruptBuffer(new Uint8Array(interruptSabRef));
  pyodide.runPython('import importlib, linecache; importlib.invalidate_caches(); linecache.clearcache()');
  const probeGone = pyodide.runPython('"blit_probe" not in globals()') === true;
  const fractionsGone = pyodide.runPython('import sys; "fractions" not in sys.modules') === true;
  const numpySum = Number(pyodide.runPython('import numpy; float(numpy.ones(4).sum())'));
  post({
    t: 'blit-result',
    ok: probeGone && fractionsGone && numpySum === 4,
    probeGone,
    fractionsGone,
    numpySum,
    fractionsOk,
    heapBefore,
    imageLen: resetImage.length,
    blitMs,
  });
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data;
  try {
    switch (m.t) {
      case 'boot':
        await boot(m);
        break;
      case 'exec': {
        const t0 = performance.now();
        try {
          const r = pyodide.runPython(m.code);
          post({ t: 'exec-result', id: m.id, ok: true, repr: String(r), ms: performance.now() - t0 });
        } catch (err) {
          post({ t: 'exec-result', id: m.id, ok: false, error: String(err), ms: performance.now() - t0 });
        }
        break;
      }
      case 'capture': {
        // Quiesce: two GC passes before serialization (mirrors production).
        pyodide.runPython('import gc; gc.collect(); gc.collect()');
        const t0 = performance.now();
        const bytes: Uint8Array = pyodide.makeMemorySnapshot();
        const buf = bytes.slice().buffer as ArrayBuffer;
        post({ t: 'snapshot', slot: m.slot, bytes: buf, ms: performance.now() - t0, size: buf.byteLength }, [buf]);
        break;
      }
      case 'numpy-record':
        await numpyRecord();
        break;
      case 'blit-test':
        blitTest();
        break;
    }
  } catch (err) {
    post({ t: 'fatal', error: String((err as Error)?.stack ?? err) });
  }
};
