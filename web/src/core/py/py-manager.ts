/**
 * Python run manager — the main-thread API. Owns the supervisor worker, the
 * global FIFO queue (cap 4, single-flight dispatch), the pre-run import gate,
 * and the ONE Y commit per run.
 *
 * SECURITY INVARIANT (never-auto-run): `toggleRunCodeBlock` has exactly four
 * call sites — SelectTool + CodeTool canvas play-button hits, the DOM
 * play-button click, Cmd/Ctrl+Enter in the editor — all local gestures.
 * Nothing observer/sync/hydration-driven may call it; remote output fields
 * render as inert data.
 */

import { getCodeProps } from '@/core/accessors';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getBbox, getHandle, hasActiveRoom, transactPyOutput } from '@/runtime/room-runtime';
import { placeRunFigures } from './py-figures';
import { AVAILABLE_PACKAGES, resolveImports, scanPythonImports, unavailableMessage } from './py-imports';
import { PY_LIMITS, type PyRunStatus, type PySetKey, type SupToMain } from './py-protocol';
import { appendOutput, clearRun, getRunEntry, patchRun, upsertRun } from './py-run-store';

interface QueuedRun {
  runId: number;
  blockId: string;
  code: string;
  setKey: PySetKey;
}

let supervisor: Worker | null = null;
let nextRunId = 1;
const queue: QueuedRun[] = [];
/** The run currently owned by the supervisor (single-flight). */
let inFlight: QueuedRun | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

/** Last 100 relayed py-trace JSON lines (Phase 0 boot/run spans) — the
 * e2e/automation read surface; DevTools gets the same lines via console. */
export const pyTraceLines: string[] = [];
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).__avloPyTraces = pyTraceLines;
}

function invalidateBlock(blockId: string): void {
  // Ticker + supervisor-message paths outlive the room (getBbox throws bare).
  if (!hasActiveRoom()) return;
  const bbox = getBbox(blockId);
  if (bbox) invalidateWorldBBox(bbox);
}

function ensureTicker(): void {
  // Repaints the running block's status text ("Running… 3.2 s") twice a
  // second; stops when nothing is active.
  ticker ??= setInterval(() => {
    if (inFlight) invalidateBlock(inFlight.blockId);
    else if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }, 500);
}

function ensureSupervisor(): Worker {
  if (supervisor) return supervisor;
  supervisor = new Worker(new URL('./py-supervisor.ts', import.meta.url), {
    type: 'module',
  });
  supervisor.onmessage = (e: MessageEvent<SupToMain>) => onSupervisorMessage(e.data);
  supervisor.onerror = (e: ErrorEvent) => resetRuntime(`Python runtime failed: ${e.message}`);
  return supervisor;
}

/** Supervisor state is unrecoverable (worker error / protocol violation) —
 * fail every run and drop the worker; the next click starts clean. */
function resetRuntime(message: string): void {
  const all = inFlight ? [inFlight, ...queue] : [...queue];
  inFlight = null;
  queue.length = 0;
  supervisor?.terminate();
  supervisor = null;
  for (const run of all) finishRun(run, 'error', message);
}

function dispatchNext(): void {
  if (inFlight || queue.length === 0) return;
  const run = queue.shift();
  if (!run) return;
  inFlight = run;
  patchRun(run.blockId, { phase: 'booting' });
  invalidateBlock(run.blockId);
  ensureSupervisor().postMessage({ t: 'run', runId: run.runId, code: run.code, setKey: run.setKey });
  ensureTicker();
}

function finishRun(run: QueuedRun, status: PyRunStatus, output: string): void {
  // Deleted block / left room → drop the commit, never throw.
  if (hasActiveRoom() && getHandle(run.blockId)) {
    transactPyOutput(() => {
      const y = getHandle(run.blockId)?.y;
      if (!y) return;
      y.set('output', output);
      y.set('outputStatus', status);
      y.set('outputVisible', true);
    });
  }
  clearRun(run.blockId);
  invalidateBlock(run.blockId);
}

function onSupervisorMessage(m: SupToMain): void {
  switch (m.t) {
    case 'trace': {
      // biome-ignore lint/suspicious/noConsole: THE visible py:trace line — always-on by design (redesign P0)
      console.info('py:trace', m.line);
      pyTraceLines.push(m.line);
      if (pyTraceLines.length > 100) pyTraceLines.shift();
      break;
    }
    case 'phase': {
      if (inFlight?.runId !== m.runId) break;
      patchRun(inFlight.blockId, {
        phase: m.phase,
        received: m.received,
        total: m.total,
        // "Running… N s" counts execution, not queue/boot/download time —
        // restart the clock when the run actually dispatches.
        ...(m.phase === 'running' ? { startedAt: performance.now() } : null),
      });
      invalidateBlock(inFlight.blockId);
      break;
    }
    case 'stdout': {
      if (inFlight?.runId === m.runId) appendOutput(inFlight.blockId, m.chunk);
      break;
    }
    case 'result': {
      if (inFlight?.runId !== m.runId) break;
      const run = inFlight;
      inFlight = null;
      finishRun(run, m.status, m.output);
      placeRunFigures(run.blockId, run.runId, m.figures);
      dispatchNext();
      break;
    }
    case 'sup-fatal': {
      // The supervisor's active-run bookkeeping never clears on this path —
      // dispatching into it again would wedge every subsequent run. Full
      // reset, same as onerror.
      resetRuntime(`Python runtime failed: ${m.error}`);
      break;
    }
  }
}

/** Is this block runnable at all (v1: python only)? */
export function isRunnableCodeBlock(blockId: string): boolean {
  const y = getHandle(blockId)?.y;
  if (!y) return false;
  return getCodeProps(y)?.language === 'python';
}

/**
 * THE run/cancel toggle — see the never-auto-run invariant above.
 * Click on idle block = run; on queued block = dequeue; on running = cancel.
 */
export function toggleRunCodeBlock(blockId: string): void {
  const existing = getRunEntry(blockId);
  if (existing) {
    cancelRun(blockId);
    return;
  }
  const y = getHandle(blockId)?.y;
  const props = y ? getCodeProps(y) : null;
  if (props?.language !== 'python') return;

  const code = props.content.toString(); // snapshot at click time
  const { setKey, missing } = resolveImports(scanPythonImports(code), AVAILABLE_PACKAGES);
  if (missing.length > 0) {
    // Pre-run refusal: one commit, zero downloads, zero boots.
    transactPyOutput(() => {
      y?.set('output', unavailableMessage(missing));
      y?.set('outputStatus', 'unavailable');
      y?.set('outputVisible', true);
    });
    return;
  }
  if (queue.length + (inFlight ? 1 : 0) >= PY_LIMITS.queueCap) return;

  const run: QueuedRun = { runId: nextRunId++, blockId, code, setKey };
  queue.push(run);
  upsertRun(blockId, {
    runId: run.runId,
    phase: 'queued',
    liveOutput: '',
    startedAt: performance.now(),
  });
  invalidateBlock(blockId);
  dispatchNext();
}

export function cancelRun(blockId: string): void {
  const entry = getRunEntry(blockId);
  if (!entry) return;
  if (inFlight?.blockId === blockId) {
    ensureSupervisor().postMessage({ t: 'cancel', runId: inFlight.runId });
    return; // supervisor resolves it (interrupt → grace → kill)
  }
  const i = queue.findIndex((q) => q.blockId === blockId);
  if (i >= 0) queue.splice(i, 1);
  clearRun(blockId);
  invalidateBlock(blockId);
}
