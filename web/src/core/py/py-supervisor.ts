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
 *   is refused, same rule as the stdlib-zip hash guard in the spike.
 * - Verified tar bytes persist in the Cache API (`avlo-py-<buildHash>`,
 *   shared with the SW's cache-first route — this is the offline path); each
 *   boot gets the fetched/matched buffers TRANSFERRED outright (no resident
 *   copy — the old ~38 MB in-memory 'all' cache is gone). Cache hits are
 *   re-verified against the lock: the SW route writes this cache unverified.
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
 * Snapshot discipline (P3):
 * - stdlib boots restore the prebuilt `baseline.snap` (lock-verified, Cache
 *   API — tar posture); package-set boots restore the set's OPFS snapshot
 *   (generated client-side on first use, sha-sealed + buildHash-bound wrapper,
 *   zero bundle fetches on hit) or generate one (baseline restore + mounts +
 *   capture riding the boot). Snapshots ACCELERATE, never gate: any
 *   fetch/verify/restore failure lands on the cold path, and a snapshot-fed
 *   boot that dies pre-ready deletes its artifact and retries cold ONCE with
 *   the run still pending.
 *
 * Single-flight: main's manager serializes runs; at most one run is active or
 * pending here at any time.
 */

import { PY_ORIGIN } from '@avlo/api-client';
import { BUILD_LOCK, matchesLockEntry } from '@avlo/py-loader';
import {
  type ExecToSup,
  type MainToSup,
  PY_LIMITS,
  type PyBundlePayload,
  type PyRunStatus,
  type PySetKey,
  type ResultMsg,
  type RunMsg,
} from './py-protocol';
import { allocPySab, clearInterrupt, EPOCH, PyCancelKind, type PySabViews, writeInterrupt } from './py-sab';
import { deleteSetSnapshot, type PackedTree, readSetSnapshot, writeSetSnapshot } from './py-snapshot';
import { SET_BUNDLES } from './py-stdlib-modules.gen';
import { setTraceSink, traceAdd, traceEmit, traceReset, traceSpanAsync } from './py-trace';

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
/** Guards overlapping async spawns; only the latest token may proceed. */
let spawnToken = 0;
/** What the CURRENT generation booted from — routes the poison path when a
 * snapshot-fed boot dies pre-ready ('stacked' → drop the OPFS wrapper,
 * 'baseline' → drop its Cache API entry). */
let bootSnapshotKind: 'stacked' | 'baseline' | null = null;
/** The set whose snapshot fed the current boot (poison-delete target). */
let bootSnapshotSetKey: PySetKey | null = null;
/** One cold retry per failure — a second pre-ready fatal surfaces normally. */
let snapshotRetried = false;
/** Human label for the CURRENT generation's boot path — logged with bootMs on
 * exec-ready (the snapshot-used / cold-boot signal). Set in spawnExecutor. */
let bootDescription = '';
/** When the boot message was posted — exec-ready closes the 'boot-wait' span
 * (executor worker spin-up + boot; the delta vs bootMs is spin-up cost). */
let bootPostedAt = 0;

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

setTraceSink((line) => post({ t: 'trace', line }));

const bundlesOf = (setKey: PySetKey): readonly string[] => (setKey === 'stdlib' ? [] : SET_BUNDLES[setKey]);

/** Does the booted generation's bundle set cover the run's needs? */
function setSatisfies(booted: PySetKey | null, need: PySetKey): boolean {
  if (booted === null) return false;
  const have = bundlesOf(booted);
  return bundlesOf(need).every((b) => have.includes(b));
}

/** Every path from a tar meta may only address INTO its mount root. */
const safePathSegs = (p: string): boolean => p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

/** meta.json is the FIRST ustar entry by construction (pack-package D2).
 * The tar is sha-pinned by the manifest before this runs; the path checks
 * guard the remaining trust link — a bad meta minted by the BUILD side would
 * otherwise steer MEMFS extraction/dlopen outside the mount root. */
function parseTarMeta(bytes: Uint8Array): { prefix: string; loadOrder: readonly string[] } {
  const ascii = (from: number, to: number) => new TextDecoder().decode(bytes.subarray(from, to)).replace(/\0.*$/s, '');
  if (ascii(0, 100) !== 'meta.json') throw new Error('bundle tar: first entry is not meta.json');
  const size = Number.parseInt(ascii(124, 136), 8);
  if (!Number.isInteger(size) || size <= 0 || size > 65_536) throw new Error('bundle tar: implausible meta.json size');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(512, 512 + size))) as {
    prefix?: unknown;
    loadOrder?: unknown;
  };
  const { prefix, loadOrder } = meta;
  if (typeof prefix !== 'string' || !prefix.startsWith('/') || !safePathSegs(prefix.slice(1))) {
    throw new Error(`bundle tar: unsafe prefix ${JSON.stringify(prefix)}`);
  }
  if (!Array.isArray(loadOrder) || !loadOrder.every((s): s is string => typeof s === 'string' && safePathSegs(s))) {
    throw new Error('bundle tar: unsafe loadOrder');
  }
  return { prefix, loadOrder: Object.freeze([...loadOrder]) };
}

/** Ensure every bundle of the set is present + lock-verified, posting download
 * progress for the pending run. Returns boot payloads in deps-first order —
 * buffers are handed to the caller outright (transferred to the executor;
 * persistence is the Cache API, not supervisor memory).
 *
 * Cache API over memory: works in a dedicated worker without a SW (THE offline
 * path for tars) and shares URL keys with the SW's cache-first route. Hits are
 * RE-VERIFIED against the lock — the SW route caches whatever the network
 * returned, and a poisoned/stale entry must not reach a mount. `res.body`
 * yields DECODED bytes, so counts + shas run over identity bytes even when the
 * worker served `.br`. */
async function ensureBundles(setKey: PySetKey): Promise<PyBundlePayload[]> {
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
    if (!(await matchesLockEntry(bytes.buffer, expected))) {
      // Unverified SW put (or a stale generation) — drop and refetch below.
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
    if (active && !active.dispatched) {
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
      // to the executor afterwards.
      await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/x-tar' } }));
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

/** Fetch + lock-verify the prebuilt baseline snapshot. Cache API persistent
 * (tar posture: the SW streams `.snap` cacheFirst UNVERIFIED — this check is
 * the integrity leg; hits are re-verified for the same reason). Returns null
 * when the lock carries no baseline entry, on any fetch/verify failure, or
 * offline-uncached: snapshots accelerate boots, they never brick them. */
async function ensureBaseline(): Promise<ArrayBuffer | null> {
  const expected = BUILD_LOCK.artifacts['baseline.snap'];
  if (!expected) return null;
  const url = `${ARTIFACT_BASE}baseline.snap`;
  try {
    const cache = await caches.open(PY_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const bytes = await hit.arrayBuffer();
      if (await matchesLockEntry(bytes, expected)) return bytes;
      await cache.delete(url);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`baseline.snap: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    if (!(await matchesLockEntry(bytes, expected))) {
      throw new Error('baseline.snap drifted from the committed build-lock');
    }
    // Fresh Response copies the buffer per spec — safe to transfer afterwards.
    await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    return bytes;
  } catch (err) {
    console.warn('py: baseline snapshot unavailable (cold boot) —', err);
    return null;
  }
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
 * dead worker left assigned would wedge the next run. */
function teardownExecutor(): void {
  executor?.terminate();
  executor = null;
  executorReady = false;
  sab = null;
  bootedSetKey = null;
  bootSnapshotKind = null;
  bootSnapshotSetKey = null;
}

function armIdleTeardown(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (active === null) teardownExecutor(); // respawn restores from OPFS/baseline in ~0.5 s
  }, PY_LIMITS.idleTeardownMs);
}

/** Redesign P1: snapshot machinery is PARKED until P2's build-side owned
 * snapshots land — every boot is a cold mount boot. The fork's snapshot
 * patches (0005/0007/0008b + emsdk dsoBaseHook) are parked too, so flipping
 * this back on would run the 0.29-era capture path against a fork that no
 * longer records DSO bases: don't. P2 replaces this whole branch. */
const SNAPSHOTS_ENABLED = false;

async function spawnExecutor(setKey: PySetKey, opts?: { noSnapshot?: boolean }): Promise<void> {
  const token = ++spawnToken;
  executor?.terminate();
  executor = null;
  executorReady = false;
  bootedSetKey = null;
  bootSnapshotKind = null;
  bootSnapshotSetKey = null;
  traceReset();
  const spawnStart = performance.now();
  const useSnapshot = SNAPSHOTS_ENABLED && !opts?.noSnapshot;
  let payloads: PyBundlePayload[] = [];
  let snapshot: ArrayBuffer | undefined;
  let tree: PackedTree | undefined;
  let capture = false;
  try {
    // Independent I/O chains (glue trio hash vs snapshot/tar reads) — overlap
    // them on the cold first spawn (ensureGlueVerified memoizes on success).
    if (setKey === 'stdlib') {
      // The baseline IS the stdlib set's snapshot — no OPFS entry, no bundles.
      const [, baseline] = await Promise.all([
        traceSpanAsync('glue-preflight', ensureGlueVerified),
        useSnapshot ? traceSpanAsync('baseline', ensureBaseline) : null,
      ]);
      snapshot = baseline ?? undefined;
    } else {
      const [, held] = await Promise.all([
        traceSpanAsync('glue-preflight', ensureGlueVerified),
        useSnapshot ? traceSpanAsync('snapshot-read', () => readSetSnapshot(BUILD_LOCK.buildHash, setKey)) : null,
      ]);
      if (held) {
        // OPFS hit — the wrapper carries site-packages (DSO bytes + mtimes),
        // so the boot needs ZERO bundle fetches: the offline win.
        snapshot = held.container;
        tree = held.tree;
      } else {
        // Generation: baseline restore + mounts + capture riding the boot.
        // Baseline null (offline/unshipped) still generates — cold + capture.
        const [baseline, fetched] = await Promise.all([
          useSnapshot ? traceSpanAsync('baseline', ensureBaseline) : null,
          traceSpanAsync('bundles', () => ensureBundles(setKey)),
        ]);
        payloads = fetched;
        snapshot = baseline ?? undefined;
        capture = useSnapshot;
      }
    }
  } catch (err) {
    if (token !== spawnToken) return;
    // Download/verify failure: surface as the pending run's result (or stay
    // dormant); the next click re-attempts.
    if (active) failActiveRun(downloadFailureMessage(err, setKey), 'error', false);
    return;
  }
  if (token !== spawnToken) return; // superseded by a newer spawn
  sab = allocPySab(); // never reuse across generations
  epoch += 1;
  Atomics.store(sab.i32, EPOCH, epoch);
  executor = new Worker(new URL('./py-executor.ts', import.meta.url), {
    type: 'module',
  });
  executor.onmessage = (e: MessageEvent<ExecToSup>) => onExecutorMessage(e.data);
  executor.onerror = (e: ErrorEvent) => {
    if (active) failActiveRun(`executor error: ${e.message}`, /out of memory|OOM/i.test(e.message) ? 'oom' : 'error');
    else teardownExecutor(); // dormant executor broke — never leave it assigned
  };
  if (snapshot && active && !active.dispatched) {
    post({ t: 'phase', runId: active.runId, phase: 'restoring' });
  }
  // Boot message carries the LOCK's stdlib zip hash — the executor verifies its
  // MEMFS mount against it (restage ⇒ recapture, the spike's standing guard).
  // Buffers transfer outright: persistence is the Cache API / OPFS, not this heap.
  const transfer: Transferable[] = payloads.map((p) => p.bytes);
  if (snapshot) transfer.push(snapshot);
  if (tree) transfer.push(tree.blob);
  executor.postMessage(
    {
      t: 'boot',
      artifactBase: ARTIFACT_BASE,
      sab: sab.sab,
      stdlibSha256: BUILD_LOCK.artifacts['python_stdlib.zip'].sha256,
      bundles: payloads,
      snapshot,
      tree,
      ...(capture ? { capture: true, captureKey: setKey } : {}),
    },
    transfer,
  );
  bootedSetKey = setKey;
  bootSnapshotKind = tree ? 'stacked' : snapshot ? 'baseline' : null;
  bootSnapshotSetKey = snapshot ? setKey : null;
  bootDescription = tree
    ? 'restored OPFS set snapshot (stacked, zero bundle fetches)'
    : capture
      ? snapshot
        ? 'generating set snapshot on a baseline restore'
        : 'generating set snapshot cold (no baseline)'
      : snapshot
        ? 'restored baseline snapshot'
        : 'cold boot (no snapshot)';
  // 'spawn' = the pre-spawn critical path (everything before the executor
  // even exists); 'boot-wait' (closed on exec-ready) − executor bootMs =
  // worker spin-up + message latency.
  bootPostedAt = performance.now();
  traceAdd('spawn', spawnStart, bootPostedAt, { setKey, snapshot: !!snapshot, stacked: !!tree, capture });
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
  if (respawn) void spawnExecutor(desiredSetKey);
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
      // run, and a forged capture must never reach persistent storage.
      // Persistence overlaps the pending run (fire-and-forget; best-effort).
      if (!executorReady) void writeSetSnapshot(BUILD_LOCK.buildHash, m.captureKey, m.container, m.tree);
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
        // Blit failed/skipped or the heap outgrew the reset image — the NEXT
        // run needs a fresh generation for isolation, and an eager respawn
        // (cached bundles / OPFS snapshot) also reclaims the grown memory now.
        teardownExecutor();
        void spawnExecutor(desiredSetKey);
      } else {
        armIdleTeardown();
      }
      break;
    }
    case 'exec-fatal': {
      traceEmit('sup', 'fatal', { ready: executorReady, error: m.error.split('\n')[0] });
      if (!executorReady && bootSnapshotKind !== null && !snapshotRetried) {
        // A snapshot-fed boot died pre-ready (BUILD_ID gate, DSO table drift,
        // hook replay error, stdlib drift over a poisoned image…). Drop the
        // artifact, retry ONCE cold with the run still pending — a snapshot
        // failure must be invisible to the user.
        console.warn(`py: ${bootSnapshotKind} snapshot boot failed — retrying cold:`, m.error.split('\n')[0]);
        if (bootSnapshotKind === 'stacked' && bootSnapshotSetKey) {
          void deleteSetSnapshot(BUILD_LOCK.buildHash, bootSnapshotSetKey);
        } else {
          void caches.open(PY_CACHE).then((c) => c.delete(`${ARTIFACT_BASE}baseline.snap`));
        }
        snapshotRetried = true;
        void spawnExecutor(desiredSetKey, { noSnapshot: true });
        break;
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
  void spawnExecutor(m.setKey);
}

post({ t: 'sup-ready' });
