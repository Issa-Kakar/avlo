## Overview

This guide implements Perfect Freehand library integration for smooth, jaggy-free freehand stroke rendering while maintaining perfect shapes as-is. The implementation uses an explicit `kind: 'freehand' | 'shape'` semantic flag to distinguish rendering paths. 

**Version:** 1.2.2 (current stable)
**Import:** Named export `getStroke` from `'perfect-freehand'`

### Core Principle
**The canonical input to Perfect Freehand must be the same tuple array for both preview and commit.**
We will:
1. Preserve the exact PF tuple array created during drawing
2. Bypass ALL simplification for freehand strokes
3. Store tuples alongside flat arrays for backward compatibility
4. Use the same tuples and for commit and preview
- **Freehand strokes** (pen/highlighter via drawing tool) → render as **Perfect Freehand polygon fill**
- **Perfect shapes** (snap via hold detector or shape tool) → render as **stroked polyline** (unchanged)
- **Commit path:** Freehand stores raw point tuples, Shapes store generated polyline
- **Render time:** Geometry pipeline branches on `kind` field. Freehand will compute the perfect freehand render with the raw tuples.

#### File: `client/src/renderer/stroke-builder/pf-config.ts` (NEW FILE)

Create this new file with shared PF options:

```typescript
/**
 * Shared Perfect Freehand options, fixed-width (no thinning/pressure).
 * Used by overlay preview (live) and base-canvas (commit).
 */
export const PF_OPTIONS_BASE = {
  // 'size' will be supplied at call-site to match stroke.style.size
  thinning: 0,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
} as const;
```
### STEP 1: Update Type Definitions

#### File: `/packages/shared/src/types/room.ts`

**Location:** After line 16 (within the Stroke interface)

**Add this new field:**
```typescript
export interface Stroke {
  id: StrokeId;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  points: number[]; // Keep for backward compat
  pointsTuples?: [number, number][]; // NEW: Add this line
  bbox: [number, number, number, number];
  scene: SceneIdx;
  createdAt: number;
  userId: UserId;
  kind: 'freehand' | 'shape';
}
```

#### File: `/packages/shared/src/types/snapshot.ts`

**Location:** After line 28 (within the StrokeView interface)

**Add this new field:**
```typescript
export interface StrokeView {
  id: StrokeId;
  points: ReadonlyArray<number>;
  pointsTuples?: [number, number][] | null; // NEW: Add this line
  polyline: Float32Array | null;
  style: {
    color: string;
    size: number;
    opacity: number;
    tool: 'pen' | 'highlighter';
  };
  bbox: [number, number, number, number];
  scene: SceneIdx;
  createdAt: number;
  userId: string;
  kind: 'freehand' | 'shape';
}
```

#### File: `client/src/lib/tools/types.ts`

**Add dual array storage to `DrawingState` for zero-conversion preview:**

```typescript
export interface DrawingState {
  isDrawing: boolean;
  pointerId: number | null;
  points: number[];             // flat centerline [x,y, x,y, ...] for commit/simplify
  pointsPF: [number, number][]; // PF-native live buffer [[x,y], [x,y], ...] for preview only

  // Tool settings frozen at gesture start
  config: DrawingToolConfig;
  startTime: number;
}
```
**Update `StrokePreview` to use PF-native tuples:**

```typescript
/**
 * StrokePreview is the preview data for drawing strokes
 * Used by DrawingTool and RenderLoop
 * IMPORTANT: Points are PF-native tuples to avoid per-frame conversions in overlay
 */
export interface StrokePreview {
  kind: 'stroke'; // Discriminant for union type
  points: [number, number][]; // PF-native tuples: [[x,y], [x,y], ...] in world coordinates
  tool: 'pen' | 'highlighter';
  color: string;
  size: number; // World units
  opacity: number;
  bbox: [number, number, number, number] | null; // Used for dirty rect tracking
}
```
**Rationale:** DrawingTool maintains both arrays in lockstep during drawing. The flat `points` array is used for commit on shapes and hold detector firing for shape recognition after 600ms dwell. The `pointsPF` tuple array is returned by `getPreview()` for zero-conversion rendering—Perfect Freehand accepts and returns tuples natively, so we avoid per-frame flat↔tuple conversions in the hot preview path.
**Note:** DrawingTool must maintain both `state.points` (flat) and `state.pointsPF` (tuples) in lockstep:
- In `resetState()`: initialize both as empty arrays `[]`
- In `startDrawing()`: initialize both with first point: `points: [x, y]` and `pointsPF: [[x, y]]`
- In `addPoint()` RAF callback: push to both: `points.push(...pending)` and `pointsPF.push([pending[0], pending[1]])`
- In `flushPending()`: push to both arrays
- In `getPreview()`: return `pointsPF` for freehand preview (not `points`)

#### File: `client/src/renderer/layers/preview.ts`

**Replace entire `drawPreview` function:**

```typescript
import type { StrokePreview,  } from '@/lib/tools/types';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from '../stroke-builder/pf-config';

/**
 * Draw preview stroke
 * CRITICAL: This is called INSIDE world transform scope
 * The context has the world transform already applied when this is called
 * The preview is drawn as an authoring overlay AFTER world content but BEFORE transform restore
 * Preview points are in world coordinates and will be transformed to canvas automatically
 */
export function drawPreview(ctx: CanvasRenderingContext2D, preview: StrokePreview): void {
  if (!preview || preview.points.length < 2) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity; // Tool-specific opacity

  // PF input: [x,y][]; output: [x,y][] (not flat)
  const outline = getStroke(preview.points, {
    ...PF_OPTIONS_BASE,
    size: preview.size,
    last: false, // live preview
    
  });

  if (outline.length > 0) {
    const path = new Path2D();
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      path.lineTo(outline[i][0], outline[i][1]);
    }
    path.closePath();
    ctx.fillStyle = preview.color;
    ctx.fill(path);
  }

  ctx.restore();
}
```
**Note:** Perfect shape previews are handled separately by `perfect-shape-preview.ts` and remain unchanged.

---

**CHANGE: Modify commitStroke method (starting at line 361)**
The current freehand commit path does run simplification and only appends the final point to the flat array, not the PF tuple buffer, which can desync the last few points (exactly where corners are most sensitive). Both are core causes of your “ripple/chip” at sharp turns. 
There are two commit paths. commitStroke(...) is the freehand path; perfect shapes go through commitPerfectShapeFromPreview()
Concrete change:

Delete the simplification step and everything that depends on simplified.
Always push the final point into both buffers (points and pointsPF) if it wasn’t already there.
Persist the PF tuples as the canonical PF input alongside the flat array (for back-compat + bbox/transport).
Compute final bbox from the raw centerline (flat points), not from a simplified array.
Patch sketch :
```typescript
commitStroke(finalX: number, finalY: number): void {
  if (!this.state.isDrawing) return;

  // 1) Flush RAF first (unchanged)
  this.flushPending();

  // 2) Append final point to BOTH representations if needed
  const len = this.state.points.length;
  const needsFinal = len < 2 || this.state.points[len - 2] !== finalX || this.state.points[len - 1] !== finalY;
  if (needsFinal) {
    this.state.points.push(finalX, finalY);
    this.state.pointsPF.push([finalX, finalY]);      // ← ADD THIS to keep lockstep
  }

  // 3) Validate minimum points (unchanged)
  if (this.state.points.length < 4) { this.cancelDrawing(); return; }

  const previewBounds = this.lastBounds;

  // 5) Use raw centerline for size/bbox checks
  const rawPoints = this.state.points;
  // 6) Canonical PF tuples = exact tuple buffer used for preview (clone for immutability)
  const canonicalTuples = this.state.pointsPF.slice();
  const estimatedSize = estimateEncodedSize(rawPoints);
  if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) { /* handle too-large */ }

  const finalBbox = calculateBBox(rawPoints, this.state.config.size);
// 11) Commit to Y.Doc with BOTH raw points and canonical tuples
    const strokeId = ulid();
    const userId = this.userId;

    try {
      this.room.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const strokes = root.get('strokes') as Y.Array<any>;
        const meta = root.get('meta') as Y.Map<any>;

        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        if (!sceneTicks) {
          console.error('CRITICAL: scene_ticks not initialized - Phase 2 implementation is broken');
          return;
        }

        const currentScene = sceneTicks.length;

        strokes.push([
          {
            id: strokeId,
            tool: this.state.config.tool,
            color: this.state.config.color,
            size: this.state.config.size,
            opacity: this.state.config.opacity,
            points: rawPoints,              // Raw flat centerline (backward compat)
            pointsTuples: canonicalTuples,  // CRITICAL: Canonical PF tuples (authoritative for rendering)
            bbox: finalBbox,
            scene: currentScene,
            createdAt: Date.now(),
            userId,
            kind: 'freehand',
          },
        ]);
      });
    } catch (err) {
      console.error('Failed to commit stroke:', err);
    } finally {
      // 12) Invalidate preview + final bbox
      if (previewBounds) {
        this.onInvalidate?.(previewBounds);
      }
      if (finalBbox) {
        this.onInvalidate?.(finalBbox);
      }
      // 13) Reset state (finalOutline persists for held frame)
      this.resetState();
    }
}
```
By removing DP and storing tuples, the PF input is identical across preview and commit; the base canvas and the held preview can render the same outline (last:true) with identical inputs, erasing the ripple. Your current preview uses PF tuples with last:false, so without this alignment the final frame will still “bump.”

### 6. Path Builder (Dual Geometry)

#### File: `client/src/renderer/stroke-builder/path-builder.ts`
**Replace entire file:**

```typescript
import type { StrokeView } from '@avlo/shared';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from './pf-config';

export type PolylineData = {
  kind: 'polyline';
  path: Path2D | null;
  polyline: Float32Array;
  bounds: { x: number; y: number; width: number; height: number };
  pointCount: number;
};

export type PolygonData = {
  kind: 'polygon';
  path: Path2D | null;
  polygon: Float32Array;
  bounds: { x: number; y: number; width: number; height: number };
  pointCount: number;
};

export type StrokeRenderData = PolylineData | PolygonData;

/**
 * Builds POLYLINE render data (for perfect/snap shapes).
 * Creates Float32Array and Path2D at render time only.
 */
export function buildPolylineRenderData(stroke: StrokeView): PolylineData {
  const { points } = stroke;
  const stride = 2;
  const pointCount = Math.floor(points.length / stride);
  const polyline = new Float32Array(pointCount * 2);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasPath2D = typeof (globalThis as any).Path2D === 'function';
  const path = hasPath2D ? new Path2D() : null;

  if (pointCount === 0) {
    return {
      kind: 'polyline',
      path,
      polyline,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      pointCount: 0,
    };
  }

  // Extract first point
  let minX = points[0];
  let maxX = points[0];
  let minY = points[1];
  let maxY = points[1];

  if (path) {
    path.moveTo(points[0], points[1]);
  }
  polyline[0] = points[0];
  polyline[1] = points[1];

  // Process remaining points
  for (let i = 1; i < pointCount; i++) {
    const srcIdx = i * stride;
    const dstIdx = i * 2;

    const x = points[srcIdx];
    const y = points[srcIdx + 1];

    if (path) {
      path.lineTo(x, y);
    }
    polyline[dstIdx] = x;
    polyline[dstIdx + 1] = y;

    // Update bounds
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return { kind: 'polyline', path, polyline, bounds, pointCount };
}

/**
 * Builds PF POLYGON render data (for freehand).
 * Uses fixed-width PF (no thinning), polygon is filled at render.
 */
export function buildPFPolygonRenderData(stroke: StrokeView): PolygonData {
  const size = stroke.style.size;

  // CRITICAL FIX: canonical tuples for polygon
  const inputTuples = stroke.pointsTuples ?? [];

  // Use the canonical tuples 
  const outline = getStroke(inputTuples, {
    ...PF_OPTIONS_BASE,
    size,
    last: true, // finalized geometry on base canvas
  });
  

  // PF returns [[x,y], ...]; flatten once into typed array for draw
  const polygon = new Float32Array(outline.length * 2);
  for (let i = 0; i < outline.length; i++) {
    polygon[i * 2] = outline[i][0];
    polygon[i * 2 + 1] = outline[i][1];
  }

  const pointCount = outline.length;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasPath2D = typeof (globalThis as any).Path2D === 'function';
  const path = hasPath2D ? new Path2D() : null;

  if (path && pointCount > 0) {
    path.moveTo(polygon[0], polygon[1]);
    for (let i = 2; i < polygon.length; i += 2) {
      path.lineTo(polygon[i], polygon[i + 1]);
    }
    path.closePath();
  }

  // Bounds from polygon (not centerline) for accurate dirty-rects
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < polygon.length; i += 2) {
    const x = polygon[i], y = polygon[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return { kind: 'polygon', path, polygon, bounds, pointCount };
}
```

### 7. Stroke Cache (LRU with Geometry Variants)

#### File: `client/src/renderer/stroke-builder/stroke-cache.ts`

**Replace entire file:**

```typescript
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
```

---

### 8. Stroke Renderer

#### File: `client/src/renderer/layers/strokes.ts`

**Update `renderStroke()` function - around line 80:**

```typescript
function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeView,
  _viewTransform: ViewTransform,
): void {
  // Get or build render data (cache selects geometry based on stroke.kind)
  const renderData = strokeCache.getOrBuild(stroke);

  if (renderData.pointCount < 2) {
    return; // Need at least 2 points for a line
  }

  ctx.save();
  ctx.globalAlpha = stroke.style.opacity;

  if (renderData.kind === 'polygon') {
    // FREEHAND (PF polygon) → fill
    ctx.fillStyle = stroke.style.color;
    if (renderData.path) {
      ctx.fill(renderData.path);
    } else {
      // Rare test fallback (no Path2D)
      ctx.beginPath();
      const pg = renderData.polygon;
      ctx.moveTo(pg[0], pg[1]);
      for (let i = 2; i < pg.length; i += 2) {
        ctx.lineTo(pg[i], pg[i + 1]);
      }
      ctx.closePath();
      ctx.fill();
    }
  } else {
    // SHAPES (polyline) → stroke
    ctx.strokeStyle = stroke.style.color;
    ctx.lineWidth = stroke.style.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.style.tool === 'highlighter') {
      ctx.globalCompositeOperation = 'source-over';
    }

    if (renderData.path) {
      ctx.stroke(renderData.path);
    } else {
      // Fallback when Path2D not available (tests)
      ctx.beginPath();
      const pl = renderData.polyline;
      ctx.moveTo(pl[0], pl[1]);
      for (let i = 2; i < pl.length; i += 2) {
        ctx.lineTo(pl[i], pl[i + 1]);
      }
      ctx.stroke();
    }
  }

  ctx.restore();
}
```

---

### 9. Canvas Invalidation (ID-based Cache Eviction)

#### File: `client/src/renderer/layers/index.ts`

**Add export for cache invalidation:**

```typescript
// Existing exports
export { drawStrokes, clearStrokeCache } from './strokes';
export { drawText } from './text';

// NEW: ID-keyed geometry cache eviction (used by Canvas on bbox changes/removals)
import { getStrokeCacheInstance } from '../stroke-builder/stroke-cache';

export function invalidateStrokeCacheByIds(ids: Iterable<string>) {
  getStrokeCacheInstance().invalidateMany(ids);
}
```

#### File: `client/src/canvas/Canvas.tsx`

---

# 0) Quick model of “how the cache actually works” (so Canvas can play nice)

* **Cache entry scope:** one entry **per stroke id**.
* **Variants:** each entry holds a tiny map of **geometry variants**, keyed by a **geokey**:

  * Shapes (stroked polyline) ⇒ geometry is **width-independent** → geokey `'pl'`.
  * Freehand (PF polygon) ⇒ geometry **depends on width** → geokey like
    `pf:s=<size>;sm=0.5;sl=0.5;th=0;pr=0`.
  * The cache decides which builder to run (polyline vs PF polygon) by the stroke’s semantic `kind`. 
* **LRU policy:** map insertion order acts as LRU over **stroke ids**. When over the cap, pop the oldest id. Invalidating an id drops **all its variants**.  