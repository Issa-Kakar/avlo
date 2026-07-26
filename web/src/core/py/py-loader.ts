/**
 * Fork boot wrapper — the one place that touches the pyodide loader API.
 * Cold-boots glue+wasm+stdlib from `artifactBase` = `PY_ORIGIN/<buildHash>/`
 * (dev: the `/api/py` Vite proxy).
 *
 * L2 UNIFORM BOOT (cold-restore attack): when `snapshot` feeds are present
 * the fork ALWAYS boots with `_avloRestore` (noInitialRun — runtime init +
 * preRun + main-module ctors run; main()/CPython init is deferred) and the
 * async preBlit driver decides restore-vs-cold on the fly:
 *   - header feed resolves null → `Module.callMain()` on the SAME Module —
 *     the cold path costs zero re-instantiates and there is no upfront
 *     restore/cold decision point.
 *   - header non-null → validate (buildId pre-grow, U9) → grow → await the
 *     precompiled DSO Modules → replay at recorded bases → hard table assert
 *     → await the verified heap buffer (pre-touching grown pages while
 *     waiting) → blit → return the captured hiwire SnapshotConfig.
 * Pre-mutation failures (validation/compile) fall back cold on the SAME
 * Module via onSnapInvalid; from the first replay call on, the Module is
 * DIRTY (LDSO/table/GOT hold replay state a later cold dlopen would
 * registry-hit — orphaned exports over a fresh sbrk), so mutation-zone
 * failures throw DirtyRestoreError and the executor re-instantiates fresh.
 *
 * Deferred-main safety (receipted against the shipped glue): with
 * noInitialRun the factory promise resolves BEFORE main, `preMain`/`postRun`
 * are no-ops, and main's own C-side runtime keepalive makes its exit tail
 * self-contained — but a keepalive-less exit lands in `Module.exitCode` via
 * onExit (the Stage-5 check saw undefined pre-main), so runCold re-checks it.
 */

import type { AvsHeader } from './py-snapshot';
import { traceBegin, traceSpanAsync } from './py-trace';

// biome-ignore lint/suspicious/noExplicitAny: fork loader has no bundled types in-app
export type Pyodide = any;

/** Tags every failure raised in preBlit's MUTATION zone (DSO replay onward).
 * The executor's cue that the Module is unusable for a same-Module cold
 * fallback: post `exec-snap-invalid` and run a FRESH `bootPyodide` instead.
 * Cold-main failures are deliberately NOT wrapped — retrying the same
 * failing cold boot would loop. */
export class DirtyRestoreError extends Error {}

/** Async boot-input feeds, assembled by the executor from the supervisor's
 * snap-header / snap-heap / boot-data messages. All promises RESOLVE (never
 * reject) except modulesP, whose rejection is consumed inside preBlit's
 * pre-mutation zone (compile failure ⇒ cold on the same Module). */
export interface PySnapshotFeeds {
  headerP: Promise<AvsHeader | null>;
  heapP: Promise<ArrayBuffer | null>;
  /** Precompiled group-DSO Modules keyed by recorded ABSOLUTE dlopen path —
   * compiled off the transferred tars, overlapped with the main instantiate. */
  modulesP: Promise<Map<string, WebAssembly.Module> | null>;
  /** The executor posts exec-snap-invalid (pre-mutation fallback ran cold). */
  onSnapInvalid(reason: string): void;
  /** Driver sets `restored: true` the moment the blit landed — the executor's
   * poison-routing flag for everything thrown after preBlit returns. */
  outcome: { restored: boolean };
}

export interface PyBootOptions {
  artifactBase: string;
  /** Uniform-boot feeds — absent (snapshots off / in-boot cold retry) boots
   * the classic auto-main path with no seam involvement. */
  snapshot?: PySnapshotFeeds;
}

const msgOf = (err: unknown): string => String((err as Error)?.message ?? err);

/**
 * Pre-touch the grown heap region while the verified heap buffer is still in
 * flight, so the blit's first-write page faults are prepaid. Both details are
 * load-bearing (F11):
 * - The yield is a MessageChannel self-post, NOT setTimeout(0): the 4 ms
 *   nesting clamp would eat the win, and MessageChannel shares the message
 *   task source so the snap-heap onmessage interleaves fairly.
 * - The touch is `Atomics.or(i32, off >> 2, 0)` — a VALUE-PRESERVING RMW.
 *   Replay already wrote active data segments at forced memBases inside the
 *   grown region: a zero-write would clobber them, and a plain read can be
 *   dead-code-eliminated and only commits read mappings.
 * The i32 view is re-acquired per slice; touching skips entirely (first
 * yield observes the settled promise) when the heap already arrived.
 */
async function touchWhileAwaiting(
  // biome-ignore lint/suspicious/noExplicitAny: live emscripten Module — no types in-app
  Module: any,
  oldLen: number,
  heapLen: number,
  heapP: Promise<ArrayBuffer | null>,
): Promise<ArrayBuffer | null> {
  const endWait = traceBegin('snap-wait-heap');
  let settled = false;
  const flag = () => {
    settled = true;
  };
  heapP.then(flag, flag);
  const mc = new MessageChannel();
  let wake: (() => void) | null = null;
  mc.port1.onmessage = () => wake?.();
  const yield_ = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      mc.port2.postMessage(0);
    });
  const SLICE = 8 << 20;
  let touched = 0;
  for (let off = oldLen; off < heapLen; ) {
    await yield_(); // lets snap-heap onmessage + the settle microtask run first
    if (settled) break;
    const end = Math.min(off + SLICE, heapLen);
    const i32 = new Int32Array((Module.HEAPU8 as Uint8Array).buffer);
    for (let p = off; p < end; p += 4096) Atomics.or(i32, p >> 2, 0);
    touched += end - off;
    off = end;
  }
  const heap = await heapP;
  mc.port1.onmessage = null;
  mc.port1.close();
  mc.port2.close();
  endWait({ touchedMB: Math.round(touched / 1e6) });
  return heap;
}

/**
 * The owned restore order (workerd-derived: DSOs preload at recorded bases
 * BEFORE the heap lands — table state, not heap state, is the fragile part):
 * buildId assert (pre-grow, U9) → growMemory (0001 runtime export; takes a
 * target BYTE size and refreshes the views itself) → exact-length assert →
 * await precompiled Modules → replay per recorded loadOrder (verbatim
 * ABSOLUTE paths, U7; the emsdk dsoBaseHook FORCES memBase and ASSERTS
 * tableBase per DSO) → restoreDsoHandles → dsoReplayDone → HARD
 * tableLenAtCapture assert → await + blit the verified heap. Returns the
 * captured hiwire SnapshotConfig for finalizeBootstrap (or undefined after a
 * cold main — finalizeBootstrap(undefined) IS the cold branch).
 */
function makePreBlit(feeds: PySnapshotFeeds) {
  // biome-ignore lint/suspicious/noExplicitAny: live emscripten Module + fork API — no types in-app
  return async (Module: any, API: any): Promise<unknown> => {
    const runCold = (): undefined => {
      Module.callMain();
      // With noInitialRun the factory promise resolved BEFORE main, so the
      // Stage-5 exitCode check saw undefined. Module === emscriptenSettings
      // (asm prologue `var Module = moduleArg`), so a no-keepalive exit lands
      // in Module.exitCode via onExit and would otherwise proceed silently
      // over an ABORTed runtime (F4).
      if (Module.exitCode !== undefined) throw new Error(`cold main exited ${Module.exitCode}`);
      return undefined;
    };
    const endWaitHeader = traceBegin('snap-wait-header');
    const header = await feeds.headerP;
    endWaitHeader({ hit: header !== null });
    if (!header) return runCold();
    const oldLen = (Module.HEAPU8 as Uint8Array).length;
    let mods: Map<string, WebAssembly.Module>;
    try {
      // Pre-mutation zone — everything here leaves the Module clean (growth
      // included: benign), so failures fall back cold on the SAME Module.
      if (header.buildId !== API.config.BUILD_ID) {
        throw new Error(`snapshot buildId ${header.buildId} ≠ glue ${API.config.BUILD_ID}`);
      }
      if (oldLen < header.heapLen) Module.growMemory(header.heapLen);
      if ((Module.HEAPU8 as Uint8Array).length !== header.heapLen) {
        throw new Error(`pre-grow failed: heap ${(Module.HEAPU8 as Uint8Array).length} ≠ ${header.heapLen}`);
      }
      const m = await feeds.modulesP; // compile failures land here
      if (!m) throw new Error('snapshot DSO precompile unavailable');
      mods = m;
    } catch (err) {
      feeds.onSnapInvalid(msgOf(err).split('\n')[0]);
      return runCold();
    }
    try {
      // MUTATION ZONE — same-Module cold is FORBIDDEN from the first replay
      // call on: LDSO/table/GOT hold replay state a later cold dlopen would
      // registry-hit (orphaned exports over a fresh sbrk).
      API.setDsoLoadInfo(header.dso);
      const endReplay = traceBegin('dso-replay');
      for (const path of header.dso.loadOrder) {
        const mod = mods.get(path);
        if (!mod) throw new Error(`snapshot replay: no module for DSO ${path}`);
        API.loadDynlibReplay(path, mod);
      }
      API.restoreDsoHandles(header.dsoHandles);
      API.dsoReplayDone();
      endReplay({ count: header.dso.loadOrder.length });
      if ((Module.wasmTable.length as number) !== header.tableLenAtCapture) {
        throw new Error(`snapshot table drift: ${Module.wasmTable.length} ≠ ${header.tableLenAtCapture}`);
      }
      const heap = await touchWhileAwaiting(Module, oldLen, header.heapLen, feeds.heapP);
      if (!heap || heap.byteLength !== header.heapLen) {
        throw new Error(heap ? `snapshot heap ${heap.byteLength} B ≠ ${header.heapLen}` : 'snapshot heap unavailable');
      }
      const endBlit = traceBegin('heap-blit');
      (Module.HEAPU8 as Uint8Array).set(new Uint8Array(heap), 0);
      endBlit({ mb: Math.round(header.heapLen / 1e6) });
      feeds.outcome.restored = true;
      return header.hiwire;
    } catch (err) {
      throw new DirtyRestoreError(msgOf(err));
    }
  };
}

/** Cold-boot knife: free + zero every dlopened DSO's in-heap ELF copy
 * (`file_data`) once all dlopens are done. dlopen keeps the instantiated
 * module and short-circuits later opens at the LDSO registry (heap state the
 * blit restores), and CPython's ExtensionFileLoader re-reads from MEMFS, not
 * from this copy — the raw bytes are pure dead weight (~14.6 MB for `all`).
 * Runs on COLD boots only (restore boots never re-malloc file_data — replay
 * feeds precompiled Modules straight to loadWebAssemblyModule), BEFORE the
 * capture bake so freed pages are reused instead of growing sbrk — and the
 * snapshot shrinks by the same amount (every restore reads/hashes/transfers/
 * blits less). Zeroing first keeps any unreused tail deterministic in the
 * capture image. The +28/+32 struct offsets (file_data / file_data_size) are
 * emsdk-5.0.3-pinned: any implausible value warns and ABORTS the knife —
 * never the boot. Returns bytes freed (span meta is the caller's job). */
export function freeDsoFileData(pyodide: Pyodide): { freedBytes: number; aborted: boolean } {
  let freedBytes = 0;
  try {
    const M = pyodide._module;
    const heapU32 = M.HEAPU32 as Uint32Array;
    const heapU8 = M.HEAPU8 as Uint8Array;
    const dsoHandles = pyodide._api.recordDsoHandles() as Record<string, { handles: number[] }>;
    for (const { handles } of Object.values(dsoHandles)) {
      for (const h of handles) {
        const p = heapU32[(h + 28) >> 2];
        const size = heapU32[(h + 32) >> 2];
        if (!p || !size) continue;
        if (size >= 32 << 20 || p + size > heapU8.length) {
          console.warn(`py: dso-free aborted — implausible file_data (ptr ${p}, size ${size}) — emsdk struct layout drift?`);
          return { freedBytes, aborted: true };
        }
        heapU8.fill(0, p, p + size);
        M._free(p);
        heapU32[(h + 28) >> 2] = 0;
        heapU32[(h + 32) >> 2] = 0;
        freedBytes += size;
      }
    }
  } catch (err) {
    console.warn('py: dso-free failed (continuing) —', err);
    return { freedBytes, aborted: true };
  }
  return { freedBytes, aborted: false };
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
      ...(opts.snapshot ? { _avloRestore: { preBlit: makePreBlit(opts.snapshot) } } : {}),
    }),
  );
}
