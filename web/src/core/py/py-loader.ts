/**
 * Fork boot wrapper — the one place that touches the pyodide loader API.
 * Cold-boots glue+wasm+stdlib from `artifactBase` = `PY_ORIGIN/<buildHash>/`
 * (dev: the `/api/py` Vite proxy), restores snapshots via `_loadSnapshot`
 * (+ `_preRestoreHook` DSO/MEMFS replay for stacked images), and arms
 * `_makeSnapshot` on generation boots (the fork gates `makeMemorySnapshot()`
 * on it).
 */

import type { AvloSnapshotMeta, PackedTree } from './py-snapshot';
import { traceBegin, traceSpanAsync } from './py-trace';

// biome-ignore lint/suspicious/noExplicitAny: fork loader has no bundled types in-app
export type Pyodide = any;

export interface PyBootOptions {
  artifactBase: string;
  /** Restore payload (fork container bytes). */
  snapshot?: ArrayBuffer;
  /** Stacked restore: site-packages tree replayed by the `_preRestoreHook`. */
  tree?: PackedTree;
  /** Generation boot — permits `makeMemorySnapshot()` after restore. */
  makeSnapshot?: boolean;
}

/** Runs INSIDE the fork's `restoreSnapshot`, after the memory pre-grow and
 * BEFORE the heap overwrite (patch 0007 contract; sync; `Module` is the only
 * handle — the loadPyodide promise hasn't resolved). MEMFS file bytes live in
 * JS objects OUTSIDE the wasm heap, so the tree written here survives the
 * overwrite; the heap carries importlib/zipimport's belief about it, which is
 * why bytes AND mtimes must match capture exactly (pyc validation). DSOs are
 * re-instantiated in recorded order so wasm-table entries line up — drift
 * throws "snapshot DSO table drift" (emsdk hook) and fails the boot.
 */
function makePreRestoreHook(tree: PackedTree) {
  // biome-ignore lint/suspicious/noExplicitAny: live emscripten Module — no types in-app
  return (avlo: AvloSnapshotMeta, Module: any): void => {
    const { API, FS } = Module;
    API.setDsoLoadInfo(avlo.dso);
    const endTree = traceBegin('tree-write');
    for (const d of tree.dirs) {
      try {
        FS.mkdirTree(d);
      } catch {
        /* exists */
      }
    }
    const blob = new Uint8Array(tree.blob);
    const byPath = new Map<string, Uint8Array>();
    const byBase = new Map<string, Uint8Array>();
    for (const f of tree.files) {
      const bytes = blob.subarray(f.off, f.off + f.len);
      FS.writeFile(f.path, bytes);
      FS.utime(f.path, f.mtimeMs, f.mtimeMs);
      byPath.set(f.path, bytes);
      byBase.set(f.path.split('/').pop() ?? f.path, bytes);
    }
    endTree({ dirs: tree.dirs.length, files: tree.files.length, mb: Math.round(blob.length / 1e6) });
    const endReplay = traceBegin('dso-replay');
    let maxMs = 0;
    let maxDso = '';
    for (const name of avlo.dso.loadOrder) {
      const bytes = byPath.get(name) ?? byBase.get(name.split('/').pop() ?? name);
      if (!bytes) throw new Error(`snapshot replay: no bytes for DSO ${name}`);
      const start = performance.now();
      API.loadDynlibReplay(name, bytes);
      const ms = performance.now() - start;
      if (ms > maxMs) {
        maxMs = ms;
        maxDso = name.split('/').pop() ?? name;
      }
    }
    API.restoreDsoHandles(avlo.dsoHandles);
    API.dsoReplayDone();
    endReplay({ count: avlo.dso.loadOrder.length, maxMs: Math.round(maxMs * 10) / 10, maxDso });
  };
}

export async function bootPyodide(opts: PyBootOptions): Promise<Pyodide> {
  // Non-literal specifier: opaque to the typechecker AND to Vite's bundler —
  // resolved at runtime against the served artifact dir.
  const endImport = traceBegin('glue-import');
  const mod = await import(/* @vite-ignore */ `${opts.artifactBase}pyodide.mjs`);
  endImport();
  return traceSpanAsync('load-pyodide', () =>
    mod.loadPyodide({
      indexURL: opts.artifactBase,
      packages: [],
      // Hash determinism parity with make-baseline (heap-behavior consistency;
      // also keeps fresh-boot fallback runs deterministic modulo entropy).
      env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
      ...(opts.snapshot ? { _loadSnapshot: opts.snapshot } : {}),
      ...(opts.tree ? { _preRestoreHook: makePreRestoreHook(opts.tree) } : {}),
      ...(opts.makeSnapshot ? { _makeSnapshot: true } : {}),
    }),
  );
}
