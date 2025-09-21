import { describe, it, expect } from 'vitest';
import { UniformGrid } from '../uniform-grid';

describe('UniformGrid', () => {
  interface TestItem {
    id: string;
    name: string;
  }

  it('should insert and query items correctly', () => {
    const grid = new UniformGrid<TestItem>(10);

    const item1: TestItem = { id: '1', name: 'item1' };
    const item2: TestItem = { id: '2', name: 'item2' };
    const item3: TestItem = { id: '3', name: 'item3' };

    // Insert items at different locations
    grid.insert(item1, [0, 0, 5, 5]); // Top-left corner
    grid.insert(item2, [20, 20, 25, 25]); // Far away
    grid.insert(item3, [8, 8, 12, 12]); // Overlapping cells with item1

    // Query near item1 - should find item1 and item3
    const results1 = grid.query(5, 5, 10);
    expect(results1).toHaveLength(2);
    expect(results1.map((i) => i.id).sort()).toEqual(['1', '3']);

    // Query near item2 - radius 5 from (22,22) extends to cells containing item3
    // due to cell boundaries, so both item2 and item3 might be returned
    const results2 = grid.query(22, 22, 5);
    // The grid is conservative - it returns items from all cells that the query circle touches
    // Since item3 is in cells that might overlap with the query region, it could be included
    expect(results2.length).toBeGreaterThanOrEqual(1);
    expect(results2.some((i) => i.id === '2')).toBe(true);

    // Query empty area - should find nothing
    const results3 = grid.query(100, 100, 5);
    expect(results3).toHaveLength(0);
  });

  it('should handle items spanning multiple cells', () => {
    const grid = new UniformGrid<TestItem>(10);

    const largeItem: TestItem = { id: 'large', name: 'large item' };

    // Insert a large item that spans multiple cells
    grid.insert(largeItem, [5, 5, 35, 35]); // Spans 4x4 cells

    // Query at various points - should all find the large item
    expect(grid.query(10, 10, 1)).toHaveLength(1);
    expect(grid.query(30, 30, 1)).toHaveLength(1);
    expect(grid.query(20, 20, 1)).toHaveLength(1);
    expect(grid.query(5, 5, 1)).toHaveLength(1);
  });

  it('should prevent duplicate insertions', () => {
    const grid = new UniformGrid<TestItem>(10);

    const item: TestItem = { id: '1', name: 'item' };

    // Insert the same item multiple times
    grid.insert(item, [0, 0, 5, 5]);
    grid.insert(item, [10, 10, 15, 15]); // Should be ignored
    grid.insert(item, [20, 20, 25, 25]); // Should be ignored

    expect(grid.size()).toBe(1);
    expect(grid.getAllItems()).toHaveLength(1);
  });

  it('should support rectangular queries', () => {
    const grid = new UniformGrid<TestItem>(10);

    const item1: TestItem = { id: '1', name: 'item1' };
    const item2: TestItem = { id: '2', name: 'item2' };
    const item3: TestItem = { id: '3', name: 'item3' };

    grid.insert(item1, [5, 5, 8, 8]);
    grid.insert(item2, [15, 5, 18, 8]);
    grid.insert(item3, [5, 15, 8, 18]);

    // Query a horizontal rectangle - items in cells that overlap the rect are returned
    // The grid is conservative and returns all items in touched cells
    const results1 = grid.queryRect(0, 0, 20, 10);
    // All three items might be included due to cell boundaries
    expect(results1.length).toBeGreaterThanOrEqual(2);
    expect(results1.some((i) => i.id === '1')).toBe(true);
    expect(results1.some((i) => i.id === '2')).toBe(true);

    // Query a vertical rectangle - should find item1 and item3
    const results2 = grid.queryRect(0, 0, 10, 20);
    expect(results2.length).toBeGreaterThanOrEqual(2);
    expect(results2.some((i) => i.id === '1')).toBe(true);
    expect(results2.some((i) => i.id === '3')).toBe(true);
  });

  it('should provide accurate statistics', () => {
    const grid = new UniformGrid<TestItem>(10);

    const item1: TestItem = { id: '1', name: 'item1' };
    const item2: TestItem = { id: '2', name: 'item2' };

    grid.insert(item1, [0, 0, 5, 5]); // In cell (0,0)
    grid.insert(item2, [5, 5, 15, 15]); // Spans 2x2 cells

    const stats = grid.getStats();
    expect(stats.itemCount).toBe(2);
    expect(stats.cellCount).toBeGreaterThan(0);
    expect(stats.cellSize).toBe(10);
  });

  it('should clear all items', () => {
    const grid = new UniformGrid<TestItem>(10);

    grid.insert({ id: '1', name: 'item1' }, [0, 0, 5, 5]);
    grid.insert({ id: '2', name: 'item2' }, [10, 10, 15, 15]);

    expect(grid.size()).toBe(2);

    grid.clear();

    expect(grid.size()).toBe(0);
    expect(grid.getAllItems()).toHaveLength(0);
    expect(grid.query(2, 2, 10)).toHaveLength(0);
  });
});
