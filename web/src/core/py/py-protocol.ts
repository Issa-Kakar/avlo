/**
 * Python runtime message protocol — the single source of truth for every
 * main ↔ supervisor ↔ executor exchange. Plain discriminated unions over
 * structured-cloneable data; bulk payloads ride transferables.
 *
 * Channel map (see core/py/CLAUDE.md):
 *   main ⇄ supervisor : postMessage (the MainToSup / SupToMain unions)
 *   supervisor ⇄ executor : postMessage (SupToExec / ExecToSup) + one 64 B PY_SAB
 *     (py-sab.ts) for interrupt/state/heartbeat — writable while the
 *     executor's event loop is blocked in synchronous Python.
 */

import type { PackedTree } from './py-snapshot';

/** Mirrors the code block's Y `outputStatus` field — renderer drives tint. */
export type PyRunStatus = 'ok' | 'error' | 'cancelled' | 'timeout' | 'unavailable' | 'oom';

/** Package-set key: which bundles a run needs (P1 ships stdlib-only).
 * MUST mirror build.config.json `sets` keys — the gen.ts cast in
 * py-imports.ts (SET_KEYS_BY_SIZE) silently lies if this union lags. */
export type PySetKey = 'stdlib' | 'sqlite3' | 'numpy' | 'numpy+pandas' | 'numpy+matplotlib' | 'all';

/** Live phase for the run store / play-button UI (never written to Y). */
export type PyRunPhase = 'queued' | 'booting' | 'downloading' | 'restoring' | 'running' | 'cancelling';

export interface PyFigure {
  /** PNG bytes — transferred, then ingested through the image pipeline. */
  png: ArrayBuffer;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- main → sup

export interface RunMsg {
  t: 'run';
  runId: number;
  code: string;
  setKey: PySetKey;
}
export interface CancelMsg {
  t: 'cancel';
  runId: number;
}
/** Idle-teardown veto/ping and future config live here as needed. */
export type MainToSup = RunMsg | CancelMsg;

// ---------------------------------------------------------------- sup → main

export interface SupReadyMsg {
  t: 'sup-ready';
}
export interface PhaseMsg {
  t: 'phase';
  runId: number;
  phase: PyRunPhase;
  /** e.g. download progress: receivedBytes/totalBytes. */
  received?: number;
  total?: number;
}
/** Batched stdout+stderr (≥100 ms / ≥8 KB) — DOM overlay live view only. */
export interface StdoutMsg {
  t: 'stdout';
  runId: number;
  chunk: string;
}
export interface ResultMsg {
  t: 'result';
  runId: number;
  status: PyRunStatus;
  /** Final combined output, already capped + truncation-marked (harness). */
  output: string;
  durationMs: number;
  figures: PyFigure[];
}
export interface SupFatalMsg {
  t: 'sup-fatal';
  error: string;
}
export type SupToMain = SupReadyMsg | PhaseMsg | StdoutMsg | ResultMsg | SupFatalMsg;

// ---------------------------------------------------------------- sup → exec

/** One package bundle to mount at boot — bytes are a deterministic ustar
 * (meta.json first) fetched + sha-verified by the SUPERVISOR; the executor
 * never fetches. `loadOrder` is the tar meta's canonical DSO order; the
 * ARRAY order across bundles is the set's deps-first mount order. */
export interface PyBundlePayload {
  name: string;
  /** Extraction root (site-packages) — from the tar meta. */
  prefix: string;
  loadOrder: readonly string[];
  /** Transferred on boot (the supervisor keeps cached copies). */
  bytes: ArrayBuffer;
}

export interface ExecBootMsg {
  t: 'boot';
  /** Base URL for glue/wasm/stdlib artifacts (`PY_ORIGIN/<buildHash>/`). */
  artifactBase: string;
  sab: SharedArrayBuffer;
  /** Manifest hash of python_stdlib.zip — the executor hashes the zip AS
   * MOUNTED in MEMFS and refuses the boot on drift (restage ⇒ recapture). */
  stdlibSha256: string;
  /** Package bundles to mount before the harness installs (M2). */
  bundles?: PyBundlePayload[];
  /** Snapshot restore payload (fork container bytes); absent = cold boot. */
  snapshot?: ArrayBuffer;
  /** Packed site-packages tree for STACKED restores — the `_preRestoreHook`
   * rebuilds MEMFS + replays DSOs from it before the heap overwrite. */
  tree?: PackedTree;
  /** Generation boot: bake the set's imports, capture, post `exec-snapshot`.
   * Arms `_makeSnapshot` in the loader — required for capture (fork gate). */
  capture?: boolean;
  /** Set the capture is for — echoed back on `exec-snapshot` (bootedSetKey
   * can move under a late message). */
  captureKey?: PySetKey;
}
export interface ExecRunMsg {
  t: 'exec';
  runId: number;
  code: string;
}
export type SupToExec = ExecBootMsg | ExecRunMsg;

// ---------------------------------------------------------------- exec → sup

export interface ExecReadyMsg {
  t: 'exec-ready';
  bootMs: number;
}
export interface ExecStdoutMsg {
  t: 'exec-stdout';
  runId: number;
  chunk: string;
}
export interface ExecDoneMsg {
  t: 'exec-done';
  runId: number;
  /** ok=false carries the harness-trimmed traceback in `output`'s tail. */
  ok: boolean;
  /** True when the failure was a KeyboardInterrupt (cancel/timeout mapping
   * to 'cancelled' vs 'timeout' is the supervisor's call via CANCEL_KIND). */
  interrupted: boolean;
  output: string;
  durationMs: number;
  figures: PyFigure[];
  /** Blit reset failed/skipped (wasm table grew, no reset image, fixup threw)
   * or the heap grew past 1.5× the image — supervisor respawns eagerly
   * instead of arming idle teardown (isolation + memory reclaim). */
  needsRespawn: boolean;
}
/** Generation capture riding the boot (before exec-ready, before ANY user
 * code — the supervisor drops it once `executorReady`). Transfer list:
 * `[container, tree.blob]`. */
export interface ExecSnapshotMsg {
  t: 'exec-snapshot';
  captureKey: PySetKey;
  container: ArrayBuffer;
  tree: PackedTree;
}
export interface ExecFatalMsg {
  t: 'exec-fatal';
  error: string;
}
export type ExecToSup = ExecReadyMsg | ExecStdoutMsg | ExecDoneMsg | ExecSnapshotMsg | ExecFatalMsg;

// ------------------------------------------------------------------- limits

// Frozen: shared by all three threads' module scopes — a cap must never be
// reshapeable at runtime, least of all from the executor realm.
export const PY_LIMITS = Object.freeze({
  /** Wall-clock soft timeout → SIGINT (supervisor clock). */
  softTimeoutMs: 30_000,
  /** Grace after soft timeout / cancel before executor.terminate(). */
  hardGraceMs: 5_000,
  cancelGraceMs: 2_000,
  /** SIGINT repeat cadence until acknowledged — a terminated-but-still-
   * spinning zombie executor can eat one write (P0-B finding). */
  interruptRepeatMs: 50,
  /** Run queue cap; further clicks are ignored (silently — queue-full
   * feedback is polish backlog). */
  queueCap: 4,
  /** stdout relay batching. */
  stdoutFlushMs: 100,
  stdoutFlushBytes: 8_192,
  /** Idle executor teardown — THE memory-reclaim product knob: snapshots put
   * respawn at ~0.5 s (OPFS restore), so torn-down is the default state.
   * Field-tune downward (60 s → 30 s candidate) once restore timings hold. */
  idleTeardownMs: 60_000,
  maxFigures: 4,
  maxFigurePx: 2_048,
  /** Final-output char cap — mirrors MAX_OUTPUT_CHARS in code-tokens.ts. */
  maxOutputChars: 4_096,
} as const);

export const OUTPUT_TRUNCATION_MARKER = '\n… output truncated (4096 char limit)';
