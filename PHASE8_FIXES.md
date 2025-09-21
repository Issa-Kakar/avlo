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

## Testing Checklist

1. **Zoom Out Test**: Zoom out completely and verify eraser works consistently
2. **Pointer Leave Test**: Move cursor off canvas, verify preview disappears
3. **Tool Switch Test**: Switch from eraser to pen, verify preview clears
4. **Dimming Visibility Test**: Verify dimmed strokes are clearly visible
5. **1px Stroke Test**: Draw thin strokes and verify they erase as easily as thick ones
6. **Performance Test**: Create 1000+ strokes and verify eraser remains responsive
7. **Mobile Test**: Verify eraser is properly disabled on mobile (view-only)

## Files to Modify

1. `/client/src/lib/tools/EraserTool.ts` - Main fixes
2. `/client/src/renderer/OverlayRenderLoop.ts` - setPreviewProvider fix
3. `/client/src/renderer/layers/eraser-dim.ts` - Dimming improvements
4. `/client/src/canvas/Canvas.tsx` - Pass getView, handle pointerLeave
5. `/client/src/lib/spatial/uniform-grid.ts` - New file (optional)
