/**
 * UniformGrid - A simple spatial index for efficient hit-testing
 * Divides the world into uniform cells and tracks which items are in each cell
 */

export class UniformGrid<T extends { id: string }> {
  private cellSize: number;
  private grid: Map<string, Set<T>> = new Map();
  // Track unique items to prevent duplicates
  private itemsById: Map<string, T> = new Map();

  constructor(cellSize: number = 128) {
    this.cellSize = cellSize;
  }

  /**
   * Get the cell key for a coordinate
   */
  private getCellKey(x: number, y: number): string {
    const ix = Math.floor(x / this.cellSize);
    const iy = Math.floor(y / this.cellSize);
    return `${ix},${iy}`;
  }

  /**
   * Insert an item into the grid based on its bounding box
   * An item may be inserted into multiple cells if it spans cell boundaries
   */
  insert(item: T, bbox: [number, number, number, number]): void {
    // Prevent duplicate insertions
    if (this.itemsById.has(item.id)) {
      return;
    }

    this.itemsById.set(item.id, item);

    const [minX, minY, maxX, maxY] = bbox;
    const minIx = Math.floor(minX / this.cellSize);
    const minIy = Math.floor(minY / this.cellSize);
    const maxIx = Math.floor(maxX / this.cellSize);
    const maxIy = Math.floor(maxY / this.cellSize);

    // Insert into all cells that the bbox overlaps
    for (let ix = minIx; ix <= maxIx; ix++) {
      for (let iy = minIy; iy <= maxIy; iy++) {
        const key = `${ix},${iy}`;
        if (!this.grid.has(key)) {
          this.grid.set(key, new Set());
        }
        this.grid.get(key)!.add(item);
      }
    }
    const cols = maxIx - minIx + 1;
    const rows = maxIy - minIy + 1;
    const totalCells = cols * rows;
    // Log suspicious but allowed ranges
    if (totalCells > 1000) {
      console.log('[🚨 UNIFORM GRID] Large cell range', {
        totalCells,
        bbox: bbox.map(v => v.toFixed(2)),
        indices: { minIx, maxIx, minIy, maxIy }
      });
    }
    if (totalCells > 100000) {
      console.log('[⚠️ UNIFORM GRID] Excessive cell count detected!', {
        cols,
        rows,
        totalCells,
        minIx, maxIx,
        minIy, maxIy,
        bbox,
        cellSize: this.cellSize,
        item: { id: item.id },
        timestamp: performance.now().toFixed(2)
      });
    }
  }
  
  /**
   * Query items within a radius of a point
   * Returns unique items that are in cells that could contain the query circle
   */
  query(cx: number, cy: number, radius: number): T[] {
    const results = new Set<T>();

    // Find all cells that the query circle could overlap
    const minIx = Math.floor((cx - radius) / this.cellSize);
    const minIy = Math.floor((cy - radius) / this.cellSize);
    const maxIx = Math.floor((cx + radius) / this.cellSize);
    const maxIy = Math.floor((cy + radius) / this.cellSize);

    // Collect all items from relevant cells
    for (let ix = minIx; ix <= maxIx; ix++) {
      for (let iy = minIy; iy <= maxIy; iy++) {
        const key = `${ix},${iy}`;
        const items = this.grid.get(key);
        if (items) {
          items.forEach((item) => results.add(item));
        }
      }
    }

    return Array.from(results);
  }

  /**
   * Query items within a rectangular region
   * Returns unique items in cells that overlap the query rectangle
   */
  queryRect(minX: number, minY: number, maxX: number, maxY: number): T[] {
    const results = new Set<T>();

    const minIx = Math.floor(minX / this.cellSize);
    const minIy = Math.floor(minY / this.cellSize);
    const maxIx = Math.floor(maxX / this.cellSize);
    const maxIy = Math.floor(maxY / this.cellSize);

    for (let ix = minIx; ix <= maxIx; ix++) {
      for (let iy = minIy; iy <= maxIy; iy++) {
        const key = `${ix},${iy}`;
        const items = this.grid.get(key);
        if (items) {
          items.forEach((item) => results.add(item));
        }
      }
    }

    return Array.from(results);
  }

  /**
   * Get all items in the grid
   */
  getAllItems(): T[] {
    return Array.from(this.itemsById.values());
  }

  /**
   * Get the number of unique items in the grid
   */
  size(): number {
    return this.itemsById.size;
  }

  /**
   * Clear all items from the grid
   */
  clear(): void {
    this.grid.clear();
    this.itemsById.clear();
  }

  /**
   * Get statistics about the grid (useful for debugging/tuning)
   */
  getStats(): {
    cellCount: number;
    itemCount: number;
    avgItemsPerCell: number;
    maxItemsPerCell: number;
    cellSize: number;
  } {
    const cellCount = this.grid.size;
    const itemCount = this.itemsById.size;

    let maxItemsPerCell = 0;
    let totalItemsInCells = 0;

    for (const items of this.grid.values()) {
      const count = items.size;
      totalItemsInCells += count;
      if (count > maxItemsPerCell) {
        maxItemsPerCell = count;
      }
    }

    return {
      cellCount,
      itemCount,
      avgItemsPerCell: cellCount > 0 ? totalItemsInCells / cellCount : 0,
      maxItemsPerCell,
      cellSize: this.cellSize,
    };
  }
}
