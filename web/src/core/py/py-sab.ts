/**
 * PY_SAB — the 64-byte supervisor⇄executor control plane. One per executor
 * GENERATION: never reuse across spawns (a terminated executor keeps spinning
 * until its next yield point and could still read/write a shared buffer —
 * generation state must never bleed into the replacement).
 *
 * Layout (deliberately NOT SpmcRing/SlotTable — those model 1-producer/
 * N-consumer; this is 1:1 duplex, same shared-layout-module pattern as
 * core/image/image-sab.ts):
 *   u8 [0]      (reserved)  was the pyodide setInterruptBuffer cell — the
 *                           interrupt is DISARMED since 2026-08 (the armed
 *                           signal check taxed every run 2-4.5%; cancel is a
 *                           kill+respawn now). Slot stays reserved for a
 *                           future real cancellation.
 *   i32[1]      STATE       executor lifecycle (PyExecState)
 *   i32[2]      RUN_ID      currently-executing run (0 = idle)
 *   i32[3]      HEARTBEAT   incremented by the executor between runs —
 *                           diagnostic-only today (no reader; DevTools/
 *                           post-mortem inspection)
 *   i32[4]      EPOCH       executor generation stamp (supervisor-written) —
 *                           diagnostic-only today (liveness is spawnToken +
 *                           onmessage-mute, not the epoch)
 *   i32[5]      FUTEX_SEQ   reserved for a future Futex wait/notify pair
 *   i32[6]      (reserved)  was CANCEL_KIND (never had a reader)
 *   i32[7]      MEM_KIB     executor-reported heap size after each run, in
 *                           KiB — raw bytes hit 2^31 at the 2 GiB ceiling and
 *                           would read back negative from an Int32 slot
 *                           (read by the py-build harness memory checks)
 */

export const PY_SAB_BYTES = 64;

export const STATE = 1; // i32 indices (u8[0] + i32[6] reserved — see layout)
export const RUN_ID = 2;
export const HEARTBEAT = 3;
export const EPOCH = 4;
export const FUTEX_SEQ = 5;
export const MEM_KIB = 7;

export const PyExecState = Object.freeze({
  Booting: 0,
  Idle: 1,
  Running: 2,
} as const);
export type PyExecState = (typeof PyExecState)[keyof typeof PyExecState];

/** Cancel-reason vocabulary. No live producer since the 2026-08 interrupt
 * disarm — kept as the seam a future real cancellation re-lands behind. */
export const PyCancelKind = Object.freeze({
  None: 0,
  UserCancel: 1,
  SoftTimeout: 2,
} as const);
export type PyCancelKind = (typeof PyCancelKind)[keyof typeof PyCancelKind];

export interface PySabViews {
  sab: SharedArrayBuffer;
  u8: Uint8Array<SharedArrayBuffer>;
  i32: Int32Array<SharedArrayBuffer>;
}

export function allocPySab(): PySabViews {
  return mapPySab(new SharedArrayBuffer(PY_SAB_BYTES));
}

export function mapPySab(sab: SharedArrayBuffer): PySabViews {
  return { sab, u8: new Uint8Array(sab), i32: new Int32Array(sab) };
}
