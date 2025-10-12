# Perfect Freehand Implementation Fix - Comprehensive Guide

## Executive Summary

The Perfect Freehand preview-commit mismatch occurs because:
1. **Simplification runs even at tolerance 0** - deduplication and point removal changes corner weights
2. **Data conversion from flat to tuples** - creates new arrays with different precision
4. **No canonical data preserved** - PF tuples are recreated rather than reused



## Core Principle

**The canonical input to Perfect Freehand must be the same tuple array for both preview and commit.**

We will:
1. Preserve the exact PF tuple array created during drawing
2. Bypass ALL simplification for freehand strokes
3. Store tuples alongside flat arrays for backward compatibility
4. Use the same tuples and for commit and preview

## Complete Data Flow Map

```mermaid
graph TD
    A[User draws] --> B[DrawingTool maintains dual arrays]
    B --> C["points: flat [x,y,x,y,...]"]
    B --> D["pointsPF: tuples [[x,y],[x,y],...]"]

    D --> E[Preview: getStroke(pointsPF, last:false)]
    E --> F[Overlay renders preview]

    G[Pointer up] --> H[Flush pending points]
    H --> I{Freehand?}

    I -->|Yes| J[Skip simplification]
    I -->|No| K[Simplify for shapes]

    J --> L[Store both arrays in Y.Doc]
    K --> M[Store simplified flat only]

    L --> N["points + pointsTuples"]
    M --> O["points only"]

    N --> P[Snapshot copies both]
    O --> Q[Snapshot copies flat only]

    P --> R[Renderer prefers pointsTuples]
    Q --> S[Renderer converts flat→tuples]

    R --> T[getStroke(pointsTuples, last:true)]
    S --> U[getStroke(flatToPairs(points), last:true)]
```

## Files That Need Modification

1. **Type definitions** (2 files)
   - `/packages/shared/src/types/room.ts`
   - `/packages/shared/src/types/snapshot.ts`

2. **Core logic** (3 files)
   - `/client/src/lib/tools/DrawingTool.ts`
   - `/client/src/lib/room-doc-manager.ts`
   - `/client/src/renderer/stroke-builder/path-builder.ts`

3. **Preview handling** (2 files)
   - `/client/src/renderer/layers/preview.ts`
   - `/client/src/renderer/OverlayRenderLoop.ts`

## Step-by-Step Implementation Instructions

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

### STEP 2: Modify DrawingTool to Bypass Simplification and Store Tuples

#### File: `/client/src/lib/tools/DrawingTool.ts`

**CHANGE 0: Add required imports at the top of file**

Add these imports after the existing imports:
```typescript
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from '@/renderer/stroke-builder/pf-config';
```

**CHANGE 1: Add final outline storage for held frame**

After line 34 (add new private fields):
```typescript
  // Callbacks
  private onInvalidate?: (bounds: [number, number, number, number]) => void;

  // NEW: Add these fields for final frame handling
  private finalOutline: [number, number][] | null = null;
  private shouldUseFinalOutline = false;
```

**CHANGE: Modify commitStroke method (starting at line 361)**
The current freehand commit path does run simplification and only appends the final point to the flat array, not the PF tuple buffer, which can desync the last few points (exactly where corners are most sensitive). Both are core causes of your “ripple/chip” at sharp turns. 
There are two commit paths. commitStroke(...) is the freehand path; perfect shapes go through commitPerfectShapeFromPreview()
Concrete change:

Delete the simplification step and everything that depends on simplified.
Always push the final point into both buffers (points and pointsPF) if it wasn’t already there.
Persist the PF tuples as the canonical PF input alongside the flat array (for back-compat + bbox/transport).
Compute final bbox from the raw centerline (flat points), not from a simplified array.
Patch sketch (only the moving parts):

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

  // 4) NO COMMIT-TIME SIMPLIFICATION for freehand — remove this:
  // const { points: simplified } = simplifyStroke(this.state.points, this.state.config.tool);

  // 5) Use raw centerline for size/bbox checks
  const rawPoints = this.state.points;
  const estimatedSize = estimateEncodedSize(rawPoints);
  if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) { /* handle too-large */ }

  const finalBbox = calculateBBox(rawPoints, this.state.config.size);

  // 6) Canonical PF tuples = the exact tuple buffer we used for preview
  // Shallow-clone if you prefer immutability after reset:
  const canonicalTuples = this.state.pointsPF.slice();

  // 7) (Optional) Compute final outline ONCE for the held overlay frame
  // const finalOutline = getStroke(canonicalTuples, { ...PF_OPTIONS_BASE, size: this.state.config.size, last: true });
  // overlay.setFinalFreehandOutline(finalOutline);

  // 8) Commit to Y.Doc: store both flat points and PF tuples, and tag kind:'freehand'
  this.room.mutate((ydoc) => {
    const root = ydoc.getMap('root');
    const strokes = root.get('strokes') as Y.Array<any>;
    const meta = root.get('meta') as Y.Map<any>;
    const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
    const currentScene = sceneTicks.length;

    strokes.push([{
      id: ulid(),
      tool: this.state.config.tool,
      color: this.state.config.color,
      size: this.state.config.size,
      opacity: this.state.config.opacity,
      points: rawPoints,                 // raw flat centerline
      pointsTuples: canonicalTuples,     // NEW: PF-native tuples (authoritative PF input)
      bbox: finalBbox,
      scene: currentScene,
      createdAt: Date.now(),
      userId: this.userId,
      kind: 'freehand',
    }]);
  });

  // 9) Invalidate preview + final bbox (unchanged conceptually; update var names)
  if (previewBounds) this.onInvalidate?.(previewBounds);
  this.onInvalidate?.(finalBbox);

  this.resetState();
}
```
By removing DP and storing tuples, the PF input is identical across preview and commit; the base canvas and the held preview can render the same outline (last:true) with identical inputs, erasing the ripple. Your current preview uses PF tuples with last:false, so without this alignment the final frame will still “bump.”
The last-point lockstep fix addresses a subtle but critical mismatch at corners. Today’s code appends the last point only to points (flat). We must append it to pointsPF too. Otherwise, the preview’s last-frame tuples and the committed tuples can diverge by one point — exactly where you notice “chips.”
The old flow used an empty result from simplification to mean “too big”. Replace that with a direct size check on the raw centerline so you preserve your transport guard without changing geometry. 
**CHANGE 3: Update getPreview method (line 315)**

Modify the getPreview method to use final outline when available:
```typescript
  getPreview(): PreviewData | null {
    if (!this.state.isDrawing) return null;

    // Perfect shape preview (unchanged)
    if (this.snap && this.liveCursorWU) {
      const { color, size } = this.state.config;
      return {
        kind: 'perfectShape',
        shape: this.snap.kind,
        color,
        size,
        opacity: this.state.config.opacity,
        anchors: { kind: this.snap.kind, ...this.snap.anchors } as any,
        cursor: this.liveCursorWU,
        bbox: null
      };
    }

    // Freehand preview
    if (this.state.pointsPF.length < 2) return null;

    // NEW: Use final outline if we have it (for held frame)
    if (this.shouldUseFinalOutline && this.finalOutline) {
      return {
        kind: 'strokeFinal', // NEW kind for final frame
        outline: this.finalOutline, // Pre-computed outline
        tool: this.state.config.tool,
        color: this.state.config.color,
        size: this.state.config.size,
        opacity: this.state.config.opacity,
        bbox: this.lastBounds,
      };
    }

    // Regular preview (unchanged)
    return {
      kind: 'stroke',
      points: this.state.pointsPF,
      tool: this.state.config.tool,
      color: this.state.config.color,
      size: this.state.config.size,
      opacity: this.state.config.opacity,
      bbox: this.lastBounds,
    };
  }
```

**CHANGE 4: Update resetState to clear final outline**

Modify resetState method (around line 77):
```typescript
  private resetState(): void {
    this.state = {
      isDrawing: false,
      pointerId: null,
      points: [],
      pointsPF: [],
      config: {
        tool: this.toolType,
        color: this.settings.color,
        size: this.settings.size,
        opacity: this.settings.opacity,
      },
      startTime: 0,
    };
    this.lastBounds = null;
    this.finalOutline = null; // NEW: Clear final outline
    this.shouldUseFinalOutline = false; // NEW: Reset flag
  }
```

### STEP 3: Update RoomDocManager to Pass Through Tuples

#### File: `/client/src/lib/room-doc-manager.ts`

**Location:** Line 1706 (in the buildSnapshot method where strokes are mapped)

**Replace the stroke mapping with:**
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
        points: s.points,
        pointsTuples: (s as any).pointsTuples ?? null, // NEW: Pass through tuples
        polyline: null as unknown as Float32Array | null,
        style: {
          color: s.color,
          size: s.size,
          opacity: s.opacity,
          tool: s.tool,
        },
        bbox: s.bbox,
        scene: s.scene,
        createdAt: s.createdAt,
        userId: s.userId,
        kind: (s as any).kind ?? 'shape', // Existing back-compat
      }));
```

### STEP 4: Update Path Builder to Prefer Tuples

#### File: `/client/src/renderer/stroke-builder/path-builder.ts`

**Location:** Line 110 (in buildPFPolygonRenderData function)

**Replace the function with:**
```typescript
export function buildPFPolygonRenderData(stroke: StrokeView): PolygonData {
  const size = stroke.style.size;

  // CRITICAL FIX: Prefer canonical tuples if available
  const inputTuples = stroke.pointsTuples ?? flatToPairs(stroke.points);

  // Use the canonical tuples or fallback conversion
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

### STEP 5: Update Preview Types and Renderer

#### File: `/client/src/lib/tools/types.ts`

**Add new type after StrokePreview (around line 35):**
```typescript
/**
 * StrokeFinalPreview is the final frame preview with pre-computed outline
 * Used for the held frame to match base canvas exactly
 */
export interface StrokeFinalPreview {
  kind: 'strokeFinal';
  outline: [number, number][]; // Pre-computed PF outline
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  bbox: [number, number, number, number] | null;
}
```

**Update PreviewData union (line 99):**
```typescript
export type PreviewData = StrokePreview | StrokeFinalPreview | EraserPreview | TextPreview | PerfectShapePreview;
```

#### File: `/client/src/renderer/layers/preview.ts`

**Replace the entire file with:**
```typescript
import type { StrokePreview, StrokeFinalPreview } from '@/lib/tools/types';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from '../stroke-builder/pf-config';

/**
 * Draw preview stroke (regular)
 * CRITICAL: This is called INSIDE world transform scope
 */
export function drawPreview(ctx: CanvasRenderingContext2D, preview: StrokePreview): void {
  if (!preview || preview.points.length < 2) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity;

  // PF input: [x,y][]; output: [x,y][] (not flat)
  const outline = getStroke(preview.points, {
    ...PF_OPTIONS_BASE,
    size: preview.size,
    last: false, // live preview
  });

  drawOutline(ctx, outline, preview.color);
  ctx.restore();
}

/**
 * Draw final preview stroke (held frame)
 * Uses pre-computed outline with last:true
 */
export function drawFinalPreview(ctx: CanvasRenderingContext2D, preview: StrokeFinalPreview): void {
  if (!preview || !preview.outline || preview.outline.length === 0) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity;
  drawOutline(ctx, preview.outline, preview.color);
  ctx.restore();
}

/**
 * Helper to draw PF outline
 */
function drawOutline(ctx: CanvasRenderingContext2D, outline: [number, number][], color: string): void {
  if (outline.length > 0) {
    const path = new Path2D();
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      path.lineTo(outline[i][0], outline[i][1]);
    }
    path.closePath();
    ctx.fillStyle = color;
    ctx.fill(path);
  }
}
```

#### File: `/client/src/renderer/OverlayRenderLoop.ts`

**Modify the frame method (around line 108) to handle strokeFinal:**
```typescript
        // Check preview kind using discriminant
        if (previewToDraw.kind === 'stroke') {
          // Existing stroke preview (world space)
          ctx.save();
          ctx.scale(view.scale, view.scale);
          ctx.translate(-view.pan.x, -view.pan.y);
          drawPreview(ctx, previewToDraw);
          ctx.restore();
        } else if (previewToDraw.kind === 'strokeFinal') {
          // NEW: Final stroke preview with pre-computed outline
          ctx.save();
          ctx.scale(view.scale, view.scale);
          ctx.translate(-view.pan.x, -view.pan.y);
          // NOTE: Import drawFinalPreview at top with drawPreview:
          // import { drawPreview, drawFinalPreview } from './layers/preview';
          drawFinalPreview(ctx, previewToDraw);
          ctx.restore();
        } else if (previewToDraw.kind === 'eraser') {
          // ... existing eraser code
        }
```

### STEP 6: Add Debug Assertions (Development Only)

#### File: `/client/src/lib/tools/DrawingTool.ts`

Add after flushPending() in commitStroke:
```typescript
    // DEBUG: Verify arrays are in sync
    if (import.meta.env.DEV) {
      console.assert(
        this.state.pointsPF.length === this.state.points.length / 2,
        'PF tuples not in lockstep with flat points'
      );
    }
```

#### File: `/client/src/renderer/stroke-builder/path-builder.ts`

Add in buildPFPolygonRenderData after getting inputTuples:
```typescript
  // DEBUG: Verify tuples match flat if both exist
  if (import.meta.env.DEV && stroke.pointsTuples) {
    console.assert(
      stroke.pointsTuples.length === stroke.points.length / 2,
      'Snapshot tuples & flats out of sync'
    );
  }
```

## Testing & Validation

### Manual Testing Checklist

1. **Corner Preservation**
   - [ ] Draw sharp corners (acute angles)
   - [ ] Verify no "chipping" after commit
   - [ ] Check that preview matches committed stroke exactly

2. **Performance**
   - [ ] Draw very long strokes (10,000+ points)
   - [ ] Verify no lag or stuttering
   - [ ] Check memory usage remains reasonable

### Automated Validation

Add these console logs temporarily during testing:

```javascript
// In DrawingTool.commitStroke after computing canonicalTuples
console.log('Commit:', {
  flatLength: processedPoints.length,
  tuplesLength: canonicalTuples?.length,
  isFreehand,
  tool: this.state.config.tool
});

// In path-builder.ts buildPFPolygonRenderData
console.log('Render:', {
  hasTuples: !!stroke.pointsTuples,
  tuplesLength: stroke.pointsTuples?.length,
  flatLength: stroke.points.length / 2
});
```


## Performance Considerations

### Storage Impact
- **Before:** ~16 bytes per coordinate (flat array + CRDT)
- **After:** ~32 bytes per coordinate (flat + tuples + CRDT)
- **Mitigation:** Only for freehand strokes, shapes unchanged

### Network Impact
- **Before:** Simplified strokes (fewer points)
- **After:** Raw strokes (all points)
- **Mitigation:** Monitor and add export-time simplification if needed

### Memory Impact
- **Before:** One array per stroke
- **After:** Two arrays per freehand stroke
- **Mitigation:** Cache eviction remains unchanged

## Success Metrics

1. **Visual Quality**
   - Zero reports of corner chipping
   - No preview-commit mismatch bugs
   - Smooth drawing experience maintained
---
