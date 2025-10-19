import RBush from 'rbush';
import type { SpatialIndex, StrokeView, TextView } from '@avlo/shared';

export interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  kind: 'stroke' | 'text';
  data: StrokeView | TextView;
}

export class RBushSpatialIndex implements SpatialIndex {
  private tree: RBush<IndexEntry>;
  private strokesById: Map<string, StrokeView>;
  private textsById: Map<string, TextView>;

  constructor() {
    // maxEntries = 9 is RBush default, good for most cases
    this.tree = new RBush<IndexEntry>(9);
    this.strokesById = new Map();
    this.textsById = new Map();
  }

  /**
   * Clear the index completely (for scene changes)
   */
  clear(): void {
    this.tree.clear();
    this.strokesById.clear();
    this.textsById.clear();
  }

  /**
   * Bulk load initial data (for first room join)
   */
  bulkLoad(strokes: ReadonlyArray<StrokeView>, texts: ReadonlyArray<TextView>): void {
    const items: IndexEntry[] = [];

    // Add strokes - use stored bbox directly (already inflated)
    for (const stroke of strokes) {
      if (stroke.bbox && stroke.bbox.length === 4) {
        const [minX, minY, maxX, maxY] = stroke.bbox;
        items.push({
          minX, minY, maxX, maxY,
          id: stroke.id,
          kind: 'stroke',
          data: stroke,
        });
        this.strokesById.set(stroke.id, stroke);
      }
    }

    // Add texts - compute bbox from x,y,w,h
    for (const text of texts) {
      items.push({
        minX: text.x,
        minY: text.y,
        maxX: text.x + text.w,
        maxY: text.y + text.h,
        id: text.id,
        kind: 'text',
        data: text,
      });
      this.textsById.set(text.id, text);
    }

    if (items.length > 0) {
      this.tree.load(items);
    }
  }

  /**
   * Insert a single stroke (incremental update)
   */
  insertStroke(stroke: StrokeView): void {
    if (!stroke.bbox || stroke.bbox.length !== 4) return;

    const [minX, minY, maxX, maxY] = stroke.bbox;
    this.tree.insert({
      minX, minY, maxX, maxY,
      id: stroke.id,
      kind: 'stroke',
      data: stroke,
    });
    this.strokesById.set(stroke.id, stroke);
  }

  /**
   * Insert a single text (incremental update)
   */
  insertText(text: TextView): void {
    this.tree.insert({
      minX: text.x,
      minY: text.y,
      maxX: text.x + text.w,
      maxY: text.y + text.h,
      id: text.id,
      kind: 'text',
      data: text,
    });
    this.textsById.set(text.id, text);
  }

  /**
   * Remove by ID (for deletions)
   */
  removeById(id: string): void {
    // Find the entry to remove
    const stroke = this.strokesById.get(id);
    const text = this.textsById.get(id);

    if (stroke && stroke.bbox) {
      const [minX, minY, maxX, maxY] = stroke.bbox;
      // RBush remove requires exact match
      this.tree.remove({
        minX, minY, maxX, maxY,
        id: stroke.id,
        kind: 'stroke',
        data: stroke,
      } as any, (a, b) => a.id === b.id);
      this.strokesById.delete(id);
    } else if (text) {
      this.tree.remove({
        minX: text.x,
        minY: text.y,
        maxX: text.x + text.w,
        maxY: text.y + text.h,
        id: text.id,
        kind: 'text',
        data: text,
      } as any, (a, b) => a.id === b.id);
      this.textsById.delete(id);
    }
  }

  // SpatialIndex interface implementation
  queryCircle(cx: number, cy: number, radius: number): ReadonlyArray<StrokeView> {
    const results = this.tree.search({
      minX: cx - radius,
      minY: cy - radius,
      maxX: cx + radius,
      maxY: cy + radius,
    });

    // Filter to strokes only and return
    return results
      .filter(item => item.kind === 'stroke')
      .map(item => item.data as StrokeView);
  }

  queryRect(minX: number, minY: number, maxX: number, maxY: number): ReadonlyArray<StrokeView> {
    const results = this.tree.search({ minX, minY, maxX, maxY });

    // Filter to strokes only
    return results
      .filter(item => item.kind === 'stroke')
      .map(item => item.data as StrokeView);
  }

  // Include texts in rect query (for selection tools)
  queryRectAll(minX: number, minY: number, maxX: number, maxY: number): {
    strokes: ReadonlyArray<StrokeView>;
    texts: ReadonlyArray<TextView>;
  } {
    const results = this.tree.search({ minX, minY, maxX, maxY });

    const strokes = results
      .filter(item => item.kind === 'stroke')
      .map(item => item.data as StrokeView);

    const texts = results
      .filter(item => item.kind === 'text')
      .map(item => item.data as TextView);

    return { strokes, texts };
  }

  getAllStrokes(): ReadonlyArray<StrokeView> {
    return Array.from(this.strokesById.values());
  }

  getAllTexts(): ReadonlyArray<TextView> {
    return Array.from(this.textsById.values());
  }

  // Debug helper
  getStats(): { treeSize: number; strokeCount: number; textCount: number } {
    return {
      treeSize: this.tree.all().length,
      strokeCount: this.strokesById.size,
      textCount: this.textsById.size,
    };
  }
}