import RBush from 'rbush';
import type { ObjectKind, IndexEntry, ObjectHandle } from '../types/objects';
import type { BBoxTuple } from '../types/geometry';

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

  /**
   * @deprecated Use queryBBox (tuple-first) instead. rbush `{minX,...}` shape is
   * an implementation detail of this class.
   */
  query(bounds: { minX: number; minY: number; maxX: number; maxY: number }): IndexEntry[] {
    return this.tree.search(bounds);
  }

  /** Tuple-first bbox query. */
  queryBBox(bbox: BBoxTuple): IndexEntry[] {
    return this.tree.search({ minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3] });
  }

  /** Radius query around (x, y). */
  queryRadius(x: number, y: number, r: number): IndexEntry[] {
    return this.tree.search({ minX: x - r, minY: y - r, maxX: x + r, maxY: y + r });
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
