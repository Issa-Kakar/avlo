/**
 * Fork boot wrapper — the one place that touches the pyodide loader API.
 * Cold-boots glue+wasm+stdlib from `artifactBase` = `PY_ORIGIN/<buildHash>/`
 * (dev: the `/api/py` Vite proxy). P2 owned restore: `restore` drives the
 * fork's `_avloRestore.preBlit` seam — the fork boots with noInitialRun
 * (runtime init + preRun + main-module ctors run; main()/CPython init is
 * skipped) and this driver replays DSOs at recorded bases, then blits the
 * heap straight from OPFS into wasm memory before finalizeBootstrap resumes
 * the interpreter.
 */

import { type AvsHeader, readHeapInto, type SnapReadHandle } from './py-snapshot';
import { traceBegin, traceSpanAsync } from './py-trace';

// biome-ignore lint/suspicious/noExplicitAny: fork loader has no bundled types in-app
export type Pyodide = any;

/** Everything preBlit needs, assembled by the executor's snap-probe. */
export interface PyRestore {
  header: AvsHeader;
  handle: SnapReadHandle;
  /** Recorded ABSOLUTE dlopen path → wasm bytes (sliced from the boot tars). */
  soBytes: Map<string, Uint8Array>;
}

export interface PyBootOptions {
  artifactBase: string;
  /** Owned snapshot restore — absent = cold boot. */
  restore?: PyRestore;
}

/** Tags every failure raised inside preBlit. The executor's cue to post
 * `exec-snap-invalid` and continue COLD in the same boot — anything thrown
 * AFTER preBlit returned (finalizeBootstrap onward) is a post-blit failure
 * and takes the exec-fatal → supervisor poison path instead. */
export class PreBlitError extends Error {}

/**
 * The owned restore order (workerd-derived: DSOs preload at recorded bases
 * BEFORE the heap lands — table state, not heap state, is the fragile part):
 *   1. buildId assert (BEFORE growMemory — validation failures precede
 *      memory growth so the aborted Module stays small for the in-worker
 *      cold retry, U9)
 *   2. Module.growMemory(heapLen) — the 0001-v2 runtime export; memory is
 *      wasm-exported so upstream's INITIAL_MEMORY path never worked here
 *   3. DSO replay per recorded loadOrder (verbatim ABSOLUTE paths — U7),
 *      then handle re-association; the emsdk dsoBaseHook FORCES memBase and
 *      ASSERTS tableBase per DSO ("snapshot DSO table drift")
 *   4. HARD post-replay assert: wasmTable.length === tableLenAtCapture (F5)
 *   5. chunked OPFS→HEAPU8 reads folding the fast hash (readHeapInto
 *      re-acquires the view per chunk — growth detaches ArrayBuffers)
 *   6. handle.close() in finally — a live sync handle must NEVER survive
 *      toward harden (write authority across the scrub boundary)
 * Returns the captured hiwire SnapshotConfig for finalizeBootstrap.
 */
function makePreBlit({ header, handle, soBytes }: PyRestore) {
  // biome-ignore lint/suspicious/noExplicitAny: live emscripten Module + fork API — no types in-app
  return (Module: any, API: any): unknown => {
    try {
      if (header.buildId !== API.config.BUILD_ID) {
        throw new Error(`snapshot buildId ${header.buildId} ≠ glue ${API.config.BUILD_ID}`);
      }
      if ((Module.HEAPU8 as Uint8Array).length < header.heapLen) Module.growMemory(header.heapLen);
      if ((Module.HEAPU8 as Uint8Array).length !== header.heapLen) {
        throw new Error(`pre-grow failed: heap ${(Module.HEAPU8 as Uint8Array).length} ≠ ${header.heapLen}`);
      }
      API.setDsoLoadInfo(header.dso);
      const endReplay = traceBegin('dso-replay');
      let maxMs = 0;
      let maxDso = '';
      for (const path of header.dso.loadOrder) {
        const bytes = soBytes.get(path);
        if (!bytes) throw new Error(`snapshot replay: no bytes for DSO ${path}`);
        const start = performance.now();
        API.loadDynlibReplay(path, bytes);
        const ms = performance.now() - start;
        if (ms > maxMs) {
          maxMs = ms;
          maxDso = path.split('/').pop() ?? path;
        }
      }
      API.restoreDsoHandles(header.dsoHandles);
      API.dsoReplayDone();
      endReplay({ count: header.dso.loadOrder.length, maxMs: Math.round(maxMs * 10) / 10, maxDso });
      if ((Module.wasmTable.length as number) !== header.tableLenAtCapture) {
        throw new Error(`snapshot table drift: ${Module.wasmTable.length} ≠ ${header.tableLenAtCapture}`);
      }
      const endRead = traceBegin('heap-read');
      readHeapInto(handle, header, () => Module.HEAPU8 as Uint8Array);
      endRead({ mb: Math.round(header.heapLen / 1e6) });
      return header.hiwire;
    } catch (err) {
      throw err instanceof PreBlitError ? err : new PreBlitError(String((err as Error)?.message ?? err));
    } finally {
      handle.close();
    }
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
      // Hash determinism parity with capture boots (heap-behavior
      // consistency; also keeps cold-boot runs deterministic modulo entropy).
      env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' },
      ...(opts.restore ? { _avloRestore: { preBlit: makePreBlit(opts.restore) } } : {}),
    }),
  );
}
