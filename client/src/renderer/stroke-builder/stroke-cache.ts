import type { StrokeView } from '@avlo/shared';
import {
  buildPolylineRenderData,
  buildPFPolygonRenderData,
  type StrokeRenderData,
} from './path-builder';

/**
 * Stroke render cache (LRU) with geometry variants per stroke ID.
 * - Entry keyed by stroke.id
 * - Variant keyed by a small "geometry key"
 *   • polyline: independent of style.size (stroke width does not affect geometry)
 *   • polygon (Perfect Freehand): depends on style.size (width affects geometry)
 *
 * Style-only edits (color, opacity, polyline width) DO NOT invalidate geometry.
 */
type GeomKey = string;
type Variants = Map<GeomKey, StrokeRenderData>;
type Entry = { id: string; variants: Variants };

export class StrokeRenderCache {
  private lru = new Map<string, Entry>(); // Insertion-ordered LRU over stroke IDs
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = Math.max(1, maxSize | 0);
  }

  getOrBuild(stroke: StrokeView): StrokeRenderData {
    // Derive geometry kind from stroke.kind
    const desired = stroke.kind === 'freehand'
      ? { kind: 'polygon' as const }
      : { kind: 'polyline' as const };

    const key = computeGeomKey(stroke, desired);

    // LRU touch / lookup
    let entry = this.lru.get(stroke.id);
    if (entry) {
      // Touch: move to back
      this.lru.delete(stroke.id);
      this.lru.set(stroke.id, entry);
      const hit = entry.variants.get(key);
      if (hit) return hit;
    } else {
      entry = { id: stroke.id, variants: new Map() };
      this.lru.set(stroke.id, entry);
    }

    // Build the requested geometry
    const built =
      desired.kind === 'polygon'
        ? buildPFPolygonRenderData(stroke)
        : buildPolylineRenderData(stroke);

    entry.variants.set(key, built);
    this.evictIfNeeded();
    return built;
  }

  /**
   * Invalidate a specific stroke ID (all variants).
   */
  invalidate(strokeId: string): void {
    this.lru.delete(strokeId);
  }

  /**
   * Invalidate multiple stroke IDs.
   */
  invalidateMany(ids: Iterable<string>): void {
    for (const id of ids) {
      this.lru.delete(id);
    }
  }

  /**
   * Clear entire cache.
   * Called on scene change or major updates.
   */
  clear(): void {
    this.lru.clear();
  }

  /**
   * Get current cache size for monitoring.
   */
  get size(): number {
    return this.lru.size;
  }

  private evictIfNeeded(): void {
    while (this.lru.size > this.maxSize) {
      const firstKey = this.lru.keys().next().value as string | undefined;
      if (!firstKey) break;
      this.lru.delete(firstKey);
    }
  }
}

// Singleton export for shared access
let globalCacheInstance: StrokeRenderCache | null = null;

export function getStrokeCacheInstance(): StrokeRenderCache {
  if (!globalCacheInstance) {
    globalCacheInstance = new StrokeRenderCache(1000);
  }
  return globalCacheInstance;
}

// --- Helpers ---

function computeGeomKey(
  stroke: StrokeView,
  want: { kind: 'polyline' | 'polygon' }
): GeomKey {
  if (want.kind === 'polyline') {
    // Polyline geometry ignores style.size
    return 'pl';
  }
  // PF polygon geometry depends on width (size). PF knobs are fixed for now.
  const s = stroke.style.size;
  return `pf:s=${s};sm=0.5;sl=0.5;th=0;pr=0`;
}
