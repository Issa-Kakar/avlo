/**
 * `core/sab` — worker-agnostic SharedArrayBuffer control-plane toolkit.
 *
 * The command / cancel / staleness channel between a producer (the main thread)
 * and a hardware-scaled pool of consumers (workers): tiny, latency-sensitive
 * intent lives in shared memory and is re-read at every checkpoint, so a burst of
 * would-be cancels collapses into a single `Atomics.load` of current intent.
 * Large / rare payloads (a decoded ImageBitmap) still travel by `postMessage` +
 * Transferable — already zero-copy, kept as-is.
 *
 * First consumer: image decode (`core/image/image-sab.ts`). See `CLAUDE.md` for
 * the memory-ordering rules, single-producer invariant, and futex discipline.
 */

export { Futex } from './futex';
export { SpmcRing } from './ring';
export { SlotTable } from './slot-table';

export interface SabLayout {
  /** i32 header fields (ring cursors, epoch, futex seq). */
  headerWords: number;
  slotCount: number;
  /** i32 fields per slot record. */
  slotWords: number;
  /** Number of independent rings (e.g. high / low priority lanes). */
  rings: number;
  /** Records per ring — must be a power of two. */
  ringCap: number;
  /** i32 words per ring record. */
  ringRecWords: number;
  /** Bytes of side-region per slot (the per-slot hash). */
  hashBytesPerSlot: number;
}

export interface ControlSab {
  sab: SharedArrayBuffer;
  /** i32 view over header + slot table + every ring (the whole atomic region). */
  ctrl: Int32Array;
  /** Byte side-region (`slotCount * hashBytesPerSlot`), placed after the i32 region. */
  hashes: Uint8Array;
  /** i32 index where the slot table begins (header occupies `[0, headerWords)`). */
  slotOffset: number;
  /** i32 index where each ring's records begin (length === `layout.rings`). */
  ringOffsets: number[];
  layout: SabLayout;
}

/** Throw unless the realm is cross-origin isolated (⇒ SAB + `Atomics.waitAsync`). */
export function assertCrossOriginIsolated(): void {
  if (typeof crossOriginIsolated === 'undefined' || !crossOriginIsolated) {
    throw new Error(
      '[sab] requires crossOriginIsolated — set COOP: same-origin + COEP: credentialless (web/public/_headers + vite.config.ts).',
    );
  }
}

function computeOffsets(layout: SabLayout) {
  const slotOffset = layout.headerWords;
  const ringOffsets: number[] = [];
  let cursor = slotOffset + layout.slotCount * layout.slotWords;
  for (let i = 0; i < layout.rings; i++) {
    ringOffsets.push(cursor);
    cursor += layout.ringCap * layout.ringRecWords;
  }
  const ctrlWords = cursor;
  return { slotOffset, ringOffsets, ctrlWords, ctrlBytes: ctrlWords * 4, hashBytes: layout.slotCount * layout.hashBytesPerSlot };
}

/** Carve a fresh SAB for `layout` (producer side, main thread). */
export function allocControlSab(layout: SabLayout): ControlSab {
  const { ctrlBytes, hashBytes } = computeOffsets(layout);
  return mapControlSab(new SharedArrayBuffer(ctrlBytes + hashBytes), layout);
}

/** Map an existing SAB with the SAME layout (consumer side, after `postMessage`). */
export function mapControlSab(sab: SharedArrayBuffer, layout: SabLayout): ControlSab {
  const { slotOffset, ringOffsets, ctrlWords, ctrlBytes, hashBytes } = computeOffsets(layout);
  return {
    sab,
    ctrl: new Int32Array(sab, 0, ctrlWords),
    hashes: new Uint8Array(sab, ctrlBytes, hashBytes),
    slotOffset,
    ringOffsets,
    layout,
  };
}
