/**
 * Image decode control plane — the concrete SAB layout over the generic
 * `core/sab` toolkit. Imported by BOTH the main thread (`image-manager.ts`,
 * producer) and the decode workers (`image-worker.ts`, consumers), so the memory
 * layout is agreed by construction — a single source of truth, no version field.
 *
 *   HEADER (i32)   epoch + two lane cursor pairs + futex seq
 *   SLOT TABLE     SLOT_COUNT × { needGen, needLevel, needW, needH, doneGen, doneLevel }
 *   HIGH / LOW     two SpmcRings of [slot, gen] — New vs Upgrade/Downgrade lanes
 *   HASHES         SLOT_COUNT × 32 raw SHA-256 bytes (self-describing slots)
 *
 * ≈ 36 KB total. The decoded ImageBitmap never lives here (GPU-backed) — it goes
 * back by `postMessage` + Transferable. Only command / cancel / staleness is SAB.
 */

import { allocControlSab, type ControlSab, Futex, mapControlSab, type SabLayout, SlotTable, SpmcRing } from '@/core/sab';

// ── Header (absolute i32 indices into `ctrl`) ───────────────────────────────
export const H_EPOCH = 0; // bump → workers abandon all in-flight work
const H_HIGH_HEAD = 1;
const H_HIGH_TAIL = 2;
const H_LOW_HEAD = 3;
const H_LOW_TAIL = 4;
const H_FUTEX_SEQ = 5;
const HEADER_WORDS = 6;

// ── Slot fields (i32 offsets within a slot record) ──────────────────────────
export const F_NEED_GEN = 0; // bumped when desired level changes / re-request
export const F_NEED_LEVEL = 1; // 0 | 1 | 2 ; EVICTED(-1) = cancelled
export const F_NEED_W = 2; // target decode width  (0 ⇒ full-res decode at level 0)
export const F_NEED_H = 3; // target decode height
export const F_DONE_GEN = 4; // worker stamps after posting the bitmap; main reads it for in-flight dedup
export const F_DONE_LEVEL = 5; // worker stamps the completed level (observability)
const SLOT_WORDS = 6;

export const EVICTED = -1;

export const SLOT_COUNT = 512; // ≫ realistic visible asset count
const RING_CAP = 512; // power of two (ring mask)
const RING_REC_WORDS = 2; // [slot, gen]
const HASH_BYTES = 32; // raw SHA-256

const LAYOUT: SabLayout = {
  headerWords: HEADER_WORDS,
  slotCount: SLOT_COUNT,
  slotWords: SLOT_WORDS,
  rings: 2,
  ringCap: RING_CAP,
  ringRecWords: RING_REC_WORDS,
  hashBytesPerSlot: HASH_BYTES,
};

/** The image control plane: one SAB, two priority lanes, one slot table, one futex. */
export interface ImageSab {
  sab: SharedArrayBuffer;
  ctrl: Int32Array;
  slots: SlotTable;
  highRing: SpmcRing; // New decodes (New-in-view beats Upgrade/Downgrade)
  lowRing: SpmcRing; // Upgrade / Downgrade decodes
  futex: Futex;
}

function build(c: ControlSab): ImageSab {
  return {
    sab: c.sab,
    ctrl: c.ctrl,
    slots: new SlotTable(c.ctrl, c.slotOffset, SLOT_COUNT, SLOT_WORDS, c.hashes, HASH_BYTES),
    highRing: new SpmcRing(c.ctrl, H_HIGH_HEAD, H_HIGH_TAIL, c.ringOffsets[0], RING_CAP, RING_REC_WORDS),
    lowRing: new SpmcRing(c.ctrl, H_LOW_HEAD, H_LOW_TAIL, c.ringOffsets[1], RING_CAP, RING_REC_WORDS),
    futex: new Futex(c.ctrl, H_FUTEX_SEQ),
  };
}

/** Producer side (main thread): carve a fresh control SAB. */
export function allocImageSab(): ImageSab {
  return build(allocControlSab(LAYOUT));
}

/** Consumer side (worker): map the SAB delivered via `postMessage`. */
export function mapImageSab(sab: SharedArrayBuffer): ImageSab {
  return build(mapControlSab(sab, LAYOUT));
}

/** Read the global epoch (workers capture it at decode start; checkpoints compare). */
export function loadEpoch(ctrl: Int32Array): number {
  return Atomics.load(ctrl, H_EPOCH);
}

/** Bump the global epoch — every in-flight decode abandons at its next checkpoint. */
export function bumpEpoch(ctrl: Int32Array): void {
  Atomics.add(ctrl, H_EPOCH, 1);
}
