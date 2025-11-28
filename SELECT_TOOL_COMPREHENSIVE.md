# SelectTool Comprehensive Technical Documentation

**Branch:** `feature/select-tool`
**Date:** 2025-01-27
**Purpose:** Complete reference for understanding and modifying SelectTool behavior

---

## Table of Contents

1. [State Machine Architecture](#1-state-machine-architecture)
2. [Selection Store (Zustand)](#2-selection-store-zustand)
3. [Hit Testing Pipeline](#3-hit-testing-pipeline)
4. [Transform System](#4-transform-system)
5. [Commit Pipeline](#5-commit-pipeline)
6. [Preview System](#6-preview-system)
7. [Dirty Rect System](#7-dirty-rect-system)
8. [Rendering Integration](#8-rendering-integration)
9. [Canvas Integration](#9-canvas-integration)
10. [Current Limitations & Known Issues](#10-current-limitations--known-issues)

---

## 1. State Machine Architecture

### 1.1 Phases

**File:** `client/src/lib/tools/SelectTool.ts`

```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';
```

| Phase | Description | Transitions To |
|-------|-------------|----------------|
| `idle` | No active gesture | → `pendingClick` on pointer down |
| `pendingClick` | Waiting to determine if click or drag (within thresholds) | → `marquee`, `translate`, or `scale` on move<br>→ `idle` on pointer up (click finalization) |
| `marquee` | Dragging marquee selection rectangle | → `idle` on pointer up (finalize selection) |
| `translate` | Dragging to move selected objects | → `idle` on pointer up (commit translate) |
| `scale` | Dragging resize handle | → `idle` on pointer up (commit scale) |

### 1.2 DownTarget Classification System

**Purpose:** Disambiguate pointer-down context to determine correct phase transition.

```typescript
type DownTarget =
  | 'none'
  | 'handle'                   // Clicked resize handle
  | 'objectInSelection'        // Clicked object that IS selected
  | 'objectOutsideSelection'   // Clicked object that is NOT selected
  | 'selectionGap'             // Empty space INSIDE selection bounds
  | 'background';              // Empty space OUTSIDE selection bounds
```

**Classification Logic in `begin()` (lines 101-149):**

```typescript
begin(pointerId: number, worldX: number, worldY: number): void {
  this.pointerId = pointerId;
  this.downWorld = [worldX, worldY];
  this.downTimeMs = performance.now();
  this.downTarget = 'none';

  const store = useSelectionStore.getState();

  // Priority 1: Check handles (only if selection exists)
  if (store.selectedIds.length > 0) {
    const handleHit = this.hitTestHandle(worldX, worldY);
    if (handleHit) {
      this.activeHandle = handleHit;
      this.downTarget = 'handle';
      this.phase = 'pendingClick';
      return;
    }
  }

  // Priority 2: Check object hit
  const hit = this.hitTestObjects(worldX, worldY);
  this.hitAtDown = hit;

  if (hit) {
    const isSelected = store.selectedIds.includes(hit.id);
    this.downTarget = isSelected ? 'objectInSelection' : 'objectOutsideSelection';
    this.phase = 'pendingClick';
    return;
  }

  // Priority 3: Check if inside selection bounds vs background
  const selectionBounds = this.computeSelectionBounds();
  if (selectionBounds && this.pointInWorldRect(worldX, worldY, selectionBounds)) {
    this.downTarget = 'selectionGap';
  } else {
    this.downTarget = 'background';
  }

  this.phase = 'pendingClick';
}
```

### 1.3 Phase Transitions

**Constants:**
```typescript
const MOVE_THRESHOLD_PX = 4;   // Screen-space distance threshold
const CLICK_WINDOW_MS = 180;   // Time threshold for ambiguous clicks
```

**Transition Logic in `move()` (lines 152-269):**

```typescript
case 'pendingClick': {
  // Compute distance and elapsed time
  const dx = screenX - this.downScreen[0];
  const dy = screenY - this.downScreen[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const elapsed = performance.now() - this.downTimeMs;

  const passMove = dist > MOVE_THRESHOLD_PX;
  const passTime = elapsed >= CLICK_WINDOW_MS;

  // Target-aware branching
  switch (this.downTarget) {
    case 'handle':
      if (!passMove) break;
      this.phase = 'scale';
      // Initialize scale transform
      const bounds = this.computeSelectionBounds();
      const origin = this.getScaleOrigin(this.activeHandle!, bounds!);
      store.beginScale(bounds!, origin, this.activeHandle!);
      break;

    case 'objectOutsideSelection':
      if (!passMove) break;
      // Select this object, then translate
      store.setSelection([this.hitAtDown!.id]);
      this.phase = 'translate';
      const newBounds = this.computeSelectionBounds();
      store.beginTranslate(newBounds!);
      break;

    case 'objectInSelection':
      if (!passMove) break;
      // Keep selection, translate group
      this.phase = 'translate';
      store.beginTranslate(this.computeSelectionBounds()!);
      break;

    case 'selectionGap':
      // CRITICAL: Never marquee from inside selection!
      if (!passMove && !passTime) break;
      // Drag intent → translate selection
      this.phase = 'translate';
      store.beginTranslate(this.computeSelectionBounds()!);
      break;

    case 'background':
      if (!passMove && !passTime) break;
      // Empty background drag → marquee
      this.phase = 'marquee';
      store.beginMarquee(this.downWorld!);
      store.updateMarquee([worldX, worldY]);
      this.updateMarqueeSelection();
      break;
  }
}
```

### 1.4 State Diagram

```
                    ┌─────────────┐
                    │    idle     │
                    └──────┬──────┘
                           │ pointerdown
                           ↓
                 ┌────────────────────┐
                 │  pendingClick      │
                 │  (classify target) │
                 └────────┬───────────┘
                          │ move > 4px OR elapsed > 180ms
          ┌───────────────┼───────────────┬──────────────┐
          ↓               ↓               ↓              ↓
    ┌─────────┐    ┌──────────┐    ┌─────────┐   ┌──────────┐
    │ marquee │    │translate │    │  scale  │   │  (idle)  │
    │         │    │          │    │         │   │ (click)  │
    └────┬────┘    └─────┬────┘    └────┬────┘   └──────────┘
         │               │              │
         │ pointerup     │ pointerup    │ pointerup
         │               │              │
         └───────────────┴──────────────┴─────────→ idle
```

---

## 2. Selection Store (Zustand)

### 2.1 State Shape

**File:** `client/src/stores/selection-store.ts`

```typescript
interface SelectionState {
  selectedIds: string[];                    // Array of object ULIDs
  mode: 'none' | 'single' | 'multi';        // Derived from selectedIds.length
  transform: TransformState;                // Active transform (see 2.2)
  marquee: MarqueeState;                    // Marquee drag state (see 2.3)
}
```

### 2.2 Transform State

```typescript
type TransformState =
  | { kind: 'none' }
  | TranslateTransform
  | ScaleTransform;

interface TranslateTransform {
  kind: 'translate';
  dx: number;                               // World units offset
  dy: number;                               // World units offset
  originBounds: WorldRect;                  // Bounds before transform started
}

interface ScaleTransform {
  kind: 'scale';
  origin: [number, number];                 // Fixed point in world coords
  scaleX: number;                           // X scale factor (can be negative!)
  scaleY: number;                           // Y scale factor (can be negative!)
  originBounds: WorldRect;                  // Bounds before transform started
  handleId: HandleId;                       // Which handle is being dragged
}
```

**CRITICAL:** `scaleX` and `scaleY` CAN be negative (flip behavior when dragging past origin).

### 2.3 Marquee State

```typescript
interface MarqueeState {
  active: boolean;                          // True during marquee drag
  anchor: [number, number] | null;          // First corner in world coords
  current: [number, number] | null;         // Opposite corner (cursor) in world coords
}
```

### 2.4 Actions

**Selection Management:**
```typescript
setSelection(ids: string[]): void
  // Sets selectedIds, updates mode, clears transform & marquee

clearSelection(): void
  // Resets to empty state
```

**Transform Lifecycle:**
```typescript
beginTranslate(originBounds: WorldRect): void
  // Initializes TranslateTransform with dx=0, dy=0

updateTranslate(dx: number, dy: number): void
  // Updates dx, dy (safe no-op if not in translate mode)

beginScale(originBounds: WorldRect, origin: [number, number], handleId: HandleId): void
  // Initializes ScaleTransform with scaleX=1, scaleY=1

updateScale(scaleX: number, scaleY: number): void
  // Updates scale factors (safe no-op if not in scale mode)

endTransform(): void
  // Resets to { kind: 'none' }

cancelTransform(): void
  // Same as endTransform (for clarity)
```

**Marquee Lifecycle:**
```typescript
beginMarquee(anchor: [number, number]): void
  // Sets active=true, anchor=cursor, current=cursor

updateMarquee(current: [number, number]): void
  // Updates current corner position

endMarquee(): void
  // Sets active=false (preserves anchor/current for cleanup)

cancelMarquee(): void
  // Resets entire marquee state to null
```

### 2.5 Integration Pattern

**In SelectTool:**
```typescript
import { useSelectionStore } from '@/stores/selection-store';

// Get state (read-only)
const store = useSelectionStore.getState();
const { selectedIds, transform } = store;

// Mutate via actions
store.setSelection([id]);
store.beginTranslate(bounds);
store.updateTranslate(dx, dy);
```

**In objects.ts (renderer):**
```typescript
import { useSelectionStore } from '@/stores/selection-store';

// Direct import in render function (re-reads on each frame)
const selectionState = useSelectionStore.getState();
const selectedSet = new Set(selectionState.selectedIds);
const transform = selectionState.transform;

// Apply transform conditionally
if (transform.kind !== 'none' && selectedSet.has(handle.id)) {
  applySelectionTransform(ctx, transform);
}
```

---

## 3. Hit Testing Pipeline

### 3.1 Overview

**File:** `client/src/lib/tools/SelectTool.ts`

Hit testing uses a **two-stage pipeline:**
1. **Spatial query:** RBush R-tree query for candidates (coarse, bbox-based)
2. **Geometry test:** Precise hit test per object kind (shape-aware)

### 3.2 Constants

```typescript
const HIT_RADIUS_PX = 6;       // Screen-space hit test radius for selection
const HIT_SLACK_PX = 2.0;      // Forgiving feel (like EraserTool)
const HANDLE_HIT_PX = 10;      // Screen-space hit radius for resize handles
```

### 3.3 Hit Candidate Structure

```typescript
interface HitCandidate {
  id: string;                   // Object ULID
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  distance: number;             // Distance to edge/interior (0 if inside)
  insideInterior: boolean;      // True if cursor is inside shape interior
  area: number;                 // Bounding box area (for nesting priority)
  isFilled: boolean;            // True if shape has fillColor
}
```

### 3.4 hitTestObjects() Pipeline

**Function signature (line 897):**
```typescript
private hitTestObjects(worldX: number, worldY: number): HitCandidate | null
```

**Steps:**

1. **Convert to world-space radius:**
```typescript
const view = this.getView();
const radiusWorld = (HIT_RADIUS_PX + HIT_SLACK_PX) / view.scale;
```

2. **Query spatial index:**
```typescript
const results = spatialIndex.query({
  minX: worldX - radiusWorld,
  minY: worldY - radiusWorld,
  maxX: worldX + radiusWorld,
  maxY: worldY + radiusWorld,
});
```

3. **Test each candidate by kind:**
```typescript
for (const entry of results) {
  const handle = snapshot.objectsById.get(entry.id);
  const candidate = this.testObject(worldX, worldY, radiusWorld, handle);
  if (candidate) candidates.push(candidate);
}
```

4. **Pick best candidate:**
```typescript
if (candidates.length === 0) return null;
if (candidates.length === 1) return candidates[0];
return this.pickBestCandidate(candidates);
```

### 3.5 testObject() - Shape-Specific Tests

**Dispatch by kind (lines 929-1006):**

**Strokes & Connectors:**
```typescript
case 'stroke':
case 'connector': {
  const points = y.get('points') as [number, number][];
  const strokeWidth = y.get('width') ?? 2;
  const tolerance = radiusWorld + strokeWidth / 2;

  if (this.strokeHitTest(worldX, worldY, points, tolerance)) {
    return {
      id: handle.id,
      kind: handle.kind,
      distance: 0,
      insideInterior: false,     // Strokes are NEVER interior
      area: this.computePolylineArea(points),
      isFilled: true,             // Visually "solid"
    };
  }
  return null;
}
```

**Shapes:**
```typescript
case 'shape': {
  const frame = y.get('frame') as [number, number, number, number];
  const shapeType = y.get('shapeType') || 'rect';
  const strokeWidth = y.get('width') ?? 1;
  const fillColor = y.get('fillColor');
  const isFilled = !!fillColor;

  // For SELECT: click inside unfilled shapes still selects them
  const hitResult = this.shapeHitTestForSelection(
    worldX, worldY, radiusWorld, frame, shapeType, strokeWidth, isFilled
  );

  if (hitResult) {
    return {
      id: handle.id,
      kind: 'shape',
      distance: hitResult.distance,
      insideInterior: hitResult.insideInterior,
      area: frame[2] * frame[3],
      isFilled,
    };
  }
  return null;
}
```

**Text:**
```typescript
case 'text': {
  const frame = y.get('frame') as [number, number, number, number];
  const [x, y, w, h] = frame;

  if (this.pointInRect(worldX, worldY, x, y, w, h)) {
    return {
      id: handle.id,
      kind: 'text',
      distance: 0,
      insideInterior: true,
      area: w * h,
      isFilled: true,
    };
  }
  return null;
}
```

### 3.6 shapeHitTestForSelection() - Geometry Tests

**Function (lines 1106-1133):**

```typescript
private shapeHitTestForSelection(
  cx: number, cy: number, r: number,
  frame: [number, number, number, number],
  shapeType: string,
  strokeWidth: number,
  _isFilled: boolean  // Unused - selection allows interior clicks regardless
): { distance: number; insideInterior: boolean } | null
```

**Strategy:**
1. **Check inside interior first** (regardless of fill):
```typescript
const insideInterior = this.pointInsideShape(cx, cy, frame, shapeType);
if (insideInterior) {
  return { distance: 0, insideInterior: true };
}
```

2. **Check near stroke edge:**
```typescript
const halfStroke = strokeWidth / 2;
const nearEdge = this.shapeEdgeHitTest(cx, cy, r + halfStroke, frame, shapeType);
if (nearEdge) {
  return { distance: nearEdge, insideInterior: false };
}
```

**Shape-specific interior tests:**

**Diamond (lines 1138-1146):**
```typescript
case 'diamond': {
  const top: [number, number] = [x + w / 2, y];
  const right: [number, number] = [x + w, y + h / 2];
  const bottom: [number, number] = [x + w / 2, y + h];
  const left: [number, number] = [x, y + h / 2];
  return this.pointInDiamond(cx, cy, top, right, bottom, left);
}
```

**Ellipse (lines 1148-1161):**
```typescript
case 'ellipse': {
  const ecx = x + w / 2;
  const ecy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  if (rx < 0.001 || ry < 0.001) return false;

  const dx = (cx - ecx) / rx;
  const dy = (cy - ecy) / ry;
  return (dx * dx + dy * dy) <= 1;
}
```

**Rect/RoundedRect (fallback):**
```typescript
return this.pointInRect(cx, cy, x, y, w, h);
```

### 3.7 pickBestCandidate() - Z-Order Aware Algorithm

**CRITICAL:** This is the algorithm that determines which object wins when multiple are under cursor.

**Function (lines 1016-1102):**

```typescript
private pickBestCandidate(candidates: HitCandidate[]): HitCandidate {
  if (candidates.length === 1) return candidates[0];

  // Sort by Z: ULID descending = newest/topmost first
  const sorted = [...candidates].sort((a, b) =>
    a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  );

  type PaintClass = 'ink' | 'fill';

  // Unfilled shape interior = transparent logical region (not paint)
  const isFrameInterior = (c: HitCandidate): boolean =>
    c.kind === 'shape' && !c.isFilled && c.insideInterior;

  // Everything else that actually paints pixels at this point
  const classifyPaint = (c: HitCandidate): PaintClass | null => {
    if (c.kind === 'stroke' || c.kind === 'connector' || c.kind === 'text') {
      return 'ink';
    }

    if (c.kind === 'shape') {
      if (c.isFilled) {
        return 'fill';  // Filled shape interior or border
      }
      if (!c.isFilled && !c.insideInterior) {
        return 'ink';   // Unfilled shape BORDER (outline stroke)
      }
      return null;      // Unfilled shape interior = transparent
    }

    return 'ink';  // Fallback
  };

  let bestFrame: HitCandidate | null = null;   // Smallest unfilled interior
  let firstPaint: HitCandidate | null = null;  // First visible paint in Z
  let firstPaintClass: PaintClass | null = null;

  // Scan from topmost to bottommost, respecting occlusion
  for (const c of sorted) {
    if (isFrameInterior(c)) {
      // Transparent frame region: remember smallest, keep scanning
      if (!bestFrame || c.area < bestFrame.area) {
        bestFrame = c;
      }
      continue;  // Don't stop - look for paint underneath
    }

    const paintClass = classifyPaint(c);
    if (paintClass !== null) {
      // Found first painted thing - this occludes everything below
      firstPaint = c;
      firstPaintClass = paintClass;
      break;  // Stop scanning
    }
  }

  // Case 1: Only frame interiors, no paint at this pixel
  if (!firstPaint && bestFrame) {
    return bestFrame;  // Return smallest frame (most nested)
  }

  // Case 2: No paint and no frames (shouldn't happen)
  if (!firstPaint) {
    return sorted[0];  // Fallback to topmost
  }

  // Case 3: First painted thing is ink (stroke/text/connector/border)
  // Ink ALWAYS beats frames
  if (firstPaintClass === 'ink') {
    return firstPaint;
  }

  // Case 4: First painted thing is a filled shape interior
  if (!bestFrame) {
    return firstPaint;  // No frames to compare with
  }

  // Case 5: Both filled shape and frame(s) contain the cursor
  // "More enclosed" = smaller region wins
  if (bestFrame.area < firstPaint.area) return bestFrame;
  if (firstPaint.area < bestFrame.area) return firstPaint;

  // Equal areas: tie-break by Z (sorted is topmost-first)
  const idxPaint = sorted.indexOf(firstPaint);
  const idxFrame = sorted.indexOf(bestFrame);
  return idxPaint <= idxFrame ? firstPaint : bestFrame;
}
```

**Key Decision Logic:**

| Scenario | Outcome |
|----------|---------|
| Stroke on top of filled shape | Stroke wins (ink beats fill) |
| Filled shape on top of stroke | Filled shape wins (topmost paint) |
| Unfilled frame with stroke underneath | Stroke wins (frame is transparent, ink found) |
| Small unfilled frame inside big filled shape | Small frame wins (smaller area) |
| Nested unfilled frames (no paint) | Smallest frame wins |

### 3.8 Handle Hit Testing

**Function (lines 843-895):**

```typescript
private hitTestHandle(worldX: number, worldY: number): HandleId | null {
  const store = useSelectionStore.getState();
  if (store.selectedIds.length === 0) return null;

  const bounds = this.computeSelectionBounds();
  if (!bounds) return null;

  const view = this.getView();
  const handleRadius = HANDLE_HIT_PX / view.scale;

  // Test corners first (they take priority)
  const corners: { id: HandleId; x: number; y: number }[] = [
    { id: 'nw', x: bounds.minX, y: bounds.minY },
    { id: 'ne', x: bounds.maxX, y: bounds.minY },
    { id: 'se', x: bounds.maxX, y: bounds.maxY },
    { id: 'sw', x: bounds.minX, y: bounds.maxY },
  ];

  for (const h of corners) {
    const dx = worldX - h.x;
    const dy = worldY - h.y;
    if (dx * dx + dy * dy <= handleRadius * handleRadius) {
      return h.id;
    }
  }

  // Test side edges (not rendered, but for cursor/scaling)
  const edgeTolerance = handleRadius;

  // North edge (top)
  if (Math.abs(worldY - bounds.minY) <= edgeTolerance &&
      worldX > bounds.minX + handleRadius && worldX < bounds.maxX - handleRadius) {
    return 'n';
  }
  // South, West, East (similar logic)

  return null;
}
```

**Handle IDs:**
```typescript
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
```

---

## 4. Transform System

### 4.1 Translate Transform

**Initialization (in `move()` case 'pendingClick'):**
```typescript
const bounds = this.computeSelectionBounds();
store.beginTranslate(bounds!);
```

**Update (in `move()` case 'translate'):**
```typescript
case 'translate': {
  if (this.downWorld) {
    const dx = worldX - this.downWorld[0];
    const dy = worldY - this.downWorld[1];
    store.updateTranslate(dx, dy);
    this.invalidateTransformPreview();
  }
}
```

**Preview Application (in objects.ts):**
```typescript
function applySelectionTransform(ctx, transform) {
  if (transform.kind === 'translate') {
    ctx.translate(transform.dx, transform.dy);
  }
}
```

### 4.2 Scale Transform

**Origin Calculation:**

**Function `getScaleOrigin()` (lines 566-583):**

```typescript
private getScaleOrigin(handle: HandleId, bounds: WorldRect): [number, number] {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  // Scale origin is opposite edge/corner from the dragged handle
  switch (handle) {
    // Corners - opposite corner
    case 'nw': return [bounds.maxX, bounds.maxY];
    case 'ne': return [bounds.minX, bounds.maxY];
    case 'se': return [bounds.minX, bounds.minY];
    case 'sw': return [bounds.maxX, bounds.minY];
    // Sides - opposite edge midpoint
    case 'n': return [midX, bounds.maxY];
    case 's': return [midX, bounds.minY];
    case 'e': return [bounds.minX, midY];
    case 'w': return [bounds.maxX, midY];
  }
}
```

**Scale Factor Computation:**

**Function `computeScaleFactors()` (lines 585-635):**

```typescript
private computeScaleFactors(worldX: number, worldY: number): { scaleX: number; scaleY: number } {
  const store = useSelectionStore.getState();
  const transform = store.transform;

  if (transform.kind !== 'scale') {
    return { scaleX: 1, scaleY: 1 };
  }

  const { origin, originBounds, handleId } = transform;
  const [ox, oy] = origin;

  // Original dimensions
  const origWidth = originBounds.maxX - originBounds.minX;
  const origHeight = originBounds.maxY - originBounds.minY;

  // Vector from origin to cursor
  const dx = worldX - ox;
  const dy = worldY - oy;

  // Get sign multipliers based on handle direction
  const handleSignX = this.getHandleSignX(handleId);
  const handleSignY = this.getHandleSignY(handleId);

  let scaleX = 1;
  let scaleY = 1;

  const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handleId);
  const isSideH = handleId === 'e' || handleId === 'w';
  const isSideV = handleId === 'n' || handleId === 's';

  if (isCorner) {
    // Corner handles: free scale in both axes (SIGNED for flip)
    scaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
    scaleY = origHeight > 0 ? (dy * handleSignY) / origHeight : 1;
  } else if (isSideH) {
    // East/West handle: X scales, Y = 1
    scaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
    scaleY = 1;
  } else if (isSideV) {
    // North/South handle: Y scales, X = 1
    scaleY = origHeight > 0 ? (dy * handleSignY) / origHeight : 1;
    scaleX = 1;
  }

  // Apply minimum scale magnitude (0.1) but preserve sign for flip
  const minScale = 0.1;
  scaleX = Math.sign(scaleX || 1) * Math.max(minScale, Math.abs(scaleX));
  scaleY = Math.sign(scaleY || 1) * Math.max(minScale, Math.abs(scaleY));

  return { scaleX, scaleY };
}
```

**Sign Functions (lines 637-653):**

```typescript
/** Returns +1 or -1 for X direction based on handle */
private getHandleSignX(handleId: HandleId): number {
  switch (handleId) {
    case 'nw': case 'w': case 'sw': return -1;  // Left side
    case 'ne': case 'e': case 'se': return 1;   // Right side
    default: return 1;
  }
}

/** Returns +1 or -1 for Y direction based on handle */
private getHandleSignY(handleId: HandleId): number {
  switch (handleId) {
    case 'nw': case 'n': case 'ne': return -1;  // Top side
    case 'sw': case 's': case 'se': return 1;   // Bottom side
    default: return 1;
  }
}
```

### 4.3 signX/signY System for Flip Behavior

**Purpose:** Allow dragging handles past the origin to flip objects (negative scale).

**How it works:**

1. **Handle direction determines sign:**
   - NW handle: signX = -1, signY = -1 (drag up-left to shrink, down-right to grow)
   - SE handle: signX = +1, signY = +1 (drag down-right to grow, up-left to shrink)

2. **Crossing origin flips:**
   - Drag SE handle past NW corner → scaleX < 0, scaleY < 0 → object flips both axes
   - Drag E handle past W edge → scaleX < 0 → horizontal flip

3. **Formula:**
```typescript
scaleX = (cursorDx * handleSignX) / originalWidth
// If cursor crosses origin: cursorDx changes sign → scale becomes negative
```

**Example:** SE handle (bottom-right corner)
```
origin = NW corner = [100, 100]
originalBounds = { minX: 100, minY: 100, maxX: 200, maxY: 200 }
originalWidth = 100, originalHeight = 100

// Normal drag (cursor at [250, 250]):
dx = 250 - 100 = 150
dy = 250 - 100 = 150
signX = +1, signY = +1
scaleX = (150 * 1) / 100 = 1.5 ✓ (grow)
scaleY = (150 * 1) / 100 = 1.5 ✓ (grow)

// Flip drag (cursor at [50, 50] - crossed origin):
dx = 50 - 100 = -50
dy = 50 - 100 = -50
signX = +1, signY = +1
scaleX = (-50 * 1) / 100 = -0.5 ✓ (flip + shrink)
scaleY = (-50 * 1) / 100 = -0.5 ✓ (flip + shrink)
```

### 4.4 Preview Application in objects.ts

**Function `applySelectionTransform()` (lines 307-334):**

```typescript
function applySelectionTransform(
  ctx: CanvasRenderingContext2D,
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number; handleId?: HandleId },
  objectKind: 'stroke' | 'shape' | 'text' | 'connector'
): void {
  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    ctx.translate(transform.dx, transform.dy);
  } else if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
    const [ox, oy] = transform.origin;
    let sx = transform.scaleX;
    let sy = transform.scaleY;

    // Strokes and connectors ALWAYS scale uniformly
    if (objectKind === 'stroke' || objectKind === 'connector') {
      const uniformScale = computeUniformScale(sx, sy, transform.handleId);
      sx = uniformScale;
      sy = uniformScale;
    }

    ctx.translate(ox, oy);
    ctx.scale(sx, sy);
    ctx.translate(-ox, -oy);
  }
}
```

**Uniform Scale for Strokes (lines 336-353):**

```typescript
function computeUniformScale(scaleX: number, scaleY: number, handleId?: HandleId): number {
  if (!handleId) {
    // Default: use max scale (preserves sign from scaleX)
    return Math.sign(scaleX || 1) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  }

  switch (handleId) {
    case 'e': case 'w': return scaleX;  // Horizontal: X is primary
    case 'n': case 's': return scaleY;  // Vertical: Y is primary
    default:
      // Corners: use max scale
      return Math.sign(scaleX || 1) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  }
}
```

**Why uniform for strokes:**
- Preserves visual appearance of freehand strokes
- Non-uniform scaling would distort strokes unnaturally
- Shapes allow non-uniform (WYSIWYG frame resize)

---

## 5. Commit Pipeline

### 5.1 commitTranslate()

**Function (lines 699-728):**

```typescript
private commitTranslate(selectedIds: string[], dx: number, dy: number): void {
  const snapshot = this.room.currentSnapshot;

  this.room.mutate((ydoc: Y.Doc) => {
    const root = ydoc.getMap('root');
    const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      const yMap = objects.get(id);
      if (!yMap) continue;

      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        // Offset all points
        const points = yMap.get('points') as [number, number][];
        if (!points) continue;
        const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
        yMap.set('points', newPoints);
      } else {
        // Offset frame (shapes, text)
        const frame = yMap.get('frame') as [number, number, number, number];
        if (!frame) continue;
        const [x, y, w, h] = frame;
        yMap.set('frame', [x + dx, y + dy, w, h]);
      }
    }
  });
}
```

**Points-based objects (strokes, connectors):**
- Offset every point by (dx, dy)
- Create new array to trigger Y.Map change detection

**Frame-based objects (shapes, text):**
- Offset frame position (x, y) by (dx, dy)
- Width and height unchanged

### 5.2 commitScale()

**Function (lines 730-784):**

```typescript
private commitScale(
  selectedIds: string[],
  origin: [number, number],
  scaleX: number,
  scaleY: number,
  handleId: HandleId
): void {
  const snapshot = this.room.currentSnapshot;
  const [ox, oy] = origin;

  this.room.mutate((ydoc: Y.Doc) => {
    const root = ydoc.getMap('root');
    const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      const yMap = objects.get(id);
      if (!yMap) continue;

      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        // Strokes: ALWAYS uniform scale
        const uniformScale = this.computeUniformScaleForCommit(scaleX, scaleY, handleId);

        const points = yMap.get('points') as [number, number][];
        if (!points) continue;
        const newPoints: [number, number][] = points.map(([x, y]) => [
          ox + (x - ox) * uniformScale,
          oy + (y - oy) * uniformScale,
        ]);
        yMap.set('points', newPoints);
      } else {
        // Shapes/text: non-uniform allowed
        const frame = yMap.get('frame') as [number, number, number, number];
        if (!frame) continue;
        const [x, y, w, h] = frame;

        // Scale corners around origin
        const newX1 = ox + (x - ox) * scaleX;
        const newY1 = oy + (y - oy) * scaleY;
        const newX2 = ox + ((x + w) - ox) * scaleX;
        const newY2 = oy + ((y + h) - oy) * scaleY;

        // Handle negative scale (flip) - ensure positive dimensions
        yMap.set('frame', [
          Math.min(newX1, newX2),
          Math.min(newY1, newY2),
          Math.abs(newX2 - newX1),
          Math.abs(newY2 - newY1),
        ]);
      }
    }
  });
}
```

**Uniform scale computation for commit (lines 786-794):**

```typescript
private computeUniformScaleForCommit(scaleX: number, scaleY: number, handleId: HandleId): number {
  switch (handleId) {
    case 'e': case 'w': return scaleX;  // Horizontal: X is primary
    case 'n': case 's': return scaleY;  // Vertical: Y is primary
    default:
      // Corners: use max scale (preserves sign from scaleX)
      return Math.sign(scaleX || 1) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  }
}
```

**Critical flip handling for shapes:**
```typescript
// Negative scale means flip - corners cross
// Use Math.min/max to ensure frame origin is always top-left
// Use Math.abs to ensure dimensions are positive
yMap.set('frame', [
  Math.min(newX1, newX2),  // Always leftmost X
  Math.min(newY1, newY2),  // Always topmost Y
  Math.abs(newX2 - newX1), // Always positive width
  Math.abs(newY2 - newY1), // Always positive height
]);
```

### 5.3 Transform Flow Summary

```
TRANSLATE FLOW:
┌─────────────────┐
│  move() loop    │ → updateTranslate(dx, dy)
│  compute dx,dy  │ → invalidateTransformPreview()
└─────────────────┘
         ↓
┌─────────────────┐
│  objects.ts     │ → Read store, apply ctx.translate(dx, dy)
│  render preview │
└─────────────────┘
         ↓
┌─────────────────┐
│  end()          │ → commitTranslate()
│  pointer up     │ → mutate Y.Maps: points/frame += (dx, dy)
└─────────────────┘

SCALE FLOW:
┌─────────────────┐
│  move() loop    │ → computeScaleFactors(cursor)
│  cursor tracks  │ → updateScale(scaleX, scaleY)
│                 │ → invalidateTransformPreview()
└─────────────────┘
         ↓
┌─────────────────┐
│  objects.ts     │ → Read store, apply ctx transform:
│  render preview │    translate(origin) → scale(sx, sy) → translate(-origin)
└─────────────────┘
         ↓
┌─────────────────┐
│  end()          │ → commitScale()
│  pointer up     │ → mutate Y.Maps:
│                 │    - Strokes: uniform scale points around origin
│                 │    - Shapes: scale frame corners, abs() for flip
└─────────────────┘
```

---

## 6. Preview System

### 6.1 getPreview() Function

**Function (lines 414-452):**

```typescript
getPreview(): SelectionPreview | null {
  const store = useSelectionStore.getState();
  const { selectedIds, transform, marquee } = store;

  // Compute marquee rect if active
  let marqueeRect: WorldRect | null = null;
  if (marquee.active && marquee.anchor && marquee.current) {
    marqueeRect = {
      minX: Math.min(marquee.anchor[0], marquee.current[0]),
      minY: Math.min(marquee.anchor[1], marquee.current[1]),
      maxX: Math.max(marquee.anchor[0], marquee.current[0]),
      maxY: Math.max(marquee.anchor[1], marquee.current[1]),
    };
  }

  // Compute selection bounds with transform applied
  let selectionBounds: WorldRect | null = null;
  let handles: { id: HandleId; x: number; y: number }[] | null = null;

  if (selectedIds.length > 0) {
    const baseBounds = this.computeSelectionBounds();
    if (baseBounds) {
      selectionBounds = this.applyTransformToBounds(baseBounds, transform);
      handles = this.computeHandles(selectionBounds);
    }
  }

  const isTransforming = transform.kind !== 'none';

  return {
    kind: 'selection',
    selectionBounds,
    marqueeRect,
    handles: isTransforming ? null : handles, // Hide handles during transform
    isTransforming,
    selectedIds,
    bbox: null,
  };
}
```

### 6.2 SelectionPreview Type

**File:** `client/src/lib/tools/types.ts` (lines 119-133)

```typescript
export interface SelectionPreview {
  kind: 'selection';
  /** Selection bounds in world coords (with transform applied for preview) */
  selectionBounds: WorldRect | null;
  /** Marquee rect in world coords (anchor to current point) */
  marqueeRect: WorldRect | null;
  /** Handle positions for resize (world coords) */
  handles: { id: HandleId; x: number; y: number }[] | null;
  /** Whether currently transforming (to hide handles during drag) */
  isTransforming: boolean;
  /** IDs of selected objects (for rendering selection highlight) */
  selectedIds: string[];
  /** Always null for overlay previews */
  bbox: null;
}
```

### 6.3 Bounds Helpers

**computeSelectionBounds() (lines 509-532):**
```typescript
private computeSelectionBounds(): WorldRect | null {
  const store = useSelectionStore.getState();
  const { selectedIds } = store;
  if (selectedIds.length === 0) return null;

  const snapshot = this.room.currentSnapshot;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;

    // bbox format is [minX, minY, maxX, maxY], NOT [x, y, width, height]
    const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
    minX = Math.min(minX, bMinX);
    minY = Math.min(minY, bMinY);
    maxX = Math.max(maxX, bMaxX);
    maxY = Math.max(maxY, bMaxY);
  }

  if (!isFinite(minX)) return null;

  return { minX, minY, maxX, maxY };
}
```

**applyTransformToBounds() (lines 534-555):**
```typescript
private applyTransformToBounds(bounds: WorldRect, transform: { kind: string; dx?: number; dy?: number; scaleX?: number; scaleY?: number; origin?: [number, number] }): WorldRect {
  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    return {
      minX: bounds.minX + transform.dx,
      minY: bounds.minY + transform.dy,
      maxX: bounds.maxX + transform.dx,
      maxY: bounds.maxY + transform.dy,
    };
  }

  if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
    const [ox, oy] = transform.origin;
    return {
      minX: ox + (bounds.minX - ox) * transform.scaleX,
      minY: oy + (bounds.minY - oy) * transform.scaleY,
      maxX: ox + (bounds.maxX - ox) * transform.scaleX,
      maxY: oy + (bounds.maxY - oy) * transform.scaleY,
    };
  }

  return bounds;
}
```

**computeHandles() (lines 557-564):**
```typescript
private computeHandles(bounds: WorldRect): { id: HandleId; x: number; y: number }[] {
  return [
    { id: 'nw', x: bounds.minX, y: bounds.minY },
    { id: 'ne', x: bounds.maxX, y: bounds.minY },
    { id: 'se', x: bounds.maxX, y: bounds.maxY },
    { id: 'sw', x: bounds.minX, y: bounds.maxY },
  ];
}
```

---

## 7. Dirty Rect System

### 7.1 invalidateTransformPreview()

**Function (lines 666-695):**

```typescript
private invalidateTransformPreview(): void {
  const bounds = this.computeSelectionBounds();
  if (!bounds) return;

  const store = useSelectionStore.getState();
  const transformedBounds = this.applyTransformToBounds(bounds, store.transform);

  if (this.prevPreviewBounds) {
    // Subsequent moves: union previous with current
    const unionBounds: WorldRect = {
      minX: Math.min(this.prevPreviewBounds.minX, transformedBounds.minX),
      minY: Math.min(this.prevPreviewBounds.minY, transformedBounds.minY),
      maxX: Math.max(this.prevPreviewBounds.maxX, transformedBounds.maxX),
      maxY: Math.max(this.prevPreviewBounds.maxY, transformedBounds.maxY),
    };
    this.invalidateWorld(unionBounds);
  } else {
    // FIRST MOVE: Invalidate BOTH original AND transformed bounds
    // This clears ghosting from objects at their original position
    const unionBounds: WorldRect = {
      minX: Math.min(bounds.minX, transformedBounds.minX),
      minY: Math.min(bounds.minY, transformedBounds.minY),
      maxX: Math.max(bounds.maxX, transformedBounds.maxX),
      maxY: Math.max(bounds.maxY, transformedBounds.maxY),
    };
    this.invalidateWorld(unionBounds);
  }

  this.prevPreviewBounds = transformedBounds;
}
```

### 7.2 prevPreviewBounds Tracking

**Field declaration (line 84):**
```typescript
private prevPreviewBounds: WorldRect | null = null;
```

**Reset in resetState() (line 504):**
```typescript
private resetState(): void {
  this.phase = 'idle';
  this.pointerId = null;
  this.downWorld = null;
  this.downScreen = null;
  this.hitAtDown = null;
  this.activeHandle = null;
  this.downTarget = 'none';
  this.downTimeMs = 0;
  this.prevPreviewBounds = null;  // ← Reset here
}
```

### 7.3 Union Bounds Calculation

**Strategy:**

1. **First move:** Union of **original** bounds + **transformed** bounds
   - Clears both where objects were AND where they are now
   - Prevents ghosting artifacts

2. **Subsequent moves:** Union of **previous transformed** bounds + **current transformed** bounds
   - Clears motion trail (where preview was, where it is now)
   - Minimal dirty region (only covers the change)

**Visual Example (Translate):**

```
Frame 0 (pointer down):
  Original bounds: [100, 100, 200, 200]
  prevPreviewBounds = null

Frame 1 (first move, dx=10, dy=10):
  Transformed bounds: [110, 110, 210, 210]
  Union: [100, 100, 210, 210]  ← covers BOTH positions
  prevPreviewBounds = [110, 110, 210, 210]

Frame 2 (move again, dx=20, dy=20):
  Transformed bounds: [120, 120, 220, 220]
  Union: [110, 110, 220, 220]  ← covers motion from frame 1 to frame 2
  prevPreviewBounds = [120, 120, 220, 220]
```

### 7.4 Cancel Cleanup

**In `cancel()` (lines 379-404):**

```typescript
cancel(): void {
  // Invalidate dirty rect before clearing transform state
  if (this.phase === 'translate' || this.phase === 'scale') {
    const bounds = this.computeSelectionBounds();
    if (bounds) {
      const store = useSelectionStore.getState();
      const transformedBounds = this.applyTransformToBounds(bounds, store.transform);
      // Union original + transformed bounds to clear any ghosting
      const unionBounds: WorldRect = {
        minX: Math.min(bounds.minX, transformedBounds.minX),
        minY: Math.min(bounds.minY, transformedBounds.minY),
        maxX: Math.max(bounds.maxX, transformedBounds.maxX),
        maxY: Math.max(bounds.maxY, transformedBounds.maxY),
      };
      this.invalidateWorld(unionBounds);
    }
  }

  useSelectionStore.getState().cancelTransform();
  useSelectionStore.getState().cancelMarquee();
  this.resetState();
  this.invalidateOverlay();
}
```

---

## 8. Rendering Integration

### 8.1 Base Canvas - Object Transform Rendering

**File:** `client/src/renderer/layers/objects.ts`

**Main rendering function (lines 8-105):**

```typescript
export function drawObjects(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  const { spatialIndex, objectsById } = snapshot;
  if (!spatialIndex) return;

  // === READ SELECTION STATE FOR TRANSFORM PREVIEW ===
  const selectionState = useSelectionStore.getState();
  const selectedSet = new Set(selectionState.selectedIds);
  const transform = selectionState.transform;
  const isTransforming = transform.kind !== 'none';

  // ... spatial query and sorting ...

  for (const entry of sortedCandidates) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    if (shouldSkipLOD(handle.bbox, viewTransform)) continue;

    // === TRANSFORM SELECTED OBJECTS DURING ACTIVE TRANSFORM ===
    const isSelected = selectedSet.has(entry.id);
    const needsTransform = isTransforming && isSelected;

    if (needsTransform) {
      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        // Strokes/Connectors: use canvas transform (uniform scale for strokes)
        ctx.save();
        applySelectionTransform(ctx, transform, handle.kind);
        drawObject(ctx, handle);
        ctx.restore();
      } else if (handle.kind === 'shape') {
        // Shapes: WYSIWYG - compute transformed frame, draw with original stroke width
        drawShapeWithTransform(ctx, handle, transform);
      } else if (handle.kind === 'text') {
        // Text: WYSIWYG - compute transformed frame
        drawTextWithTransform(ctx, handle, transform);
      }
    } else {
      drawObject(ctx, handle);
    }
  }
}
```

**WYSIWYG Shape Rendering (lines 439-479):**

```typescript
function drawShapeWithTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number }
): void {
  const { y } = handle;

  // Get original frame and compute transformed frame
  const frame = y.get('frame') as [number, number, number, number];
  if (!frame) return;

  const transformedFrame = applyTransformToFrame(frame, transform);

  // Get styling from Y.Map
  const shapeType = (y.get('shapeType') as string) || 'rect';
  const fillColor = y.get('fillColor') as string | undefined;
  const color = (y.get('color') ?? y.get('strokeColor')) as string | undefined;
  const width = ((y.get('width') ?? y.get('strokeWidth')) as number) ?? 1;
  const opacity = (y.get('opacity') as number) ?? 1;

  // Build path from TRANSFORMED frame (not cached)
  const path = buildShapePathFromFrame(shapeType, transformedFrame);

  ctx.save();
  ctx.globalAlpha = opacity;

  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill(path);
  }

  if (color && width > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;  // ORIGINAL width - NOT scaled!
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }

  ctx.restore();
}
```

**Key insight:** Stroke width does NOT scale during preview. Only geometry scales.

**Transform application to frame (lines 358-387):**

```typescript
function applyTransformToFrame(
  frame: [number, number, number, number],
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number }
): [number, number, number, number] {
  const [x, y, w, h] = frame;

  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    return [x + transform.dx, y + transform.dy, w, h];
  }

  if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
    const [ox, oy] = transform.origin;
    const { scaleX, scaleY } = transform;

    // Scale corners around origin
    const newX1 = ox + (x - ox) * scaleX;
    const newY1 = oy + (y - oy) * scaleY;
    const newX2 = ox + ((x + w) - ox) * scaleX;
    const newY2 = oy + ((y + h) - oy) * scaleY;

    return [
      Math.min(newX1, newX2),
      Math.min(newY1, newY2),
      Math.abs(newX2 - newX1),
      Math.abs(newY2 - newY1),
    ];
  }

  return frame;
}
```

### 8.2 Overlay Canvas - Selection UI Rendering

**File:** `client/src/renderer/OverlayRenderLoop.ts`

**Selection preview rendering (lines 288-376):**

```typescript
} else if (previewToDraw?.kind === 'selection') {
  // Selection preview (world space for bounds, screen space for handle sizing)
  ctx.save();
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);

  // === SELECTION HIGHLIGHTING (only when not transforming) ===
  if (!previewToDraw.isTransforming && previewToDraw.selectedIds?.length > 0) {
    const snapshot = getSnapshot();
    const cache = getObjectCacheInstance();

    ctx.strokeStyle = 'rgba(59, 130, 246, 1)';  // Blue
    ctx.lineWidth = 2 / view.scale;  // 2px visual regardless of zoom
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const id of previewToDraw.selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      // Text: stroke the frame rect
      if (handle.kind === 'text') {
        const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
        if (frame) {
          const [x, y, w, h] = frame;
          ctx.strokeRect(x, y, w, h);
        }
        continue;
      }

      // Strokes/Connectors: use bbox rectangle (avoids PF "ball" end cap artifact)
      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        const [minX, minY, maxX, maxY] = handle.bbox;
        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
        continue;
      }

      // Shapes: stroke the cached Path2D (follows actual geometry)
      const path = cache.getOrBuild(id, handle);
      ctx.stroke(path);
    }
  }

  // Draw marquee rect if active (dashed, light blue fill)
  if (previewToDraw.marqueeRect) {
    const { minX, minY, maxX, maxY } = previewToDraw.marqueeRect;
    ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
    ctx.lineWidth = 1 / view.scale;
    ctx.setLineDash([4 / view.scale, 4 / view.scale]);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.setLineDash([]);
  }

  // Draw selection bounds and handles (skip during active transform)
  if (previewToDraw.selectionBounds && !previewToDraw.isTransforming) {
    const { minX, minY, maxX, maxY } = previewToDraw.selectionBounds;

    // Selection box stroke
    ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
    ctx.lineWidth = 1.5 / view.scale;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

    // Corner handles (8px screen size, scaled to world)
    if (previewToDraw.handles) {
      const handleSize = 8 / view.scale;
      ctx.fillStyle = 'white';
      ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
      ctx.lineWidth = 1.5 / view.scale;

      for (const h of previewToDraw.handles) {
        ctx.fillRect(
          h.x - handleSize / 2,
          h.y - handleSize / 2,
          handleSize,
          handleSize
        );
        ctx.strokeRect(
          h.x - handleSize / 2,
          h.y - handleSize / 2,
          handleSize,
          handleSize
        );
      }
    }
  }

  ctx.restore();
}
```

**Rendering strategy:**

1. **Selection highlighting** (blue stroke on each object):
   - Only when NOT transforming (prevents double-rendering with transformed objects)
   - Strokes/connectors: Use bbox rect (avoids PF end-cap artifacts)
   - Shapes: Stroke the Path2D geometry (follows shape contours)
   - Text: Stroke frame rectangle

2. **Marquee rectangle:**
   - Light blue semi-transparent fill (0.08 alpha)
   - Dashed stroke (4px dash pattern scaled to world)

3. **Selection bounds + handles:**
   - Only when NOT transforming (hidden during drag for clarity)
   - Bounds: Solid blue stroke (1.5px scaled to world)
   - Handles: White fill + blue stroke, 8px screen-size (scaled to world for WYSIWYG)

---

## 9. Canvas Integration

### 9.1 Tool Creation

**File:** `client/src/canvas/Canvas.tsx`

**SelectTool creation branch (lines 530-537):**

```typescript
} else if (activeTool === 'select') {
  tool = new SelectTool(roomDoc, {
    invalidateWorld: (bounds) => renderLoopRef.current?.invalidateWorld(bounds),
    invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
    getView: () => viewTransformRef.current,
    applyCursor,
    setCursorOverride: (cursor) => { cursorOverrideRef.current = cursor; },
  });
}
```

### 9.2 Cursor Management

**applyCursor function (lines 209-234):**

```typescript
const applyCursor = useCallback(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas) return;

  // Priority 1: Explicit override (from tool or MMB)
  if (cursorOverrideRef.current) {
    canvas.style.cursor = cursorOverrideRef.current;
    return;
  }

  // Priority 2: Tool-based default
  const currentTool = activeToolRef.current;
  switch (currentTool) {
    case 'eraser':
      canvas.style.cursor = 'url("/cursors/avloEraser.cur") 16 16, auto';
      break;
    case 'pan':
      canvas.style.cursor = 'grab';
      break;
    case 'select':
      canvas.style.cursor = 'default';  // Arrow cursor
      break;
    default:
      canvas.style.cursor = 'crosshair';
  }
}, []);
```

**Cursor override pattern in SelectTool:**

```typescript
// In SelectTool constructor:
this.setCursorOverride = opts.setCursorOverride;

// During scale gesture (in move() → scale phase):
const cursor = this.getHandleCursor(this.activeHandle!);
this.setCursorOverride(cursor);
this.applyCursor();

// On gesture end (in end()):
this.setCursorOverride(null);
this.applyCursor();
```

**Handle cursor mapping (lines 656-664):**

```typescript
private getHandleCursor(handle: HandleId): string {
  switch (handle) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    default: return 'default';
  }
}
```

### 9.3 Hover Cursor Updates

**updateHoverCursor() method (lines 467-483):**

```typescript
updateHoverCursor(worldX: number, worldY: number): void {
  const store = useSelectionStore.getState();
  if (store.selectedIds.length === 0) {
    this.setCursorOverride(null);
    this.applyCursor();
    return;
  }

  const handle = this.hitTestHandle(worldX, worldY);
  if (handle) {
    const cursor = this.getHandleCursor(handle);
    this.setCursorOverride(cursor);
  } else {
    this.setCursorOverride(null);
  }
  this.applyCursor();
}
```

**Called from Canvas.tsx pointer move handler (lines 731-733):**

```typescript
// SelectTool: update handle hover cursor when idle
if (activeToolRef.current === 'select' && !tool.isActive()) {
  (tool as SelectTool).updateHoverCursor(world[0], world[1]);
}
```

### 9.4 Event Flow

**Pointer Down → Move → Up:**

```typescript
// Canvas.tsx handlePointerDown (line 619)
const handlePointerDown = (e: PointerEvent) => {
  if (e.button !== 0) return; // Only left button

  const tool = toolRef.current;
  if (!tool?.canBegin()) return;

  const worldCoords = screenToWorld(e.clientX, e.clientY);
  if (!worldCoords) return;

  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  tool.begin(e.pointerId, worldCoords[0], worldCoords[1]);
};

// Canvas.tsx handlePointerMove (line 678)
const handlePointerMove = (e: PointerEvent) => {
  const world = screenToWorld(e.clientX, e.clientY);
  if (world) {
    tool.move(world[0], world[1]);

    // SelectTool: update handle hover when idle
    if (activeToolRef.current === 'select' && !tool.isActive()) {
      (tool as SelectTool).updateHoverCursor(world[0], world[1]);
    }
  }
};

// Canvas.tsx handlePointerUp (line 739)
const handlePointerUp = (e: PointerEvent) => {
  const tool = toolRef.current;
  if (!tool?.isActive() || e.pointerId !== tool.getPointerId()) return;

  canvas.releasePointerCapture(e.pointerId);

  const world = screenToWorld(e.clientX, e.clientY);
  tool.end(world?.[0], world?.[1]);
  roomDoc.updateActivity('idle');
};
```

---

## 10. Current Limitations & Known Issues

### 10.1 Scale Flip Behavior

**Issue:** Negative scale values (flip) during preview work correctly, but there are edge cases:

1. **Flip + resize interaction:**
   - Dragging past origin flips the object
   - Dirty rect computation may not perfectly cover the flip transition
   - Can cause brief ghosting artifacts during rapid flips

2. **Uniform scale for strokes:**
   - Strokes always scale uniformly (computeUniformScale)
   - Side handles (n/s/e/w) only scale in one axis for shapes, but use primary axis for strokes
   - This can feel unintuitive when selecting mixed stroke+shape groups

**Recommendation for fixing:**
- Add explicit flip state tracking (separate from sign of scale)
- Invalidate full bounds on sign change (detect flip transition)
- Consider clamping minimum negative scale to prevent excessive flips

### 10.2 Dirty Rect Union Bounds

**Issue:** Motion trail invalidation uses union bounds, which can be larger than necessary:

```typescript
// Current: Union of previous and current bounds
const unionBounds = {
  minX: Math.min(prevBounds.minX, currBounds.minX),
  minY: Math.min(prevBounds.minY, currBounds.minY),
  maxX: Math.max(prevBounds.maxX, currBounds.maxX),
  maxY: Math.max(prevBounds.maxY, currBounds.maxY),
};
```

**Problem:** For diagonal motion, union creates a large rectangle covering the entire motion path, not just start + end.

**Example:**
```
Previous bounds: [100, 100, 200, 200]
Current bounds:  [150, 150, 250, 250]
Union:           [100, 100, 250, 250]  ← 150x150 rect, but only need 2x 100x100
```

**Recommendation for optimization:**
- Use **two separate rects** instead of union
- `invalidateWorld([prevBounds, currBounds])` with array support
- Requires RenderLoop to support multi-rect invalidation

### 10.3 Handle Positioning During Non-Uniform Scale

**Issue:** Handle positions are computed from transformed bounds, which can flip during negative scale:

```typescript
// If scaleX < 0, minX and maxX swap positions
// Handles are computed from minX/maxX, so they visually flip
const handles = [
  { id: 'nw', x: bounds.minX, y: bounds.minY },  // ← May be on right side if flipped!
  { id: 'ne', x: bounds.maxX, y: bounds.minY },
  // ...
];
```

**Current behavior:** Handles are hidden during transform (`isTransforming = true`), so this is not visible.

**Future consideration:** If handles are shown during transform, they need flip-aware positioning.

### 10.4 Marquee Selection Geometry

**Issue:** Marquee selection uses simple bbox intersection:

```typescript
// Current: Uses RBush spatial query + bbox intersection
const results = spatialIndex.query(marqueeRect);
```

**Problem:** This selects objects whose bbox touches marquee, not precise geometry.

**Example:**
- User draws marquee around a diagonal stroke
- Stroke's bbox is much larger than visual stroke
- Marquee selects stroke even if only bbox corner is inside

**Recommendation for improvement:**
- Add precise geometry intersection test for marquee (lines 1474-1527 exist but unused)
- Use `objectIntersectsRect()` from SelectTool
- Trade-off: Performance vs precision (acceptable for user-facing tool)

### 10.5 Multi-Select with Mixed Object Types

**Current behavior:** Scaling a multi-select with strokes + shapes:
- Strokes scale uniformly (max of scaleX/scaleY)
- Shapes scale non-uniformly (independent scaleX/scaleY)

**Issue:** Visual disconnect when dragging side handles (e.g., east handle):
- Shapes only scale horizontally (scaleY = 1)
- Strokes scale uniformly (scaleX used for both axes)
- Result: Strokes appear to "grow vertically" when user only wanted horizontal scale

**Potential solutions:**
1. **Force uniform scale for entire selection** if ANY stroke is selected
2. **Separate transform per object type** (complex)
3. **Visual indicator** showing that strokes scale uniformly

### 10.6 Selection Store Persistence

**Current:** Selection store is transient (not persisted to localStorage).

**Implication:** Selection is lost on page refresh or room change.

**Consideration:** This is intentional for now. Future auto-select-after-commit feature will rebuild selection on tool switch.

### 10.7 Z-Order Changes During Transform

**Issue:** Objects maintain their ULID z-order during transform preview. If user adds a new object while transform is in progress:

1. New object gets higher ULID (newer)
2. New object renders on top of selected objects
3. Transform preview shows selected objects "underneath" the new object

**Current behavior:** Acceptable (rare edge case).

**Potential improvement:** Temporarily boost selected objects' z-order during transform (requires render pipeline changes).

---

## Appendix A: Type Reference

### WorldRect
```typescript
interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
```

### HandleId
```typescript
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
```

### Phase
```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';
```

### DownTarget
```typescript
type DownTarget =
  | 'none'
  | 'handle'
  | 'objectInSelection'
  | 'objectOutsideSelection'
  | 'selectionGap'
  | 'background';
```

---

## Appendix B: Constants

```typescript
// Hit testing
const HIT_RADIUS_PX = 6;       // Screen-space selection radius
const HIT_SLACK_PX = 2.0;      // Forgiving tolerance
const HANDLE_HIT_PX = 10;      // Handle hit radius

// State machine
const MOVE_THRESHOLD_PX = 4;   // Drag detection threshold
const CLICK_WINDOW_MS = 180;   // Ambiguous click time window

// Scale limits
const MIN_SCALE = 0.1;         // Minimum absolute scale factor
```

---

## Appendix C: File Summary

| File | Lines | Purpose |
|------|-------|---------|
| `SelectTool.ts` | ~1529 | Main tool implementation with state machine |
| `selection-store.ts` | ~141 | Zustand store for selection state |
| `types.ts` | ~140 | Type definitions (SelectionPreview added) |
| `objects.ts` | ~544 | Base canvas rendering with transform preview |
| `OverlayRenderLoop.ts` | ~404 | Overlay rendering for selection UI |
| `Canvas.tsx` | ~961 | Tool integration and event handling |

---

**End of Document**
