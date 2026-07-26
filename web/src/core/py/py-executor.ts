/**
 * Python EXECUTOR worker — nested child of py-supervisor. Owns the pyodide
 * instance; its event loop is BLOCKED for the whole of a synchronous run, so
 * everything time-based (timeouts, cancellation clocks) lives in the
 * supervisor. Cancellation reaches a blocked run only through the interrupt
 * byte of PY_SAB (pyodide's signal check reads it between bytecodes).
 *
 * stdout/stderr: raw `write` hooks (byte-exact, streaming decode) → one
 * shared buffer → relayed in ≥100 ms / ≥8 KB chunks (flush decisions happen
 * INSIDE the write callback — no timers fire while Python runs). The final
 * output is capped at PY_LIMITS.maxOutputChars with a truncation marker.
 */

// Lock-free verify subpath — the executor must not carry the build-lock JSON.
import { sha256Hex } from '@avlo/py-loader/verify';
import { assertRealmHardened, hardenRealm, scrubWorkerScope } from './py-harden';
import { HARNESS_INSTALL, RUN_INVOKE } from './py-harness';
import { bootPyodide, DirtyRestoreError, freeDsoFileData, type Pyodide, type PySnapshotFeeds } from './py-loader';
import { collectSoBytes, mountBundleTree } from './py-mount';
import {
  type BootPrepMsg,
  type ExecRunMsg,
  OUTPUT_TRUNCATION_MARKER,
  PY_LIMITS,
  type PyBundlePayload,
  type PyFigure,
  type PySetKey,
  type SupToExec,
} from './py-protocol';
import { HEARTBEAT, MEM_KIB, mapPySab, PyExecState, type PySabViews, RUN_ID, STATE } from './py-sab';
import type { AvsCaptureMeta, AvsHeader } from './py-snapshot';
import { installWasmTimers, setTraceSink, traceBegin, traceEmit, traceReset, traceSpan, traceSpanAsync } from './py-trace';

let pyodide: Pyodide = null;
let sab: PySabViews | null = null;
let currentRunId = 0;
/** True once this generation booted from an OPFS snapshot restore (the blit
 * landed). Rides exec-ready + every exec-fatal — the supervisor's poison
 * routing keys on it. */
let restored = false;

/** L2 boot-input deferreds — the supervisor streams boot-data / snap-header /
 * snap-heap in ANY order relative to boot-prep (a warm cache lets boot-data
 * outrun boot-prep); every message parks here and boot logic starts at
 * boot-prep. Deferreds RESOLVE only, never reject — absence of a message is
 * covered by the supervisor's completeness contract (a value or null always
 * arrives, or this worker is terminated). */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const D = {
  tars: deferred<PyBundlePayload[]>(),
  header: deferred<AvsHeader | null>(),
  heap: deferred<ArrayBuffer | null>(),
};

/** Ready-point heap copy — the blit-reset image. Taken at the END of boot on
 * EVERY path (cold included), so it already contains the harness, the armed
 * interrupt C-state, and post_restore's reseeded entropy: the post-blit fixup
 * is just re-arm + post_restore, never a harness re-install. null (slice OOM)
 * ⇒ every run reports needsRespawn and isolation rides eager respawn. */
let resetImage: Uint8Array | null = null;
let tableLenAtReady = 0;

/** Per-set generation imports, keyed by BUNDLE name (deps ride their own
 * bundles; mpl-deps has no top-level import — matplotlib pulls them). numpy
 * MUST bake numpy.random: numpy 2.x defers the global RandomState, and an
 * unbaked global re-seeds fresh at first touch after every restore (G8R). */
const BUNDLE_IMPORTS: Record<string, string> = {
  numpy: 'import numpy, numpy.random\n_ = numpy.random.get_state()\ndel _',
  dateutil: 'import dateutil',
  pytz: 'import pytz',
  pandas: 'import pandas',
  matplotlib: 'import matplotlib, matplotlib.pyplot', // Agg default + fontlist prebaked by py-build
  seaborn: 'import seaborn',
};

/** Post-blit fixup: reseed entropy/caches (post_restore) + sweep /tmp — MEMFS
 * is JS-side and survives the heap overwrite, so run-created files would
 * otherwise leak into the next run. os.walk only (shutil is not warmup-safe). */
const POST_RUN_RESET = `def _avlo_reset():
    import os
    import _avlo_runtime
    _avlo_runtime.post_restore()
    for _root, _dirs, _files in os.walk('/tmp', topdown=False):
        for _f in _files:
            try:
                os.remove(_root + '/' + _f)
            except OSError:
                pass
        if _root != '/tmp':
            try:
                os.rmdir(_root)
            except OSError:
                pass
_avlo_reset()
del _avlo_reset`;

/** Captured before any user code can run — result/relay delivery stays
 * intact even if a run reassigns `self.postMessage`. */
const rawPost = (self as unknown as Worker).postMessage.bind(self as unknown as Worker);

setTraceSink((line) => rawPost({ t: 'exec-trace', line }));

/** Combined stdout+stderr for the CURRENT run. Decoders are recreated per
 * run — a multi-byte character split across the last chunk of a run would
 * otherwise leak its partial state into the next run's decode. */
let outBuf = '';
let outTruncated = false;
let relayedUpTo = 0;
let lastFlushAt = 0;
let stdoutDecoder = new TextDecoder();
let stderrDecoder = new TextDecoder();

function post(msg: unknown, transfer?: Transferable[]): void {
  rawPost(msg, transfer ?? []);
}

function appendOutput(text: string): void {
  if (outTruncated) return;
  outBuf += text;
  if (outBuf.length > PY_LIMITS.maxOutputChars) {
    outBuf = outBuf.slice(0, PY_LIMITS.maxOutputChars) + OUTPUT_TRUNCATION_MARKER;
    outTruncated = true;
  }
  const pending = outBuf.length - relayedUpTo;
  const now = performance.now();
  if (outTruncated || pending >= PY_LIMITS.stdoutFlushBytes || now - lastFlushAt >= PY_LIMITS.stdoutFlushMs) {
    flushRelay(now);
  }
}

function flushRelay(now = performance.now()): void {
  if (outBuf.length > relayedUpTo) {
    post({ t: 'exec-stdout', runId: currentRunId, chunk: outBuf.slice(relayedUpTo) });
    relayedUpTo = outBuf.length;
    lastFlushAt = now;
  }
}

function makeWriteHook(stream: 'out' | 'err') {
  // Reads the CURRENT decoder at write time (exec() swaps in fresh ones).
  return (buf: Uint8Array): number => {
    const decoder = stream === 'out' ? stdoutDecoder : stderrDecoder;
    appendOutput(decoder.decode(buf, { stream: true }));
    return buf.length;
  };
}

/**
 * Restage ⇒ recapture, productionized (the spike's standing guard): the
 * interpreter's belief about the stdlib zip (zipimport TOC offsets, mtimes)
 * lives in the wasm heap, and BUILD_ID only pins glue↔wasm — a drifted zip
 * under a matching fork is exactly the corruption class it cannot catch.
 * Hash the zip AS MOUNTED (read back from MEMFS, not re-fetched) against the
 * supervisor-verified manifest and refuse the boot on mismatch. Also the
 * anchor P3 snapshots key on: a heap image is only valid over the byte-
 * identical zip it was captured against.
 */
async function verifyStdlibZip(expectedSha256: string): Promise<void> {
  const zipPath = pyodide.runPython("import sys; next(p for p in sys.path if p.endswith('.zip'))") as string;
  // MEMFS file contents are plain-ArrayBuffer views — the narrow cast is true.
  const sha = await sha256Hex(pyodide.FS.readFile(zipPath) as Uint8Array<ArrayBuffer>);
  if (sha !== expectedSha256) {
    throw new Error(`stdlib zip drift: ${zipPath} hashes ${sha}, manifest expects ${expectedSha256} — re-run stage.mjs`);
  }
}

/** Mount one bundle: graft the tar's tree DIRECTLY into MEMFS (walker —
 * node contents adopt tar subarray views, no in-wasm tarfile, no copies),
 * then loadDynlib every DSO in the meta's canonical order (the supervisor
 * sends bundles in deps-first set order). Restore boots pass `extractOnly` —
 * the replayed groups are already registered in LDSO at their recorded bases,
 * but the `.avlo/*.so` FILES must still land: CPython's ExtensionFileLoader
 * fopens + fstats the path BEFORE dlopen (dynload_shlib.c), and only then
 * does the C dlopen short-circuit on the LDSO registry hit (find_existing —
 * heap state the blit restores), so lazy post-restore imports need the file
 * present even though its bytes are never re-read by dlopen. */
async function mountBundle(b: PyBundlePayload, extractOnly: boolean): Promise<void> {
  const endWalk = traceBegin('mount-walk');
  mountBundleTree(pyodide.FS, b.prefix, new Uint8Array(b.bytes));
  endWalk({ bundle: b.name });
  if (extractOnly) return;
  const endDlopen = traceBegin('mount-dlopen');
  for (const so of b.loadOrder) {
    await pyodide._api.loadDynlib(`${b.prefix}/${so}`);
  }
  // `dsos`, not `n` — a meta key named `n` clobbers the span-name field in
  // py-trace's `{ n, at, ms, ...meta }` spread (browser-ledger finding).
  endDlopen({ bundle: b.name, dsos: b.loadOrder.length });
}

/** Owned capture — bake the set's imports into the heap (so restored AND
 * capture generations stop re-importing on warm runs), then ship meta + a
 * dense heap copy to the supervisor for AVS2 assembly + OPFS persistence.
 * Runs at the pre-harden slot (after stdlib-verify + post_restore, before
 * harden/harness — capturing at ready would bake installed-harness state and
 * force an untested double-install on restore) and before ANY user code (the
 * supervisor drops exec-snapshot once ready). stdlib captures too (no bundles
 * → no bake; the gc still runs). Best-effort: a capture failure warns and the
 * boot continues snapshotless. */
function captureSetSnapshot(captureKey: PySetKey | undefined, bundles: PyBundlePayload[]): void {
  if (!captureKey) return;
  try {
    traceSpan('capture-imports', () => {
      for (const b of bundles) {
        const imports = BUNDLE_IMPORTS[b.name];
        if (imports) pyodide.runPython(imports);
      }
      pyodide.runPython('import gc; gc.collect(); gc.collect()');
    });
    const t0 = performance.now();
    const api = pyodide._api;
    // Meta reads BEFORE the heap slice — a serializeHiwireState throw (live
    // PyProxy in the table) skips the ~80 MB copy entirely.
    const dso = api.getDsoLoadInfo();
    const dsoHandles = api.recordDsoHandles();
    const hiwire = api.serializeHiwireState();
    const buildId = api.config.BUILD_ID as string;
    const tableLenAtCapture = pyodide._module.wasmTable.length as number;
    const heap = traceSpan('capture-snapshot', () => (pyodide._module.HEAP8 as Uint8Array).slice().buffer as ArrayBuffer);
    const meta: AvsCaptureMeta = { dso, dsoHandles, hiwire, buildId, tableLenAtCapture, heapLen: heap.byteLength };
    post({ t: 'exec-snapshot', captureKey, meta, heap }, [heap]);
    console.warn(
      `py: captured ${captureKey} snapshot (${(heap.byteLength / 1e6).toFixed(1)} MB, ${(performance.now() - t0).toFixed(0)} ms)`,
    );
  } catch (err) {
    console.warn('py: snapshot capture failed (continuing snapshotless) —', err);
  }
}

async function boot(m: BootPrepMsg): Promise<void> {
  if (pyodide || sab) {
    // One boot per generation — a second would re-run mounts over live state
    // and re-point the interrupt buffer mid-flight. Refuse loudly.
    post({ t: 'exec-fatal', error: 'boot after boot', restored });
    return;
  }
  sab = mapPySab(m.sab);
  traceReset();
  const t0 = performance.now();
  const wasmTimers = installWasmTimers();
  let wasm: Record<string, unknown> = {};
  let bundleCount = 0;
  const outcome = { restored: false };
  try {
    let snapshot: PySnapshotFeeds | undefined;
    if (m.trySnapshot) {
      // DSO precompile — kicks off the moment tars + a non-null header are
      // both in, overlapped with glue import + main instantiate (V8 compiles
      // on process background threads). WebAssembly.compile COPIES its input,
      // so the adopted tar subarrays stay safe. Wrapped by wasmTimers (so
      // compile time shows in the boot aggregates) and consumed inside
      // preBlit, which precedes harden's compile-surface delete (F12 — same
      // window as today's replay).
      const modulesP = (async (): Promise<Map<string, WebAssembly.Module> | null> => {
        const [tars, header] = await Promise.all([D.tars.promise, D.header.promise]);
        if (!header) return null;
        const so = collectSoBytes(tars);
        const pairs = await Promise.all(
          header.dso.loadOrder.map(async (p): Promise<[string, WebAssembly.Module]> => {
            const bytes = so.get(p);
            if (!bytes) throw new Error(`snapshot precompile: no bytes for DSO ${p}`);
            // Tar payloads are plain transferred ArrayBuffers — the narrow cast is true.
            return [p, await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>)];
          }),
        );
        return new Map(pairs);
      })();
      modulesP.catch(() => {}); // rejection consumed only inside preBlit — never unhandled
      snapshot = {
        headerP: D.header.promise,
        heapP: D.heap.promise,
        modulesP,
        onSnapInvalid: (reason) => post({ t: 'exec-snap-invalid', reason }),
        outcome,
      };
    }
    // Uniform boot: with feeds present the fork ALWAYS boots noInitialRun and
    // the preBlit driver decides restore-vs-cold in flight — a restore lands
    // in the realm before it is stripped, so even a poisoned image boots
    // authority-less. Without feeds (snapshots off, in-boot cold retry) the
    // classic auto-main path runs.
    pyodide = await traceSpanAsync('boot-pyodide', async () => {
      if (snapshot) {
        try {
          return await bootPyodide({ artifactBase: m.artifactBase, snapshot });
        } catch (err) {
          if (err instanceof DirtyRestoreError) {
            // Mutation-zone failure (replay/table/heap/blit): the Module is
            // DIRTY — LDSO/table/GOT hold replay state a later cold dlopen
            // would registry-hit — so re-instantiate FRESH in this same
            // worker. The supervisor deletes the file, no respawn (U4).
            post({ t: 'exec-snap-invalid', reason: String(err.message).split('\n')[0] });
            return bootPyodide({ artifactBase: m.artifactBase });
          }
          // Cold-main failures and post-preBlit throws propagate raw —
          // retrying the same failing cold boot would loop (F5); the catch
          // below routes them to exec-fatal with outcome.restored intact.
          throw err;
        }
      }
      return bootPyodide({ artifactBase: m.artifactBase });
    });
    restored = outcome.restored;
    const bundles = await D.tars.promise;
    bundleCount = bundles.length;
    for (const b of bundles) {
      // Cold boots mount fully; restore boots extract-only (DSOs replayed).
      const endMount = traceBegin('mount');
      await mountBundle(b, restored);
      endMount({ bundle: b.name });
    }
    wasm = wasmTimers.collect();
    wasmTimers.uninstall(); // all compiles are behind us; the realm scrub below must not see wrappers
    await traceSpanAsync('stdlib-verify', () => verifyStdlibZip(m.stdlibSha256)); // ALWAYS before any capture — never snapshot an unverified stdlib
    // Reseed entropy consumers + drop caches that alias pre-snapshot state;
    // ends with the tz bridge (superset of the old ensure_tzpath call —
    // idempotent and import-light on cold boots).
    traceSpan('post-restore', () => pyodide.runPython('import _avlo_runtime; _avlo_runtime.post_restore(); del _avlo_runtime'));
    if (!restored) {
      // Cold-boot file_data knife (Step 4): all dlopens are behind us, the
      // bake ahead reuses the freed region, and the capture image shrinks by
      // the same ~14.6 MB (all-set). Runs on non-capture cold boots too —
      // pure RAM win there.
      const endFree = traceBegin('dso-free');
      const { freedBytes, aborted } = freeDsoFileData(pyodide);
      endFree({ mb: Math.round(freedBytes / 1e6), ...(aborted ? { aborted: true } : {}) });
      captureSetSnapshot(m.captureKey, bundles);
    }
    // Last network/compile touch is behind us — strip the realm's ambient
    // authority, then freeze the intrinsics the run protocol flows through.
    // MUST precede the harness install: the Python-side guard is the
    // defense-in-depth layer, this is the authoritative one.
    traceSpan('harden', () => {
      scrubWorkerScope();
      hardenRealm();
      // Fail closed: if the scrub silently no-op'd on any authority, abort the
      // boot here (⇒ exec-fatal) rather than install the harness and run code in
      // an unconfined realm. Same-origin ⇒ this scrub IS the boundary.
      assertRealmHardened();
    });
    pyodide.setInterruptBuffer(sab.u8);
    pyodide.setStdout({ write: makeWriteHook('out'), isatty: false });
    pyodide.setStderr({ write: makeWriteHook('err'), isatty: false });
    traceSpan('harness', () => pyodide.runPython(HARNESS_INSTALL));
    try {
      const endImage = traceBegin('reset-image');
      resetImage = (pyodide._module.HEAP8 as Uint8Array).slice();
      tableLenAtReady = pyodide._module.wasmTable.length as number;
      endImage({ mb: Math.round(resetImage.length / 1e6) });
    } catch (err) {
      console.warn('py: no blit image (per-run respawn instead) —', err);
      resetImage = null;
    }
  } catch (err) {
    // outcome.restored is the truth for poison routing: true ⇒ the blit
    // landed and this is a post-blit death (supervisor deletes + ONE cold
    // respawn); false ⇒ cold-boot failure (no snapshot to blame).
    restored = outcome.restored;
    traceEmit('exec', 'boot-fatal', { restored, error: String((err as Error)?.message ?? err).split('\n')[0], wasm });
    post({ t: 'exec-fatal', error: String((err as Error)?.stack ?? err), restored });
    return;
  }
  Atomics.store(sab.i32, STATE, PyExecState.Idle);
  const bootMs = performance.now() - t0;
  traceEmit('exec', 'boot', {
    bootMs: Math.round(bootMs),
    restored,
    triedSnapshot: m.trySnapshot,
    bundles: bundleCount,
    capture: !!m.captureKey && !restored,
    wasm,
  });
  post({ t: 'exec-ready', bootMs, restored });
}

function exec(m: ExecRunMsg): void {
  if (!pyodide || !sab) {
    post({ t: 'exec-fatal', error: 'exec before boot', restored });
    return;
  }
  currentRunId = m.runId;
  outBuf = '';
  outTruncated = false;
  relayedUpTo = 0;
  lastFlushAt = performance.now();
  stdoutDecoder = new TextDecoder();
  stderrDecoder = new TextDecoder();
  Atomics.store(sab.i32, RUN_ID, m.runId);
  Atomics.store(sab.i32, STATE, PyExecState.Running);
  traceReset();
  const t0 = performance.now();
  let ok = false;
  let interrupted = false;
  let figures: PyFigure[] = [];
  try {
    pyodide.globals.set('_avlo_code', m.code); // string → by value, no proxy
    const res = JSON.parse(traceSpan('run-python', () => pyodide.runPython(RUN_INVOKE) as string)) as {
      ok: boolean;
      interrupted: boolean;
      figures: [string, number, number][];
    };
    ok = res.ok;
    interrupted = res.interrupted;
    figures =
      res.figures.length === 0
        ? []
        : traceSpan('figures', () =>
            res.figures.map(([path, w, h]) => {
              // FS.readFile can return a subarray VIEW over MEMFS — .slice() mints the
              // fresh exact-size buffer that transfer requires.
              const bytes = pyodide.FS.readFile(path) as Uint8Array;
              pyodide.FS.unlink(path);
              return { png: bytes.slice().buffer, width: w, height: h };
            }),
          );
  } catch (err) {
    // Harness-level failure (or KeyboardInterrupt landing outside user code —
    // e.g. during compile): surface as the run's error output.
    interrupted = /KeyboardInterrupt/.test(String(err));
    appendOutput(interrupted ? 'KeyboardInterrupt\n' : `${String((err as Error)?.message ?? err)}\n`);
  }
  // Drain any incomplete multibyte tail the streaming decoders still hold —
  // a run whose last chunk ends mid-character must not lose its final glyphs.
  const stdoutTail = stdoutDecoder.decode();
  if (stdoutTail) appendOutput(stdoutTail);
  const stderrTail = stderrDecoder.decode();
  if (stderrTail) appendOutput(stderrTail);
  flushRelay();
  // Blit reset — every run starts the next one from the ready-point image
  // (stateless, reproducible runs). Sound because DSO instances/table entries
  // are engine-side and their in-heap state returns WITH the image; guard on
  // table growth anyway (nothing should grow it: no ctypes, no WebAssembly
  // compile surface post-harden) and respawn instead of blitting stale bases.
  const heapLen = (pyodide._module.HEAP8 as Uint8Array).length;
  const img = resetImage;
  let blitOk = false;
  if (img && pyodide._module.wasmTable.length === tableLenAtReady) {
    try {
      const endBlit = traceBegin('blit');
      (pyodide._module.HEAP8 as Uint8Array).set(img);
      // Heap growth during the run: prefix restored, tail zeroed — wasted
      // address space, not corruption (respawn reclaims it via needsRespawn).
      if (heapLen > img.length) (pyodide._module.HEAP8 as Uint8Array).fill(0, img.length);
      endBlit({ mb: Math.round(img.length / 1e6) });
      pyodide.setInterruptBuffer(sab.u8); // C-side flag is in the image; re-arm is free paranoia
      traceSpan('post-run-reset', () => pyodide.runPython(POST_RUN_RESET));
      blitOk = true;
    } catch (err) {
      console.warn('py: blit reset failed —', err);
    }
  }
  const needsRespawn = !blitOk || heapLen > 1.5 * (img?.length ?? 0);
  // KiB, not bytes: HEAP8.length reaches 2^31 at the 2 GiB ceiling — as raw
  // bytes it would wrap negative in the Int32 slot.
  Atomics.store(sab.i32, MEM_KIB, heapLen >>> 10);
  Atomics.store(sab.i32, RUN_ID, 0);
  Atomics.store(sab.i32, STATE, PyExecState.Idle);
  Atomics.add(sab.i32, HEARTBEAT, 1);
  const durationMs = performance.now() - t0;
  post(
    {
      t: 'exec-done',
      runId: m.runId,
      ok,
      interrupted,
      output: outBuf,
      durationMs,
      figures,
      needsRespawn,
    },
    figures.map((f) => f.png),
  );
  traceEmit('exec', 'run', {
    runId: m.runId,
    ok,
    interrupted,
    execMs: Math.round(durationMs),
    needsRespawn,
    heapMB: Math.round(heapLen / 1e6),
  });
  currentRunId = 0;
}

self.onmessage = (e: MessageEvent<SupToExec>) => {
  const m = e.data;
  switch (m.t) {
    case 'boot-prep':
      void boot(m);
      break;
    case 'boot-data':
      D.tars.resolve(m.bundles);
      break;
    case 'snap-header':
      D.header.resolve(m.header);
      break;
    case 'snap-heap':
      if (m.reason) console.warn('py: snapshot read failed supervisor-side —', m.reason);
      D.heap.resolve(m.heap);
      break;
    case 'exec':
      exec(m);
      break;
  }
};
