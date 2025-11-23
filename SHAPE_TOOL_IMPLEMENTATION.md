# Shape Tool Previous Implementation Guide

## Overview(THIS IS A PREVIOUS DOCUMENT FOR REFERENCE)
We're implementing dedicated shape tools (Rectangle, Ellipse, Arrow, Line) that bypass the hold detector and start in "already snapped" mode. **These tools will be corner-anchored (not center-anchored** like the existing perfect shapes from hold detection for the existing box and circle), reusing the existing DrawingTool infrastructure with a forced snap mode.

## Architecture Context

### Existing Infrastructure
1. **DrawingTool** - Handles freehand drawing and perfect shape recognition via HoldDetector
2. **HoldDetector** - Triggers after 600ms dwell to recognize shapes
3. **Perfect Shape Preview** - Renders live geometry from anchors + cursor
4. **Canvas.tsx** - Routes pointer events to tools, manages tool lifecycle
5. **Zustand Store** - Manages tool state and settings

## Existing Technical Pipeline

### Complete Flow: Pointer-Down to Commit

```
User Input → Canvas Events → DrawingTool → Shape Recognition → Preview → Commit
```

### 1. Gesture Start (Pointer-Down)

```typescript
Canvas.handlePointerDown()
  ↓ Convert to world coordinates
DrawingTool.begin()
  ├── Freeze tool settings (color, size, opacity)
  ├── Start HoldDetector (600ms timer, 6px screen jitter)
  ├── Initialize snap = null
  └── Set liveCursorWU = [worldX, worldY]
```

### 2. Movement During Drawing

```typescript
Canvas.handlePointerMove()
  ↓
DrawingTool.move()
  ├── Update liveCursorWU (always)
  ├── If !snap:
  │   ├── Update hold detector (screen space jitter check)
  │   └── Add point to freehand path (RAF coalesced)
  └── If snap:
      └── Request overlay frame (geometry updates from cursor)
```

### 3. Hold Detection Fires (600ms Dwell)

```typescript
HoldDetector.onFire()
  ↓
DrawingTool.onHoldFire()
  ├── Flush pending RAF updates
  ├── Call recognizeOpenStroke()
  │   ├── Fit circle (Taubin method on raw points)
  │   ├── Fit AABB rectangle (two-channel approach)
  │   ├── Score both shapes
  │   ├── Apply tie-breakers and ambiguity rules
  │   └── Return result (shape or ambiguous flag)
  ├── If ambiguous: continue freehand (no snap)
  └── If recognized: set snap state, cancel hold
```

### 4. Preview Generation & Rendering

```typescript
DrawingTool.getPreview()
  ├── If snap: return PerfectShapePreview
  │   └── Contains: anchors + liveCursorWU + style
  └── Else: return StrokePreview (freehand)

OverlayRenderLoop.frame()
  ├── Clear overlay canvas
  ├── Get preview from tool
  └── Draw perfect shape (compute geometry from anchors + cursor)
```

### 5. Commit (Pointer-Up)

```typescript
Canvas.handlePointerUp()
  ↓
DrawingTool.end()
  ├── Cancel hold detector
  ├── If snap:
  │   └── commitPerfectShapeFromPreview()
  │       ├── Generate polyline from shape geometry
  │       ├── Compute bbox (once)
  │       └── Commit as regular stroke to Yjs
  └── Else: commit freehand stroke
```
### Key Behaviors to Preserve
- Hold-to-perfect flow remains untouched for pen/highlighter tools
- All shapes commit as regular strokes (polylines)
- Preview rendering through OverlayRenderLoop
- Single tool instantiation point in Canvas.tsx

## Implementation Steps

### Step 1: Update Zustand Store Structure

**File: `/client/src/stores/device-ui-store.ts`**

```typescript
// Add after line 4
export type ShapeVariant = 'line' | 'rectangle' | 'ellipse' | 'arrow';

// Update Tool type (line 4)
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape';

// Add to DeviceUIState interface (after line 18)
shape: {
  variant: ShapeVariant;
  settings: ToolSettings; // Reuse existing ToolSettings type
};

// Add to initial state (after line 58)
shape: { variant: 'rectangle', settings: { size: 4, color: '#0F172A' } },

// Add action (after line 40)
setShapeSettings: (settings: Partial<{ variant: ShapeVariant } & ToolSettings>) => void;

// Add action implementation (after line 89)
setShapeSettings: (settings) =>
  set((state) => ({
    shape: { ...state.shape, ...settings },
  })),
```

### Step 2: Extend Type Definitions

**File: `/client/src/lib/tools/types.ts`**

```typescript
// Update PerfectShapeAnchors union (replace lines 76-78)
export type PerfectShapeAnchors =
  | { kind: 'line';        A: [number, number] }
  | { kind: 'circle';      center: [number, number] }
  | { kind: 'box';         cx: number; cy: number; angle: number; hx0: number; hy0: number } // center-anchored (hold detector)
  | { kind: 'rect';        A: [number, number] }                                             // corner-anchored AABB
  | { kind: 'ellipseRect'; A: [number, number] }                                             // corner-anchored ellipse
  | { kind: 'arrow';       A: [number, number] };

// Update shape discriminant in PerfectShapePreview (line 65)
shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow';
```

### Step 3: Enhance DrawingTool with Forced Snap Mode

**File: `/client/src/lib/tools/DrawingTool.ts`**

```typescript
// Add type definition (after line 16)
type ForcedSnapKind = 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow';

// Update constructor signature (line 46)
constructor(
  room: IRoomDocManager,
  settings: ToolSettings,
  toolType: 'pen' | 'highlighter',
  userId: string,
  onInvalidate?: (bounds: [number, number, number, number]) => void,
  requestOverlayFrame?: RequestOverlayFrame,
  getView?: () => ViewTransform,
  opts?: { forceSnapKind?: ForcedSnapKind }  // NEW parameter
)

// Add field to store options (after line 44)
private opts: { forceSnapKind?: ForcedSnapKind } = {};

// Store opts in constructor (after line 61)
this.opts = opts ?? {};

// Update snap type to include new kinds (lines 35-41)
private snap:
  | null
  | (
      | { kind: 'line';        anchors: { A: [number, number] } }
      | { kind: 'circle';      anchors: { center: [number, number] } }
      | { kind: 'box';         anchors: { cx: number; cy: number; angle: number; hx0: number; hy0: number } }
      | { kind: 'rect';        anchors: { A: [number, number] } }
      | { kind: 'ellipseRect'; anchors: { A: [number, number] } }
      | { kind: 'arrow';       anchors: { A: [number, number] } }
    ) = null;

// Update begin method (replace lines 93-106)
begin(pointerId: number, worldX: number, worldY: number): void {
  this.startDrawing(pointerId, worldX, worldY);

  // If Shape tool requested forced snap, seed it immediately
  if (this.opts.forceSnapKind) {
    const k = this.opts.forceSnapKind;
    this.snap =
      k === 'line'        ? { kind: 'line',        anchors: { A: [worldX, worldY] } }
    : k === 'circle'      ? { kind: 'circle',      anchors: { center: [worldX, worldY] } }
    : k === 'box'         ? { kind: 'box',         anchors: { cx: worldX, cy: worldY, angle: 0, hx0: 0.5, hy0: 0.5 } }
    : k === 'rect'        ? { kind: 'rect',        anchors: { A: [worldX, worldY] } }
    : k === 'ellipseRect' ? { kind: 'ellipseRect', anchors: { A: [worldX, worldY] } }
    : /* arrow */           { kind: 'arrow',       anchors: { A: [worldX, worldY] } };

    this.liveCursorWU = [worldX, worldY];
    this.requestOverlayFrame?.(); // Start preview immediately
    return; // Skip HoldDetector in forced mode
  }

  // Existing freehand flow with HoldDetector
  if (this.getView) {
    const [sx, sy] = this.getView().worldToCanvas(worldX, worldY);
    this.hold.start({ x: sx, y: sy });
  }
  this.snap = null;
  this.liveCursorWU = [worldX, worldY];
  this.requestOverlayFrame?.();
}

// Update commitPerfectShapeFromPreview (add after line 456, before closing brace)
  } else if (this.snap.kind === 'rect') {
    const { A } = this.snap.anchors;
    const C = finalCursor;
    const B: [number, number] = [C[0], A[1]];
    const D: [number, number] = [A[0], C[1]];
    points = [
      A[0], A[1],
      B[0], B[1],
      C[0], C[1],
      D[0], D[1],
      A[0], A[1],
  ];

} else if (this.snap.kind === 'ellipseRect') {
  // Corner-anchored ellipse inscribed in AABB
  const { A } = this.snap.anchors;
  const C = finalCursor;
  const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
  const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max(0.0001, (maxX - minX) / 2);
  const ry = Math.max(0.0001, (maxY - minY) / 2);
  // Approximate perimeter for point density
  const perim = Math.PI * (3*(rx+ry) - Math.sqrt((3*rx+ry)*(rx+3*ry)));
  const n = Math.max(24, Math.ceil(perim / 8));
  points = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    points.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
  }

} else if (this.snap.kind === 'arrow') {
  // Arrow with dynamic head size
  const { A } = this.snap.anchors;
  const B = finalCursor;
  const vx = B[0] - A[0], vy = B[1] - A[1];
  const len = Math.hypot(vx, vy) || 1;
  const headSize = Math.min(40, len * 0.25);
  const spread = Math.PI / 7; // ~25 degrees
  const theta = Math.atan2(vy, vx);
  const H1: [number, number] = [
    B[0] - headSize * Math.cos(theta + spread),
    B[1] - headSize * Math.sin(theta + spread)
  ];
  const H2: [number, number] = [
    B[0] - headSize * Math.cos(theta - spread),
    B[1] - headSize * Math.sin(theta - spread)
  ];
  // Single continuous polyline: shaft + head
  points = [A[0], A[1], B[0], B[1], H1[0], H1[1], B[0], B[1], H2[0], H2[1]];
}
```

### Step 4: Update Canvas.tsx Tool Instantiation

**File: `/client/src/canvas/Canvas.tsx`**

```typescript
// Get shape state from store (add after line 148)
const { activeTool, pen, highlighter, eraser, text, shape } = useDeviceUIStore();

// Update tool instantiation block (add after line 614, before "} else {")
} else if (activeTool === 'shape') {
  // Map shape variant to forced snap kind
  const variant = shape?.variant ?? 'rectangle';
  const forceSnapKind =
    variant === 'rectangle' ? 'rect' :
    variant === 'ellipse'   ? 'ellipseRect' :
    variant === 'arrow'     ? 'arrow' : 'line';

  // Use shape settings or fall back to pen settings
  const settings = shape?.settings ?? pen;

  tool = new DrawingTool(
    roomDoc,
    settings,
    'pen', // Shape tool uses pen mechanics
    userId,
    (_bounds) => overlayLoopRef.current?.invalidateAll(),
    () => overlayLoopRef.current?.invalidateAll(),
    () => viewTransformRef.current,
    { forceSnapKind } // Pass forced snap configuration
  );

// Add 'shape' to dependency array (line 678-690)
}, [
  roomDoc,
  userId,
  activeTool,
  pen,
  highlighter,
  eraser,
  text,
  shape, // ADD THIS
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor,
]);
```

### Step 5: Extend Perfect Shape Preview Renderer

**File: `/client/src/renderer/layers/perfect-shape-preview.ts`**

```typescript
// Add after line 30 (after line anchor check)
if (anchors.kind === 'arrow') {
  // Arrow: shaft from A to cursor plus dynamic arrowhead
  const { A } = anchors;
  const B = cursor;

  // Draw shaft
  ctx.beginPath();
  ctx.moveTo(A[0], A[1]);
  ctx.lineTo(B[0], B[1]);
  ctx.stroke();

  // Draw arrowhead
  const vx = B[0] - A[0], vy = B[1] - A[1];
  const len = Math.hypot(vx, vy) || 1;
  const headSize = Math.min(40, len * 0.25);
  const spread = Math.PI / 7;
  const theta = Math.atan2(vy, vx);

  ctx.beginPath();
  ctx.moveTo(B[0], B[1]);
  ctx.lineTo(
    B[0] - headSize * Math.cos(theta + spread),
    B[1] - headSize * Math.sin(theta + spread)
  );
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(B[0], B[1]);
  ctx.lineTo(
    B[0] - headSize * Math.cos(theta - spread),
    B[1] - headSize * Math.sin(theta - spread)
  );
  ctx.stroke();

  return;
}

  if (anchors.kind === 'rect') {
    // Corner-anchored rectangle (A = fixed corner, C = cursor/opposite)
    const { A } = anchors;
    const C = cursor;
    const B: [number, number] = [C[0], A[1]];
    const D: [number, number] = [A[0], C[1]];

    ctx.beginPath();
    ctx.moveTo(A[0], A[1]);
    ctx.lineTo(B[0], B[1]);
    ctx.lineTo(C[0], C[1]);
    ctx.lineTo(D[0], D[1]);
    ctx.closePath();
    ctx.stroke();
  }

// Add after circle check (line 40)
if (anchors.kind === 'ellipseRect') {
  // Corner-anchored ellipse inscribed in AABB
  const { A } = anchors;
  const C = cursor;
  const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
  const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max(0.0001, (maxX - minX) / 2);
  const ry = Math.max(0.0001, (maxY - minY) / 2);

  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  return;
}
```

## Key Implementation Notes

### Shape Behavior Differences
- **Hold-detected shapes** (existing): Center-anchored, require 600ms dwell
- **Dedicated shape tools** (new): Corner-anchored, immediate preview on pointer-down

### Anchor Semantics
- `rect` and `ellipseRect`: Point A is the fixed corner, cursor defines opposite corner
- `arrow` and `line`: Point A is the start, cursor defines the end
- `circle` (hold-detected): Center is fixed, cursor defines radius
- `box` (hold-detected): Center is fixed, cursor scales X/Y axes

### Polyline Generation
All shapes convert to polylines at commit time:
- **Rectangle**: 5 points (closed)
- **Ellipse**: Adaptive point density based on perimeter
- **Arrow**: 5 points (shaft + two head segments)
- **Line**: 2 points

### Preview Flow
1. Pointer down → DrawingTool seeds snap immediately (no hold)
2. Pointer move → Updates liveCursorWU, requests overlay frame
3. Overlay renders preview from anchors + cursor
4. Pointer up → Generates polyline, commits as regular stroke

## Migration Notes
The existing perfect shape detection (hold-to-snap) remains completely untouched. The new shape tools are additive and use a parallel code path through the same DrawingTool infrastructure.