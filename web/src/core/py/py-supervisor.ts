/**
 * Python SUPERVISOR worker — the always-live control plane. Spawns/terminates
 * the nested executor (so `terminate()` works and teardown cascades), owns
 * every wall clock (soft/hard timeouts, cancel grace, idle teardown — the
 * executor can't service timers mid-run), fetches + sha-verifies package
 * bundles (the executor NEVER fetches; bundle bytes ride postMessage), and
 * relays results to main.
 *
 * Bundle discipline (M2):
 * - The dev manifest (staged by py-build stage.mjs) is the source of truth
 *   for bundle hashes + set membership; every fetched tar is verified against
 *   it before use — a stale mix of artifacts is refused, same rule as the
 *   stdlib-zip hash guard in the spike.
 * - Verified tar bytes are CACHED in supervisor memory across executor
 *   generations; each boot gets transferred COPIES (originals stay).
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
 * Single-flight: main's manager serializes runs; at most one run is active or
 * pending here at any time.
 */

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
import { SET_BUNDLES } from './py-stdlib-modules.gen';

// Dev default; P2 swaps to the py-loader build-lock origin.
const ARTIFACT_BASE = '/py-dev/fork/';

interface ActiveRun {
  runId: number;
  code: string;
  dispatched: boolean;
  startedAt: number;
  softTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  interruptRepeat: ReturnType<typeof setInterval> | null;
  cancelKind: PyCancelKind;
}

interface ManifestEntry {
  sha256: string;
  size: number;
}
interface DevManifest {
  sets: Record<string, string[]>;
  artifacts: Record<string, ManifestEntry>;
  bundles: Record<string, ManifestEntry>;
}

/** Verified tar bytes + the parsed mount recipe (512-byte meta header). */
interface CachedBundle {
  bytes: ArrayBuffer;
  prefix: string;
  loadOrder: readonly string[];
}

let executor: Worker | null = null;
let executorReady = false;
let sab: PySabViews | null = null;
let epoch = 0;
let active: ActiveRun | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

let manifest: DevManifest | null = null;
const bundleCache = new Map<string, CachedBundle>();
/** Set the CURRENT executor generation booted with (null = none). */
let bootedSetKey: PySetKey | null = null;
/** Last requested set — eager respawns reuse it (cache makes them free). */
let desiredSetKey: PySetKey = 'stdlib';
/** Guards overlapping async spawns; only the latest token may proceed. */
let spawnToken = 0;

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

const bundlesOf = (setKey: PySetKey): readonly string[] => (setKey === 'stdlib' ? [] : (SET_BUNDLES[setKey] ?? []));

/** Does the booted generation's bundle set cover the run's needs? */
function setSatisfies(booted: PySetKey | null, need: PySetKey): boolean {
  if (booted === null) return false;
  const have = bundlesOf(booted);
  return bundlesOf(need).every((b) => have.includes(b));
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
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

const HEX64 = /^[0-9a-f]{64}$/;

/** Shape-check what we consume from the fetched manifest, then deep-freeze it
 * — every hash and size downstream verification trusts becomes immutable the
 * moment it enters the supervisor. */
function validateManifest(m: DevManifest): DevManifest {
  const entryOk = (e: ManifestEntry | undefined): e is ManifestEntry =>
    !!e && HEX64.test(e.sha256) && Number.isInteger(e.size) && e.size > 0;
  if (!entryOk(m.artifacts?.['python_stdlib.zip'])) throw new Error('manifest: missing/invalid python_stdlib.zip entry');
  for (const [name, e] of Object.entries(m.bundles ?? {})) {
    if (!entryOk(e)) throw new Error(`manifest: invalid bundle entry ${name}`);
  }
  for (const e of Object.values(m.artifacts)) Object.freeze(e);
  for (const e of Object.values(m.bundles)) Object.freeze(e);
  Object.freeze(m.artifacts);
  Object.freeze(m.bundles);
  Object.freeze(m.sets);
  return Object.freeze(m);
}

async function ensureManifest(): Promise<DevManifest> {
  if (manifest) return manifest;
  const res = await fetch(`${ARTIFACT_BASE}manifest.json`);
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  manifest = validateManifest((await res.json()) as DevManifest);
  return manifest;
}

/** Fetch + verify every uncached bundle of the set, posting download
 * progress for the pending run. Returns the set's cached entries in
 * deps-first order. */
async function ensureBundles(setKey: PySetKey): Promise<CachedBundle[]> {
  const names = bundlesOf(setKey);
  if (names.length === 0) return [];
  const m = await ensureManifest();
  const toFetch = names.filter((n) => !bundleCache.has(n));
  const total = toFetch.reduce((n, b) => n + (m.bundles[b]?.size ?? 0), 0);
  let received = 0;
  const progress = () => {
    if (active && !active.dispatched) {
      post({ t: 'phase', runId: active.runId, phase: 'downloading', received, total });
    }
  };
  progress();
  for (const name of toFetch) {
    const expected = m.bundles[name];
    if (!expected) throw new Error(`bundle ${name} not in manifest`);
    const res = await fetch(`${ARTIFACT_BASE}bundles/${name}.tar`);
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
        throw new Error(`${name}.tar exceeds manifest size (${expected.size} B) — staged artifacts drifted, re-run stage.mjs`);
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
    const sha = await sha256Hex(bytes.buffer);
    if (sha !== expected.sha256) {
      throw new Error(`${name}.tar sha256 mismatch — staged artifacts drifted, re-run stage.mjs`);
    }
    const meta = parseTarMeta(bytes);
    bundleCache.set(name, Object.freeze({ bytes: bytes.buffer, prefix: meta.prefix, loadOrder: meta.loadOrder }));
  }
  return names.map((n) => bundleCache.get(n) as CachedBundle);
}

function clearRunTimers(run: ActiveRun): void {
  if (run.softTimer !== null) clearTimeout(run.softTimer);
  if (run.hardTimer !== null) clearTimeout(run.hardTimer);
  if (run.interruptRepeat !== null) clearInterval(run.interruptRepeat);
  run.softTimer = run.hardTimer = run.interruptRepeat = null;
}

/** Terminate + null the executor generation (heap + RAM freed; the bundle
 * cache SURVIVES — respawns re-mount from memory). Safe when already
 * dormant. Used for idle teardown AND broken-executor paths — a dead worker
 * left assigned would wedge the next run. */
function teardownExecutor(): void {
  executor?.terminate();
  executor = null;
  executorReady = false;
  sab = null;
  bootedSetKey = null;
}

function armIdleTeardown(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (active === null) teardownExecutor(); // respawn is cheap (snapshots at P3)
  }, PY_LIMITS.idleTeardownMs);
}

async function spawnExecutor(setKey: PySetKey): Promise<void> {
  const token = ++spawnToken;
  executor?.terminate();
  executor = null;
  executorReady = false;
  bootedSetKey = null;
  let bundles: CachedBundle[];
  let stdlibSha256: string;
  try {
    // Manifest is required for EVERY spawn (not just bundle sets) — the boot
    // message carries the stdlib zip hash the executor verifies its MEMFS
    // mount against (restage ⇒ recapture, the spike's standing guard).
    stdlibSha256 = (await ensureManifest()).artifacts['python_stdlib.zip'].sha256;
    bundles = await ensureBundles(setKey);
  } catch (err) {
    if (token !== spawnToken) return;
    // Download/verify failure: surface as the pending run's result (or stay
    // dormant); the next click re-attempts.
    if (active) failActiveRun(`Python runtime download failed: ${String((err as Error)?.message ?? err)}`, 'error', false);
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
  const names = bundlesOf(setKey);
  // COPIES transfer to the executor; the cache keeps the originals.
  const payloads: PyBundlePayload[] = bundles.map((b, i) => ({
    name: names[i],
    prefix: b.prefix,
    loadOrder: b.loadOrder,
    bytes: b.bytes.slice(0),
  }));
  executor.postMessage(
    { t: 'boot', artifactBase: ARTIFACT_BASE, sab: sab.sab, stdlibSha256, bundles: payloads },
    payloads.map((p) => p.bytes),
  );
  bootedSetKey = setKey;
}

function dispatch(run: ActiveRun): void {
  if (!executor || !sab) return;
  run.dispatched = true;
  run.startedAt = performance.now();
  clearInterrupt(sab);
  executor.postMessage({ t: 'exec', runId: run.runId, code: run.code });
  post({ t: 'phase', runId: run.runId, phase: 'running' });
  run.softTimer = setTimeout(() => {
    run.softTimer = null;
    beginInterrupt(run, PyCancelKind.SoftTimeout, PY_LIMITS.hardGraceMs);
  }, PY_LIMITS.softTimeoutMs);
}

/** Write SIGINT now, keep re-writing until the run resolves, hard-kill after
 * the grace window if Python never surfaces the interrupt. */
function beginInterrupt(run: ActiveRun, kind: PyCancelKind, graceMs: number): void {
  if (!sab || run !== active) return;
  run.cancelKind = kind;
  post({ t: 'phase', runId: run.runId, phase: 'cancelling' });
  const views = sab;
  writeInterrupt(views, kind);
  run.interruptRepeat ??= setInterval(() => writeInterrupt(views, kind), PY_LIMITS.interruptRepeatMs);
  run.hardTimer ??= setTimeout(() => {
    run.hardTimer = null;
    failActiveRun(
      kind === PyCancelKind.UserCancel ? 'Cancelled (forced stop).' : 'Timed out (forced stop).',
      kind === PyCancelKind.UserCancel ? 'cancelled' : 'timeout',
      /* respawn */ true,
    );
  }, graceMs);
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
  // Eager respawn reuses the last set's CACHED bundles — next click lands on
  // a warm worker with the same mounts.
  if (respawn) void spawnExecutor(desiredSetKey);
  armIdleTeardown();
}

function onExecutorMessage(m: ExecToSup): void {
  switch (m.t) {
    case 'exec-ready': {
      executorReady = true;
      if (active && !active.dispatched) dispatch(active);
      else armIdleTeardown();
      break;
    }
    case 'exec-stdout': {
      if (active?.runId === m.runId) post({ t: 'stdout', runId: m.runId, chunk: m.chunk });
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
      post({
        t: 'result',
        runId: m.runId,
        status,
        output,
        durationMs: m.durationMs,
        figures: m.figures,
      } satisfies ResultMsg);
      armIdleTeardown();
      break;
    }
    case 'exec-fatal': {
      if (active) {
        // Boot failure (executor never became ready) → an eager respawn
        // would just boot a second doomed worker; go dormant instead and
        // let the next click re-attempt.
        const respawn = executorReady;
        failActiveRun(
          `Python runtime failed: ${m.error.split('\n')[0]}`,
          /out of memory|OOM|RangeError/i.test(m.error) ? 'oom' : 'error',
          respawn,
        );
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
  active = {
    runId: m.runId,
    code: m.code,
    dispatched: false,
    startedAt: performance.now(),
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
