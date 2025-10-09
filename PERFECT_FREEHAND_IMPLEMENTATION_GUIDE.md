# Perfect Freehand Implementation Guide

## Overview

This guide implements Perfect Freehand library integration for smooth, jaggy-free freehand stroke rendering while maintaining perfect shapes as-is. The implementation uses an explicit `kind: 'freehand' | 'shape'` semantic flag to distinguish rendering paths. 

## Installation

```bash
# At client package root
npm i perfect-freehand
# or: yarn add perfect-freehand or pnpm add perfect-freehand
```

**Version:** 1.2.2 (current stable)
**Import:** Named export `getStroke` from `'perfect-freehand'`

---

## Implementation Structure

### Core Principle

- **Freehand strokes** (pen/highlighter via drawing tool) → render as **Perfect Freehand polygon fill**
- **Perfect shapes** (snap via hold detector or shape tool) → render as **stroked polyline** (unchanged)
- **Commit path:** Both store simplified centerline (RDP for freehand, generated polyline for shapes)
- **Render time:** Geometry pipeline branches on `kind` field. Freehand will compute the perfect freehand render once from the centerline.

**Terminology**: Stroke width = visual thickness. In the model this is style.size. Perfect Freehand’s size option is fed from style.size.
Object size = geometric scaling. This does not change Stroke width. It’s a later-phase select/lasso feature and is independent of PF.
Shapes vs Freehand: Shapes render as stroked polylines (width-independent geometry). Freehand renders as a PF polygon fill (width-dependent geometry), built at render time from the stored centerline.

### File Changes Summary

1. Type definitions (add `kind` field)
2. DrawingTool commit paths (stamp `kind`)
3. RoomDocManager snapshot building (copy `kind` with back-compat)
4. PF config (shared options)
5. Preview rendering (PF for freehand preview)
6. Path builder (dual builders: polyline vs PF polygon)
7. Stroke cache (LRU with geometry variants)
8. Stroke renderer (branch on `kind`)
9. Canvas invalidation (ID-based cache eviction)
10. Export helpers (cache invalidation API)

---

## Detailed Implementation

### 1. Type Definitions

#### File: `packages/shared/src/types/room.ts`

**Add `kind` field to persisted `Stroke` interface:**

```typescript
export interface Stroke {
  id: StrokeId;
  tool: 'pen' | 'highlighter';
  color: string; // #RRGGBB format
  size: number; // world units (px at scale=1)
  opacity: number; // 0..1; highlighter default 0.25
  points: number[]; // CRITICAL: flattened [x0,y0, x1,y1, ...]
  // NEVER Float32Array in storage
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] world units
  scene: SceneIdx; // assigned at commit time
  createdAt: number; // ms epoch timestamp
  userId: UserId; // awareness id at commit
  /**
   * Semantic origin of the geometry:
   *  - 'freehand' => renderer builds a Perfect Freehand polygon and fills it
   *  - 'shape'    => renderer strokes the polyline as-is (perfect/snap shapes)
   */
  kind: 'freehand' | 'shape';
}
```

#### File: `packages/shared/src/types/snapshot.ts`

**Add `kind` field to `StrokeView` interface:**

```typescript
export interface StrokeView {
  id: StrokeId;
  points: ReadonlyArray<number>; // Raw points from Y.Doc (stored as number[], never Float32Array)
  polyline: Float32Array | null; // Built at RENDER time ONLY from points
  // Will be null in snapshot, created during canvas render from points
  style: {
    color: string;
    size: number;
    opacity: number;
    tool: 'pen' | 'highlighter';
  };
  bbox: [number, number, number, number];
  scene: SceneIdx; // Scene where stroke was committed (assigned at commit time using currentScene)
  createdAt: number;
  userId: string;
  /**
   * Same semantic flag as in Stroke (copied through snapshot pipeline).
   * Renderer maps kind -> geometry pipeline (polygon vs polyline).
   */
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

**Rationale:** DrawingTool maintains both arrays in lockstep during drawing. The flat `points` array is used for commit (simplification, bbox calculation). The `pointsPF` tuple array is returned by `getPreview()` for zero-conversion rendering—Perfect Freehand accepts and returns tuples natively, so we avoid per-frame flat↔tuple conversions in the hot preview path.

---

### 2. DrawingTool Commit Paths

#### File: `client/src/lib/tools/DrawingTool.ts`

**Location 1: `commitStroke()` method (freehand path) - around line 425**

Add `kind: 'freehand'` to the stroke object:

```typescript
strokes.push([
  {
    id: strokeId,
    tool: this.state.config.tool, // Frozen at start
    color: this.state.config.color, // Frozen at start
    size: this.state.config.size, // Frozen at start
    opacity: this.state.config.opacity, // Frozen at start
    points: simplified, // Plain number[]
    bbox: simplifiedBbox,
    scene: currentScene,
    createdAt: Date.now(),
    userId,
    kind: 'freehand', // NEW: explicit semantic flag
  },
]);
```

**Location 2: `commitPerfectShapeFromPreview()` method (perfect shape path) - around line 583**

Add `kind: 'shape'` to the stroke object:

```typescript
strokes.push([{
  id: strokeId,
  tool: this.state.config.tool,
  color: this.state.config.color,
  size: this.state.config.size,
  opacity: this.state.config.opacity,
  points,  // Generated polyline
  bbox,    // Computed at commit
  scene: currentScene,
  createdAt: Date.now(),
  userId: this.userId,
  kind: 'shape', // NEW: explicit semantic flag
}]);
```

**Important:** DrawingTool must maintain both `state.points` (flat) and `state.pointsPF` (tuples) in lockstep:
- In `resetState()`: initialize both as empty arrays `[]`
- In `startDrawing()`: initialize both with first point: `points: [x, y]` and `pointsPF: [[x, y]]`
- In `addPoint()` RAF callback: push to both: `points.push(...pending)` and `pointsPF.push([pending[0], pending[1]])`
- In `flushPending()`: push to both arrays
- In `getPreview()`: return `pointsPF` for freehand preview (not `points`)

This ensures zero-conversion overhead in the preview rendering hot path.

---

### 3. RoomDocManager Snapshot Building

#### File: `client/src/lib/room-doc-manager.ts`

**Location: `buildSnapshot()` method - around line 1691**

Add `kind` field to StrokeView mapping with backward compatibility:

```typescript
const strokes = allStrokes
  .filter((s) => {
    const match = s.scene === currentScene;
    if (!match) {
      // Filtering stroke by scene
    }
    return match;
  })
  .map((s) => ({
    id: s.id,
    points: s.points, // Include points for renderer to build Float32Array
    // CRITICAL: Float32Array MUST be created at render time only, never in snapshot
    polyline: null as unknown as Float32Array | null, // Will be created at render time from points
    style: {
      color: s.color,
      size: s.size,
      opacity: s.opacity,
      tool: s.tool,
    },
    bbox: s.bbox,
    scene: s.scene, // Include scene field (assigned at commit time, used for filtering)
    createdAt: s.createdAt,
    userId: s.userId,
    kind: (s as any).kind ?? 'shape', // NEW: copy kind with back-compat default
  }));
```

**Explanation:** Legacy strokes (created before this change) will not have a `kind` field. We default to `'shape'` to preserve existing "stroked polyline" rendering behavior.

---

### 4. Perfect Freehand Configuration

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

---

### 5. Preview Rendering

#### File: `client/src/renderer/layers/preview.ts`

**Replace entire `drawPreview` function:**

```typescript
import type { StrokePreview } from '@/lib/tools/types';
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

// Use a MUTABLE 2-tuple to match PF's accepted point type
type Vec2 =  [number, number];

/**
 * Convert flat points array to PF-native tuples (one-time conversion at cache build).
 */
function flatToPairs(points: ReadonlyArray<number>): Vec2[] {
  const n = (points.length / 2) | 0;
  const out = new Array<Vec2>(n);
  // i = source index (flat), j = tuple index
  for (let i = 0, j = 0; j < n; j++, i += 2) {
    // as const ensures each element is treated as a readonly 2-tuple
    out[j] = [points[i], points[i + 1]] as const;
  }
  return out;
}

/**
 * Builds PF POLYGON render data (for freehand).
 * Uses fixed-width PF (no thinning), polygon is filled at render.
 */
export function buildPFPolygonRenderData(stroke: StrokeView): PolygonData {
  const size = stroke.style.size;

  // Convert flat→tuples once, then call PF with last:true
  const outline = getStroke(flatToPairs(stroke.points), {
    ...PF_OPTIONS_BASE,
    size,
    last: true, // finalized geometry on the base canvas
  });

  // PF returns [[x,y], ...]; flatten once into a typed array for draw
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
    x: minX || 0,
    y: minY || 0,
    width: (maxX - minX) || 0,
    height: (maxY - minY) || 0
  };

  return { kind: 'polygon', path, polygon, bounds, pointCount };
}

/**
 * Checks if a stroke's bbox is visible in the viewport.
 * Inflates bbox by half the stroke width since bbox is computed from points only.
 * Used for culling optimization.
 */
export function isStrokeVisible(
  stroke: StrokeView,
  viewportBounds: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const [minX, minY, maxX, maxY] = stroke.bbox;
  const halfWidth = stroke.style.size / 2;

  return !(
    maxX + halfWidth < viewportBounds.minX ||
    minX - halfWidth > viewportBounds.maxX ||
    maxY + halfWidth < viewportBounds.minY ||
    minY - halfWidth > viewportBounds.maxY
  );
}
```

---

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

---

# 1) What `Canvas.tsx` does today that we must extend

* `diffBounds()` only looks at **bbox equality** to decide dirty rectangles for strokes (and positions/sizes for texts). That correctly catches adds/removes and **geometry** edits, but it **misses style-only changes** (color/opacity/width) because those typically don’t modify the bbox. 

* In the snapshot subscription, you compute `changedBounds` using that function and call `invalidateWorld(bounds)` for base canvas; overlay is separately handled and already has a “hold one frame” to avoid flicker at commit. We’ll keep that, we’ll just teach the diff to also notice style-only changes and to emit **evict ids** where necessary.  

---

# 2) Minimal, low-churn changes to `Canvas.tsx`

Then import it in `Canvas.tsx`:

```ts
import {
  clearStrokeCache,
  drawPresenceOverlays,
  invalidateStrokeCacheByIds, // NEW
} from '../renderer/layers';
```

(These are exactly what your PF guide sketched.)  

## 2.b Replace `diffBounds` with `diffBoundsAndEvicts`

Add a style equality helper and return both **dirty bounds** and **ids to evict**. The principle:

* **Evict** ids when a stroke **disappears** or its **bbox changed** (i.e., geometry changed).
* **Dirty-only** when **style changed but bbox didn’t**.


```ts
type EvictId = string;
type DiffResult = {
  dirty: WorldBounds[];
  evictIds: EvictId[];
};

function stylesEqual(
  a: { color: string; size: number; opacity: number},
  b: { color: string; size: number; opacity: number},
) {
  return a.color === b.color && a.size === b.size && a.opacity === b.opacity;
}


function bboxToBounds(b: [number, number, number, number]): WorldBounds {
  return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
}

function diffBoundsAndEvicts(prev: Snapshot, next: Snapshot): DiffResult {
  const prevSt = new Map(prev.strokes.map(s => [s.id, s]));
  const nextSt = new Map(next.strokes.map(s => [s.id, s]));
  const dirty: WorldBounds[] = [];
  const evict = new Set<string>();

  // Added / modified
  for (const [id, n] of nextSt) {
    const p = prevSt.get(id);
    if (!p) {
      // Added: repaint only (cache had no entry)
      dirty.push(bboxToBounds(n.bbox));
      continue;
    }

    const bboxChanged = !bboxEquals(p.bbox, n.bbox);
    const styleChanged = !styleEquals(p.style, n.style); // ← compare .size here

    if (bboxChanged) {
      // Geometry changed → evict, and repaint old+new footprint
      evict.add(id);
      bounds.push(bboxToBounds(p.bbox));
      bounds.push(bboxToBounds(n.bbox));
    } else if (styleChanged) {
      // Style only → repaint, no eviction (low churn)
      dirty.push(bboxToBounds(n.bbox));
    }
  }

  // Removed
  for (const [id, p] of prevSt) {
    if (!nextSt.has(id)) {
      evict.add(id);
      dirty.push(bboxToBounds(p.bbox));
    }
  }

  // --- Text blocks ---
  const prevTxt = new Map(prev.texts.map(t => [t.id, t]));
  const nextTxt = new Map(next.texts.map(t => [t.id, t]));

  for (const [id, n] of nextTxt) {
    const p = prevTxt.get(id);
    const rectChanged = !p || p.x !== n.x || p.y !== n.y || p.w !== n.w || p.h !== n.h;
    const styleOrContentChanged = !!p && (p.color !== n.color || p.size !== n.size || p.content !== n.content);
    if (rectChanged || styleOrContentChanged) {
      dirty.push({ minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h });
      if (p && rectChanged) dirty.push({ minX: p.x, minY: p.y, maxX: p.x + p.w, maxY: p.y + p.h });
    }
  }
  for (const [id, p] of prevTxt) {
    if (!nextTxt.has(id)) {
      dirty.push({ minX: p.x, minY: p.y, maxX: p.x + p.w, maxY: p.y + p.h });
    }
  }

  return { dirty, evictIds: [...evict] };
}
```

> Note: your `DirtyRectTracker` already inflates and coalesces; keep emitting **raw world bboxes** here (no manual padding). 

## 2.c Use the new diff in the snapshot subscription

Inside the `subscribeSnapshot` handler in `Canvas.tsx`, replace the old callsite:

```ts
// was:
const changedBounds = diffBounds(prevSnapshot, newSnapshot);
for (const bounds of changedBounds) {
  renderLoopRef.current.invalidateWorld(bounds);
}
overlayLoopRef.current.invalidateAll();
```

with:

```ts
const { dirty, evictIds } = diffBoundsAndEvicts(prevSnapshot, newSnapshot);

// Evict geometry for ids whose geometry footprint changed or were removed
if (evictIds.length) {
  invalidateStrokeCacheByIds(evictIds);
}

// Repaint everything that changed style or geometry, additions/removals, etc.
// (DirtyRectTracker will coalesce or promote to full clear if appropriate.)
for (const b of dirty) {
  renderLoopRef.current.invalidateWorld(b);
}

overlayLoopRef.current.invalidateAll();
```

---


## Cache Eviction Behavior Matrix

| Change Type                         | Freehand (PF polygon)           | Perfect Shape (polyline)       |
|-------------------------------------|---------------------------------|--------------------------------|
| **Color/Opacity/ change**           | No evict (bbox unchanged)       | No evict (bbox unchanged)      |
| **Size(width) change**              | No evict (Cache stores new Variant) | No evict (render-time width)   |
| **Move/Resize (points change)**     | **Evict** (bbox changes)        | **Evict** (bbox changes)       |
| **Delete**                          | **Evict**                       | **Evict**                      |
| **Add new**                         | No evict (no prior cache)       | No evict (no prior cache)      |
Style-only change (color, opacity, width) with bbox unchanged:
Dirty: YES (you need a repaint).
Evict: NO (geometry didn’t change)
* **Text repaint**: adding the style/content check ensures color/font changes repaint even when the box is stable (previously missed). The dirty rectangles for text still lean on the tracker to inflate/coalesce. (Your overview shows text is drawn by the base canvas after strokes, so this is sufficient.) 

---

## Testing Checklist

### Visual Parity
- [ ] Freehand strokes (pen/highlighter) render smooth at all zoom levels
- [ ] Perfect shapes (line/circle/box/rect/ellipse/arrow) render unchanged
- [ ] Preview matches committed rendering (no flash/mismatch)
- [ ] Color/opacity changes don't rebuild geometry (check performance)

### Performance
- [ ] LRU cache eviction works (monitor cache size)
- [ ] No stuttering during continuous drawing
- [ ] Dirty rect invalidation still works correctly
- [ ] Scene change clears cache properly

---

## Architecture Notes

The `kind: 'freehand' | 'shape'` field describes **what the user drew**, not **how to render it**. This semantic approach:
**Clear intent:** Renderer knows user intent, not just "was RDP applied?"
**Editable:** Future select/resize tools can preserve stroke kind through transforms

- **Polyline builder** (`buildPolylineRenderData`): Fast, width-independent, used for perfect shapes
- **Polygon builder** (`buildPFPolygonRenderData`): Width-dependent(but not evicted), filled, used for freehand
Both produce `Path2D` + typed arrays for hardware-accelerated rendering.

### Why LRU Over FIFO

- **Better hit rate:** Hot strokes (visible/edited) stay cached during panning
- **Predictable eviction:** Least-recently-used strokes evicted first, not oldest
- **Memory bound:** Cap at 1000 entries prevents unbounded growth

### Why Geometry Variants

- **Style-only edits** (color/opacity) don't invalidate geometry → **zero cache churn**
- **Width changes** on freehand trigger new PF polygon variant → **correct rendering**
- **Width changes** on shapes reuse polyline geometry → **fast recolor**

---

## Future Enhancements (Out of Scope)
- Stroke background fills (trivial: PF polygon is already a fill)
- Shape fills (geometric, not PF-based)
- Lasso/select/resize with ID-keyed invalidation
- Stroke outline option (dual-pass: fill + stroke)

---

## Summary

This implementation:

1. **Adds `kind` field** to both `Stroke` (Yjs) and `StrokeView` (snapshot)
2. **Stamps `kind`** at commit time in DrawingTool
3. **Uses Perfect Freehand** for freehand preview and rendering (polygon fill)
4. **Keeps perfect shapes** as stroked polylines (unchanged)
5. **LRU cache** with geometry variants (style-only edits don't evict)
6. **ID-based invalidation** from bbox diff in Canvas.tsx
7. **Zero schema migration** (backward compatible with default to `'shape'`)

**Result:** Smooth, jaggy-free freehand strokes at all zoom levels while maintaining crisp perfect shapes.
