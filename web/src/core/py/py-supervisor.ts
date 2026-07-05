/**
 * Python SUPERVISOR worker — the always-live control plane. Spawns/terminates
 * the nested executor (so `terminate()` works and teardown cascades), owns
 * every wall clock (soft/hard timeouts, cancel grace, idle teardown — the
 * executor can't service timers mid-run), and relays results to main.
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

import { type ExecToSup, type MainToSup, PY_LIMITS, type PyRunStatus, type ResultMsg, type RunMsg } from './py-protocol';
import { allocPySab, clearInterrupt, EPOCH, PyCancelKind, type PySabViews, writeInterrupt } from './py-sab';

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

let executor: Worker | null = null;
let executorReady = false;
let sab: PySabViews | null = null;
let epoch = 0;
let active: ActiveRun | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function clearRunTimers(run: ActiveRun): void {
  if (run.softTimer !== null) clearTimeout(run.softTimer);
  if (run.hardTimer !== null) clearTimeout(run.hardTimer);
  if (run.interruptRepeat !== null) clearInterval(run.interruptRepeat);
  run.softTimer = run.hardTimer = run.interruptRepeat = null;
}

function armIdleTeardown(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (active === null && executor !== null) {
      executor.terminate();
      executor = null;
      executorReady = false;
      sab = null; // heap + RAM freed; respawn is cheap (snapshots at P3)
    }
  }, PY_LIMITS.idleTeardownMs);
}

function spawnExecutor(): void {
  executor?.terminate();
  executorReady = false;
  sab = allocPySab(); // never reuse across generations
  epoch += 1;
  Atomics.store(sab.i32, EPOCH, epoch);
  executor = new Worker(new URL('./py-executor.ts', import.meta.url), {
    type: 'module',
  });
  executor.onmessage = (e: MessageEvent<ExecToSup>) => onExecutorMessage(e.data);
  executor.onerror = (e: ErrorEvent) =>
    failActiveRun(`executor error: ${e.message}`, /out of memory|OOM/i.test(e.message) ? 'oom' : 'error');
  executor.postMessage({ t: 'boot', artifactBase: ARTIFACT_BASE, sab: sab.sab });
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
  if (respawn) spawnExecutor(); // eager: next click lands on a warm worker
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
        failActiveRun(`Python runtime failed: ${m.error.split('\n')[0]}`, /out of memory|OOM|RangeError/i.test(m.error) ? 'oom' : 'error');
      } else {
        // Boot failed with nothing pending (e.g. eager respawn while
        // artifacts unreachable) — go dormant; the next run re-attempts and
        // its failure then surfaces as that run's result.
        executor?.terminate();
        executor = null;
        executorReady = false;
        sab = null;
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
          // Not dispatched yet (executor still booting) — drop it.
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
  if (executor && executorReady) {
    dispatch(active);
  } else {
    post({ t: 'phase', runId: m.runId, phase: 'booting' });
    if (!executor) spawnExecutor();
    // else: boot in flight — exec-ready dispatches the pending run.
  }
}

post({ t: 'sup-ready' });
