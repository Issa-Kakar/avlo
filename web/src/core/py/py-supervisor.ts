/**
 * Python SUPERVISOR worker — the always-live control plane. Spawns/terminates
 * the nested executor (so `terminate()` works and teardown cascades), owns
 * every wall clock (soft/hard timeouts, cancel grace, idle teardown — the
 * executor can't service timers mid-run), fetches + sha-verifies package
 * bundles (the executor NEVER fetches; bundle bytes ride postMessage), and
 * relays results to main.
 *
 * Bundle discipline (M3/P2):
 * - The COMMITTED build-lock (@avlo/py-loader) is the source of truth for
 *   artifact hashes + set membership — no boot-time manifest fetch; every
 *   fetched tar is verified against it before use. A stale mix of artifacts
 *   is refused, same rule as the executor's stdlib-zip as-mounted guard.
 * - Verified tar bytes persist in the Cache API (`avlo-py-<buildHash>`,
 *   shared with the SW's verify-at-fill route — this is the offline path);
 *   each boot gets the fetched/matched buffers TRANSFERRED outright (no
 *   resident copy — the old ~38 MB in-memory 'all' cache is gone). Hits the
 *   SW marked `x-avlo-verified` skip the re-hash (the SW lock-verified them
 *   before writing); unmarked hits (this supervisor's own puts, legacy
 *   entries) are re-verified against the lock.
 * - A run whose required bundles aren't mounted in the current generation
 *   forces a respawn with the right set (supersets satisfy subsets).
 *
 * Interrupt discipline (P0-B findings, load-bearing):
 * - FRESH PY_SAB per executor generation — a terminated executor blocked in a
 *   wasm busy loop keeps spinning until its next yield and would consume
 *   SIGINT writes from a shared buffer, stealing the replacement's first
 *   interrupt.
 * - Repeat SIGINT writes every PY_LIMITS.interruptRepeatMs until the run
 *   resolves — converts any one-shot swallow into bounded extra latency.
 *
 * Snapshot discipline (P2 owned dense snapshots + L2 topology flip):
 * - EVERY set (stdlib included) may restore `opfs:/py/<buildHash>/<set>.snap`.
 *   THIS supervisor owns ALL OPFS I/O: it opens/parses/reads+hashes the
 *   snapshot (T3, in the shadow of executor spawn + glue + instantiate) and
 *   TRANSFERS the verified heap buffer; the executor's preBlit driver only
 *   blits. It also persists exec-snapshot captures (AVS2 assembly + chunked
 *   OPFS write, off the executor's critical path) and deletes poisoned files.
 *   Bundles are fetched on EVERY spawn — restore boots still mount
 *   site-packages from the tars and precompile DSOs out of them.
 * - Spawn topology (L2): the worker is constructed FIRST, then three detached
 *   tasks feed it — T1 glue-preflight → boot-prep, T2 bundles → boot-data
 *   (transfer), T3 snapshot open/parse → snap-header, read+hash →
 *   snap-heap (transfer). Every task captures its worker + token and posts
 *   only behind a synchronous live() check (F1); teardown/supersession bumps
 *   the token (F2) and MUTES the dying worker's onmessage before terminate
 *   (F3) so stale-generation messages can never interleave. Every
 *   executor-side await has a guaranteed sup-side completion signal —
 *   boot-data or teardown; snap-header value|null; snap-heap value|null or
 *   provably-unawaited after exec-snap-invalid/supersession (F6/F16). There
 *   is NO boot watchdog: a task failure calls abortSpawn, which tears the
 *   (otherwise-hung) worker down unconditionally.
 * - Snapshots ACCELERATE, never gate: uniform boots fall back cold on the
 *   SAME Module for pre-mutation failures (snap-header:null / compile fail)
 *   and re-instantiate in the SAME worker on mutation-zone failures
 *   (exec-snap-invalid → delete only, no respawn); a restored boot that dies
 *   post-blit pre-ready (exec-fatal restored:true) deletes its file and
 *   retries cold ONCE with the run still pending; a restored generation whose
 *   FIRST run hard-fails deletes its file before the eager respawn (U6).
 * - All snapshot-file mutations ride the per-set snapOps promise chain and
 *   T3 reads await its head (F10) — a poison delete and the eager respawn's
 *   probe can never race. Hash/parse failures may delete ONLY off a
 *   lock-holding open rung (F9 — the buffered getFile rung sees unstable
 *   bytes that may be another tab's mid-write).
 *
 * Single-flight: main's manager serializes runs; at most one run is active or
 * pending here at any time.
 */

import { PY_ORIGIN } from '@avlo/api-client';
import { BUILD_LOCK, matchesLockEntry } from '@avlo/py-loader';
import { parseTarMeta } from './py-mount';
import {
  type BootDataMsg,
  type BootPrepMsg,
  type ExecToSup,
  type MainToSup,
  PY_LIMITS,
  type PyBundlePayload,
  type PyRunStatus,
  type PySetKey,
  type ResultMsg,
  type RunMsg,
  type SnapHeaderMsg,
  type SnapHeapMsg,
} from './py-protocol';
import { allocPySab, clearInterrupt, EPOCH, PyCancelKind, type PySabViews, writeInterrupt } from './py-sab';
import {
  type AvsHeader,
  deleteSetSnapshot,
  openSetSnapshotSup,
  parseAvsHeader,
  readSnapshotToBuffer,
  type SnapOpen,
  writeSetSnapshot,
} from './py-snapshot';
import { SET_BUNDLES } from './py-stdlib-modules.gen';
import { setTraceSink, traceAdd, traceBegin, traceEmit, traceReset } from './py-trace';

// Immutable content-hashed artifact origin — the committed lock pins the hash,
// the worker 404s anything else (stale lock fails visible, never wrong).
const ARTIFACT_BASE = `${PY_ORIGIN}/${BUILD_LOCK.buildHash}/`;
// Shared with the SW's cache-first route (same URL keys); activate-time
// eviction there deletes any avlo-py-* cache with a different hash.
const PY_CACHE = `avlo-py-${BUILD_LOCK.buildHash}`;

interface ActiveRun {
  runId: number;
  code: string;
  dispatched: boolean;
  /** When the run REQUEST arrived (click→ready/result trace anchor). */
  reqAt: number;
  startedAt: number;
  softTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  interruptRepeat: ReturnType<typeof setInterval> | null;
  cancelKind: PyCancelKind;
}

let executor: Worker | null = null;
let executorReady = false;
let sab: PySabViews | null = null;
let epoch = 0;
let active: ActiveRun | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Set the CURRENT executor generation booted with (null = none). */
let bootedSetKey: PySetKey | null = null;
/** Last requested set — eager respawns reuse it (cache makes them free). */
let desiredSetKey: PySetKey = 'stdlib';
/** Guards overlapping async spawns; only the latest token may proceed.
 * teardownExecutor bumps it too (F2) — detached spawn tasks of a torn-down
 * generation must go inert, not feed a corpse or the next worker. */
let spawnToken = 0;
/** Per-generation snapshot flags. Replaced wholesale in spawnExecutor; the
 * generation's T3 task captures ITS object, while onExecutorMessage always
 * mutates the current one (stale workers are muted, so they can never write
 * here). `snapAbandoned` (F16): a live-generation exec-snap-invalid means the
 * executor provably never awaits snap-heap — the in-flight read stops and
 * posts nothing. */
let gen = { snapAbandoned: false };
/** Whether the CURRENT generation's boot msg carried trySnapshot — with
 * exec-ready's `restored` this resolves the boot path for logging. */
let bootTriedSnapshot = false;
/** True from a restored generation's exec-ready until its first run resolves
 * — the U6 window: a hard failure inside it poison-deletes the snapshot. */
let firstRunAfterRestore = false;
/** One cold retry per failure — a second pre-ready fatal surfaces normally. */
let snapshotRetried = false;
/** Human label for the CURRENT generation's boot path — logged with bootMs on
 * exec-ready (the snapshot-used / cold-boot signal). Resolved AT exec-ready —
 * the supervisor knows the header verdict (snap-open {hit}), but only the
 * executor knows whether the blit actually landed. */
let bootDescription = '';
/** When the boot message was posted — exec-ready closes the 'boot-wait' span
 * (executor worker spin-up + boot; the delta vs bootMs is spin-up cost). */
let bootPostedAt = 0;

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

setTraceSink((line) => post({ t: 'trace', line }));

const bundlesOf = (setKey: PySetKey): readonly string[] => (setKey === 'stdlib' ? [] : SET_BUNDLES[setKey]);

/** Per-set snapshot-file operation chain (F10) — MODULE scope, surviving
 * teardown: every write/delete APPENDS, every T3 read awaits the head before
 * opening. Serializes the U6 poison-delete against the eager respawn's probe
 * (the pre-existing race this fixes) and capture-write against the next
 * spawn's read. Ops are best-effort (they swallow their own errors), the
 * catch is belt so one rejection can never wedge a set's chain. */
const snapOps = new Map<PySetKey, Promise<void>>();
const snapOpsHead = (setKey: PySetKey): Promise<void> => snapOps.get(setKey) ?? Promise.resolve();
function chainSnapOp(setKey: PySetKey, op: () => Promise<void>): void {
  snapOps.set(
    setKey,
    snapOpsHead(setKey)
      .then(op)
      .catch(() => {}),
  );
}
const chainDelete = (setKey: PySetKey): void => chainSnapOp(setKey, () => deleteSetSnapshot(BUILD_LOCK.buildHash, setKey));

/** Does the booted generation's bundle set cover the run's needs? */
function setSatisfies(booted: PySetKey | null, need: PySetKey): boolean {
  if (booted === null) return false;
  const have = bundlesOf(booted);
  return bundlesOf(need).every((b) => have.includes(b));
}

/** Ensure every bundle of the set is present + lock-verified, posting download
 * progress for the pending run. Returns boot payloads in deps-first order —
 * buffers are handed to the caller outright (transferred to the executor;
 * persistence is the Cache API, not supervisor memory).
 *
 * Cache API over memory: works in a dedicated worker without a SW (THE offline
 * path for tars) and shares URL keys with the SW's verify-at-fill route. Hits
 * carrying the SW's `x-avlo-verified` marker were lock-verified BEFORE the
 * write and skip the re-hash (~40 MB/boot saved on the warm path); unmarked
 * hits (this supervisor's own miss-path puts, legacy entries) are re-verified
 * — a poisoned/stale entry must not reach a mount. `res.body` yields DECODED
 * bytes, so counts + shas run over identity bytes even when the worker served
 * `.br`. */
async function ensureBundles(setKey: PySetKey, live: () => boolean): Promise<PyBundlePayload[]> {
  const names = bundlesOf(setKey);
  if (names.length === 0) return [];
  const cache = await caches.open(PY_CACHE);
  const byName = new Map<string, PyBundlePayload>();
  const misses: string[] = [];
  for (const name of names) {
    const expected = BUILD_LOCK.bundles[name];
    if (!expected) throw new Error(`bundle ${name} not in build-lock`);
    const hit = await cache.match(`${ARTIFACT_BASE}bundles/${name}.tar`);
    if (!hit) {
      misses.push(name);
      continue;
    }
    const bytes = new Uint8Array(await hit.arrayBuffer());
    if (hit.headers.get('x-avlo-verified') !== '1' && !(await matchesLockEntry(bytes.buffer, expected))) {
      // Unmarked AND failing the lock (stale generation, torn write) — drop
      // and refetch below.
      await cache.delete(`${ARTIFACT_BASE}bundles/${name}.tar`);
      misses.push(name);
      continue;
    }
    const meta = parseTarMeta(bytes);
    byName.set(name, { name, prefix: meta.prefix, loadOrder: meta.loadOrder, bytes: bytes.buffer });
  }
  const total = misses.reduce((n, b) => n + BUILD_LOCK.bundles[b].size, 0);
  let received = 0;
  const progress = () => {
    // live-guarded (F13): a superseded spawn's still-streaming download must
    // not stamp stale progress over the new generation's phase.
    if (live() && active && !active.dispatched) {
      post({ t: 'phase', runId: active.runId, phase: 'downloading', received, total });
    }
  };
  if (misses.length > 0) progress();
  // Misses download concurrently (sum → max wall-clock). All per-tar state is
  // closure-local; `received` interleaves safely (single-threaded increments)
  // and converges to `total`; any reject propagates through Promise.all.
  await Promise.all(
    misses.map(async (name) => {
      const expected = BUILD_LOCK.bundles[name];
      const url = `${ARTIFACT_BASE}bundles/${name}.tar`;
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`${name}.tar: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > expected.size) {
          // Abort BEFORE buffering an over-long body — the sha check below
          // would catch the mismatch, but only after holding the whole stream.
          void reader.cancel();
          throw new Error(`${name}.tar exceeds build-lock size (${expected.size} B) — artifact mix drifted from build-lock`);
        }
        chunks.push(value);
        received += value.length;
        progress();
      }
      const bytes = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
      if (!(await matchesLockEntry(bytes.buffer, expected))) {
        throw new Error(`${name}.tar sha256 mismatch — artifact mix drifted from build-lock`);
      }
      const meta = parseTarMeta(bytes);
      // Fresh Response copies the buffer per spec — safe to transfer `bytes.buffer`
      // to the executor afterwards. Marked verified: the sha check above IS the
      // at-fill verification, so whichever put wins the benign SW-vs-supervisor
      // race, later boots take the marker fast-path.
      await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/x-tar', 'x-avlo-verified': '1' } }));
      byName.set(name, { name, prefix: meta.prefix, loadOrder: meta.loadOrder, bytes: bytes.buffer });
    }),
  );
  return names.map((n) => byName.get(n) as PyBundlePayload);
}

/** Verify the JS glue trio against the committed lock once per page load.
 * These are the artifacts pyodide ingests through its OWN indexURL fetches
 * (dynamic import + instantiateStreaming) — the supervisor never sees those
 * bytes, so this preflight is the drift/corruption gate for contexts the
 * verifying SW route doesn't cover (dev, first load before SW control).
 * With the SW active it also warms the verified cache with the same
 * responses the executor's import will hit. stdlib.zip is deliberately
 * absent: verifyStdlibZip hashes it AS MOUNTED in every context. Memoized on
 * SUCCESS only — a transient offline failure must not brick the page. */
let gluePreflight: Promise<void> | null = null;
function ensureGlueVerified(): Promise<void> {
  gluePreflight ??= (async () => {
    for (const name of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm'] as const) {
      const expected = BUILD_LOCK.artifacts[name];
      if (!expected) throw new Error(`${name} not in build-lock`);
      const res = await fetch(`${ARTIFACT_BASE}${name}`);
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      if (!(await matchesLockEntry(await res.arrayBuffer(), expected))) {
        throw new Error(`${name} drifted from the committed build-lock — refusing to boot`);
      }
    }
  })().catch((err) => {
    gluePreflight = null;
    throw err;
  });
  return gluePreflight;
}

/** First-load-offline is a user situation, not an integrity failure — say so.
 * X MB = everything a cold cache would need for this set (glue + wasm +
 * stdlib + the set's tars). */
function downloadFailureMessage(err: unknown, setKey: PySetKey): string {
  if (err instanceof TypeError || !navigator.onLine) {
    const bytes =
      Object.values(BUILD_LOCK.artifacts).reduce((n, a) => n + a.size, 0) +
      bundlesOf(setKey).reduce((n, b) => n + (BUILD_LOCK.bundles[b]?.size ?? 0), 0);
    return `You're offline — connect once to download the Python runtime (~${Math.ceil(bytes / 1e6)} MB).`;
  }
  return `Python runtime download failed: ${String((err as Error)?.message ?? err)}`;
}

function clearRunTimers(run: ActiveRun): void {
  if (run.softTimer !== null) clearTimeout(run.softTimer);
  if (run.hardTimer !== null) clearTimeout(run.hardTimer);
  if (run.interruptRepeat !== null) clearInterval(run.interruptRepeat);
  run.softTimer = run.hardTimer = run.interruptRepeat = null;
}

/** Terminate + null the executor generation (heap + RAM freed; verified tars
 * persist in the Cache API — respawns re-match without a network trip). Safe
 * when already dormant. Used for idle teardown AND broken-executor paths — a
 * dead worker left assigned would wedge the next run. Bumps the spawn token
 * (F2) so detached spawn tasks of this generation go inert, and MUTES the
 * worker before terminate (F3) — terminate() closes ports asynchronously
 * enough that an already-queued message from the dying worker could otherwise
 * still fire onExecutorMessage and corrupt the next generation's state. */
function teardownExecutor(): void {
  spawnToken++;
  if (executor) {
    executor.onmessage = null;
    executor.terminate();
  }
  executor = null;
  executorReady = false;
  sab = null;
  bootedSetKey = null;
  bootTriedSnapshot = false;
  firstRunAfterRestore = false;
}

function armIdleTeardown(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (active === null) teardownExecutor(); // respawn restores from the OPFS snapshot
  }, PY_LIMITS.idleTeardownMs);
}

/** Kill-switch for the owned snapshot path (P2). false ⇒ every boot is a
 * plain cold mount boot: no OPFS probe, no capture — the safe fallback if a
 * fleet-wide snapshot bug ever ships. Existing OPFS files go stale-but-inert
 * (buildHash-dir GC reaps them on the next capture-side touch). */
const SNAPSHOTS_ENABLED = true;

/** Fail the current spawn: tear the (possibly hung) worker down
 * UNCONDITIONALLY — with the L2 topology the executor already exists and is
 * awaiting inputs that will now never arrive, and no boot watchdog exists —
 * then surface the failure as the pending run's result (or stay dormant; the
 * next click re-attempts). Callers live()-guard: a superseded task must not
 * tear down its successor. */
function abortSpawn(message: string): void {
  teardownExecutor();
  if (active) failActiveRun(message, 'error', false);
}

/** L2 spawn: construct the executor FIRST, then feed it via three detached
 * tasks so bundle prep + snapshot open/read/hash overlap worker spin-up +
 * glue import + wasm instantiate. Synchronous through task launch. Discipline
 * (F1): every task captures `w`/`token`/`gen` — never the module vars — and
 * every post is a synchronous `if (!live()) return; w.postMessage(...)` pair
 * (no await between); posting to a terminated captured worker is benign
 * (message discarded; transferred buffers just detach). Span closers are
 * live()-guarded too (F14): a stale closer firing after the next spawn's
 * traceReset would land in the wrong boot's line. */
function spawnExecutor(setKey: PySetKey, opts?: { noSnapshot?: boolean }): void {
  const token = ++spawnToken;
  if (executor) {
    executor.onmessage = null; // F3 — mute before terminate
    executor.terminate();
  }
  executor = null;
  executorReady = false;
  bootedSetKey = null;
  bootTriedSnapshot = false;
  firstRunAfterRestore = false;
  gen = { snapAbandoned: false };
  traceReset();
  const spawnStart = performance.now();
  const useSnapshot = SNAPSHOTS_ENABLED && !opts?.noSnapshot;
  sab = allocPySab(); // never reuse across generations
  epoch += 1;
  Atomics.store(sab.i32, EPOCH, epoch);
  const w = new Worker(new URL('./py-executor.ts', import.meta.url), {
    type: 'module',
  });
  w.onmessage = (e: MessageEvent<ExecToSup>) => onExecutorMessage(e.data);
  w.onerror = (e: ErrorEvent) => {
    if (active) failActiveRun(`executor error: ${e.message}`, /out of memory|OOM/i.test(e.message) ? 'oom' : 'error');
    else teardownExecutor(); // dormant executor broke — never leave it assigned
  };
  executor = w;
  bootedSetKey = setKey;
  bootTriedSnapshot = useSnapshot;
  const live = () => token === spawnToken;
  const myGen = gen;
  const sabRef = sab.sab;

  // T1 — glue preflight (memoized after the first success) → boot-prep. The
  // prep msg carries the LOCK's stdlib zip hash — the executor verifies its
  // MEMFS mount against it (restage ⇒ recapture).
  void (async () => {
    const endGlue = traceBegin('glue-preflight');
    try {
      await ensureGlueVerified();
    } catch (err) {
      if (!live()) return;
      abortSpawn(downloadFailureMessage(err, setKey));
      return;
    }
    if (!live()) return;
    endGlue();
    w.postMessage({
      t: 'boot-prep',
      artifactBase: ARTIFACT_BASE,
      sab: sabRef,
      stdlibSha256: BUILD_LOCK.artifacts['python_stdlib.zip'].sha256,
      buildHash: BUILD_LOCK.buildHash,
      trySnapshot: useSnapshot,
      ...(useSnapshot ? { captureKey: setKey } : {}),
    } satisfies BootPrepMsg);
    // 'spawn' = construction → boot-prep posted (NOTE: no longer contains the
    // bundle wait — that overlaps the boot now); 'boot-wait' (closed on
    // exec-ready) − executor bootMs = spin-up + message latency.
    bootPostedAt = performance.now();
    traceAdd('spawn', spawnStart, bootPostedAt, { setKey, trySnapshot: useSnapshot });
  })();

  // T2 — bundle fetch/verify → boot-data (buffers transfer outright:
  // persistence is the Cache API, not this heap). Needed on restore boots too
  // (site-packages mounts from the tars; DSO precompile slices .so bytes out
  // of them); stdlib resolves []. May outrun T1 on a first-load glue fetch —
  // the executor parks either order (F7).
  void (async () => {
    let payloads: PyBundlePayload[] | null = null;
    const endBundles = traceBegin('bundles');
    try {
      payloads = await ensureBundles(setKey, live);
    } catch (err) {
      if (!live()) return;
      abortSpawn(downloadFailureMessage(err, setKey));
      return;
    }
    if (!live()) {
      payloads = null;
      return;
    }
    endBundles({ count: payloads.length });
    try {
      w.postMessage(
        { t: 'boot-data', bundles: payloads } satisfies BootDataMsg,
        payloads.map((p) => p.bytes),
      );
    } finally {
      payloads = null; // F15 — transferred (or discarded); never retained here
    }
  })();

  // T3 — snapshot open/parse → snap-header, read+hash → snap-heap. ONE task,
  // catch-all: after a non-null header the executor's driver AWAITS snap-heap
  // (unless it posted exec-snap-invalid first), so a value|null must always
  // follow (F6). Reads await the snapOps chain head (F10).
  if (useSnapshot) {
    void (async () => {
      await snapOpsHead(setKey);
      if (!live()) return;
      const endOpen = traceBegin('snap-open');
      let opened: SnapOpen | null = null;
      let header: AvsHeader | null = null;
      try {
        opened = await openSetSnapshotSup(BUILD_LOCK.buildHash, setKey);
        if (opened) header = parseAvsHeader(opened.handle, { buildHash: BUILD_LOCK.buildHash, setKey });
      } catch (err) {
        // Parse failure: poison-delete ONLY off a lock-holding rung (F9 — the
        // buffered getFile rung may be reading another tab's mid-write).
        if (opened?.deletable) chainDelete(setKey);
        console.warn(`py: ${setKey} snapshot open/parse failed — booting cold:`, String((err as Error)?.message ?? err).split('\n')[0]);
        header = null;
      }
      if (!live()) {
        opened?.handle.close();
        return;
      }
      endOpen({ hit: header !== null });
      w.postMessage({ t: 'snap-header', header } satisfies SnapHeaderMsg);
      if (!header || !opened) {
        opened?.handle.close();
        return;
      }
      let heap: ArrayBuffer | null = null;
      let reason: string | undefined;
      const endRead = traceBegin('snap-read');
      try {
        heap = await readSnapshotToBuffer(opened.handle, header, { live, abandoned: () => myGen.snapAbandoned });
      } catch (err) {
        reason = String((err as Error)?.message ?? err).split('\n')[0];
        if (opened.deletable) chainDelete(setKey); // F9 again — hash misses land here
      } finally {
        opened.handle.close();
      }
      if (!live()) {
        heap = null;
        return;
      }
      endRead({ mb: Math.round(header.heapLen / 1e6), ...(heap === null && !reason ? { aborted: true } : {}) });
      if (myGen.snapAbandoned) {
        // F16 — the executor posted exec-snap-invalid and provably never
        // awaits snap-heap (its driver went cold / re-instantiated fresh).
        heap = null;
        return;
      }
      try {
        w.postMessage({ t: 'snap-heap', heap, ...(reason ? { reason } : {}) } satisfies SnapHeapMsg, heap ? [heap] : []);
      } finally {
        heap = null; // F15
      }
    })();
  }
}

function dispatch(run: ActiveRun): void {
  if (!executor || !sab) return;
  run.dispatched = true;
  run.startedAt = performance.now();
  traceAdd('req-to-dispatch', run.reqAt, run.startedAt);
  clearInterrupt(sab);
  executor.postMessage({ t: 'exec', runId: run.runId, code: run.code });
  post({ t: 'phase', runId: run.runId, phase: 'running' });
  run.softTimer = setTimeout(() => {
    run.softTimer = null;
    beginInterrupt(run, PyCancelKind.SoftTimeout, PY_LIMITS.hardGraceMs);
  }, PY_LIMITS.softTimeoutMs);
}

/** Write SIGINT now, keep re-writing until the run resolves, hard-kill after
 * the grace window if Python never surfaces the interrupt. UserCancel
 * OUTRANKS SoftTimeout: a Stop click during the timeout grace re-arms the
 * kill on the shorter cancel grace, a soft timeout landing after a cancel
 * changes nothing, and repeats of the same kind never extend the deadline.
 * Closures read `run.cancelKind` live so the forced-kill label always
 * matches the graceful exec-done mapping. */
function beginInterrupt(run: ActiveRun, kind: PyCancelKind, graceMs: number): void {
  if (!sab || run !== active) return;
  const arm = run.hardTimer === null || (kind === PyCancelKind.UserCancel && run.cancelKind !== PyCancelKind.UserCancel);
  if (arm) {
    run.cancelKind = kind;
    if (run.hardTimer !== null) clearTimeout(run.hardTimer);
    run.hardTimer = setTimeout(() => {
      run.hardTimer = null;
      const cancelled = run.cancelKind === PyCancelKind.UserCancel;
      failActiveRun(
        cancelled ? 'Cancelled (forced stop).' : 'Timed out (forced stop).',
        cancelled ? 'cancelled' : 'timeout',
        /* respawn */ true,
      );
    }, graceMs);
  }
  post({ t: 'phase', runId: run.runId, phase: 'cancelling' });
  const views = sab;
  writeInterrupt(views, run.cancelKind);
  run.interruptRepeat ??= setInterval(() => writeInterrupt(views, run.cancelKind), PY_LIMITS.interruptRepeatMs);
}

/** Synthesize a result for the active run (executor dead/hung paths). */
function failActiveRun(message: string, status: PyRunStatus, respawn = true): void {
  const run = active;
  if (!run) return;
  active = null;
  clearRunTimers(run);
  const result: ResultMsg = {
    t: 'result',
    runId: run.runId,
    status,
    output: message,
    durationMs: run.dispatched ? performance.now() - run.startedAt : 0,
    figures: [],
  };
  post(result);
  traceEmit('sup', 'run', { runId: run.runId, status, synthesized: true });
  // Eager respawn reuses the last set's CACHED bundles — next click lands on
  // a warm worker with the same mounts.
  if (respawn) spawnExecutor(desiredSetKey);
  armIdleTeardown();
}

function onExecutorMessage(m: ExecToSup): void {
  switch (m.t) {
    case 'exec-trace': {
      post({ t: 'trace', line: m.line });
      break;
    }
    case 'exec-ready': {
      executorReady = true;
      snapshotRetried = false;
      firstRunAfterRestore = m.restored;
      bootDescription = m.restored
        ? 'restored OPFS snapshot'
        : bootTriedSnapshot
          ? 'cold boot + capture (no valid snapshot)'
          : SNAPSHOTS_ENABLED
            ? 'cold retry (snapshot poisoned)' // the only noSnapshot spawn while the kill switch is on
            : 'cold boot (snapshots off)';
      const now = performance.now();
      if (bootPostedAt > 0) traceAdd('boot-wait', bootPostedAt, now, { bootMs: Math.round(m.bootMs) });
      bootPostedAt = 0;
      traceEmit('sup', 'boot', {
        setKey: bootedSetKey,
        path: bootDescription,
        bootMs: Math.round(m.bootMs),
        ...(active ? { reqToReadyMs: Math.round(now - active.reqAt) } : {}),
      });
      console.warn(`py: ${bootedSetKey} executor ready — ${bootDescription}, boot ${m.bootMs.toFixed(0)} ms`);
      if (active && !active.dispatched) dispatch(active);
      else armIdleTeardown();
      break;
    }
    case 'exec-stdout': {
      if (active?.runId === m.runId) post({ t: 'stdout', runId: m.runId, chunk: m.chunk });
      break;
    }
    case 'exec-snapshot': {
      // Only a BOOT-time capture is legitimate — once ready, user code has
      // run, and a forged capture must never reach persistent storage (the
      // F3 onmessage-mute is what actually closes the stale-generation
      // window; this guard covers the live one). Persistence rides the
      // snapOps chain and overlaps the pending run (best-effort).
      if (!executorReady) chainSnapOp(m.captureKey, () => writeSetSnapshot(BUILD_LOCK.buildHash, m.captureKey, m.meta, m.heap));
      break;
    }
    case 'exec-snap-invalid': {
      // The executor rejected the snapshot (pre-mutation fallback on the same
      // Module, or a dirty-restore re-instantiate) and already continued cold
      // IN the same worker — delete the artifact, mark the generation
      // abandoned (F16: an in-flight T3 read stops and posts nothing — the
      // executor provably never awaits snap-heap now), nothing else (U4: no
      // respawn; the cold boot's capture re-persists a fresh one).
      console.warn(`py: ${bootedSetKey} snapshot invalid — deleted, boot continued cold:`, m.reason);
      traceEmit('sup', 'snap-invalid', { setKey: bootedSetKey, reason: m.reason });
      gen.snapAbandoned = true;
      if (bootedSetKey) chainDelete(bootedSetKey);
      break;
    }
    case 'exec-done': {
      const run = active;
      if (!run || run.runId !== m.runId) break;
      active = null;
      clearRunTimers(run);
      if (sab) clearInterrupt(sab);
      const status: PyRunStatus = m.ok
        ? 'ok'
        : m.interrupted
          ? run.cancelKind === PyCancelKind.SoftTimeout
            ? 'timeout'
            : run.cancelKind === PyCancelKind.UserCancel
              ? 'cancelled'
              : 'error'
          : 'error';
      // Graceful interrupts print nothing (the harness eats KeyboardInterrupt)
      // — never leave the output panel blank on a non-ok result.
      let output = m.output;
      if (status === 'timeout') {
        output += `${output ? '\n' : ''}Run timed out after ${PY_LIMITS.softTimeoutMs / 1000} s.`;
      } else if (status === 'cancelled') {
        output += `${output ? '\n' : ''}Run cancelled.`;
      }
      post(
        {
          t: 'result',
          runId: m.runId,
          status,
          output,
          durationMs: m.durationMs,
          figures: m.figures,
        } satisfies ResultMsg,
        m.figures.map((f) => f.png),
      );
      const now = performance.now();
      traceAdd('run', run.startedAt, now);
      traceEmit('sup', 'run', {
        runId: m.runId,
        status,
        execMs: Math.round(m.durationMs),
        reqToResultMs: Math.round(now - run.reqAt),
      });
      if (m.needsRespawn) {
        // U6: the FIRST run of a restored generation hard-failing (trap-class
        // — not ok, not an interrupt) implicates the image itself. Delete the
        // snapshot BEFORE the eager respawn — CHAINED (F10), so the respawn's
        // T3 probe awaits the delete instead of racing it (a structurally-
        // valid-but-bad image must not loop restore → crash → restore).
        if (firstRunAfterRestore && !m.ok && !m.interrupted && bootedSetKey) {
          console.warn(`py: ${bootedSetKey} restored generation's first run hard-failed — poisoning snapshot`);
          chainDelete(bootedSetKey);
        }
        // Blit failed/skipped or the heap outgrew the reset image — the NEXT
        // run needs a fresh generation for isolation, and an eager respawn
        // (cached bundles / OPFS snapshot) also reclaims the grown memory now.
        teardownExecutor();
        spawnExecutor(desiredSetKey);
      } else {
        firstRunAfterRestore = false;
        armIdleTeardown();
      }
      break;
    }
    case 'exec-fatal': {
      traceEmit('sup', 'fatal', { ready: executorReady, restored: m.restored, error: m.error.split('\n')[0] });
      if (!executorReady && m.restored && !snapshotRetried) {
        // A restored boot died POST-blit pre-ready (stdlib drift over a
        // poisoned image, finalizeBootstrap failure, mount/harden death…).
        // Drop the artifact (chained — the retry's probe awaits it, F10),
        // retry ONCE cold with the run still pending — a snapshot failure
        // must be invisible to the user. (Pre-blit failures never land here;
        // they fall back cold in-worker via exec-snap-invalid.)
        console.warn('py: restored boot failed post-blit — poisoning snapshot, retrying cold:', m.error.split('\n')[0]);
        if (bootedSetKey) chainDelete(bootedSetKey);
        snapshotRetried = true;
        spawnExecutor(desiredSetKey, { noSnapshot: true });
        break;
      }
      if (firstRunAfterRestore) {
        // Post-ready fatal inside the restored generation's first-run window
        // — same U6 poison rationale as the exec-done leg.
        firstRunAfterRestore = false;
        if (bootedSetKey) chainDelete(bootedSetKey);
      }
      if (active) {
        // Boot failure (executor never became ready) → an eager respawn
        // would just boot a second doomed worker; go dormant instead and
        // let the next click re-attempt.
        const respawn = executorReady;
        // Pyodide's internal indexURL fetches (glue/wasm/stdlib) fail here
        // when offline-uncached — surface the same friendly offline message
        // as the supervisor's own bundle fetches.
        const message =
          !respawn && !navigator.onLine
            ? downloadFailureMessage(new TypeError('offline'), desiredSetKey)
            : `Python runtime failed: ${m.error.split('\n')[0]}`;
        failActiveRun(message, /out of memory|OOM|RangeError/i.test(m.error) ? 'oom' : 'error', respawn);
        if (!respawn) teardownExecutor();
      } else {
        // Boot failed with nothing pending (e.g. eager respawn while
        // artifacts unreachable) — go dormant; the next run re-attempts and
        // its failure then surfaces as that run's result.
        teardownExecutor();
      }
      break;
    }
  }
}

self.onmessage = (e: MessageEvent<MainToSup>) => {
  const m = e.data;
  switch (m.t) {
    case 'run':
      onRun(m);
      break;
    case 'cancel': {
      if (active?.runId === m.runId) {
        if (active.dispatched) {
          beginInterrupt(active, PyCancelKind.UserCancel, PY_LIMITS.cancelGraceMs);
        } else {
          // Not dispatched yet (executor still booting/downloading) — drop it.
          failActiveRun('Cancelled.', 'cancelled', false);
        }
      }
      break;
    }
  }
};

function onRun(m: RunMsg): void {
  if (active) {
    // Manager serializes runs — this is a protocol violation, refuse loudly.
    post({ t: 'sup-fatal', error: `run ${m.runId} while ${active.runId} active` });
    return;
  }
  if (!globalThis.crossOriginIsolated) {
    // No COOP/COEP ⇒ no SharedArrayBuffer ⇒ no interrupt/cancel channel.
    // Refuse with a precise result instead of a constructor throw later.
    post({
      t: 'result',
      runId: m.runId,
      status: 'error',
      output: 'Python runtime unavailable: this context is not cross-origin isolated (COOP/COEP headers missing).',
      durationMs: 0,
      figures: [],
    } satisfies ResultMsg);
    return;
  }
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const reqAt = performance.now();
  active = {
    runId: m.runId,
    code: m.code,
    dispatched: false,
    reqAt,
    startedAt: reqAt,
    softTimer: null,
    hardTimer: null,
    interruptRepeat: null,
    cancelKind: PyCancelKind.None,
  };
  desiredSetKey = m.setKey;
  if (executor && setSatisfies(bootedSetKey, m.setKey)) {
    if (executorReady) dispatch(active);
    else post({ t: 'phase', runId: m.runId, phase: 'booting' });
    // else: boot in flight — exec-ready dispatches the pending run.
    return;
  }
  // Wrong (or no) generation for this set — respawn with the right bundles.
  post({ t: 'phase', runId: m.runId, phase: 'booting' });
  spawnExecutor(m.setKey);
}
