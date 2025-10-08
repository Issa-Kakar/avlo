# Cache Clearing & Invalidation Architecture - Deep Dive

**Purpose:** Comprehensive reference for understanding when, why, and how caches are cleared and content is invalidated in the Avlo rendering pipeline.

**Last Updated:** 2025-10-06

---

## Table of Contents

1. [Overview: Multi-Level Cache System](#overview-multi-level-cache-system)
2. [Stroke Render Cache](#stroke-render-cache)
3. [Dirty Rectangle Tracker](#dirty-rectangle-tracker)
4. [Canvas.tsx Invalidation Logic](#canvastsx-invalidation-logic)
5. [Scene Change Cascades](#scene-change-cascades)
6. [Transform Change Handling](#transform-change-handling)
7. [Snapshot Diffing Strategy](#snapshot-diffing-strategy)
8. [Preview Hold Mechanism](#preview-hold-mechanism)
9. [Complete Invalidation Flow Chart](#complete-invalidation-flow-chart)
10. [Performance Tuning Parameters](#performance-tuning-parameters)

---

## Overview: Multi-Level Cache System

The Avlo rendering pipeline uses **three distinct caching/invalidation layers**:

```typescript
// Layer 1: Stroke Render Cache (Path2D + Float32Array)
// Singleton, ID-keyed, cleared on scene change
StrokeRenderCache: Map<strokeId, { path: Path2D, polyline: Float32Array, ... }>

// Layer 2: Dirty Rectangle Tracker (per-frame invalidation regions)
// Tracks world-space changes, converts to device pixels for clearing
DirtyRectTracker: {
  rects: DevicePixelRect[]
  fullClearRequired: boolean
  lastTransform: { scale, pan }
}

// Layer 3: Snapshot Reference (event-driven updates)
// Triggers invalidation via subscribeSnapshot callback
snapshotRef: RefObject<Snapshot>
```

**Why three layers?**

1. **Stroke Cache:** Amortizes expensive Path2D construction across frames
2. **Dirty Tracker:** Optimizes partial canvas clears (draw only changed regions)
3. **Snapshot Ref:** Prevents React re-renders while maintaining reactivity

---

## Stroke Render Cache

### Location
- Primary: `/client/src/renderer/stroke-builder/stroke-cache.ts`
- Export: `/client/src/renderer/layers/index.ts` → `clearStrokeCache()`
- Consumer: `/client/src/renderer/layers/strokes.ts` (drawStrokes function)

### Data Structure

```typescript
class StrokeRenderCache {
  private cache = new Map<string, StrokeRenderData>();
  private maxSize = 1000; // FIFO eviction

  interface StrokeRenderData {
    path: Path2D | null;        // GPU-accelerated stroke path
    polyline: Float32Array;     // Fallback for ctx.lineTo()
    bounds: { x, y, width, height };
    pointCount: number;
  }
}
```

### Cache Lifecycle

**1. Build (Lazy):**

```typescript
// Called from drawStrokes() for each visible stroke
getOrBuild(stroke: StrokeView): StrokeRenderData {
  const cached = this.cache.get(stroke.id);
  if (cached) return cached; // Cache hit

  // Cache miss: Build render data NOW
  const renderData = buildStrokeRenderData(stroke);

  // FIFO eviction if cache full
  if (this.cache.size >= this.maxSize) {
    const firstKey = this.cache.keys().next().value;
    this.cache.delete(firstKey);
  }

  this.cache.set(stroke.id, renderData);
  return renderData;
}
```

**Why ID-keyed?** Strokes are **immutable after commit**. Once a stroke exists in the Y.Doc with a ULID, its points/style never change. The ID is a perfect cache key.

**2. Clear (Scene Change):**

```typescript
// In drawStrokes() - RenderLoop.ts:257
if (snapshot.scene !== lastScene) {
  strokeCache.clear(); // Dump entire cache
  lastScene = snapshot.scene;
}
```

**Why clear on scene change?**
- Scene changes represent major document state transitions (undo/redo, scene navigation)
- Old scene strokes are no longer visible, so cache entries are dead weight
- Prevents unbounded memory growth in long sessions

**3. Invalidate (Single Stroke):**

```typescript
// Called when a specific stroke is deleted (Phase 10 feature)
strokeCache.invalidate(strokeId);
```

**Currently unused** - deletion not yet implemented. When it is, this will remove a single cache entry without clearing the entire cache.

**4. Destroy (Unmount):**

```typescript
// Canvas.tsx:437 - RenderLoop cleanup
return () => {
  renderLoop.stop();
  renderLoop.destroy();
  renderLoopRef.current = null;
  clearStrokeCache(); // Prevent memory leak on room switch
};
```

**Critical for multi-room apps:** Switching rooms would otherwise accumulate cache entries for all previously visited rooms.

### Cache Hit Ratio Analysis

```typescript
// Theoretical hit ratio for a 500-stroke document with 1000-entry cache:
// Frame 1: 500 misses, 0 hits (0% hit rate)
// Frame 2: 0 misses, 500 hits (100% hit rate)
// Frames 2-N: 100% hit rate until scene change or eviction

// Eviction scenario (10k strokes, 1000 cache):
// First 1000 strokes: Cached
// Strokes 1001-10000: FIFO eviction, recycling cache entries
// Hit rate stabilizes at ~90% (visible strokes usually stable frame-to-frame)
```

---

## Dirty Rectangle Tracker

### Location
`/client/src/renderer/DirtyRectTracker.ts`

The DirtyRectTracker is a **per-frame** invalidation accumulator. It tracks which regions of the canvas need to be redrawn, allowing partial clears instead of full-frame clears.

### Core State

```typescript
class DirtyRectTracker {
  private rects: DevicePixelRect[] = []; // Accumulated dirty regions
  private fullClearRequired = false;      // Promotion flag
  private lastTransform: { scale, pan };  // Transform change detection
  private canvasSize: { width, height };  // Device pixels for area calc
  private dpr = 1;                         // Device pixel ratio
}
```

### Invalidation Methods

#### 1. World-Space Invalidation (Most Common)

```typescript
// Called from Canvas.tsx snapshot subscription for content changes
invalidateWorldBounds(bounds: WorldBounds, viewTransform: ViewTransform): void {
  // Convert world bounds to CSS pixels
  const [minX, minY] = viewTransform.worldToCanvas(bounds.minX, bounds.minY);
  const [maxX, maxY] = viewTransform.worldToCanvas(bounds.maxX, bounds.maxY);

  // Delegate to CSS pixel invalidation
  this.invalidateCanvasPixels(
    { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    viewTransform.scale,
    this.dpr
  );
}
```

**Usage:**
```typescript
// Canvas.tsx:238 - Snapshot change handler
for (const bounds of changedBounds) {
  renderLoopRef.current.invalidateWorld(bounds);
}
```

#### 2. CSS Pixel Invalidation (Internal)

```typescript
invalidateCanvasPixels(rect: CSSPixelRect, scale, dpr): void {
  if (this.fullClearRequired) return; // Already clearing everything

  // Validate rect (prevent NaN/Infinity)
  if (!isFinite(rect.x) || !isFinite(rect.y) || ...) {
    this.invalidateAll('dirty-overflow');
    return;
  }

  // Convert CSS → Device pixels
  const deviceRect = {
    x: rect.x * dpr,
    y: rect.y * dpr,
    width: rect.width * dpr,
    height: rect.height * dpr
  };

  // Inflate for stroke width + anti-aliasing
  const strokeMargin = MAX_WORLD_LINE_WIDTH * scale * dpr;
  const totalMargin = AA_MARGIN + strokeMargin;

  const inflated = {
    x: Math.floor(deviceRect.x - totalMargin),
    y: Math.floor(deviceRect.y - totalMargin),
    width: Math.ceil(deviceRect.width + 2 * totalMargin),
    height: Math.ceil(deviceRect.height + 2 * totalMargin)
  };

  // Snap to coalesce grid (16px by default)
  inflated.x = Math.floor(inflated.x / COALESCE_SNAP) * COALESCE_SNAP;
  inflated.y = Math.floor(inflated.y / COALESCE_SNAP) * COALESCE_SNAP;

  this.rects.push(inflated);
  this.checkPromotion(); // May promote to full clear
}
```

**Why inflate?**
- **Stroke width:** A 10px world-unit stroke at 2x zoom = 20px screen
- **Anti-aliasing:** Canvas AA bleeds ~1-2 pixels outside stroke bounds
- **Safety margin:** Better to over-clear than under-clear (artifacts)

**Why snap to grid?**
- Adjacent dirty rects with different offsets won't coalesce
- Snapping to 16px grid increases coalescing likelihood
- Trades slightly larger clear regions for fewer total rects

#### 3. Transform Change Detection

```typescript
notifyTransformChange(newTransform: { scale, pan }): void {
  if (
    this.lastTransform.scale !== newTransform.scale ||
    this.lastTransform.pan.x !== newTransform.pan.x ||
    this.lastTransform.pan.y !== newTransform.pan.y
  ) {
    this.fullClearRequired = true; // Force full clear
    this.rects = [];
    this.lastTransform = { ...newTransform };
  }
}
```

**Why full clear on transform?**
- Pan/zoom moves EVERYTHING on the canvas
- Dirty rect optimization would require tracking viewport-space bounds
- Simpler to just redraw everything (still event-driven, no idle CPU)

**Called from:**
```typescript
// RenderLoop.ts:269 - Every tick if transform changed
if (transformChanged) {
  this.dirtyTracker.notifyTransformChange(view);
}
```

#### 4. Force Full Clear

```typescript
invalidateAll(reason: InvalidationReason): void {
  this.fullClearRequired = true;
  this.rects = [];
}

type InvalidationReason =
  | 'scene-change'      // Canvas.tsx:218 - Scene ID changed
  | 'content-change'    // Canvas.tsx:423 - Initial render
  | 'geometry-change'   // RenderLoop.ts:467 - Canvas resize
  | 'transform-change'  // RenderLoop.ts:247 - Pan/zoom
  | 'dirty-overflow';   // DirtyRectTracker:75 - Invalid rect data
```

### Promotion Logic

The tracker **automatically promotes to full clear** when dirty rects become inefficient:

```typescript
private checkPromotion(): void {
  // Rule 1: Too many rects (tracking overhead)
  if (this.rects.length > MAX_RECT_COUNT) {
    this.fullClearRequired = true;
    this.rects = [];
    return;
  }

  // Rule 2: Union area too large (might as well full clear)
  const union = this.calculateUnion();
  const unionArea = union.width * union.height;
  const canvasArea = this.canvasSize.width * this.canvasSize.height;

  if (canvasArea > 0 && unionArea / canvasArea > MAX_AREA_RATIO) {
    this.fullClearRequired = true;
    this.rects = [];
  }
}
```

**Default thresholds:**
```typescript
const DIRTY_RECT_CONFIG = {
  MAX_RECT_COUNT: 64,      // Promote if >64 dirty rects in frame
  MAX_AREA_RATIO: 0.6,     // Promote if dirty area >60% of canvas
  COALESCE_SNAP: 16,       // Snap rects to 16px grid
  AA_MARGIN: 2,            // Anti-aliasing bleed (device px)
  MAX_WORLD_LINE_WIDTH: 50 // Worst-case stroke (world units)
};
```

**Why 64 rects?** Empirical testing showed diminishing returns beyond 50-70 rects. The overhead of tracking/iterating that many rectangles exceeds the savings from partial clearing.

**Why 60% area?** If you're clearing more than half the canvas, the cost of multiple `ctx.clearRect()` calls + bounds calculation exceeds a single full clear.

### Coalescing Algorithm

```typescript
coalesce(): void {
  if (this.rects.length <= 1) return;

  const merged: DevicePixelRect[] = [];
  const used = new Set<number>();

  for (let i = 0; i < this.rects.length; i++) {
    if (used.has(i)) continue;

    let current = { ...this.rects[i] };
    used.add(i);

    // Greedy merge: keep merging until no more overlaps
    let didMerge = true;
    while (didMerge) {
      didMerge = false;
      for (let j = 0; j < this.rects.length; j++) {
        if (used.has(j)) continue;

        if (this.rectsOverlap(current, this.rects[j])) {
          // Union the two rects
          const minX = Math.min(current.x, this.rects[j].x);
          const minY = Math.min(current.y, this.rects[j].y);
          const maxX = Math.max(current.x + current.width, this.rects[j].x + this.rects[j].width);
          const maxY = Math.max(current.y + current.height, this.rects[j].y + this.rects[j].height);

          current = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          used.add(j);
          didMerge = true;
        }
      }
    }

    merged.push(current);
  }

  this.rects = merged;
  this.checkPromotion(); // Re-check after coalescing
}
```

**Called from:**
```typescript
// RenderLoop.ts:282 - Before getting clear instructions
if (clearInstructions.type === 'dirty' && clearInstructions.rects.length > 1) {
  this.dirtyTracker.coalesce();
  clearInstructions = this.dirtyTracker.getClearInstructions();
}
```

**Overlap detection:**
```typescript
private rectsOverlap(a: DevicePixelRect, b: DevicePixelRect): boolean {
  const margin = COALESCE_SNAP; // Allow adjacent rects to merge
  return !(
    a.x > b.x + b.width + margin ||  // a is right of b
    b.x > a.x + a.width + margin ||  // b is right of a
    a.y > b.y + b.height + margin || // a is below b
    b.y > a.y + a.height + margin    // b is below a
  );
}
```

**CRITICAL:** The `margin` parameter allows rects that are **up to 16px apart** to merge. This is key for efficient coalescing of nearby strokes.

### Clear Execution

```typescript
// RenderLoop.ts:322 - Clear pass
const clearInstructions = this.dirtyTracker.getClearInstructions();

ctx.save();
ctx.setTransform(1, 0, 0, 1, 0, 0); // Identity (DPR already applied)

if (clearInstructions.type === 'full') {
  ctx.clearRect(0, 0, viewport.pixelWidth, viewport.pixelHeight);
  this.frameStats.lastClearType = 'full';
  this.frameStats.rectCount = 0;

} else if (clearInstructions.type === 'dirty' && clearInstructions.rects) {
  for (const rect of clearInstructions.rects) {
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
  }
  this.frameStats.lastClearType = 'dirty';
  this.frameStats.rectCount = clearInstructions.rects.length;
}

ctx.restore();

// CRITICAL: Reset tracker for next frame
this.dirtyTracker.reset();
```

**Frame boundary:** `reset()` is called AFTER clearing but BEFORE drawing. New invalidations during this frame's draw pass will accumulate for the NEXT frame.

---

## Canvas.tsx Invalidation Logic

Canvas.tsx is the **invalidation hub**. It:
1. Subscribes to snapshot changes (Yjs updates)
2. Diffs snapshots to find changed strokes/text
3. Converts world bounds to invalidation calls
4. Manages scene/transform change cascades

### Snapshot Subscription

```typescript
// Canvas.tsx:207 - Main subscription effect
useEffect(() => {
  let lastDocVersion = -1;

  const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
    const prevSnapshot = snapshotRef.current;
    snapshotRef.current = newSnapshot;

    if (!renderLoopRef.current || !overlayLoopRef.current) return;

    // CASE 1: Scene change (full clear both canvases)
    if (!prevSnapshot || prevSnapshot.scene !== newSnapshot.scene) {
      renderLoopRef.current.invalidateAll('scene-change');
      overlayLoopRef.current.invalidateAll();
      lastDocVersion = newSnapshot.docVersion;
      return;
    }

    // CASE 2: Document content change (strokes/text added/modified/deleted)
    if (newSnapshot.docVersion !== lastDocVersion) {
      lastDocVersion = newSnapshot.docVersion;

      // Hold preview for one frame (prevent flash on commit)
      overlayLoopRef.current.holdPreviewForOneFrame();

      // Diff snapshots to find changed bounds
      const changedBounds = diffBounds(prevSnapshot, newSnapshot);

      // Invalidate each changed region
      for (const bounds of changedBounds) {
        renderLoopRef.current.invalidateWorld(bounds);
      }

      overlayLoopRef.current.invalidateAll();

    } else {
      // CASE 3: Presence-only change (cursors moved, no doc change)
      overlayLoopRef.current.invalidateAll(); // Update overlay only
    }
  });

  return unsubscribe;
}, [roomDoc]);
```

**Three invalidation paths:**

1. **Scene change:** Full clear (new scene = entirely new content)
2. **Content change:** Targeted invalidation via bbox diffing
3. **Presence change:** Overlay only (cursors don't affect base canvas)

**Why track `lastDocVersion`?**

Yjs updates trigger snapshot callbacks for BOTH document changes and presence changes. The `docVersion` counter only increments for Y.Doc mutations (strokes/text), not awareness updates (cursors). This prevents expensive bbox diffing on every cursor move.

### Snapshot Diffing

```typescript
// Canvas.tsx:41 - Diff two snapshots to find changed regions
function diffBounds(prev: Snapshot, next: Snapshot): WorldBounds[] {
  const prevStrokeMap = new Map(prev.strokes.map(s => [s.id, s]));
  const nextStrokeMap = new Map(next.strokes.map(s => [s.id, s]));
  const dirty: WorldBounds[] = [];

  // ADDED/MODIFIED STROKES
  for (const [id, stroke] of nextStrokeMap) {
    const prevStroke = prevStrokeMap.get(id);
    if (!prevStroke || !bboxEquals(prevStroke.bbox, stroke.bbox)) {
      dirty.push({
        minX: stroke.bbox[0],
        minY: stroke.bbox[1],
        maxX: stroke.bbox[2],
        maxY: stroke.bbox[3]
      });
    }
  }

  // DELETED STROKES
  for (const [id, stroke] of prevStrokeMap) {
    if (!nextStrokeMap.has(id)) {
      dirty.push({
        minX: stroke.bbox[0],
        minY: stroke.bbox[1],
        maxX: stroke.bbox[2],
        maxY: stroke.bbox[3]
      });
    }
  }

  // TEXT BLOCKS (similar logic)
  // ...

  return dirty; // No coalescing here - DirtyRectTracker handles it
}
```

**Epsilon equality for bbox comparison:**

```typescript
function bboxEquals(a: number[], b: number[]): boolean {
  const eps = 1e-3; // 0.001 world units
  return (
    Math.abs(a[0] - b[0]) < eps &&
    Math.abs(a[1] - b[1]) < eps &&
    Math.abs(a[2] - b[2]) < eps &&
    Math.abs(a[3] - b[3]) < eps
  );
}
```

**Why epsilon?** Floating-point math can introduce tiny precision errors. Without epsilon, identical bboxes might compare as different due to rounding.

**Key insight:** Diffing is **ID-based**, not position-based. Adding 1000 strokes = 1000 dirty regions, but they're individually tracked. Moving a stroke counts as "deleted from old position, added to new position" (2 dirty rects).

### Transform Change Invalidation

```typescript
// Canvas.tsx:985 - Transform effect
useEffect(() => {
  // Trigger a frame when transform changes
  // DirtyRectTracker.notifyTransformChange() will auto-promote to full clear
  renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
  overlayLoopRef.current?.invalidateAll();

  // Notify TextTool for DOM repositioning
  if (toolRef.current && 'onViewChange' in toolRef.current) {
    (toolRef.current as any).onViewChange();
  }
}, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);
```

**Why invalidate a 1x1 rect?** This is a "tickle" to schedule a frame. The `DirtyRectTracker.notifyTransformChange()` call inside `RenderLoop.tick()` will detect the actual transform change and promote to full clear.

**Two-phase invalidation:**
1. **Canvas.tsx:** Detects transform change, schedules frame
2. **RenderLoop.tick():** Compares current vs. last transform, promotes to full clear

This separation allows RenderLoop to remain pure (no external dependencies).

---

## Scene Change Cascades

Scene changes are the **nuclear option** for invalidation. They cascade through multiple systems:

```typescript
// 1. Canvas.tsx:217 - Detect scene change
if (prevSnapshot.scene !== newSnapshot.scene) {
  renderLoopRef.current.invalidateAll('scene-change');
  overlayLoopRef.current.invalidateAll();
  return; // Short-circuit, don't diff
}

// 2. RenderLoop.ts:255 - Detect scene change (redundant guard)
if (snapshot.scene !== this.lastRenderedScene) {
  this.dirtyTracker.invalidateAll('scene-change');
  this.lastRenderedScene = snapshot.scene;
}

// 3. drawStrokes() in strokes.ts:32 - Clear stroke cache
if (snapshot.scene !== lastScene) {
  strokeCache.clear();
  lastScene = snapshot.scene;
}
```

**Why three places?**

1. **Canvas.tsx:** First responder, triggers both loops
2. **RenderLoop:** Belt-and-suspenders guard (in case Canvas.tsx invalidation was missed)
3. **drawStrokes:** Cache clearing must happen synchronously during render

**Scene change causes:**
- User navigates to different scene (future feature)
- Undo/redo crosses scene boundary (future feature)
- Room initialization (scene 0 → actual scene)

**Current reality:** Scenes are not fully implemented yet. Scene changes primarily occur at room load, where `createEmptySnapshot()` uses scene 0, then the first Y.Doc update populates the real scene.

---

## Transform Change Handling

Transform changes (pan/zoom) are **special** because they affect the entire canvas without changing document content.

### Detection Flow

```
User Action (Wheel, MMB Drag, Zoom Gesture)
    ↓
Event Handler (Canvas.tsx:923 handleWheel, :796 MMB pan)
    ↓
ZoomAnimator.to(targetScale, targetPan)
    ↓
ViewTransformContext.setScale/setPan (Zustand)
    ↓
Canvas.tsx:985 useEffect([viewTransform.scale, viewTransform.pan])
    ↓
renderLoopRef.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 })
    ↓
RenderLoop.tick() → DirtyRectTracker.notifyTransformChange(view)
    ↓
fullClearRequired = true
```

### Why Full Clear on Transform?

**Option A: Track viewport-relative dirty rects**
```typescript
// Convert world rects to viewport space, track movement
// COMPLEX: Requires projecting all existing dirty rects through transform delta
// ERROR-PRONE: Off-by-one errors cause artifacts
```

**Option B: Just redraw everything**
```typescript
// Current approach
this.fullClearRequired = true;
// SIMPLE: One flag, guaranteed correct
// FAST: Modern GPUs redraw 1920x1080 in <1ms
```

**Choice:** Option B. The complexity of viewport-space tracking doesn't justify the ~0.5ms savings.

### Smooth Zooming (ZoomAnimator)

```typescript
// Canvas.tsx:495 - Initialize animator
zoomAnimatorRef.current = new ZoomAnimator(
  () => viewTransformRef.current,
  (s) => setScaleRef.current?.(s),
  (p) => setPanRef.current?.(p)
);

// Canvas.tsx:961 - Wheel handler
zoomAnimatorRef.current?.to(targetScale, targetPan);
```

**How it works:**
1. User scrolls wheel → calculate target scale/pan
2. ZoomAnimator interpolates over ~200ms using ease-out
3. Each interpolation step updates Zustand → triggers transform effect → schedules frame
4. Result: 60fps smooth zoom with event-driven rendering (no idle CPU)

**Each zoom step triggers a full clear**, but the animator batches rapid scrolls into a single animation.

---

## Snapshot Diffing Strategy

The bbox diffing algorithm is **deliberately simple**:

```typescript
// O(N + M) where N = prev strokes, M = next strokes
const prevMap = new Map(prev.strokes.map(s => [s.id, s])); // O(N)
const nextMap = new Map(next.strokes.map(s => [s.id, s])); // O(M)

// Added/modified: O(M)
for (const [id, stroke] of nextMap) {
  const prevStroke = prevMap.get(id);
  if (!prevStroke || !bboxEquals(prevStroke.bbox, stroke.bbox)) {
    dirty.push(stroke.bbox);
  }
}

// Deleted: O(N)
for (const [id, stroke] of prevMap) {
  if (!nextMap.has(id)) {
    dirty.push(stroke.bbox);
  }
}
```

**Alternative approaches considered:**

1. **Spatial index (R-tree):** O(log N) lookup, but O(N log N) construction
   - **Rejected:** Snapshots change frequently, rebuilding R-tree is expensive
   - **Break-even:** ~10k strokes, but typical docs are <1k

2. **Dirty flags on strokes:** Mark changed strokes at mutation time
   - **Rejected:** Breaks immutability contract, requires Y.Doc integration
   - **Complexity:** Yjs doesn't expose per-item change tracking easily

3. **Timestamp-based:** Compare `lastModified` timestamps
   - **Rejected:** Requires adding metadata to every stroke
   - **Fragile:** Clock skew between clients

**Conclusion:** Simple ID-based diffing is **fast enough** for <10k strokes and maintains architectural simplicity.

---

## Preview Hold Mechanism

### The Problem

When you commit a stroke, there's a brief moment where:
1. Preview is cleared (tool resets)
2. Stroke hasn't appeared yet (Yjs update pending)
3. Canvas is empty for 1 frame → **FLASH!**

### The Solution

```typescript
// Canvas.tsx:230 - Hold preview for one frame on commit
overlayLoopRef.current.holdPreviewForOneFrame();
```

```typescript
// OverlayRenderLoop.ts:67
holdPreviewForOneFrame(): void {
  this.holdPreviewOneFrame = true;
  this.invalidateAll(); // Ensure we draw a frame
}

// OverlayRenderLoop.ts:98 - Draw cached preview
const preview = this.previewProvider?.getPreview();

if (preview) {
  this.cachedPreview = preview; // Cache latest
}

const previewToDraw = preview || (this.holdPreviewOneFrame && this.cachedPreview);
if (previewToDraw) {
  // Draw preview (either live or cached)
  // ...

  // Clear cache after drawing held frame
  if (this.holdPreviewOneFrame && !preview) {
    this.holdPreviewOneFrame = false;
    this.cachedPreview = null;
  }
}
```

**Timeline:**

```
Frame N:   User releases pointer
           DrawingTool.end() commits stroke
           Preview = active stroke (last frame with real preview)

Frame N+1: Yjs transaction commits
           Snapshot callback fires
           holdPreviewForOneFrame() called
           Preview = null (tool reset)
           Cached preview drawn (HOLD FRAME)

Frame N+2: Stroke appears in snapshot
           Stroke rendered on base canvas
           Hold flag cleared
           Normal rendering resumes
```

**Why it works:** The commit-to-snapshot latency is typically <16ms (1 frame). Holding the preview for exactly 1 frame bridges this gap perfectly.

---

## Complete Invalidation Flow Chart

```
┌─────────────────────────────────────────────────────────────────┐
│                      Invalidation Sources                       │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         │                    │                    │
    ┌────▼────┐          ┌────▼────┐          ┌───▼───┐
    │ Snapshot│          │Transform│          │Resize │
    │ Change  │          │ Change  │          │Event  │
    └────┬────┘          └────┬────┘          └───┬───┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│              Canvas.tsx (Invalidation Hub)                      │
├─────────────────────────────────────────────────────────────────┤
│  • Scene change? → invalidateAll('scene-change')                │
│  • Content change? → diffBounds() → invalidateWorld(bounds)     │
│  • Transform change? → invalidateCanvas(1x1 tickle)             │
│  • Resize? → RenderLoop.setResizeInfo()                         │
└─────────────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌──────────────────┐    ┌──────────────────┐
│   RenderLoop     │    │ OverlayRenderLoop│
│   (Base Canvas)  │    │ (Overlay Canvas) │
└────────┬─────────┘    └────────┬─────────┘
         │                       │
         ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│ DirtyRectTracker │    │  Full Clear      │
│ • Full clear?    │    │  Every Frame     │
│ • Dirty rects?   │    │  (Cheap!)        │
│ • Coalesce       │    └──────────────────┘
│ • Promote        │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Clear Canvas    │
│ • Full clear OR  │
│ • Dirty rects    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   Draw Layers    │
│ • drawStrokes()  │
│ • drawText()     │
│ • drawHUD()      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Stroke Cache    │
│ • Hit? Return    │
│ • Miss? Build    │
│ • Scene change?  │
│   → Clear cache  │
└──────────────────┘
```

---

## Performance Tuning Parameters

All configurable thresholds are in `/client/src/renderer/types.ts`:

```typescript
export const DIRTY_RECT_CONFIG = {
  // Promotion thresholds
  MAX_RECT_COUNT: 64,        // Too many rects → full clear
  MAX_AREA_RATIO: 0.6,       // >60% canvas area → full clear

  // Coalescing
  COALESCE_SNAP: 16,         // Snap rects to 16px grid

  // Inflation
  AA_MARGIN: 2,              // Anti-aliasing bleed (device px)
  MAX_WORLD_LINE_WIDTH: 50,  // Worst-case stroke (world units)
};

export const FRAME_CONFIG = {
  TARGET_FPS: 60,            // Desktop target
  MOBILE_FPS: 30,            // Mobile throttle
  HIDDEN_FPS: 4,             // Background tab rate
  TARGET_MS: 16.67,          // 60fps frame budget
  SKIP_THRESHOLD_MS: 33,     // Skip next frame if >2x budget
};
```

### Tuning Guidelines

**Increase `MAX_RECT_COUNT` (64 → 128):**
- **Effect:** More granular dirty rect tracking
- **Benefit:** Fewer full clears for busy scenes
- **Cost:** Higher CPU for rect tracking/coalescing
- **When:** High-end desktop, complex animations

**Decrease `MAX_AREA_RATIO` (0.6 → 0.4):**
- **Effect:** Promote to full clear more aggressively
- **Benefit:** Simpler clearing logic, fewer artifacts
- **Cost:** More pixels redrawn per frame
- **When:** Low-end devices, simple scenes

**Increase `COALESCE_SNAP` (16px → 32px):**
- **Effect:** More aggressive rect merging
- **Benefit:** Fewer total rects, simpler iteration
- **Cost:** Larger clear regions (redraw more pixels)
- **When:** Many small strokes close together

**Increase `AA_MARGIN` (2px → 4px):**
- **Effect:** Larger inflation around dirty rects
- **Benefit:** Safer clearing (fewer artifacts)
- **Cost:** More pixels redrawn unnecessarily
- **When:** Seeing rendering artifacts at stroke edges

### Monitoring Cache Performance

```typescript
// Add to RenderLoop.ts onStats callback
if (import.meta.env.DEV && stats.frameCount % 60 === 0) {
  console.log('[Cache Stats]', {
    cacheSize: getStrokeCacheSize(),
    clearType: stats.lastClearType,
    rectCount: stats.rectCount,
    fps: stats.fps.toFixed(1)
  });
}
```

**Ideal metrics:**
- Cache size: Grows to ~visible stroke count, stabilizes
- Clear type: `dirty` >80% of frames (full only on pan/zoom/scene)
- Rect count: <10 per frame for typical edits
- FPS: 60 (desktop), 30 (mobile)

**Red flags:**
- Cache size: Constantly hitting 1000 (FIFO churn)
  → **Fix:** Increase cache size OR reduce stroke count via simplification
- Clear type: `full` every frame
  → **Fix:** Check for transform thrashing OR add transform change debouncing
- Rect count: >50 every frame
  → **Fix:** Coalescing not working OR too many rapid edits
- FPS: <30
  → **Fix:** Enable mobile throttling OR reduce visible stroke count

---

## Summary

The Avlo cache and invalidation system is designed around **three core principles**:

1. **Event-Driven Everything:** Zero idle CPU. Frames only render when content changes.

2. **Immutability Enables Caching:** Strokes never mutate, so ID-keyed caches are safe and permanent (until scene change).

3. **Progressive Complexity:** Start simple (full clears), optimize where it matters (dirty rects for edits, cache for repeated draws).

**Key Takesways:**

- **Stroke Cache:** ID-keyed Path2D cache, cleared on scene change, FIFO eviction at 1000 entries
- **Dirty Rect Tracker:** Accumulates invalidations, promotes to full clear when inefficient
- **Snapshot Diffing:** O(N+M) bbox comparison, no spatial index needed for <10k strokes
- **Transform Changes:** Always full clear (simpler than viewport-space tracking)
- **Preview Hold:** Cache last preview for 1 frame to prevent commit flash

**Performance Knobs:**
- `MAX_RECT_COUNT`: 64 (higher = more granular, more CPU)
- `MAX_AREA_RATIO`: 0.6 (lower = more full clears, simpler)
- `COALESCE_SNAP`: 16px (higher = fewer rects, larger regions)
- Cache size: 1000 strokes (higher = less FIFO churn, more memory)

The system is **already optimized for 1-10k stroke documents**. Further optimization (spatial indices, incremental rendering) should only be considered for 100k+ stroke use cases.
