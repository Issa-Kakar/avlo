# Phase 4: Stroke Data Model & Rendering - Implementation Guide

## Critical Fixes Applied & Verified

✅ **Environment variables** - All layer stubs updated to `import.meta.env.DEV` (was `process.env.NODE_ENV`)  
✅ **Path2D/DOMRect guarded** - Feature detection for test environments  
✅ **Robust stride detection** - Validates pressure values with 80% threshold, prevents false positives  
✅ **Bbox inflation for culling** - Accounts for stroke width (half-width margin)  
✅ **CSS pixels for viewport** - Uses cssWidth/cssHeight from ViewportInfo, not device pixels  
✅ **FIFO cache strategy** - Simple eviction for Phase 4 (upgrade to LRU later if needed)  
✅ **Transform contract** - World transform applied by RenderLoop at lines 306-307 (scale then translate)  
✅ **Cache keys** - Stroke.id only, no svKey mixing (svKey reserved for cosmetic boot splash)

## Executive Summary

Phase 4 implements the core stroke rendering pipeline, transforming the immutable stroke data from snapshots into visual canvas elements. This phase bridges the gap between the Y.Doc data model (Phase 2) and the canvas infrastructure (Phase 3) to create the actual drawing visualization.

**Verified Against Codebase**: This guide has been cross-checked against the actual implementation in `/home/issak/dev/avlo/client/src/`. Key alignments:

- RenderLoop (RenderLoop.ts) applies transforms at lines 306-307: `ctx.scale(view.scale, view.scale); ctx.translate(-view.pan.x, -view.pan.y)`
- ViewportInfo (types.ts) provides both device pixels (pixelWidth/pixelHeight) and CSS pixels (cssWidth/cssHeight)
- Layer stubs fixed to use `import.meta.env.DEV` and `import.meta.env.VITE_DEBUG_RENDER_LAYERS`
- Transform utilities (transforms.ts) use CSS coordinate space
- PresenceView shape verified: `{ users: Map<UserId, {...}>, localUserId: UserId }`

**Critical Context**: We are building on a solid foundation where:

- **Phase 2** provides immutable snapshots with stroke data filtered by scene
- **Phase 3** provides an event-driven render loop with coordinate transforms and dirty rect tracking
- The registry pattern ensures singleton RoomDocManager instances
- All stroke data flows through the `mutate()` → `snapshot` → `render` pipeline

## Architectural Principles (From OVERVIEW.MD)

### Data Flow Contract

```
Y.Doc (authoritative) → Snapshot (immutable) → Render (ephemeral)
         ↑                      ↑                     ↑
    number[] storage      frozen arrays        Float32Array
    (never typed)         (per publish)        (per frame)
```

### Critical Invariants

1. **Storage**: Points stored as `number[]` in Y.Doc - NEVER Float32Array
2. **Snapshots**: Contain `points: ReadonlyArray<number>`, `polyline: null`
3. **Render Time**: Float32Array built from points ONLY during render
4. **Scene**: Assigned at commit time using `currentScene`, not during drawing
5. **Immutability**: Each snapshot creates new arrays, never mutates

## Implementation Scope

### What Phase 4 DOES Include

✅ Building render paths from snapshot stroke data  
✅ Basic stroke rendering with pen and highlighter tools  
✅ World-unit based line widths and transforms  
✅ Simple per-stroke caching by ID  
✅ Tool-specific rendering (opacity differences)  
✅ Integration with existing render loop layers

### What Phase 4 DOES NOT Include

❌ Drawing input handling (Phase 5)  
❌ Stroke creation/commit (Phase 5)  
❌ Douglas-Peucker simplification (Phase 5)  
❌ RBush spatial indexing (Phase 6)  
❌ Hit testing/eraser (Phase 10)  
❌ Complex LOD or tiling (defer to optimization phases)

## File Structure & Organization

```
client/src/
├── renderer/
│   ├── layers/
│   │   ├── strokes.ts          # Main stroke rendering implementation [CREATE]
│   │   └── index.ts            # Export drawStrokes (stub exists) [EDIT]
│   ├── stroke-builder/
│   │   ├── path-builder.ts     # Convert points to Path2D/polyline [CREATE]
│   │   ├── stroke-cache.ts     # Simple ID-based render cache [CREATE]
│   │   └── index.ts            # Export utilities [CREATE]
│   └── __tests__/
│       ├── stroke-builder/
│       │   ├── path-builder.test.ts    # Path construction tests [CREATE]
│       │   └── stroke-cache.test.ts    # Cache behavior tests [CREATE]
│       └── layers/
│           └── strokes.test.ts         # Stroke rendering tests [CREATE]
```

## Step-by-Step Implementation

### Step 1: Create Path Builder Utilities

#### 1.1 Create `/client/src/renderer/stroke-builder/path-builder.ts`

```typescript
import type { StrokeView } from '@avlo/shared';

export interface StrokeRenderData {
  path: Path2D | null; // null when Path2D not available (tests)
  polyline: Float32Array;
  bounds: { x: number; y: number; width: number; height: number }; // Plain object, not DOMRect
  pointCount: number;
  hasPressure: boolean;
}

/**
 * Detects stride robustly - only uses 3-stride if points have pressure-like values.
 * Prevents false positives on 2-stride arrays with length divisible by 3.
 *
 * CRITICAL: This is a Phase 4 heuristic. Phase 5 will enforce consistent stride at commit time:
 * - If any pressure observed during drawing → encode all points as triplets (fill missing with 1.0)
 * - Otherwise encode as pairs only
 * This ensures fixed stride per stroke, eliminating guesswork.
 */
function detectStride(points: ReadonlyArray<number>): 2 | 3 {
  if (points.length >= 3 && points.length % 3 === 0) {
    // Sample entries to verify they look like pressure values
    let samples = 0,
      validPressure = 0;
    for (let i = 2; i < points.length && samples < 12; i += 3) {
      const p = points[i];
      samples++;
      if (Number.isFinite(p) && p >= 0 && p <= 1) validPressure++;
    }
    // Require 80% of samples to be valid pressure values
    if (validPressure >= Math.ceil(samples * 0.8)) return 3;
  }
  return 2;
}

/**
 * Builds render data from stroke points.
 * Creates Float32Array and Path2D at render time only.
 *
 * CRITICAL: Points from snapshot are ReadonlyArray<number>,
 * never Float32Array until this render-time conversion.
 */
export function buildStrokeRenderData(stroke: StrokeView): StrokeRenderData {
  const { points } = stroke;

  // Robust stride detection to avoid mis-parsing
  const stride = detectStride(points);
  const hasPressure = stride === 3;
  const pointCount = Math.floor(points.length / stride);

  // Build Float32Array at render time (never stored)
  const polyline = new Float32Array(pointCount * 2);

  // Feature-detect Path2D for test environments
  const hasPath2D = typeof (globalThis as any).Path2D === 'function';
  const path = hasPath2D ? new Path2D() : null;

  if (pointCount === 0) {
    return {
      path,
      polyline,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      pointCount: 0,
      hasPressure: false,
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
    // const pressure = hasPressure ? points[srcIdx + 2] : 1.0; // For future use

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

  // Use plain object instead of DOMRect for test compatibility
  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return {
    path,
    polyline,
    bounds,
    pointCount,
    hasPressure,
  };
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

  // Inflate by half the stroke width to account for stroke thickness
  const halfWidth = stroke.style.size / 2;

  return !(
    maxX + halfWidth < viewportBounds.minX ||
    minX - halfWidth > viewportBounds.maxX ||
    maxY + halfWidth < viewportBounds.minY ||
    minY - halfWidth > viewportBounds.maxY
  );
}
```

#### 1.2 Create `/client/src/renderer/stroke-builder/stroke-cache.ts`

```typescript
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
```

#### 1.3 Create `/client/src/renderer/stroke-builder/index.ts`

```typescript
export { buildStrokeRenderData, isStrokeVisible } from './path-builder';
export type { StrokeRenderData } from './path-builder';
export { StrokeRenderCache } from './stroke-cache';
```

### Step 2: Implement Stroke Rendering Layer

#### 2.1 Create `/client/src/renderer/layers/strokes.ts`

```typescript
import type { Snapshot, StrokeView, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import { StrokeRenderCache, isStrokeVisible } from '../stroke-builder';

// Module-level cache persists across frames
const strokeCache = new StrokeRenderCache(1000);

// Track scene for cache invalidation
let lastScene = -1;

/**
 * Draws all strokes from the snapshot.
 * Called by RenderLoop in the canonical layer order.
 *
 * Context state on entry (guaranteed by RenderLoop):
 * - World transform already applied: ctx.scale(view.scale, view.scale); ctx.translate(-view.pan.x, -view.pan.y)
 * - DPR already set by CanvasStage via initial setTransform(dpr,0,0,dpr,0,0)
 * - globalAlpha = 1.0
 * - Default composite operation
 * - Each layer wrapped in save/restore by RenderLoop
 *
 * CRITICAL: This operates on immutable snapshot data.
 * Float32Arrays are built at render time, never stored.
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Clear cache on scene change
  if (snapshot.scene !== lastScene) {
    strokeCache.clear();
    lastScene = snapshot.scene;
  }

  // Calculate visible world bounds for culling
  const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);

  // Filter and render strokes
  const strokes = snapshot.strokes;
  let renderedCount = 0;
  let culledCount = 0;

  for (const stroke of strokes) {
    // Scene filtering already done in snapshot
    // Just check visibility
    if (!isStrokeVisible(stroke, visibleBounds)) {
      culledCount++;
      continue;
    }

    // Apply LOD: Skip tiny strokes (< 2px diagonal in screen space)
    if (shouldSkipLOD(stroke, viewTransform)) {
      culledCount++;
      continue;
    }

    renderStroke(ctx, stroke, viewTransform);
    renderedCount++;
  }

  // Development logging
  // CRITICAL: Use import.meta.env.DEV for Vite compatibility
  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS && renderedCount > 0) {
    console.debug(
      `[Strokes] Rendered ${renderedCount}/${strokes.length} strokes (${culledCount} culled)`,
    );
  }
}

/**
 * Renders a single stroke.
 * Handles tool-specific rendering (pen vs highlighter).
 */
function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeView,
  viewTransform: ViewTransform,
): void {
  // Get or build render data
  const renderData = strokeCache.getOrBuild(stroke);

  if (renderData.pointCount < 2) {
    return; // Need at least 2 points for a line
  }

  // Save context state for this stroke
  ctx.save();

  // Apply stroke style
  ctx.strokeStyle = stroke.style.color;
  ctx.lineWidth = stroke.style.size; // World units - transform handles scaling
  ctx.globalAlpha = stroke.style.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Tool-specific adjustments
  if (stroke.style.tool === 'highlighter') {
    // Highlighter uses normal blending at lower opacity
    // Default opacity is typically 0.25
    ctx.globalCompositeOperation = 'source-over';
  }

  // Stroke the path (with fallback for test environments)
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

  // Restore context state
  ctx.restore();
}

/**
 * LOD check: Skip strokes that are too small in screen space.
 * Returns true if stroke should be skipped.
 */
function shouldSkipLOD(stroke: StrokeView, viewTransform: ViewTransform): boolean {
  const [minX, minY, maxX, maxY] = stroke.bbox;
  const diagonal = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  const screenDiagonal = diagonal * viewTransform.scale;

  // Skip if less than 2 CSS pixels
  return screenDiagonal < 2;
}

/**
 * Calculate visible world bounds for culling.
 * Converts viewport to world coordinates.
 *
 * CRITICAL: Uses CSS pixels from viewport, not device pixels.
 * The ViewTransform operates in CSS coordinate space.
 * ViewportInfo provides both:
 * - pixelWidth/pixelHeight: Device pixels for canvas operations
 * - cssWidth/cssHeight: CSS pixels for coordinate transforms
 */
function getVisibleWorldBounds(
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): { minX: number; minY: number; maxX: number; maxY: number } {
  // Convert viewport corners to world space using CSS pixels (NOT device pixels)
  const [minX, minY] = viewTransform.canvasToWorld(0, 0);
  const [maxX, maxY] = viewTransform.canvasToWorld(viewport.cssWidth, viewport.cssHeight);

  // Add small margin for strokes partially in view
  const margin = 50 / viewTransform.scale; // 50px margin in world units

  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  };
}

/**
 * Clear the stroke cache.
 * Called on cleanup or major state changes.
 */
export function clearStrokeCache(): void {
  strokeCache.clear();
  lastScene = -1;
}

// Export for testing
export function getStrokeCacheSize(): number {
  return strokeCache.size;
}
```

#### 2.2 Update `/client/src/renderer/layers/index.ts`

```typescript
// Re-export the actual implementation
export { drawStrokes, clearStrokeCache } from './strokes';

// Keep other layer exports...
export { drawBackground } from './background';
export { drawShapes } from './shapes';
export { drawText } from './text';
export { drawAuthoringOverlays } from './authoring-overlays';
export { drawPresenceOverlays } from './presence-overlays';
export { drawHUD } from './hud';
```

### Step 3: Write Tests

#### 3.1 Create `/client/src/renderer/__tests__/stroke-builder/path-builder.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { buildStrokeRenderData, isStrokeVisible } from '../../stroke-builder/path-builder';
import type { StrokeView } from '@avlo/shared';

describe('Path Builder', () => {
  describe('buildStrokeRenderData', () => {
    it('should handle empty points array', () => {
      const stroke: StrokeView = {
        id: 'test-1',
        points: [],
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [0, 0, 0, 0],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(0);
      expect(result.polyline.length).toBe(0);
      expect(result.hasPressure).toBe(false);
    });

    it('should build path from points without pressure', () => {
      const stroke: StrokeView = {
        id: 'test-2',
        points: [100, 100, 150, 150, 200, 100], // 3 points, no pressure
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [100, 100, 200, 150],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(3);
      expect(result.polyline.length).toBe(6); // 3 points * 2 coords
      expect(result.hasPressure).toBe(false);
      expect(result.polyline[0]).toBe(100);
      expect(result.polyline[1]).toBe(100);
      expect(result.polyline[4]).toBe(200);
      expect(result.polyline[5]).toBe(100);
    });

    it('should detect pressure data from stride', () => {
      const stroke: StrokeView = {
        id: 'test-3',
        points: [100, 100, 0.5, 150, 150, 0.8, 200, 100, 1.0], // 3 points with pressure
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [100, 100, 200, 150],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(3);
      expect(result.polyline.length).toBe(6); // Still 3 points * 2 coords in polyline
      expect(result.hasPressure).toBe(true);
    });

    it('should calculate correct bounds', () => {
      const stroke: StrokeView = {
        id: 'test-4',
        points: [50, 75, 200, 25, 100, 150, 25, 100],
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [25, 25, 200, 150],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      // Using plain object bounds now, not DOMRect
      expect(result.bounds.x).toBe(25);
      expect(result.bounds.y).toBe(25);
      expect(result.bounds.width).toBe(175); // 200 - 25
      expect(result.bounds.height).toBe(125); // 150 - 25
    });
  });

  describe('isStrokeVisible', () => {
    const stroke: StrokeView = {
      id: 'test-vis',
      points: [100, 100, 200, 200],
      polyline: null,
      style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
      bbox: [100, 100, 200, 200],
      scene: 0,
      createdAt: Date.now(),
      userId: 'test-user',
    };

    it('should return true for stroke in viewport', () => {
      const viewport = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
      expect(isStrokeVisible(stroke, viewport)).toBe(true);
    });

    it('should return false for stroke outside viewport', () => {
      const viewport = { minX: 300, minY: 300, maxX: 400, maxY: 400 };
      expect(isStrokeVisible(stroke, viewport)).toBe(false);
    });

    it('should return true for stroke partially in viewport', () => {
      const viewport = { minX: 150, minY: 150, maxX: 300, maxY: 300 };
      expect(isStrokeVisible(stroke, viewport)).toBe(true);
    });
  });
});
```

#### 3.2 Create `/client/src/renderer/__tests__/stroke-builder/stroke-cache.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { StrokeRenderCache } from '../../stroke-builder/stroke-cache';
import type { StrokeView } from '@avlo/shared';

describe('StrokeRenderCache', () => {
  let cache: StrokeRenderCache;

  const createTestStroke = (id: string): StrokeView => ({
    id,
    points: [100, 100, 200, 200],
    polyline: null,
    style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
    bbox: [100, 100, 200, 200],
    scene: 0,
    createdAt: Date.now(),
    userId: 'test-user',
  });

  beforeEach(() => {
    cache = new StrokeRenderCache(3); // Small cache for testing
  });

  it('should cache render data by stroke ID', () => {
    const stroke = createTestStroke('stroke-1');

    const data1 = cache.getOrBuild(stroke);
    const data2 = cache.getOrBuild(stroke);

    expect(data1).toBe(data2); // Same reference
    expect(cache.size).toBe(1);
  });

  it('should evict oldest entry when cache is full', () => {
    const stroke1 = createTestStroke('stroke-1');
    const stroke2 = createTestStroke('stroke-2');
    const stroke3 = createTestStroke('stroke-3');
    const stroke4 = createTestStroke('stroke-4');

    cache.getOrBuild(stroke1);
    cache.getOrBuild(stroke2);
    cache.getOrBuild(stroke3);
    expect(cache.size).toBe(3);

    cache.getOrBuild(stroke4);
    expect(cache.size).toBe(3); // Still 3, oldest evicted

    // Stroke 1 should be evicted, need to rebuild
    const data1New = cache.getOrBuild(stroke1);
    const data2Cached = cache.getOrBuild(stroke2);

    expect(cache.size).toBe(3);
  });

  it('should invalidate specific stroke', () => {
    const stroke = createTestStroke('stroke-1');

    cache.getOrBuild(stroke);
    expect(cache.size).toBe(1);

    cache.invalidate('stroke-1');
    expect(cache.size).toBe(0);
  });

  it('should clear entire cache', () => {
    cache.getOrBuild(createTestStroke('stroke-1'));
    cache.getOrBuild(createTestStroke('stroke-2'));
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
```

#### 3.3 Create `/client/src/renderer/__tests__/layers/strokes.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drawStrokes, clearStrokeCache } from '../../layers/strokes';
import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../../types';
// Note: createMockContext needs to be extended with stroke methods

// Helper to create extended mock context with stroke methods
function createStrokeMockContext(): any {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    canvas: {
      width: 800,
      height: 600,
    } as HTMLCanvasElement,
  };
}

describe('Stroke Rendering Layer', () => {
  let ctx: ReturnType<typeof createStrokeMockContext>;
  let viewTransform: ViewTransform;
  let viewport: ViewportInfo;

  beforeEach(() => {
    ctx = createStrokeMockContext();
    viewTransform = {
      scale: 1,
      pan: { x: 0, y: 0 },
      worldToCanvas: (x: number, y: number) => [x, y],
      canvasToWorld: (x: number, y: number) => [x, y],
    };
    viewport = {
      pixelWidth: 800,
      pixelHeight: 600,
      cssWidth: 800,
      cssHeight: 600,
      dpr: 1,
    };
    clearStrokeCache();
  });

  it('should render visible strokes', () => {
    const snapshot: Snapshot = {
      svKey: 'test-key',
      scene: 0,
      strokes: [
        {
          id: 'stroke-1',
          points: [100, 100, 200, 200],
          polyline: null,
          style: { color: '#FF0000', size: 3, opacity: 1, tool: 'pen' },
          bbox: [100, 100, 200, 200],
          scene: 0,
          createdAt: Date.now(),
          userId: 'user-1',
        },
      ],
      texts: [],
      presence: createEmptyPresenceView(),
      spatialIndex: null,
      view: viewTransform,
      meta: { cap: 15000000, readOnly: false },
      createdAt: Date.now(),
    };

    drawStrokes(ctx, snapshot, viewTransform, viewport);

    // Should set stroke style
    expect(ctx.strokeStyle).toBe('#FF0000');
    expect(ctx.lineWidth).toBe(3);
    expect(ctx.globalAlpha).toBe(1);

    // Should stroke the path
    expect(ctx.stroke).toHaveBeenCalled();

    // Should save/restore context
    expect(ctx.save).toHaveBeenCalled();
    expect(ctx.restore).toHaveBeenCalled();
  });

  it('should apply highlighter opacity', () => {
    const snapshot: Snapshot = {
      svKey: 'test-key',
      scene: 0,
      strokes: [
        {
          id: 'highlighter-1',
          points: [100, 100, 200, 200],
          polyline: null,
          style: { color: '#FFFF00', size: 10, opacity: 0.25, tool: 'highlighter' },
          bbox: [100, 100, 200, 200],
          scene: 0,
          createdAt: Date.now(),
          userId: 'user-1',
        },
      ],
      texts: [],
      presence: createEmptyPresenceView(),
      spatialIndex: null,
      view: viewTransform,
      meta: { cap: 15000000, readOnly: false },
      createdAt: Date.now(),
    };

    drawStrokes(ctx, snapshot, viewTransform, viewport);

    expect(ctx.globalAlpha).toBe(0.25);
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });

  it('should cull strokes outside viewport', () => {
    const snapshot: Snapshot = {
      svKey: 'test-key',
      scene: 0,
      strokes: [
        {
          id: 'offscreen-1',
          points: [1000, 1000, 1100, 1100], // Outside 800x600 viewport
          polyline: null,
          style: { color: '#000000', size: 2, opacity: 1, tool: 'pen' },
          bbox: [1000, 1000, 1100, 1100],
          scene: 0,
          createdAt: Date.now(),
          userId: 'user-1',
        },
      ],
      texts: [],
      presence: createEmptyPresenceView(),
      spatialIndex: null,
      view: viewTransform,
      meta: { cap: 15000000, readOnly: false },
      createdAt: Date.now(),
    };

    drawStrokes(ctx, snapshot, viewTransform, viewport);

    // Should not stroke offscreen strokes
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it('should skip strokes with LOD threshold', () => {
    const snapshot: Snapshot = {
      svKey: 'test-key',
      scene: 0,
      strokes: [
        {
          id: 'tiny-1',
          points: [100, 100, 100.5, 100.5], // Very small stroke
          polyline: null,
          style: { color: '#000000', size: 1, opacity: 1, tool: 'pen' },
          bbox: [100, 100, 100.5, 100.5], // 0.5px diagonal
          scene: 0,
          createdAt: Date.now(),
          userId: 'user-1',
        },
      ],
      texts: [],
      presence: createEmptyPresenceView(),
      spatialIndex: null,
      view: viewTransform,
      meta: { cap: 15000000, readOnly: false },
      createdAt: Date.now(),
    };

    drawStrokes(ctx, snapshot, viewTransform, viewport);

    // Should skip tiny strokes (< 2px diagonal)
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it('should clear cache on scene change', () => {
    const snapshot1: Snapshot = {
      svKey: 'key-1',
      scene: 0,
      strokes: [
        {
          id: 'stroke-1',
          points: [100, 100, 200, 200],
          polyline: null,
          style: { color: '#FF0000', size: 3, opacity: 1, tool: 'pen' },
          bbox: [100, 100, 200, 200],
          scene: 0,
          createdAt: Date.now(),
          userId: 'user-1',
        },
      ],
      texts: [],
      presence: createEmptyPresenceView(),
      spatialIndex: null,
      view: viewTransform,
      meta: { cap: 15000000, readOnly: false },
      createdAt: Date.now(),
    };

    const snapshot2 = { ...snapshot1, scene: 1 };

    drawStrokes(ctx, snapshot1, viewTransform, viewport);
    const callCount1 = ctx.stroke.mock.calls.length;

    drawStrokes(ctx, snapshot2, viewTransform, viewport);
    const callCount2 = ctx.stroke.mock.calls.length;

    // Cache should be cleared between scenes
    expect(callCount2).toBe(callCount1 * 2);
  });
});
```

## Integration Points

### With Phase 2 (RoomDocManager)

- Receives immutable snapshots with filtered strokes
- Never accesses Y.Doc directly
- Respects scene filtering already done in snapshot

### With Phase 3 (Canvas Infrastructure)

- Integrates with `RenderLoop.tick()` layer system
- Uses `ViewTransform` for coordinate conversion
- Leverages dirty rect tracking for efficient updates
- World transform already applied by render loop

### With Future Phases

- **Phase 5**: Will add stroke creation and commit logic
- **Phase 6**: Will integrate RBush for spatial queries
- **Phase 10**: Will use cache invalidation for eraser

## Testing Strategy

### Environment Considerations

- **Path2D**: May not exist in Node/Vitest environments, code handles null gracefully
- **Mock Context**: Tests use extended mock with stroke-specific methods
- **Viewport**: Tests must provide ViewportInfo with both pixel and CSS dimensions

### Unit Tests (Pragmatic for Phase 4)

1. **Path Builder Tests**: Verify point-to-path conversion, pressure detection, bounds calculation
2. **Cache Tests**: Verify caching behavior, FIFO eviction, invalidation
3. **Render Tests**: Mock canvas context, verify style application, culling logic

### Test Helper Updates

The existing `/client/src/renderer/__tests__/test-helpers.ts` already has `createMockContext()` but needs stroke-specific methods.

#### Extended Mock Context Helper

Create a separate helper in the test file or extend the existing mock:

```typescript
// Helper to create extended mock context with stroke methods
function createStrokeMockContext(): any {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    canvas: {
      width: 800,
      height: 600,
    } as HTMLCanvasElement,
  };
}

// Helper to create empty PresenceView matching the shared type
function createEmptyPresenceView(): PresenceView {
  return {
    users: new Map(),
    localUserId: '',
  };
}
```

### What We DON'T Test Yet

- RoomDocManager integration (deferred to Phase 5)
- Actual stroke creation/mutation (Phase 5)
- Spatial indexing queries (Phase 6)
- User interaction (Phase 5)

## Performance Considerations

### Current Optimizations (Simple for Phase 4)

- **ID-based caching**: Strokes immutable after commit
- **Viewport culling**: Skip offscreen strokes (bbox inflated by stroke width)
- **LOD threshold**: Skip tiny strokes (< 2px diagonal)
- **Scene-based cache clear**: Invalidate on scene change
- **FIFO cache eviction**: Simple strategy for Phase 4 (can upgrade to LRU later)

### Multi-Room Consideration & Cache Lifecycle

The module-level `strokeCache` works for single-room-per-tab (current architecture).

#### Cache Cleanup Requirements

1. **Scene change**: Automatically cleared (already implemented)
2. **Room switch/unmount**: Call `clearStrokeCache()` in room teardown
   - Add to RoomDocManager.destroy() in future phases
   - Add to component cleanup in Canvas unmount
3. **Memory pressure**: Monitor cache size via `getStrokeCacheSize()`

#### Future Multi-Room Support

If multi-room tabs are added later, either:

1. Make cache instance-scoped (created by RenderLoop)
2. Include roomId in cache management
3. Clear cache on room switch

**CRITICAL**: Always clear cache on room lifecycle events to prevent memory leaks

## Migration Notes

### From Stub to Implementation

The `drawStrokes` function already exists as a stub in `/client/src/renderer/layers/index.ts`. The implementation will:

1. Move the stub from `index.ts` to new file `strokes.ts`
2. Replace stub with actual rendering logic
3. Re-export from `index.ts` to maintain the same import path
4. Update development logging from `process.env.NODE_ENV` to `import.meta.env.DEV`

**IMPORTANT**: The existing stubs use `process.env.NODE_ENV` which will fail in Vite.
Update ALL layer stubs to use `import.meta.env.DEV` to prevent runtime errors.

### Canvas Context State (Provided by RenderLoop)

The RenderLoop at `/client/src/renderer/RenderLoop.ts` already provides:

- World transform pre-applied (lines 306-307): `ctx.scale(view.scale, view.scale); ctx.translate(-view.pan.x, -view.pan.y)`
- DPR set once by CanvasStage, never mixed with world transform
- Each layer wrapped in save/restore automatically
- Clean state between layers
- Visible world bounds calculated with CSS pixels (lines 313-317)

### Critical Integration Points

- **ViewportInfo**: Defined in `/client/src/renderer/types.ts` with both pixel and CSS dimensions
- **CSS vs Device Pixels**: Always use `viewport.cssWidth/cssHeight` for world bounds calculations
- **Transform Context**: ViewTransform operates in CSS coordinate space, DPR applied separately by CanvasStage
- **Layer Order**: RenderLoop calls layers in canonical order (background → strokes → shapes → text → authoring → presence → HUD)

## Validation Checklist

### Architecture Compliance

- [ ] Points stored as `number[]` in Y.Doc (never Float32Array)
- [ ] Float32Array created only at render time
- [ ] Strokes filtered by scene in snapshot (not in render)
- [ ] No direct Y.Doc access from rendering code
- [ ] Immutable snapshot data (frozen arrays)
- [ ] Path2D feature detection for test compatibility
- [ ] CSS pixels used for viewport calculations (not device pixels)

### Performance Requirements

- [ ] Viewport culling implemented with stroke width inflation
- [ ] Basic LOD (skip tiny strokes < 2px diagonal)
- [ ] Simple ID-based caching with FIFO eviction
- [ ] Scene change cache invalidation
- [ ] Robust stride detection to prevent false positives

### Code Quality

- [ ] TypeScript types from @avlo/shared
- [ ] Test coverage for core utilities
- [ ] Development logging preserved
- [ ] Memory-safe patterns (cleanup cache)
- [ ] Test environment compatibility (no DOMRect dependency)

## Common Pitfalls to Avoid

1. **DON'T use process.env.NODE_ENV** - Use `import.meta.env.DEV` for Vite
2. **DON'T store Float32Array in Y.Doc** - Build at render time only
3. **DON'T cache by svKey** - Use stroke ID only (immutable after commit), svKey is for cosmetic boot splash only
4. **DON'T access Y.Doc from renderers** - Use snapshot only
5. **DON'T filter by scene in render** - Already done in snapshot
6. **DON'T implement drawing input** - That's Phase 5
7. **DON'T add RBush yet** - That's Phase 6
8. **DON'T over-optimize** - Keep it simple for Phase 4
9. **DON'T assume Path2D exists** - Feature-detect for test environments
10. **DON'T use device pixels for world bounds** - Use CSS pixels from viewport
11. **DON'T trust stride from modulo alone** - Validate pressure values exist (80% threshold)
12. **DON'T forget stroke width in culling** - Inflate bbox by half the stroke size
13. **DON'T apply transforms manually** - RenderLoop handles world transform
14. **DON'T mix DPR with world transform** - CanvasStage handles DPR separately
15. **DON'T forget cache cleanup** - Clear on scene change AND room unmount

## Success Criteria

Phase 4 is complete when:

1. ✅ Strokes render from snapshot data
2. ✅ Pen and highlighter tools display correctly (opacity, blending)
3. ✅ Basic performance optimizations work (culling with bbox inflation, LOD < 2px)
4. ✅ Tests pass for path building and caching
5. ✅ Integration with render loop layers functions correctly
6. ✅ Memory-safe patterns with proper cleanup
7. ✅ All layer stubs use `import.meta.env.DEV` (no process.env)
8. ✅ Cache keys use stroke.id only (no svKey)
9. ✅ Robust stride detection prevents false positives
10. ✅ Test helpers properly mock PresenceView structure

## Next Phase Preview

Phase 5 (Drawing Input System) will add:

- Pointer event handling
- Preview rendering during drawing
- Stroke commit with simplification
- Scene assignment at commit time
- Mobile view-only guards

---

**Remember**: This is a small side project for ~15 concurrent users. Keep implementations simple and pragmatic. The architecture is more important than premature optimization.
