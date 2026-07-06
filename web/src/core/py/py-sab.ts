/**
 * PY_SAB — the 64-byte supervisor⇄executor control plane. One per executor
 * GENERATION: never reuse across spawns — a terminated executor blocked in a
 * wasm busy loop keeps spinning until its next yield point and its Python
 * signal check would keep consuming SIGINT writes from a shared buffer,
 * silently stealing the replacement executor's first interrupt (P0-B finding).
 *
 * Layout (deliberately NOT SpmcRing/SlotTable — those model 1-producer/
 * N-consumer; this is 1:1 duplex, same shared-layout-module pattern as
 * core/image/image-sab.ts):
 *   u8 [0]      INTERRUPT   pyodide setInterruptBuffer cell (2 = SIGINT)
 *   i32[1]      STATE       executor lifecycle (PyExecState)
 *   i32[2]      RUN_ID      currently-executing run (0 = idle)
 *   i32[3]      HEARTBEAT   incremented by the executor between runs
 *   i32[4]      EPOCH       executor generation stamp (supervisor-written)
 *   i32[5]      FUTEX_SEQ   reserved for a future Futex wait/notify pair
 *   i32[6]      CANCEL_KIND why the interrupt byte was written (PyCancelKind)
 *   i32[7]      MEM_KIB     executor-reported heap size after each run, in
 *                           KiB — raw bytes hit 2^31 at the 2 GiB ceiling and
 *                           would read back negative from an Int32 slot
 */

export const PY_SAB_BYTES = 64;

export const INTERRUPT_BYTE = 0; // u8 index
export const STATE = 1; // i32 indices from here on
export const RUN_ID = 2;
export const HEARTBEAT = 3;
export const EPOCH = 4;
export const FUTEX_SEQ = 5;
export const CANCEL_KIND = 6;
export const MEM_KIB = 7;

export const SIGINT = 2;

export const PyExecState = Object.freeze({
  Booting: 0,
  Idle: 1,
  Running: 2,
} as const);
export type PyExecState = (typeof PyExecState)[keyof typeof PyExecState];

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

/** Supervisor-side: write SIGINT with the reason; repeat until acknowledged
 * (see PY_LIMITS.interruptRepeatMs). */
export function writeInterrupt(views: PySabViews, kind: PyCancelKind): void {
  Atomics.store(views.i32, CANCEL_KIND, kind);
  Atomics.store(views.u8, INTERRUPT_BYTE, SIGINT);
}

export function clearInterrupt(views: PySabViews): void {
  Atomics.store(views.u8, INTERRUPT_BYTE, 0);
  Atomics.store(views.i32, CANCEL_KIND, PyCancelKind.None);
}
