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

import { HARNESS_INSTALL, RUN_INVOKE } from './py-harness';
import { bootPyodide, type Pyodide } from './py-loader';
import { type ExecBootMsg, type ExecRunMsg, OUTPUT_TRUNCATION_MARKER, PY_LIMITS, type SupToExec } from './py-protocol';
import { HEARTBEAT, MEM_BYTES, mapPySab, PyExecState, type PySabViews, RUN_ID, STATE } from './py-sab';

let pyodide: Pyodide = null;
let sab: PySabViews | null = null;
let currentRunId = 0;

/** Combined stdout+stderr for the CURRENT run. */
let outBuf = '';
let outTruncated = false;
let relayedUpTo = 0;
let lastFlushAt = 0;
const stdoutDecoder = new TextDecoder();
const stderrDecoder = new TextDecoder();

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
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

function makeWriteHook(decoder: TextDecoder) {
  return (buf: Uint8Array): number => {
    appendOutput(decoder.decode(buf, { stream: true }));
    return buf.length;
  };
}

async function boot(m: ExecBootMsg): Promise<void> {
  sab = mapPySab(m.sab);
  const t0 = performance.now();
  try {
    pyodide = await bootPyodide({ artifactBase: m.artifactBase, snapshot: m.snapshot });
  } catch (err) {
    post({ t: 'exec-fatal', error: String((err as Error)?.stack ?? err) });
    return;
  }
  pyodide.setInterruptBuffer(sab.u8);
  pyodide.setStdout({ write: makeWriteHook(stdoutDecoder), isatty: false });
  pyodide.setStderr({ write: makeWriteHook(stderrDecoder), isatty: false });
  pyodide.runPython(HARNESS_INSTALL);
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
  Atomics.store(sab.i32, RUN_ID, m.runId);
  Atomics.store(sab.i32, STATE, PyExecState.Running);
  const t0 = performance.now();
  let ok = false;
  let interrupted = false;
  try {
    pyodide.globals.set('_avlo_code', m.code); // string → by value, no proxy
    const res = JSON.parse(pyodide.runPython(RUN_INVOKE) as string) as {
      ok: boolean;
      interrupted: boolean;
    };
    ok = res.ok;
    interrupted = res.interrupted;
  } catch (err) {
    // Harness-level failure (or KeyboardInterrupt landing outside user code —
    // e.g. during compile): surface as the run's error output.
    interrupted = /KeyboardInterrupt/.test(String(err));
    appendOutput(interrupted ? 'KeyboardInterrupt\n' : `${String((err as Error)?.message ?? err)}\n`);
  }
  flushRelay();
  Atomics.store(sab.i32, MEM_BYTES, pyodide._module?.HEAP8?.length ?? 0);
  Atomics.store(sab.i32, RUN_ID, 0);
  Atomics.store(sab.i32, STATE, PyExecState.Idle);
  Atomics.add(sab.i32, HEARTBEAT, 1);
  post({
    t: 'exec-done',
    runId: m.runId,
    ok,
    interrupted,
    output: outBuf,
    durationMs: performance.now() - t0,
    figures: [],
  });
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
