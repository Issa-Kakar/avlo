# Two-Canvas Presence & Preview Overlay Refactor - Implementation Guide

## Executive Summary

Currently, every presence cursor movement AND preview stroke motion triggers a full canvas clear because:
1. RoomDocManager builds expensive full snapshots when `isDirty || presenceDirty`
2. Canvas.tsx calls `invalidateAll('snapshot-update')` on EVERY snapshot
3. Preview rendering causes large dirty rectangles that flicker when zoomed out
4. This forces the DirtyRectTracker to clear the entire canvas

**Solution**: Split rendering into two canvases AND optimize snapshot publishing:
- **Base canvas**: World content (strokes, shapes, text) with dirty-rect optimization
- **Overlay canvas**: Preview (world-space) AND Presence (screen-space) with cheap full-clears
- **Option B-prime**: Reuse last snapshot for presence-only updates (avoid expensive buildSnapshot)

**Key Improvements**:
- On presence-only frames, clone previous snapshot with new presence instead of rebuilding from Y.Doc
- Preview rendering moved to overlay eliminates base canvas flicker during drawing
- No base invalidation on pointer move, only on actual stroke commits

## Architecture Overview

```
┌──────────────────────────────────────┐
│         Canvas.tsx                    │
├──────────────────────────────────────┤
│  baseStageRef    → RenderLoop        │
│  overlayStageRef → OverlayRenderLoop │
└──────────────────────────────────────┘
           ↓
┌──────────────────────────────────────┐
│  <div className="stage-root">         │
│    <CanvasStage ref={base} z=1 />    │
│    <CanvasStage ref={overlay} z=2 /> │
│  </div>                               │
└──────────────────────────────────────┘
```

## Step-by-Step Implementation

### Step 1: Create OverlayRenderLoop (NEW FILE)

**File**: `client/src/renderer/OverlayRenderLoop.ts`

```typescript
import type { PresenceView, ViewTransform } from '@avlo/shared';
import type { PreviewData } from '@/lib/tools/types';
import { drawPreview } from './layers/preview';

export interface PreviewProvider {
  getPreview(): PreviewData | null;
}

export interface OverlayLoopConfig {
  stage: {
    withContext: (fn: (ctx: CanvasRenderingContext2D) => void) => void;
    clear: () => void;
  };
  getView: () => ViewTransform;
  getViewport: () => { cssWidth: number; cssHeight: number; dpr: number };
  getGates: () => { awarenessReady: boolean; firstSnapshot: boolean };
  getPresence: () => PresenceView;
  drawPresence: (
    ctx: CanvasRenderingContext2D,
    presence: PresenceView,
    view: ViewTransform,
    viewport: { cssWidth: number; cssHeight: number; dpr: number },
  ) => void;
}

export class OverlayRenderLoop {
  private config: OverlayLoopConfig | null = null;
  private rafId: number | null = null;
  private needsFrame = false;
  private previewProvider: PreviewProvider | null = null;

  start(config: OverlayLoopConfig) {
    this.config = config;
  }

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.needsFrame = false;
    this.config = null;
  }

  setPreviewProvider(provider: PreviewProvider | null): void {
    this.previewProvider = provider;
    if (provider && provider.getPreview()) {
      this.invalidateAll();
    }
  }

  invalidateAll() {
    if (!this.needsFrame) {
      this.needsFrame = true;
      this.schedule();
    }
  }

  private schedule() {
    if (this.rafId || !this.config) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.needsFrame = false;
      this.frame();
    });
  }

  private frame() {
    if (!this.config) return;
    const { stage, getView, getViewport, getPresence, getGates, drawPresence } = this.config;

    // Get viewport first to check if ready
    const vp = getViewport();
    if (vp.cssWidth <= 1 || vp.cssHeight <= 1) return;

    // Always full clear overlay (cheap for preview + presence)
    stage.clear();

    const view = getView();

    // ---------- PASS 1: World-space preview (with world transform) ----------
    const preview = this.previewProvider?.getPreview();
    if (preview) {
      stage.withContext((ctx) => {
        // Apply world transform for preview rendering
        ctx.save();
        ctx.scale(view.scale, view.scale);
        ctx.translate(-view.pan.x, -view.pan.y);

        // Draw preview in world coordinates
        drawPreview(ctx, preview);

        ctx.restore();
      });
    }

    // ---------- PASS 2: Screen-space presence (DPR only) ----------
    const gates = getGates();
    if (gates.awarenessReady && gates.firstSnapshot) {
      const presence = getPresence();
      stage.withContext((ctx) => {
        drawPresence(ctx, presence, view, vp);
      });
    }
  }

  destroy() {
    this.stop();
    this.previewProvider = null;
  }
}
```

### Step 2: Update RenderLoop to Remove Presence AND Preview

**File**: `client/src/renderer/RenderLoop.ts`

Remove BOTH presence AND preview drawing from the main render loop:

```typescript
// Around line 360-375 where preview and authoring overlays are drawn:
// REMOVE preview drawing but KEEP authoring overlays
drawShapes(ctx, snapshot, view, augmentedViewport);
drawText(ctx, snapshot, view, augmentedViewport);

// Keep authoring overlays for future selection/handles
drawAuthoringOverlays(ctx, snapshot, view, augmentedViewport);

// ⛔️ DELETE these lines - preview moves to overlay:
// const preview = this.previewProvider?.getPreview();
// if (preview) {
//   drawPreview(ctx, preview);
// }

// Also around line 377-401, REMOVE the drawPresenceOverlays call
// Keep only the HUD drawing:
stage.withContext((ctx) => {
  const augmentedViewport = {
    ...viewport,
    visibleWorldBounds: getVisibleWorldBounds(
      viewport.cssWidth,
      viewport.cssHeight,
      view.scale,
      view.pan,
    ),
  };

  // ⛔️ Remove: drawPresenceOverlays(ctx, snapshot, view, augmentedViewport, gates);
  drawHUD(ctx, snapshot, view, augmentedViewport); // Keep HUD on base canvas
});
```

Note: You can keep the `previewProvider` field and `setPreviewProvider` method as no-ops for API compatibility, but the preview will no longer be drawn here.

### Step 3: Update Canvas.tsx - Two Stages & Two Loops

**File**: `client/src/canvas/Canvas.tsx`

#### 3A. Import OverlayRenderLoop
```typescript
import { OverlayRenderLoop } from '../renderer/OverlayRenderLoop';
```

#### 3B. Add refs for two stages and loops
```typescript
// Replace single stageRef with:
const baseStageRef = useRef<CanvasStageHandle>(null);
const overlayStageRef = useRef<CanvasStageHandle>(null);
const renderLoopRef = useRef<RenderLoop | null>(null);      // existing
const overlayLoopRef = useRef<OverlayRenderLoop | null>(null); // new
```

#### 3C. Update snapshot subscription to check docVersion
```typescript
// Replace the existing snapshot subscription (lines 95-113) with:
useEffect(() => {
  let lastDocVersion = -1;

  const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
    const prevSnapshot = snapshotRef.current;
    snapshotRef.current = newSnapshot;

    if (!renderLoopRef.current || !overlayLoopRef.current) return;

    // Check if scene changed (requires full clear on both)
    if (!prevSnapshot || prevSnapshot.scene !== newSnapshot.scene) {
      renderLoopRef.current.invalidateAll('scene-change');
      overlayLoopRef.current.invalidateAll();
      lastDocVersion = newSnapshot.docVersion;
      return;
    }

    // Check if document content changed (not just presence)
    // CRITICAL: docVersion increments on Y.Doc changes, NOT on presence changes
    if (newSnapshot.docVersion !== lastDocVersion) {
      lastDocVersion = newSnapshot.docVersion;
      renderLoopRef.current.invalidateAll('doc-change');
      overlayLoopRef.current.invalidateAll(); // Also update overlay for new doc
    } else {
      // Presence-only change - update overlay only
      overlayLoopRef.current.invalidateAll();
    }
  });

  snapshotRef.current = roomDoc.currentSnapshot;
  lastDocVersion = roomDoc.currentSnapshot.docVersion;

  return unsubscribe;
}, [roomDoc]);
```

#### 3D. Initialize base render loop
```typescript
// In the render loop initialization effect, update the stageRef:
renderLoop.start({
  stageRef: baseStageRef, // Changed from stageRef to use base canvas
  // ...existing config...
});
```

#### 3E. Add overlay render loop initialization
```typescript
// Add new effect for overlay loop (after base loop effect)
useLayoutEffect(() => {
  if (!overlayStageRef.current) return;

  const overlayLoop = new OverlayRenderLoop();
  overlayLoopRef.current = overlayLoop;

  overlayLoop.start({
    stage: overlayStageRef.current!,
    getView: () => viewTransformRef.current!,
    getViewport: () => {
      const cachedSize = canvasSizeRef.current;
      if (cachedSize && cachedSize.cssWidth > 0) {
        return {
          cssWidth: cachedSize.cssWidth,
          cssHeight: cachedSize.cssHeight,
          dpr: cachedSize.dpr,
        };
      }
      // Fallback
      const dpr = window.devicePixelRatio || 1;
      return { cssWidth: 1, cssHeight: 1, dpr };
    },
    getGates: () => roomDoc.getGateStatus(),
    getPresence: () => snapshotRef.current.presence,  // Get from current snapshot
    drawPresence: (ctx, presence, view, vp) => {
      // Import drawPresenceOverlays from layers
      drawPresenceOverlays(
        ctx,
        snapshotRef.current,  // Pass full snapshot (presence is already up-to-date)
        view,
        vp,
        roomDoc.getGateStatus()
      );
    },
  });

  return () => {
    overlayLoop.stop();
    overlayLoop.destroy();
    overlayLoopRef.current = null;
  };
}, [roomDoc]);
```

#### 3E2. Update DrawingTool effect to wire preview to overlay
```typescript
// In the existing DrawingTool effect (around line 295-336), after creating the tool:
const tool = new DrawingTool(
  roomDoc,
  deviceUI,
  userId,
  (bounds) => {
    // Invalidate overlay during drawing (preview lives there)
    overlayLoopRef.current?.invalidateAll();
  },
);

drawingToolRef.current = tool;

// Set preview provider on overlay loop (not base loop!)
if (!isMobile && overlayLoopRef.current) {
  overlayLoopRef.current.setPreviewProvider({
    getPreview: () => tool.getPreview(),
  });
}

// On cleanup:
return () => {
  overlayLoopRef.current?.setPreviewProvider(null);
  // ... rest of cleanup
};
```

#### 3F. Handle transform changes for both loops
```typescript
// Update the transform change effect to invalidate both:
useEffect(() => {
  renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
  overlayLoopRef.current?.invalidateAll(); // Overlay needs redraw on pan/zoom
}, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);
```

#### 3G. Handle resize for both stages
```typescript
// Split handleResize into two handlers:
const handleBaseResize = useCallback((info: ResizeInfo) => {
  setCanvasSize(info);
  canvasSizeRef.current = info;
  renderLoopRef.current?.setResizeInfo({
    width: info.pixelWidth,
    height: info.pixelHeight,
    dpr: info.dpr,
  });
}, []);

const handleOverlayResize = useCallback((info: ResizeInfo) => {
  // Overlay just needs to invalidate on resize
  overlayLoopRef.current?.invalidateAll();
}, []);
```

#### 3H. Update imperative handle for preview routing
```typescript
// In useImperativeHandle, update setPreviewProvider to route to overlay:
setPreviewProvider: (provider: () => any) => {
  // Route to overlay loop instead of base loop
  if (overlayLoopRef.current) {
    overlayLoopRef.current.setPreviewProvider({
      getPreview: provider,
    });
  }
},
```

#### 3I. Update DrawingTool invalidation callback
```typescript
// When creating DrawingTool, change invalidation to target overlay during drawing:
const tool = new DrawingTool(
  roomDoc,
  deviceUI,
  userId,
  (bounds) => {
    // During drawing, invalidate overlay (preview is there)
    // The overlay will full-clear anyway, but this triggers a frame
    overlayLoopRef.current?.invalidateAll();
  },
);

// Note: When stroke is committed, it will use mutate() which will
// trigger a doc update, causing base canvas invalidation automatically
```

#### 3J. Update JSX to render two canvases
```typescript
// Replace the single CanvasStage with:
return (
  <div className="relative w-full h-full">
    <CanvasStage
      ref={baseStageRef}
      className={className}
      style={{ position: 'absolute', inset: 0, zIndex: 1 }}
      onResize={handleBaseResize}
    />
    <CanvasStage
      ref={overlayStageRef}
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        pointerEvents: 'none' // Critical: overlay doesn't block input
      }}
      onResize={handleOverlayResize}
    />
  </div>
);
```

### Step 4: Update RoomDocManager with Option B-prime

**File**: `client/src/lib/room-doc-manager.ts`

**Critical**: Implement Option B-prime - reuse last snapshot for presence-only updates.

```typescript
// In startPublishLoop(), around line 1183-1204, replace the entire publish logic with:
private startPublishLoop(): void {
  const rafLoop = () => {
    // Keep publishing during presence animation window
    const now = this.clock.now();
    if (!this.publishState.presenceDirty && now < this.presenceAnimDeadlineMs) {
      // Force a presence publish to progress the interpolation
      this.publishState.presenceDirty = true;
    }

    // Option B-prime: Handle doc vs presence-only updates separately
    if (this.publishState.isDirty) {
      // Document changed - build full snapshot (expensive)
      const newSnapshot = this.buildSnapshot();
      this.publishSnapshot(newSnapshot);
      this.publishState.isDirty = false;
      this.publishState.presenceDirty = false; // Clear both flags
    } else if (this.publishState.presenceDirty) {
      // Presence-only update - reuse last snapshot (cheap!)
      const livePresence = this.buildPresenceView();
      const prev = this._currentSnapshot;

      // Construct a fresh object so identity changes
      const snap: Snapshot = {
        ...prev,                // reuses already-frozen arrays & fields
        presence: livePresence, // new presence
        createdAt: Date.now(),  // fresh timestamp
      };

      // Dev parity with buildSnapshot(): freeze the top-level object
      if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
        Object.freeze(snap);
      }

      this.publishSnapshot(snap); // sets current + notifies subscribers
      this.publishState.presenceDirty = false;
    }

    // Continue loop if not destroyed
    if (!this.destroyed) {
      this.publishState.rafId = this.frames.request(rafLoop);
    }
  };

  // Start the loop
  this.publishState.rafId = this.frames.request(rafLoop);
}
```

**Why this is safe**:
- docVersion doesn't change (no Y.Doc writes) on presence-only updates
- Canvas subscription already gates base invalidation on docVersion change
- Snapshot contract is preserved - presence is always up-to-date
- Avoids expensive `buildSnapshot()` which pulls all strokes from Y.Doc

### Step 5: (Optional) Implement Enhanced Bbox Diffing

For even better performance, implement diffing with epsilon comparison:

// Epsilon equality for floating point comparison
function bboxEquals(a: number[], b: number[]): boolean {
  const eps = 1e-3;
  return Math.abs(a[0] - b[0]) < eps &&
         Math.abs(a[1] - b[1]) < eps &&
         Math.abs(a[2] - b[2]) < eps &&
         Math.abs(a[3] - b[3]) < eps;
};

interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function diffBounds(prev: Snapshot, next: Snapshot): WorldBounds[] {
  const prevStrokeMap = new Map(prev.strokes.map((s) => [s.id, s]));
  const nextStrokeMap = new Map(next.strokes.map((s) => [s.id, s]));
  const dirty: WorldBounds[] = [];

  // Added/modified strokes
  for (const [id, stroke] of nextStrokeMap) {
    const prevStroke = prevStrokeMap.get(id);
    if (!prevStroke || !bboxEquals(prevStroke.bbox, stroke.bbox)) {
      // Don't inflate here - DirtyRectTracker will handle it
      dirty.push({
        minX: stroke.bbox[0],
        minY: stroke.bbox[1],
        maxX: stroke.bbox[2],
        maxY: stroke.bbox[3],
      });
    }
  }

  // Removed strokes
  for (const [id, stroke] of prevStrokeMap) {
    if (!nextStrokeMap.has(id)) {
      // Don't inflate here - DirtyRectTracker will handle it
      dirty.push({
        minX: stroke.bbox[0],
        minY: stroke.bbox[1],
        maxX: stroke.bbox[2],
        maxY: stroke.bbox[3],
      });
    }
  }

  // Handle text blocks
  const prevTextMap = new Map(prev.texts.map((t) => [t.id, t]));
  const nextTextMap = new Map(next.texts.map((t) => [t.id, t]));

  // Added/modified texts
  for (const [id, text] of nextTextMap) {
    const prevText = prevTextMap.get(id);
    if (
      !prevText ||
      prevText.x !== text.x ||
      prevText.y !== text.y ||
      prevText.w !== text.w ||
      prevText.h !== text.h
    ) {
      // Don't add padding here - DirtyRectTracker will handle it
      dirty.push({
        minX: text.x,
        minY: text.y,
        maxX: text.x + text.w,
        maxY: text.y + text.h,
      });
    }
  }

  // Removed texts
  for (const [id, text] of prevTextMap) {
    if (!nextTextMap.has(id)) {
      // Don't add padding here - DirtyRectTracker will handle it
      dirty.push({
        minX: text.x,
        minY: text.y,
        maxX: text.x + text.w,
        maxY: text.y + text.h,
      });
    }
  }

  return dirty; // Let DirtyRectTracker handle coalescing
}
```

Then in the snapshot subscription, call this instead of full invalidation:
```typescript
// Instead of: renderLoopRef.current.invalidateAll('doc-change');

++ // Use bbox diffing for targeted invalidation instead of full clear
        const changedBounds = diffBounds(prevSnapshot, newSnapshot);
        // Let DirtyRectTracker handle promotion to full clear if needed
        for (const bounds of changedBounds) {
          renderLoopRef.current.invalidateWorld(bounds);
        }
```

## Key Implementation Notes

1. **Option B-prime** - Reuse last snapshot for presence-only updates, avoiding expensive buildSnapshot()
2. **DocVersion gate** - Base canvas only invalidates when docVersion changes (actual Y.Doc updates)
3. **Preview on overlay** - Preview renders on overlay with world transform, eliminating base canvas flicker
4. **Single subscription** - Use snapshot subscription for both canvases, no separate presence subscription
5. **DirtyRectTracker untouched** - Continues to work for base canvas optimization
9. **Presence interpolation** - Kept smooth via presenceAnimDeadlineMs forcing presenceDirty

## Preview-Specific Changes

### Why Preview Moved to Overlay
- **Eliminates flicker**: Preview no longer causes base canvas dirty rectangles
- **Stable compositing**: Preview always drawn over static base image (no AA edge churn)
- **No base invalidation during drawing**: Only overlay invalidates on pointer move
- **Clean separation**: Ephemeral content (preview + presence) vs persistent content (strokes)

### Preview Implementation Details
- **World-space rendering**: Preview drawn with world transform applied (Pass 1 on overlay)
- **Provider pattern preserved**: Same `getPreview()` API, just routed to overlay loop
- **DrawingTool unchanged**: Still generates preview data the same way
- **Invalidation strategy**: During drawing → overlay only; On commit → base via doc update
- **Mobile handling**: No preview provider set on mobile (view-only)

## Performance Wins

- **No expensive snapshot builds** on presence-only changes (Option B-prime)
- **No base canvas clears** for cursor movement OR preview drawing (docVersion gate)
- **Eliminated "rectangular aura"**: Preview motion doesn't create large dirty rects on base
- **No flicker at low zoom**: Base strokes aren't repeatedly cleared/redrawn under preview
- **Cheap overlay clears** - Small canvas, minimal content, full-clear is fast
- **Reused arrays** - Strokes/texts arrays not rebuilt on presence updates
- **Smooth interpolation** - presenceAnimDeadlineMs keeps frames flowing

## Files Modified

- `client/src/renderer/OverlayRenderLoop.ts` (NEW - includes preview support)
- `client/src/renderer/RenderLoop.ts` (remove drawPresenceOverlays AND drawPreview from main pass)
- `client/src/canvas/Canvas.tsx` (main refactor - two canvases, preview routing, docVersion checking)
- `client/src/lib/room-doc-manager.ts` (Option B-prime - reuse snapshot for presence)
