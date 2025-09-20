Phase 8: Eraser Tool Implementation

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
  size: number;  // CSS pixels for cursor radius
}

interface EraserState {
  isErasing: boolean;
  pointerId: number | null;
  radiusPx: number;           // CSS pixels from deviceUI
  lastWorld: [number, number] | null;
  hitNow: Set<string>;        // IDs currently under cursor
  hitAccum: Set<string>;      // IDs accumulated during drag
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
    getViewport?: () => { cssWidth: number; cssHeight: number; dpr: number }
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
      hitAccum: new Set()
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
      hitAccum: new Set()
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
    radius: number
  ): boolean {
    // Test each segment
    for (let i = 0; i < points.length - 2; i += 2) {
      const x1 = points[i], y1 = points[i + 1];
      const x2 = points[i + 2], y2 = points[i + 3];

      const dist = this.pointToSegmentDistance(px, py, x1, y1, x2, y2);
      if (dist <= radius) return true;
    }
    return false;
  }

  private pointToSegmentDistance(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ): number {
    const dx = x2 - x1, dy = y2 - y1;

    // Handle degenerate segment
    if (dx === 0 && dy === 0) {
      return Math.hypot(px - x1, py - y1);
    }

    // Project point onto segment
    const t = Math.max(0, Math.min(1,
      ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)
    ));

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
        .map(id => strokeIdToIndex.get(id))
        .filter((idx): idx is number => idx !== undefined)
        .sort((a, b) => b - a);

      const textIndices = Array.from(this.state.hitAccum)
        .map(id => textIdToIndex.get(id))
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
        r_px: this.state.radiusPx   // Screen pixels, fixed size
      },
      hitIds: Array.from(allHits),
      dimOpacity: 0.35
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
      maxY: maxWorldY + marginWorld
    };
  }

  private isInBounds(bbox: number[] | [number, number, number, number], bounds: WorldBounds): boolean {
    return !(
      bbox[2] < bounds.minX || // bbox right < viewport left
      bbox[0] > bounds.maxX || // bbox left > viewport right
      bbox[3] < bounds.minY || // bbox bottom < viewport top
      bbox[1] > bounds.maxY    // bbox top > viewport bottom
    );
  }

  private inflateBbox(
    bbox: number[] | [number, number, number, number],
    radius: number
  ): [number, number, number, number] {
    return [
      bbox[0] - radius,
      bbox[1] - radius,
      bbox[2] + radius,
      bbox[3] + radius
    ];
  }

  private pointInBbox(
    px: number,
    py: number,
    bbox: [number, number, number, number]
  ): boolean {
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
  kind: 'stroke';  // ADD THIS DISCRIMINANT
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
  baseOpacity: number
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
    const opacity = stroke.style.tool === 'highlighter'
      ? Math.max(0.15, baseOpacity * 0.6)  // Lighter for already-transparent
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
  const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || navigator.maxTouchPoints > 1;

  // Create appropriate tool based on activeTool (branch ONCE here)
  let tool: PointerTool | null = null;

  if (activeTool === 'eraser') {
    // Pass deviceUI.eraser directly (no adapter needed)
    tool = new EraserTool(
      roomDoc,
      deviceUI.eraser,  // Direct from store, no adapter
      userId,
      () => overlayLoopRef.current?.invalidateAll(),
      // Pass viewport callback for hit-test pruning
      () => {
        const size = canvasSizeRef.current;
        if (size) {
          return {
            cssWidth: size.cssWidth,
            cssHeight: size.cssHeight,
            dpr: size.dpr
          };
        }
        return { cssWidth: 1, cssHeight: 1, dpr: 1 };
      }
    );
  } else if (activeTool === 'pen' || activeTool === 'highlighter') {
    // Use adapter only for DrawingTool
    const adaptedUI = toolbarToDeviceUI({
      tool: activeTool,
      color: activeTool === 'pen' ? pen.color : highlighter.color,
      size: activeTool === 'pen' ? pen.size : highlighter.size,
      opacity: activeTool === 'pen' ? (pen.opacity || 1) : highlighter.opacity
    });

    tool = new DrawingTool(
      roomDoc,
      adaptedUI,
      userId,
      () => overlayLoopRef.current?.invalidateAll()
    );
  } else {
    return; // Unsupported tool
  }

  // Set preview provider (both tools implement getPreview())
  if (!isMobile && overlayLoopRef.current) {
    overlayLoopRef.current.setPreviewProvider({
      getPreview: () => tool?.getPreview() || null
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

### Implementation Checklist

1. **Types & Interfaces**
   - [ ] Rename `PreviewData` → `StrokePreview` and add `kind: 'stroke'` in types.ts
   - [ ] Add `EraserPreview` interface with `kind: 'eraser'`
   - [ ] Create union type `PreviewData = StrokePreview | EraserPreview`
   - [ ] Update DrawingTool.getPreview() to return `{ kind: 'stroke', ... }`

2. **Tool Implementation**
   - [ ] Create EraserTool.ts with unified PointerTool methods
   - [ ] Only check `!isErasing` in canBegin() (no mobile/read-only)
   - [ ] Accept getViewport callback for hit-test pruning
   - [ ] Export helper methods to separate hit-test.ts if reusable

3. **Canvas Integration**
   - [ ] Import both DrawingTool and EraserTool
   - [ ] Branch only once during tool construction
   - [ ] Pass deviceUI.eraser directly (no adapter)
   - [ ] Pass viewport callback to EraserTool
   - [ ] Use unified pointer handlers (no tool branching)
   - [ ] Handle mobile gating in Canvas, not tools

4. **Overlay Rendering**
   - [ ] Update frame() to check preview.kind discriminant
   - [ ] Import drawDimmedStrokes for eraser Pass A
   - [ ] Add getSnapshot to OverlayLoopConfig
   - [ ] Ensure setTransform(dpr,0,0,dpr,0,0) for cursor circle

5. **Stroke Cache**
   - [ ] Export getStrokeCacheInstance() singleton
   - [ ] Update strokes.ts to use shared instance
   - [ ] Use same cache in eraser-dim.ts

6. **DrawingTool Updates**
   - [ ] Add `begin()`, `end()`, `cancel()`, `isActive()` methods for interface compatibility
   - [ ] Return `{ kind: 'stroke', ... }` from getPreview()

### Key Implementation Notes

1. **Coordinate Consistency**:
   - Cursor: screen-space circle (fixed CSS pixels, drawn after DPR transform)
   - Hit-testing: world-space using `radiusWorld = radiusPx / scale`
   - Dimming: world-space rendering of hit strokes

2. **Performance Budget**:
   - RAF-coalesce pointer moves
   - Cap hit-testing to ~6ms or ~100 segments per frame
   - Defer remaining work to next frame
   - Skip LOD strokes (<2px screen diagonal)

3. **Atomic Operations**:
   - Single mutate() = single undo step
   - Build id→index maps, delete in reverse order
   - Handle both strokes and texts in one transaction

4. **Gating Philosophy**:
   - Tools only check tool-local state (e.g., !isDrawing)
   - Canvas handles mobile detection
   - mutate() enforces read-only limits
   - No duplicate gating across layers

5. **Preview Rendering**:
   - Pass A: World-space dimming with shared cache
   - Pass B: Screen-space cursor after setTransform(dpr,0,0,dpr,0,0)
   - holdPreviewForOneFrame() prevents commit flicker