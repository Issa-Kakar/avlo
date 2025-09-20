import type { StrokeView } from '@avlo/shared';
import { buildStrokeRenderData, type StrokeRenderData } from './path-builder';

/**
 * Simple render cache for stroke paths.
 * Keyed by stroke ID since strokes are immutable after commit.
 *
 * This is a UI-local cache only, never persisted.
 * Phase 4 keeps it simple - no style stamping or complex keys.
 */
export class StrokeRenderCache {
  private cache = new Map<string, StrokeRenderData>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Get or build render data for a stroke.
   * Strokes are immutable after commit, so ID is sufficient key.
   */
  getOrBuild(stroke: StrokeView): StrokeRenderData {
    const cached = this.cache.get(stroke.id);
    if (cached) {
      return cached;
    }

    // Build new render data
    const renderData = buildStrokeRenderData(stroke);

    // FIFO eviction if cache is full (simple for Phase 4)
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(stroke.id, renderData);
    return renderData;
  }

  /**
   * Clear a specific stroke from cache.
   * Called when stroke is deleted (Phase 10).
   */
  invalidate(strokeId: string): void {
    this.cache.delete(strokeId);
  }

  /**
   * Clear entire cache.
   * Called on scene change or major updates.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size for monitoring.
   */
  get size(): number {
    return this.cache.size;
  }
}

// Add singleton export for shared access
let globalCacheInstance: StrokeRenderCache | null = null;

export function getStrokeCacheInstance(): StrokeRenderCache {
  if (!globalCacheInstance) {
    globalCacheInstance = new StrokeRenderCache(1000);
  }
  return globalCacheInstance;
}
