import RBush from 'rbush';
import type { BBoxTuple } from '../types/geometry';
import { applyHandleBBox, type ObjectHandle } from '../types/objects';

/**
 * Spatial index keyed on ObjectHandle. The handle IS the rbush item — its
 * `minX/minY/maxX/maxY` mirror `handle.bbox[0..3]` and are kept in sync by
 * `applyHandleBBox` (the only legal post-creation bbox mutator).
 *
 * Removals use rbush's default identity comparator (`===`). No comparator
 * function, no per-remove entry allocation — single pointer compare per leaf
 * check during tree descent.
 *
 * Scratch envelope is an instance field; it leaks only as long as a single
 * `.search()` call (rbush reads its fields and stores nothing).
 */
export class ObjectSpatialIndex extends RBush<ObjectHandle> {
  private readonly _scratch = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  /** Tuple-first bbox query. Reuses an instance-scoped scratch envelope. */
  queryBBox(bbox: Readonly<BBoxTuple>): ObjectHandle[] {
    const s = this._scratch;
    s.minX = bbox[0];
    s.minY = bbox[1];
    s.maxX = bbox[2];
    s.maxY = bbox[3];
    return this.search(s);
  }

  /** Radius query around (x, y). Reuses an instance-scoped scratch envelope. */
  queryRadius(x: number, y: number, r: number): ObjectHandle[] {
    const s = this._scratch;
    s.minX = x - r;
    s.minY = y - r;
    s.maxX = x + r;
    s.maxY = y + r;
    return this.search(s);
  }

  /**
   * In-place envelope change. CONTRACT: caller must NOT have mutated `handle.bbox`
   * or the mirror fields between the previous insert and this call — `rbush.remove`
   * descends the tree using the current envelope to locate the leaf. Always wrapped
   * by `RoomDocManager.upsertHandle`; not called elsewhere.
   */
  updateHandleBBox(handle: ObjectHandle, newBBox: Readonly<BBoxTuple>): void {
    this.remove(handle); // identity match; rbush uses current (old) envelope
    applyHandleBBox(handle, newBBox); // mutate bbox tuple + mirrors → new
    this.insert(handle); // rbush reads new envelope from mirror fields
  }
}
