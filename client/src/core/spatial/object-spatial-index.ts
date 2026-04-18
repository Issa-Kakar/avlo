import RBush from 'rbush';
import type { ObjectKind, IndexEntry, ObjectHandle } from '../types/objects';
import type { BBoxTuple } from '../types/geometry';

/**
 * ObjectSpatialIndex — pure rbush wrapper, tuple-first.
 *
 * Queries mutate a single module-scoped scratch bbox object instead of
 * allocating a fresh `{minX, minY, maxX, maxY}` per call. rbush's own
 * internals read the fields; nobody else holds a reference.
 */
const _scratchBBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

export class ObjectSpatialIndex {
  private tree = new RBush<IndexEntry>(9);

  insert(id: string, bbox: [number, number, number, number], kind: ObjectKind): void {
    const [minX, minY, maxX, maxY] = bbox;
    this.tree.insert({ minX, minY, maxX, maxY, id, kind });
  }

  update(id: string, oldBBox: [number, number, number, number], newBBox: [number, number, number, number], kind: ObjectKind): void {
    // Remove old entry
    const [minX, minY, maxX, maxY] = oldBBox;
    this.tree.remove({ minX, minY, maxX, maxY, id, kind } as IndexEntry, (a, b) => a.id === b.id);

    // Insert new entry
    this.insert(id, newBBox, kind);
  }

  remove(id: string, bbox: [number, number, number, number]): void {
    const [minX, minY, maxX, maxY] = bbox;
    // Remove by ID only - kind doesn't matter for removal
    this.tree.remove({ minX, minY, maxX, maxY, id } as IndexEntry, (a, b) => a.id === b.id);
  }

  /** Tuple-first bbox query. Reuses a module-scoped scratch envelope. */
  queryBBox(bbox: BBoxTuple): IndexEntry[] {
    _scratchBBox.minX = bbox[0];
    _scratchBBox.minY = bbox[1];
    _scratchBBox.maxX = bbox[2];
    _scratchBBox.maxY = bbox[3];
    return this.tree.search(_scratchBBox);
  }

  /** Radius query around (x, y). Reuses a module-scoped scratch envelope. */
  queryRadius(x: number, y: number, r: number): IndexEntry[] {
    _scratchBBox.minX = x - r;
    _scratchBBox.minY = y - r;
    _scratchBBox.maxX = x + r;
    _scratchBBox.maxY = y + r;
    return this.tree.search(_scratchBBox);
  }

  bulkLoad(handles: ObjectHandle[]): void {
    const items: IndexEntry[] = handles.map((h) => {
      const [minX, minY, maxX, maxY] = h.bbox;
      return { minX, minY, maxX, maxY, id: h.id, kind: h.kind };
    });

    if (items.length > 0) {
      this.tree.load(items);
    }
  }

  clear(): void {
    this.tree.clear();
  }
}
