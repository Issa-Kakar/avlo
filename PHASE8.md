Phase 8: Eraser Tool Implementation

# Phase 8 Eraser Tool - Critical Fixes Documentation

## Issues Identified

### 1. **CRITICAL: Stale View Transform in Hit-Testing**

**Severity:** Critical
**Location:** `EraserTool.updateHitTest()` line 134-135

The eraser is using `snapshot.view` for hit-testing calculations, but this view can be stale when zooming/panning. The overlay renderer correctly uses live `getView()` but the hit-test doesn't.

```typescript
// CURRENT (BROKEN):
const snapshot = this.room.currentSnapshot;
const viewTransform = snapshot.view; // <-- STALE VIEW!
const radiusWorld = this.state.radiusPx / viewTransform.scale;
```

**Impact:** When zoomed out, the eraser calculates wrong `radiusWorld` and visible bounds, causing hit-test failures.

### 2. **Cursor Remains On Screen After Pointer Leave**

**Severity:** High
**Location:** Multiple issues

#### 2a. No `onPointerLeave` handler in EraserTool

- `EraserTool` has no method to clear hover state when pointer leaves canvas
- `lastWorld` stays set, causing `getPreview()` to keep returning a circle
- Canvas `handlePointerLeave` only clears awareness cursor, not tool preview

#### 2b. `setPreviewProvider(null)` doesn't invalidate overlay

**Location:** `OverlayRenderLoop.ts` line 47-52

```typescript
setPreviewProvider(provider: PreviewProvider | null): void {
  this.previewProvider = provider;
  if (provider && provider.getPreview()) { // <-- DOESN'T INVALIDATE ON NULL!
    this.invalidateAll();
  }
}
```

#### 2c. `destroy()` and `commitErase()` don't call `onInvalidate`

- After committing or destroying, the last preview frame stays visible

### 3. **Dimming Not Obvious - baseOpacity Ignored**

**Severity:** Medium
**Location:** `eraser-dim.ts` line 8-39

The function receives `baseOpacity` parameter but **never uses it**:

```typescript
export function drawDimmedStrokes(
  ctx: CanvasRenderingContext2D,
  hitIds: string[],
  snapshot: Snapshot,
  baseOpacity: number  // <-- RECEIVED BUT IGNORED!
): void {
  // ...
  const dimFactor = stroke.style.tool === 'highlighter' ? 0.7 : 0.5;
  ctx.globalAlpha = 1; // <-- HARDCODED!
  ctx.strokeStyle = `rgba(128, 128, 128, ${dimFactor})`; // <-- FIXED ALPHA
```

### 4. **Missing Stroke Width in Hit Testing**

**Severity:** Medium
**Location:** `EraserTool.updateHitTest()` line 158, 162

Hit-testing doesn't account for stroke thickness:

```typescript
const inflatedBbox = this.inflateBbox(stroke.bbox, radiusWorld); // <-- NO STROKE WIDTH!
if (this.strokeHitTest(worldX, worldY, stroke.points, radiusWorld)) { // <-- NO STROKE WIDTH!
```

This makes 1px strokes much harder to erase than thick strokes.

### 5. **Performance: Early Break Without Resume**

**Severity:** Medium
**Location:** `EraserTool.updateHitTest()` line 171-175

```typescript
if (performance.now() - startTime > MAX_TIME_MS && segmentCount > MAX_SEGMENTS) {
  // Optional: could store resume index for next frame
  break; // <-- STOPS SCANNING, NO RESUME!
}
```

When breaking early, strokes after current position are never tested.

### 6. **Missing getView() Parameter**

**Severity:** Critical
**Location:** `Canvas.tsx` line 491-508

EraserTool is not receiving `getView` callback:

```typescript
tool = new EraserTool(
  roomDoc,
  eraser,
  userId,
  () => overlayLoopRef.current?.invalidateAll(),
  () => {
    /* getViewport */
  },
  // <-- MISSING getView PARAMETER!
);
```

### 7. **No Spatial Index Implementation**

**Severity:** Low (Performance)
**Location:** Throughout

`spatialIndex` field in Snapshot is hardcoded to `null`. No spatial indexing for efficient hit-testing.

## Fix Implementation Guide

### Fix 1: Add Live View Transform Support

#### Step 1.1: Update EraserTool Constructor

```typescript
// EraserTool.ts
export class EraserTool {
  private getView?: () => ViewTransform; // ADD THIS

  constructor(
    room: IRoomDocManager,
    settings: EraserSettings,
    userId: string,
    onInvalidate?: () => void,
    getViewport?: () => { cssWidth: number; cssHeight: number; dpr: number },
    getView?: () => ViewTransform  // ADD THIS PARAMETER
  ) {
    // ...
    this.getView = getView; // STORE IT
  }
```

#### Step 1.2: Use Live View in updateHitTest

```typescript
private updateHitTest(worldX: number, worldY: number): void {
  const snapshot = this.room.currentSnapshot;

  // USE LIVE VIEW, FALLBACK TO SNAPSHOT IF NOT PROVIDED
  const viewTransform = this.getView ? this.getView() : snapshot.view;

  const radiusWorld = this.state.radiusPx / viewTransform.scale;
  const visibleBounds = this.getVisibleWorldBounds(viewTransform);
  // ... rest of method
}
```

#### Step 1.3: Pass getView from Canvas

```typescript
// Canvas.tsx line 491
tool = new EraserTool(
  roomDoc,
  eraser,
  userId,
  () => overlayLoopRef.current?.invalidateAll(),
  () => {
    /* getViewport callback */
  },
  () => viewTransformRef.current, // ADD THIS!
);
```

### Fix 2: Handle Pointer Leave Properly

#### Step 2.1: Add clearHover Method to EraserTool

```typescript
// EraserTool.ts
clearHover(): void {
  this.pendingMove = null;
  this.state.lastWorld = null;
  this.state.hitNow.clear();
  if (!this.state.isErasing) {
    this.state.hitAccum.clear();
  }
  this.onInvalidate?.();
}
```

#### Step 2.2: Fix setPreviewProvider to Always Invalidate

```typescript
// OverlayRenderLoop.ts
setPreviewProvider(provider: PreviewProvider | null): void {
  this.previewProvider = provider;
  this.invalidateAll(); // ALWAYS INVALIDATE

  if (!provider) {
    this.cachedPreview = null;
    this.holdPreviewOneFrame = false;
  }
}
```

#### Step 2.3: Call clearHover on Pointer Leave

```typescript
// Canvas.tsx handlePointerLeave
const handlePointerLeave = () => {
  // Clear cursor when pointer leaves canvas
  roomDoc.updateCursor(undefined, undefined);

  // Clear tool hover state if it has the method
  if (tool && 'clearHover' in tool) {
    (tool as any).clearHover();
  }
};
```

#### Step 2.4: Add onInvalidate to commitErase and destroy

```typescript
// EraserTool.ts
commitErase(): void {
  // ... existing code ...
  this.resetState();
  this.onInvalidate?.(); // ADD THIS
}

destroy(): void {
  if (this.rafId) {
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }
  this.resetState();
  this.onInvalidate?.(); // ADD THIS
}
```

### Fix 3: Improve Dimming Visibility

```typescript
// eraser-dim.ts
export function drawDimmedStrokes(
  ctx: CanvasRenderingContext2D,
  hitIds: string[],
  snapshot: Snapshot,
  baseOpacity: number,
): void {
  const hitSet = new Set(hitIds);
  const cache = getStrokeCacheInstance();

  ctx.save();

  // Use source-over for more predictable darkening
  ctx.globalCompositeOperation = 'source-over';

  // Render hit strokes with strong darkening
  for (const stroke of snapshot.strokes) {
    if (!hitSet.has(stroke.id)) continue;

    const renderData = cache.getOrBuild(stroke);
    if (!renderData.path || renderData.pointCount < 2) continue;

    // Use baseOpacity parameter!
    const toolFactor = stroke.style.tool === 'highlighter' ? 0.7 : 1.0;
    const alpha = Math.min(1, Math.max(0.4, baseOpacity * toolFactor));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#000000'; // Black for clear dimming
    ctx.lineWidth = stroke.style.size + 3; // Thicker for visibility
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(renderData.path);
    ctx.restore();
  }

  // Render hit text blocks with strong overlay
  for (const text of snapshot.texts) {
    if (!hitSet.has(text.id)) continue;
    ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0.4, baseOpacity * 0.8)})`;
    ctx.fillRect(text.x, text.y, text.w, text.h);
  }

  ctx.restore();
}
```

Also increase default dimOpacity in EraserTool:

```typescript
// EraserTool.ts getPreview()
return {
  kind: 'eraser',
  circle: {
    /* ... */
  },
  hitIds: Array.from(allHits),
  dimOpacity: 0.6, // INCREASE FROM 0.35
};
```

### Fix 4: Include Stroke Width in Hit Testing

```typescript
// EraserTool.ts updateHitTest()
for (const stroke of snapshot.strokes) {
  // Include stroke half-width
  const halfWidth = (stroke.style?.size ?? 1) / 2;
  const hitRadius = radiusWorld + halfWidth;

  // Viewport prune
  if (!this.isInBounds(stroke.bbox, visibleBounds)) continue;

  // Inflated bbox test with stroke width
  const inflatedBbox = this.inflateBbox(stroke.bbox, hitRadius);
  if (!this.pointInBbox(worldX, worldY, inflatedBbox)) continue;

  // Segment distance test with stroke width
  if (this.strokeHitTest(worldX, worldY, stroke.points, hitRadius)) {
    this.state.hitNow.add(stroke.id);
  }
  // ... rest
}
```

### Fix 5: Add Resume Index for Performance

```typescript
// EraserTool.ts
export class EraserTool {
  private resumeIndex: number = 0;
  private lastUpdateWorld: [number, number] | null = null;

  private updateHitTest(worldX: number, worldY: number): void {
    // Reset resume if pointer moved significantly
    if (this.lastUpdateWorld) {
      const dist = Math.hypot(worldX - this.lastUpdateWorld[0], worldY - this.lastUpdateWorld[1]);
      if (dist > radiusWorld) {
        this.resumeIndex = 0;
      }
    }
    this.lastUpdateWorld = [worldX, worldY];

    // Start from resume index
    for (let i = this.resumeIndex; i < snapshot.strokes.length; i++) {
      const stroke = snapshot.strokes[i];
      // ... hit testing ...

      if (performance.now() - startTime > MAX_TIME_MS && segmentCount > MAX_SEGMENTS) {
        this.resumeIndex = i + 1; // Remember where to continue

        // Schedule continuation
        if (!this.rafId) {
          this.rafId = requestAnimationFrame(() => {
            this.updateHitTest(worldX, worldY); // Continue from resumeIndex
            this.rafId = null;
          });
        }
        return; // Don't reset resumeIndex yet
      }
    }

    this.resumeIndex = 0; // Finished full scan
    // ... test texts and update accumulator ...
  }
}
```

### Fix 6: Simple Spatial Index (Optional Performance Enhancement)

```typescript
// Create new file: client/src/lib/spatial/uniform-grid.ts
export class UniformGrid<T> {
  private cellSize: number;
  private grid: Map<string, T[]> = new Map();

  constructor(cellSize: number = 128) {
    this.cellSize = cellSize;
  }

  private getKey(x: number, y: number): string {
    const ix = Math.floor(x / this.cellSize);
    const iy = Math.floor(y / this.cellSize);
    return `${ix},${iy}`;
  }

  insert(item: T, bbox: [number, number, number, number]): void {
    const [minX, minY, maxX, maxY] = bbox;
    const minIx = Math.floor(minX / this.cellSize);
    const minIy = Math.floor(minY / this.cellSize);
    const maxIx = Math.floor(maxX / this.cellSize);
    const maxIy = Math.floor(maxY / this.cellSize);

    for (let ix = minIx; ix <= maxIx; ix++) {
      for (let iy = minIy; iy <= maxIy; iy++) {
        const key = `${ix},${iy}`;
        if (!this.grid.has(key)) {
          this.grid.set(key, []);
        }
        this.grid.get(key)!.push(item);
      }
    }
  }

  query(cx: number, cy: number, radius: number): T[] {
    const results = new Set<T>();
    const minIx = Math.floor((cx - radius) / this.cellSize);
    const minIy = Math.floor((cy - radius) / this.cellSize);
    const maxIx = Math.floor((cx + radius) / this.cellSize);
    const maxIy = Math.floor((cy + radius) / this.cellSize);

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

  clear(): void {
    this.grid.clear();
  }
}
```

Then use in EraserTool:

```typescript
private spatialIndex: UniformGrid<StrokeView> | null = null;
private indexedDocVersion: number = -1;

private buildSpatialIndex(snapshot: Snapshot): void {
  if (snapshot.docVersion === this.indexedDocVersion) return;

  this.spatialIndex = new UniformGrid<StrokeView>(128);
  for (const stroke of snapshot.strokes) {
    const halfWidth = (stroke.style?.size ?? 1) / 2;
    const inflatedBbox = this.inflateBbox(stroke.bbox, halfWidth);
    this.spatialIndex.insert(stroke, inflatedBbox);
  }
  this.indexedDocVersion = snapshot.docVersion;
}

private updateHitTest(worldX: number, worldY: number): void {
  const snapshot = this.room.currentSnapshot;
  this.buildSpatialIndex(snapshot);

  const candidates = this.spatialIndex?.query(worldX, worldY, radiusWorld) ?? snapshot.strokes;

  for (const stroke of candidates) {
    // ... hit test only candidates ...
  }
}
```

## Files to Modify

1. `/client/src/lib/tools/EraserTool.ts` - Main fixes
2. `/client/src/renderer/OverlayRenderLoop.ts` - setPreviewProvider fix
3. `/client/src/renderer/layers/eraser-dim.ts` - Dimming improvements
4. `/client/src/canvas/Canvas.tsx` - Pass getView, handle pointerLeave
5. `/client/src/lib/spatial/uniform-grid.ts` - New file (optional)

### Architecture Overview

Implement a whole-stroke eraser that follows the DrawingTool lifecycle pattern, uses the existing two-canvas overlay system, and commits deletions atomically for single-step undo. The tool integrates with the existing Canvas pointer event handling, ViewTransform system, and DirtyRectTracker for optimized rendering.

### Key Design Decisions

- **Tool-local gating only**: `canBegin()` only checks `!isErasing` (tool-local state). Mobile and read-only gating handled by Canvas and mutate() respectively.
- **Unified pointer interface**: Implement same method signatures as DrawingTool for polymorphic handling
- **Preview union type**: Extend PreviewData as union of StrokePreview | EraserPreview with discriminant
- **Shared stroke cache**: Use singleton cache for both base rendering and eraser dimming
- **Two-pass overlay rendering**: World-space dimming (Pass A) and screen-space cursor (Pass B)

### 8.1 Create EraserTool Class

**File:** `/client/src/lib/tools/EraserTool.ts`

```typescript
import type { IRoomDocManager } from '../room-doc-manager';
import * as Y from 'yjs';

// EraserSettings type from device-ui-store
interface EraserSettings {
  size: number; // CSS pixels for cursor radius
}

interface EraserState {
  isErasing: boolean;
  pointerId: number | null;
  radiusPx: number; // CSS pixels from deviceUI
  lastWorld: [number, number] | null;
  hitNow: Set<string>; // IDs currently under cursor
  hitAccum: Set<string>; // IDs accumulated during drag
}

export class EraserTool {
  private state: EraserState;
  private room: IRoomDocManager;
  private settings: EraserSettings;
  private userId: string;
  private rafId: number | null = null;
  private pendingMove: [number, number] | null = null;
  private onInvalidate?: () => void;
  private getViewport?: () => { cssWidth: number; cssHeight: number; dpr: number };

  constructor(
    room: IRoomDocManager,
    settings: EraserSettings,
    userId: string,
    onInvalidate?: () => void,
    getViewport?: () => { cssWidth: number; cssHeight: number; dpr: number },
  ) {
    this.room = room;
    this.settings = settings;
    this.userId = userId;
    this.onInvalidate = onInvalidate;
    this.getViewport = getViewport;
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      isErasing: false,
      pointerId: null,
      radiusPx: this.settings.size,
      lastWorld: null,
      hitNow: new Set(),
      hitAccum: new Set(),
    };
  }

  // PointerTool interface compatibility - same signature as DrawingTool
  canBegin(): boolean {
    // ONLY check tool-local readiness
    // Canvas handles mobile gating, mutate() handles read-only
    return !this.state.isErasing;
  }

  // Alias for legacy naming if needed
  canStartErasing(): boolean {
    return this.canBegin();
  }

  // PointerTool interface - polymorphic with DrawingTool
  begin(pointerId: number, worldX: number, worldY: number): void {
    this.startErasing(pointerId, worldX, worldY);
  }

  startErasing(pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isErasing) return;

    this.state = {
      isErasing: true,
      pointerId,
      radiusPx: this.settings.size,
      lastWorld: [worldX, worldY],
      hitNow: new Set(),
      hitAccum: new Set(),
    };

    this.updateHitTest(worldX, worldY);
  }

  move(worldX: number, worldY: number): void {
    if (!this.state.isErasing) return;

    // RAF coalesce like DrawingTool
    this.pendingMove = [worldX, worldY];

    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        if (this.pendingMove && this.state.isErasing) {
          this.updateHitTest(...this.pendingMove);
          this.state.lastWorld = this.pendingMove;
        }
        this.pendingMove = null;
        this.rafId = null;
      });
    }
  }

  // PointerTool interface methods for polymorphic handling
  end(worldX?: number, worldY?: number): void {
    // Eraser doesn't use final coordinates, just commit
    this.commitErase();
  }

  cancel(): void {
    this.cancelErasing();
  }

  isActive(): boolean {
    return this.state.isErasing;
  }

  getPointerId(): number | null {
    return this.state.pointerId;
  }

  destroy(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resetState();
  }

  // Compatibility alias
  isErasing(): boolean {
    return this.state.isErasing;
  }

  private updateHitTest(worldX: number, worldY: number): void {
    const snapshot = this.room.currentSnapshot;
    const viewTransform = snapshot.view;

    // Convert radius to world units
    const radiusWorld = this.state.radiusPx / viewTransform.scale;

    // Get visible bounds for pruning
    const visibleBounds = this.getVisibleWorldBounds(viewTransform);

    // Clear and rebuild hitNow
    this.state.hitNow.clear();

    // Performance budget tracking
    const startTime = performance.now();
    const MAX_TIME_MS = 6;
    let segmentCount = 0;

    // Test strokes
    for (const stroke of snapshot.strokes) {
      // Viewport prune
      if (!this.isInBounds(stroke.bbox, visibleBounds)) continue;

      // Inflated bbox test
      const inflatedBbox = this.inflateBbox(stroke.bbox, radiusWorld);
      if (!this.pointInBbox(worldX, worldY, inflatedBbox)) continue;

      // Segment distance test
      if (this.strokeHitTest(worldX, worldY, stroke.points, radiusWorld)) {
        this.state.hitNow.add(stroke.id);
      }

      segmentCount += stroke.points.length / 2;

      // Time budget check
      if (performance.now() - startTime > MAX_TIME_MS || segmentCount > 100) {
        break; // Defer rest to next frame
      }
    }

    // Test text blocks (simple bbox intersection)
    for (const text of snapshot.texts) {
      const textBbox = [text.x, text.y, text.x + text.w, text.y + text.h];
      if (!this.isInBounds(textBbox, visibleBounds)) continue;

      const inflatedBbox = this.inflateBbox(textBbox, radiusWorld);
      if (this.pointInBbox(worldX, worldY, inflatedBbox)) {
        this.state.hitNow.add(text.id);
      }
    }

    // Update accumulator if dragging
    if (this.state.pointerId !== null) {
      for (const id of this.state.hitNow) {
        this.state.hitAccum.add(id);
      }
    }

    // Trigger overlay redraw
    this.onInvalidate?.();
  }

  private strokeHitTest(
    px: number,
    py: number,
    points: ReadonlyArray<number>,
    radius: number,
  ): boolean {
    // Test each segment
    for (let i = 0; i < points.length - 2; i += 2) {
      const x1 = points[i],
        y1 = points[i + 1];
      const x2 = points[i + 2],
        y2 = points[i + 3];

      const dist = this.pointToSegmentDistance(px, py, x1, y1, x2, y2);
      if (dist <= radius) return true;
    }
    return false;
  }

  private pointToSegmentDistance(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): number {
    const dx = x2 - x1,
      dy = y2 - y1;

    // Handle degenerate segment
    if (dx === 0 && dy === 0) {
      return Math.hypot(px - x1, py - y1);
    }

    // Project point onto segment
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    return Math.hypot(px - projX, py - projY);
  }

  cancelErasing(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingMove = null;
    this.resetState();
    this.onInvalidate?.(); // Clear any preview
  }

  commitErase(): void {
    if (!this.state.isErasing) return;
    if (this.state.hitAccum.size === 0) {
      this.cancelErasing();
      return;
    }

    // Atomic delete in single transaction
    // This single mutate() constitutes ONE undo step per user (UndoManager origin=userId)
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const yStrokes = root.get('strokes') as Y.Array<any>;
      const yTexts = root.get('texts') as Y.Array<any>;

      // Build id→index maps
      const strokeIdToIndex = new Map<string, number>();
      for (let i = 0; i < yStrokes.length; i++) {
        strokeIdToIndex.set(yStrokes.get(i).id, i);
      }

      const textIdToIndex = new Map<string, number>();
      for (let i = 0; i < yTexts.length; i++) {
        textIdToIndex.set(yTexts.get(i).id, i);
      }

      // Get indices and sort descending (reverse order)
      const strokeIndices = Array.from(this.state.hitAccum)
        .map((id) => strokeIdToIndex.get(id))
        .filter((idx): idx is number => idx !== undefined)
        .sort((a, b) => b - a);

      const textIndices = Array.from(this.state.hitAccum)
        .map((id) => textIdToIndex.get(id))
        .filter((idx): idx is number => idx !== undefined)
        .sort((a, b) => b - a);

      // Delete in reverse order to preserve indices
      for (const idx of strokeIndices) {
        yStrokes.delete(idx, 1);
      }
      for (const idx of textIndices) {
        yTexts.delete(idx, 1);
      }
    });

    this.resetState();
  }

  getPreview(): EraserPreview | null {
    if (!this.state.lastWorld) return null;

    // Combine hover + accumulated hits
    const allHits = new Set([...this.state.hitNow, ...this.state.hitAccum]);

    return {
      kind: 'eraser',
      circle: {
        cx: this.state.lastWorld[0], // World coords, transformed by overlay
        cy: this.state.lastWorld[1],
        r_px: this.state.radiusPx, // Screen pixels, fixed size
      },
      hitIds: Array.from(allHits),
      dimOpacity: 0.35,
    };
  }

  // Helper methods
  private getVisibleWorldBounds(viewTransform: ViewTransform): WorldBounds {
    if (!this.getViewport) {
      // Fallback: return large bounds if viewport not available
      return { minX: -10000, minY: -10000, maxX: 10000, maxY: 10000 };
    }

    const vp = this.getViewport();
    const marginPx = this.state.radiusPx + 50; // Add margin for partial visibility
    const marginWorld = marginPx / viewTransform.scale;

    // Convert viewport corners to world coordinates
    const [minWorldX, minWorldY] = viewTransform.canvasToWorld(0, 0);
    const [maxWorldX, maxWorldY] = viewTransform.canvasToWorld(vp.cssWidth, vp.cssHeight);

    return {
      minX: minWorldX - marginWorld,
      minY: minWorldY - marginWorld,
      maxX: maxWorldX + marginWorld,
      maxY: maxWorldY + marginWorld,
    };
  }

  private isInBounds(
    bbox: number[] | [number, number, number, number],
    bounds: WorldBounds,
  ): boolean {
    return !(
      bbox[2] < bounds.minX || // bbox right < viewport left
      bbox[0] > bounds.maxX || // bbox left > viewport right
      bbox[3] < bounds.minY || // bbox bottom < viewport top
      bbox[1] > bounds.maxY // bbox top > viewport bottom
    );
  }

  private inflateBbox(
    bbox: number[] | [number, number, number, number],
    radius: number,
  ): [number, number, number, number] {
    return [bbox[0] - radius, bbox[1] - radius, bbox[2] + radius, bbox[3] + radius];
  }

  private pointInBbox(px: number, py: number, bbox: [number, number, number, number]): boolean {
    return px >= bbox[0] && px <= bbox[2] && py >= bbox[1] && py <= bbox[3];
  }
}

// Type for world bounds used in hit testing
interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
```

### 8.2 Extend Preview Types

**File:** `/client/src/lib/tools/types.ts`

**Critical Changes:**

1. Rename existing `PreviewData` interface to `StrokePreview`
2. Add `kind: 'stroke'` discriminant to StrokePreview
3. Create union type for PreviewData
4. Update DrawingTool.getPreview() to return `{ kind: 'stroke', ... }`

```typescript
// RENAME existing PreviewData to StrokePreview and add discriminant
export interface StrokePreview {
  kind: 'stroke'; // ADD THIS DISCRIMINANT
  points: ReadonlyArray<number>; // [x,y, x,y, ...] in world coordinates
  tool: 'pen' | 'highlighter';
  color: string;
  size: number; // World units
  opacity: number;
  bbox: [number, number, number, number] | null; // Used for dirty rect tracking
}

// ADD new EraserPreview interface
export interface EraserPreview {
  kind: 'eraser';
  /** Center in world coords; overlay does worldToCanvas() */
  circle: { cx: number; cy: number; r_px: number };
  hitIds: string[];
  dimOpacity: number;
}

// CREATE union type (was previously just StrokePreview)
export type PreviewData = StrokePreview | EraserPreview;
```

**Also update DrawingTool.getPreview()** in `/client/src/lib/tools/DrawingTool.ts`:

```typescript
getPreview(): PreviewData | null {
  if (!this.state.isDrawing) return null;
  // ... existing logic ...
  return {
    kind: 'stroke',  // ADD THIS
    points: this.state.points,
    // ... rest of existing properties
  };
}
```

### 8.3 Update Overlay Rendering

**File:** `/client/src/renderer/OverlayRenderLoop.ts`

**Note:** The overlay loop already handles preview rendering in its frame() method, but we need to update it to handle the new union type with discriminants. The key is to check `preview.kind` to determine which rendering path to take.

```typescript
// In frame() method, update the preview rendering section:
private frame() {
  // ... existing code up to preview handling ...

  // Handle preview rendering based on kind
  const previewToDraw = preview || (this.holdPreviewOneFrame && this.cachedPreview);
  if (previewToDraw) {
    stage.withContext((ctx) => {
      // Check preview kind using discriminant
      if (previewToDraw.kind === 'stroke') {
        // Existing stroke preview (world space)
        ctx.save();
        ctx.scale(view.scale, view.scale);
        ctx.translate(-view.pan.x, -view.pan.y);
        drawPreview(ctx, previewToDraw); // Existing preview function
        ctx.restore();

      } else if (previewToDraw.kind === 'eraser') {
        // New eraser preview (two passes)
        const snapshot = this.getSnapshot(); // Need snapshot for dimming

        // Pass A: Dim hit strokes (world space)
        if (previewToDraw.hitIds.length > 0) {
          ctx.save();
          ctx.scale(view.scale, view.scale);
          ctx.translate(-view.pan.x, -view.pan.y);
          // Import drawDimmedStrokes from new eraser-dim layer
          drawDimmedStrokes(ctx, previewToDraw.hitIds, snapshot, previewToDraw.dimOpacity);
          ctx.restore();
        }

        // Pass B: Draw cursor circle (screen space)
        ctx.save();
        // Apply only DPR, no world transform
        ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

        // Transform cursor position to screen
        const [screenX, screenY] = view.worldToCanvas(
          previewToDraw.circle.cx,
          previewToDraw.circle.cy
        );

        // Draw circle outline
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 1; // Device pixel for crisp line
        ctx.beginPath();
        ctx.arc(screenX, screenY, previewToDraw.circle.r_px, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
      }
    });
  }

  // ... rest of frame() method
}
```

**Also need to add getSnapshot callback** to OverlayLoopConfig:

```typescript
export interface OverlayLoopConfig {
  // ... existing properties ...
  getSnapshot: () => Snapshot; // ADD THIS for eraser dimming
}
```

### 8.4 Add Dimmed Stroke Rendering

Use the **global** stroke cache via `getStrokeCacheInstance()`; do not rebuild Path2D/typed arrays in the dim pass.

**File:** `/client/src/renderer/layers/eraser-dim.ts`

```typescript
import type { Snapshot } from '@avlo/shared';
import { getStrokeCacheInstance } from '../stroke-builder/stroke-cache';

export function drawDimmedStrokes(
  ctx: CanvasRenderingContext2D,
  hitIds: string[],
  snapshot: Snapshot,
  baseOpacity: number,
): void {
  const hitSet = new Set(hitIds);
  const cache = getStrokeCacheInstance();

  ctx.save();

  // Render hit strokes with reduced opacity
  for (const stroke of snapshot.strokes) {
    if (!hitSet.has(stroke.id)) continue;

    const renderData = cache.getOrBuild(stroke);
    if (!renderData.path || renderData.pointCount < 2) continue;

    // Adaptive opacity for highlighters
    const opacity =
      stroke.style.tool === 'highlighter'
        ? Math.max(0.15, baseOpacity * 0.6) // Lighter for already-transparent
        : baseOpacity;

    ctx.globalAlpha = opacity;
    ctx.strokeStyle = stroke.style.color;
    ctx.lineWidth = stroke.style.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.stroke(renderData.path);
  }

  // Render hit text blocks as semi-transparent rectangles
  for (const text of snapshot.texts) {
    if (!hitSet.has(text.id)) continue;

    ctx.fillStyle = text.color;
    ctx.globalAlpha = baseOpacity * 0.3;
    ctx.fillRect(text.x, text.y, text.w, text.h);
  }

  ctx.restore();
}
```

### 8.5 Wire Into Canvas.tsx

**File:** `/client/src/canvas/Canvas.tsx`

**Key Changes:**

1. Create a unified `PointerTool` type that both DrawingTool and EraserTool implement
2. Branch only once during tool construction, not in event handlers
3. Pass `getViewport` callback to EraserTool for hit-test pruning
4. Handle mobile gating in Canvas, not in tools

```typescript
// Import both tools
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';

// Define unified interface (can be in types.ts)
type PointerTool = DrawingTool | EraserTool;

// In the main pointer event effect (around line 454)
useEffect(() => {
  // ... existing guard checks ...

  // Mobile detection (Canvas handles this, not tools)
  const isMobile =
    /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

  // Create appropriate tool based on activeTool (branch ONCE here)
  let tool: PointerTool | null = null;

  if (activeTool === 'eraser') {
    // Pass deviceUI.eraser directly (no adapter needed)
    tool = new EraserTool(
      roomDoc,
      deviceUI.eraser, // Direct from store, no adapter
      userId,
      () => overlayLoopRef.current?.invalidateAll(),
      // Pass viewport callback for hit-test pruning
      () => {
        const size = canvasSizeRef.current;
        if (size) {
          return {
            cssWidth: size.cssWidth,
            cssHeight: size.cssHeight,
            dpr: size.dpr,
          };
        }
        return { cssWidth: 1, cssHeight: 1, dpr: 1 };
      },
    );
  } else if (activeTool === 'pen' || activeTool === 'highlighter') {
    // Use adapter only for DrawingTool
    const adaptedUI = toolbarToDeviceUI({
      tool: activeTool,
      color: activeTool === 'pen' ? pen.color : highlighter.color,
      size: activeTool === 'pen' ? pen.size : highlighter.size,
      opacity: activeTool === 'pen' ? pen.opacity || 1 : highlighter.opacity,
    });

    tool = new DrawingTool(roomDoc, adaptedUI, userId, () =>
      overlayLoopRef.current?.invalidateAll(),
    );
  } else {
    return; // Unsupported tool
  }

  // Set preview provider (both tools implement getPreview())
  if (!isMobile && overlayLoopRef.current) {
    overlayLoopRef.current.setPreviewProvider({
      getPreview: () => tool?.getPreview() || null,
    });
  }

  // Update cursor style
  canvas.style.cursor = activeTool === 'eraser' ? 'none' : 'crosshair';

  // UNIFIED POINTER HANDLERS - No tool branching here!
  const handlePointerDown = (e: PointerEvent) => {
    // Canvas gates for mobile (not tool)
    if (isMobile) return;
    if (!tool?.canBegin()) return;

    const worldCoords = screenToWorld(e.clientX, e.clientY);
    if (!worldCoords) return;

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    // Polymorphic call - works for any tool
    tool.begin(e.pointerId, worldCoords[0], worldCoords[1]);
    roomDoc.updateActivity('drawing'); // Same for pen/eraser
  };

  const handlePointerMove = (e: PointerEvent) => {
    // Update awareness cursor (not on mobile)
    if (!isMobile) {
      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (worldCoords) {
        roomDoc.updateCursor(worldCoords[0], worldCoords[1]);

        // Tool movement if active
        if (tool?.isActive() && e.pointerId === tool.getPointerId()) {
          tool.move(worldCoords[0], worldCoords[1]);
        }
      }
    }
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (!tool?.isActive() || e.pointerId !== tool.getPointerId()) return;

    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}

    const worldCoords = screenToWorld(e.clientX, e.clientY);
    tool.end(worldCoords?.[0], worldCoords?.[1]);
    roomDoc.updateActivity('idle');
  };

  const handlePointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== tool?.getPointerId()) return;

    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}

    tool?.cancel();
    roomDoc.updateActivity('idle');
  };

  // ... rest of handlers and cleanup ...

  return () => {
    // Cleanup
    const pointerId = tool?.getPointerId();
    if (pointerId !== null) {
      try {
        canvas.releasePointerCapture(pointerId);
      } catch {}
    }
    tool?.cancel();
    tool?.destroy();
    overlayLoopRef.current?.setPreviewProvider(null);
    // ... remove listeners ...
  };
}, [roomDoc, userId, activeTool, deviceUI, pen, highlighter, stageReady, screenToWorld]);
```

**Critical Notes:**

- Mobile gating happens in Canvas, not tools
- `toolbarToDeviceUI` adapter used ONLY for DrawingTool, not eraser
- All pointer handlers are tool-agnostic after construction
- Include `pen` and `highlighter` in deps for proper updates

### 8.6 Export Stroke Cache

**File:** `/client/src/renderer/stroke-builder/stroke-cache.ts`

```typescript
// Add singleton export for shared access
let globalCacheInstance: StrokeRenderCache | null = null;

export function getStrokeCacheInstance(): StrokeRenderCache {
  if (!globalCacheInstance) {
    globalCacheInstance = new StrokeRenderCache(1000);
  }
  return globalCacheInstance;
}

// Update strokes.ts to use shared instance
// const strokeCache = getStrokeCacheInstance();
```
