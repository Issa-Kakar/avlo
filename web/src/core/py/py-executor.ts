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
import { bootPyodide, type Pyodide } from './py-loader';
import {
  type ExecBootMsg,
  type ExecRunMsg,
  OUTPUT_TRUNCATION_MARKER,
  PY_LIMITS,
  type PyBundlePayload,
  type PyFigure,
  type SupToExec,
} from './py-protocol';
import { HEARTBEAT, MEM_KIB, mapPySab, PyExecState, type PySabViews, RUN_ID, STATE } from './py-sab';
import { packTree } from './py-snapshot';

let pyodide: Pyodide = null;
let sab: PySabViews | null = null;
let currentRunId = 0;

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
  sqlite3: 'import sqlite3',
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

/** Mount one bundle: write the tar into MEMFS, extract it (meta.json stays
 * out), delete the tar, then loadDynlib every DSO in the meta's canonical
 * order (the supervisor sends bundles in deps-first set order). */
async function mountBundle(b: PyBundlePayload): Promise<void> {
  pyodide.FS.writeFile('/tmp/_avlo_bundle.tar', new Uint8Array(b.bytes));
  pyodide.runPython(`import os, tarfile
with tarfile.open('/tmp/_avlo_bundle.tar') as _t:
    _t.extractall(${JSON.stringify(b.prefix)}, members=[m for m in _t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_avlo_bundle.tar')
del _t`);
  for (const so of b.loadOrder) {
    await pyodide._api.loadDynlib(`${b.prefix}/${so}`);
  }
}

/** Generation capture — bake the set's imports into the heap, snapshot, ship
 * to the supervisor for OPFS persistence. Runs BEFORE scrub/harden (capture
 * needs nothing hardened away; keeping session state out of the image) and
 * before ANY user code (the supervisor drops exec-snapshot once ready).
 * Best-effort: a capture failure warns and the boot continues snapshotless. */
function captureSetSnapshot(m: ExecBootMsg): void {
  const bundles = m.bundles ?? [];
  if (bundles.length === 0 || !m.captureKey) return;
  try {
    for (const b of bundles) {
      const imports = BUNDLE_IMPORTS[b.name];
      if (imports) pyodide.runPython(imports);
    }
    pyodide.runPython('import gc; gc.collect(); gc.collect()');
    const t0 = performance.now();
    const container = (pyodide.makeMemorySnapshot() as Uint8Array).slice().buffer;
    // Walk AFTER the imports — import-generated __pycache__ pycs are
    // heap-referenced; an earlier walk bakes an inconsistent tree (G7).
    const tree = packTree(pyodide.FS, bundles[0].prefix);
    post({ t: 'exec-snapshot', captureKey: m.captureKey, container, tree }, [container, tree.blob]);
    console.warn(
      `py: captured ${m.captureKey} snapshot (${(container.byteLength / 1e6).toFixed(1)} MB, ${(performance.now() - t0).toFixed(0)} ms)`,
    );
  } catch (err) {
    console.warn('py: snapshot capture failed (continuing snapshotless) —', err);
  }
}

async function boot(m: ExecBootMsg): Promise<void> {
  if (pyodide || sab) {
    // One boot per generation — a second would re-run mounts over live state
    // and re-point the interrupt buffer mid-flight. Refuse loudly.
    post({ t: 'exec-fatal', error: 'boot after boot' });
    return;
  }
  sab = mapPySab(m.sab);
  const t0 = performance.now();
  try {
    // Restore (when m.snapshot rides) happens INSIDE bootPyodide, before the
    // realm is stripped — so even a poisoned image lands authority-less.
    pyodide = await bootPyodide({ artifactBase: m.artifactBase, snapshot: m.snapshot, tree: m.tree, makeSnapshot: m.capture });
    for (const b of m.bundles ?? []) await mountBundle(b); // cold + generation; stacked boots carry none
    await verifyStdlibZip(m.stdlibSha256); // ALWAYS before any capture — never snapshot an unverified stdlib
    // Reseed entropy consumers + drop caches that alias pre-snapshot state;
    // ends with the tz bridge (superset of the old ensure_tzpath call —
    // idempotent and import-light on cold boots).
    pyodide.runPython('import _avlo_runtime; _avlo_runtime.post_restore(); del _avlo_runtime');
    if (m.capture) captureSetSnapshot(m);
    // Last network/compile touch is behind us — strip the realm's ambient
    // authority, then freeze the intrinsics the run protocol flows through.
    // MUST precede the harness install: the Python-side guard is the
    // defense-in-depth layer, this is the authoritative one.
    scrubWorkerScope();
    hardenRealm();
    // Fail closed: if the scrub silently no-op'd on any authority, abort the
    // boot here (⇒ exec-fatal) rather than install the harness and run code in
    // an unconfined realm. Same-origin ⇒ this scrub IS the boundary.
    assertRealmHardened();
    pyodide.setInterruptBuffer(sab.u8);
    pyodide.setStdout({ write: makeWriteHook('out'), isatty: false });
    pyodide.setStderr({ write: makeWriteHook('err'), isatty: false });
    pyodide.runPython(HARNESS_INSTALL);
    try {
      resetImage = (pyodide._module.HEAP8 as Uint8Array).slice();
      tableLenAtReady = pyodide._module.wasmTable.length as number;
    } catch (err) {
      console.warn('py: no blit image (per-run respawn instead) —', err);
      resetImage = null;
    }
  } catch (err) {
    post({ t: 'exec-fatal', error: String((err as Error)?.stack ?? err) });
    return;
  }
  Atomics.store(sab.i32, STATE, PyExecState.Idle);
  post({ t: 'exec-ready', bootMs: performance.now() - t0 });
}

function exec(m: ExecRunMsg): void {
  if (!pyodide || !sab) {
    post({ t: 'exec-fatal', error: 'exec before boot' });
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
  const t0 = performance.now();
  let ok = false;
  let interrupted = false;
  let figures: PyFigure[] = [];
  try {
    pyodide.globals.set('_avlo_code', m.code); // string → by value, no proxy
    const res = JSON.parse(pyodide.runPython(RUN_INVOKE) as string) as {
      ok: boolean;
      interrupted: boolean;
      figures: [string, number, number][];
    };
    ok = res.ok;
    interrupted = res.interrupted;
    figures = res.figures.map(([path, w, h]) => {
      // FS.readFile can return a subarray VIEW over MEMFS — .slice() mints the
      // fresh exact-size buffer that transfer requires.
      const bytes = pyodide.FS.readFile(path) as Uint8Array;
      pyodide.FS.unlink(path);
      return { png: bytes.slice().buffer, width: w, height: h };
    });
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
      (pyodide._module.HEAP8 as Uint8Array).set(img);
      // Heap growth during the run: prefix restored, tail zeroed — wasted
      // address space, not corruption (respawn reclaims it via needsRespawn).
      if (heapLen > img.length) (pyodide._module.HEAP8 as Uint8Array).fill(0, img.length);
      pyodide.setInterruptBuffer(sab.u8); // C-side flag is in the image; re-arm is free paranoia
      pyodide.runPython(POST_RUN_RESET);
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
  post(
    {
      t: 'exec-done',
      runId: m.runId,
      ok,
      interrupted,
      output: outBuf,
      durationMs: performance.now() - t0,
      figures,
      needsRespawn,
    },
    figures.map((f) => f.png),
  );
  currentRunId = 0;
}

self.onmessage = async (e: MessageEvent<SupToExec>) => {
  const m = e.data;
  switch (m.t) {
    case 'boot':
      await boot(m);
      break;
    case 'exec':
      exec(m);
      break;
  }
};
