/**
 * SlotTable — `slotCount` fixed-width records of i32 fields in shared memory,
 * plus a parallel per-slot byte side-region (the image plane stores the 32-byte
 * asset hash there, making the SAB self-describing — no slot-registration msg).
 *
 * Field semantics are owned by the consuming module (the image plane names them
 * needGen / needLevel / needW / needH / doneGen / doneLevel). All i32 access is
 * atomic; producer (main) and consumers (workers) coordinate solely through it.
 */
export class SlotTable {
  constructor(
    private readonly ctrl: Int32Array,
    private readonly slotOffset: number,
    readonly slotCount: number,
    private readonly slotWords: number,
    private readonly hashes: Uint8Array,
    private readonly hashBytes: number,
  ) {}

  private base(slot: number): number {
    return this.slotOffset + slot * this.slotWords;
  }

  load(slot: number, field: number): number {
    return Atomics.load(this.ctrl, this.base(slot) + field);
  }

  store(slot: number, field: number, value: number): void {
    Atomics.store(this.ctrl, this.base(slot) + field, value);
  }

  /** Atomic increment; returns the NEW value. */
  bump(slot: number, field: number): number {
    return Atomics.add(this.ctrl, this.base(slot) + field, 1) + 1;
  }

  /** Copy `bytes` into the slot's hash region (length must equal `hashBytes`). */
  setHash(slot: number, bytes: Uint8Array): void {
    this.hashes.set(bytes, slot * this.hashBytes);
  }

  /** A live view onto the slot's hash bytes (no copy). */
  hashView(slot: number): Uint8Array {
    const off = slot * this.hashBytes;
    return this.hashes.subarray(off, off + this.hashBytes);
  }
}
