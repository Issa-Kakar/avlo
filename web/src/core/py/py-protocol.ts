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

import type { AvsCaptureMeta, AvsHeader } from './py-snapshot';

/** Mirrors the code block's Y `outputStatus` field — renderer drives tint. */
export type PyRunStatus = 'ok' | 'error' | 'cancelled' | 'timeout' | 'unavailable' | 'oom';

/** Package-set key: which bundles a run needs. GENERATED with the set tables
 * — stage.mjs emits the union from build.config.json `sets`, so the type can
 * never lag the data again. Re-exported here so protocol consumers keep one
 * import site (type-only: erased in every bundle and under Node
 * type-stripping, so the harness's protocol import stays value-free). */
import type { PySetKey } from './py-stdlib-modules.gen';

export type { PySetKey };

/** Live phase for the run store / play-button UI (never written to Y).
 * Restore boots surface as plain 'booting' — the supervisor-side OPFS
 * open/read runs in the spawn shadow and is fast enough to not warrant its
 * own phase. */
export type PyRunPhase = 'queued' | 'booting' | 'downloading' | 'running' | 'cancelling';

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
export type MainToSup = RunMsg | CancelMsg;

// ---------------------------------------------------------------- sup → main

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
/** Relayed py-trace JSON line (Phase 0) — the main thread owns the single
 * visible `console.info('py:trace', …)` + the e2e-readable ring buffer. */
export interface TraceMsg {
  t: 'trace';
  line: string;
}
export type SupToMain = PhaseMsg | StdoutMsg | ResultMsg | SupFatalMsg | TraceMsg;

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

/**
 * L2 topology (cold-restore attack): the supervisor spawns the executor FIRST
 * and streams boot inputs as four messages so bundle prep + the OPFS snapshot
 * open/read/hash run in the shadow of worker spin-up + glue import + main
 * instantiate. The executor parks everything in module-scope deferreds and
 * starts boot logic at `boot-prep` — `boot-data` MAY outrun `boot-prep` (warm
 * cache vs first-load glue preflight), the only ordering relied on is
 * snap-header < snap-heap (same task, same channel). Per generation:
 * boot-prep and boot-data arrive exactly once (or the worker is terminated —
 * teardown IS the abort signal, there is no boot-abort message); snap-header
 * arrives exactly once iff `trySnapshot`; snap-heap exactly once iff the
 * header was non-null, EXCEPT after a live-generation `exec-snap-invalid` or
 * supersession (the executor provably never awaits it on those paths).
 */
export interface BootPrepMsg {
  t: 'boot-prep';
  /** Base URL for glue/wasm/stdlib artifacts (`PY_ORIGIN/<buildHash>/`). */
  artifactBase: string;
  sab: SharedArrayBuffer;
  /** Manifest hash of python_stdlib.zip — the executor hashes the zip AS
   * MOUNTED in MEMFS and refuses the boot on drift (restage ⇒ recapture). */
  stdlibSha256: string;
  /** Committed build-lock hash — rides the boot msg so the executor stays
   * lock-free (never imports the `@avlo/py-loader` index). */
  buildHash: string;
  /** true ⇒ UNIFORM boot: the loader always passes `_avloRestore`
   * (noInitialRun) and the preBlit driver decides restore-vs-cold on the
   * snap-header feed — pre-mutation snapshot failures fall back cold on the
   * SAME Module with zero re-instantiate (deferred `Module.callMain()`). */
  trySnapshot: boolean;
  /** The set this generation boots for — the capture key when no restore
   * happened (echoed back on `exec-snapshot`; bootedSetKey can move under a
   * late message). Present iff `trySnapshot`. */
  captureKey?: PySetKey;
}
/** Bundle payloads (transferred). Needed on restore boots too — DSO
 * precompile slices `.so` bytes from these buffers and site-packages mounts
 * from them. Always sent (empty array for stdlib). */
export interface BootDataMsg {
  t: 'boot-data';
  bundles: PyBundlePayload[];
}
/** Supervisor-side snapshot probe verdict: the parsed+validated header, or
 * null (absent / open failed / parse failed — boot cold). */
export interface SnapHeaderMsg {
  t: 'snap-header';
  header: AvsHeader | null;
}
/** The verified heap image (hash checked DURING the supervisor-side read,
 * pre-transfer), or null (read/hash failure — `reason` says why; the driver
 * is post-replay by then, so null ⇒ DirtyRestoreError ⇒ fresh cold boot). */
export interface SnapHeapMsg {
  t: 'snap-heap';
  heap: ArrayBuffer | null;
  reason?: string;
}
export interface ExecRunMsg {
  t: 'exec';
  runId: number;
  code: string;
}
export type SupToExec = BootPrepMsg | BootDataMsg | SnapHeaderMsg | SnapHeapMsg | ExecRunMsg;

// ---------------------------------------------------------------- exec → sup

export interface ExecReadyMsg {
  t: 'exec-ready';
  bootMs: number;
  /** True when this generation booted from an OPFS snapshot restore — the
   * supervisor's poison-routing + trace attribution (the preBlit driver
   * decides restore-vs-cold in flight; the supervisor only fed it). */
  restored: boolean;
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
/** Owned capture riding the boot (before exec-ready, before ANY user code —
 * the supervisor drops it once `executorReady`). The supervisor assembles the
 * AVS2 container and persists to OPFS off the executor's critical path.
 * Transfer list: `[heap]`. */
export interface ExecSnapshotMsg {
  t: 'exec-snapshot';
  captureKey: PySetKey;
  meta: AvsCaptureMeta;
  /** Dense post-bake heap copy (HEAP8.slice) — transferred. */
  heap: ArrayBuffer;
}
/** The preBlit driver rejected the snapshot feeds and the boot continued
 * COLD in the same worker (same-Module pre-mutation, or one fresh
 * re-instantiate after DirtyRestoreError). Informational: the supervisor
 * deletes the file and does NOT respawn. */
export interface ExecSnapInvalidMsg {
  t: 'exec-snap-invalid';
  reason: string;
}
export interface ExecFatalMsg {
  t: 'exec-fatal';
  error: string;
  /** Poison routing: a restored generation's pre-ready fatal deletes the
   * snapshot and retries cold once (post-blit failures land here; pre-blit
   * failures fall back cold in-boot via exec-snap-invalid instead). */
  restored: boolean;
}
/** Executor py-trace line — supervisor relays it to main as TraceMsg. */
export interface ExecTraceMsg {
  t: 'exec-trace';
  line: string;
}
export type ExecToSup = ExecReadyMsg | ExecStdoutMsg | ExecDoneMsg | ExecSnapshotMsg | ExecSnapInvalidMsg | ExecFatalMsg | ExecTraceMsg;

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
  /** Idle executor teardown — THE memory-reclaim product knob: owned OPFS
   * restores make respawn cheap, so torn-down is the default state (owner
   * decision, P2: 15 s — the idle window at ~2× heap is the RAM cost). */
  idleTeardownMs: 15_000,
  maxFigures: 4,
  maxFigurePx: 2_048,
  /** Final-output char cap — mirrors MAX_OUTPUT_CHARS in code-tokens.ts. */
  maxOutputChars: 4_096,
} as const);

export const OUTPUT_TRUNCATION_MARKER = '\n… output truncated (4096 char limit)';
