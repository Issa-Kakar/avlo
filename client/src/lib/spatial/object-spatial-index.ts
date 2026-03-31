import RBush from 'rbush';
import type { ObjectKind, IndexEntry, ObjectHandle } from '@/types/objects';

export class ObjectSpatialIndex {
  private tree = new RBush<IndexEntry>(9);

  insert(id: string, bbox: [number, number, number, number], kind: ObjectKind): void {
    const [minX, minY, maxX, maxY] = bbox;
    this.tree.insert({ minX, minY, maxX, maxY, id, kind });
  }

  update(
    id: string,
    oldBBox: [number, number, number, number],
    newBBox: [number, number, number, number],
    kind: ObjectKind,
  ): void {
    // Remove old entry
    const [minX, minY, maxX, maxY] = oldBBox;
    this.tree.remove({ minX, minY, maxX, maxY, id, kind } as IndexEntry, (a, b) => a.id === b.id);

    // Insert new entry
    this.insert(id, newBBox, kind);
  }

  remove(id: string, bbox: [number, number, number, number]): void {
    const [minX, minY, maxX, maxY] = bbox;
    // Remove by ID only - kind doesn't matter for removal
    this.tree.remove({ minX, minY, maxX, maxY, id } as any, (a, b) => a.id === b.id);
  }

  query(bounds: { minX: number; minY: number; maxX: number; maxY: number }): IndexEntry[] {
    return this.tree.search(bounds);
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
