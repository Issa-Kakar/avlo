**CONTEXT FOR PERFECT SHAPES**:
## Existing Perfect Shapes implementation: Core Behavior & User Experience

### What Users Experience

1. **Draw and Dwell**: Draw normally, then hold still for 600ms to trigger recognition
2. **Shape Competition**: Circle and rectangle are tested; if neither reaches confidence (0.58), fallback to line
3. **Snap Lock**: Once snapped, tool locks to that shape until pointer-up (no escape to freehand)
4. **Geometry Refinement**: After snap, drag pointer to adjust:
   - **Circle**: Radius follows cursor (center fixed)
   - **Rectangle**: Scales along X/Y axes independently (center fixed, always axis-aligned)
   - **Line**: Endpoint follows cursor (start point fixed)
5. **Commit**: Release pointer to commit perfect shape as regular stroke

### Shape Recognition Triggers

**Successful Snap Occurs When:**
- Circle or rectangle scores ≥ 0.58 confidence
- OR fallback to line (unless ambiguous)

**No Snap (Continue Freehand) When:**
- Any shape scores in [0.48, 0.58) - "near miss"
- Rectangle wins but has <2 right angles
- Circle wins but ≥1 right angles detected
- >4 right angles detected
- Self-intersection detected
- Near-closure detected (gap <6% of diagonal)
- Near self-touch detected

---

## Technical Pipeline

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

---

**NEW TOOLS: RECTANGLE, ELLIPSE, LINE, ARROW**
- Use existing infastructure
- chosen straight from toolbar
- first pointer down is the "anchor" drag to scale and stretch, commit on pointer up, no hold detector for this(not live perfect shape recognition, this is a dedicated tool for rectangles, ellipses, lines and arrows. The previous perfect shape detector is still untouched for live perfect shape recognition after hold)

- both **Rectangle** *and* **Ellipse** should be **corner-anchored** (first click “glues” a corner A; your cursor defines the opposite corner; we preview/commit from that AABB). We’ll keep your existing **hold-to-perfect** flow untouched (center-anchored `box` for rectangle, circle, line), and add **two new kinds** for the Shape tool:

* `rect` — corner-anchored AABB rectangle (new)
* `ellipseRect` — corner-anchored ellipse inscribed in that AABB (new)

We still reuse your current pipeline: Canvas instantiates `DrawingTool` once, the tool exposes `getPreview()`, the overlay draws the perfect shape preview, and `end()` commits a polyline.  


# The idea in one sentence

Reuse DrawingTool but allow it to start in “already snapped” mode, with the first pointer-down acting as the anchor for your chosen shape. From there, the existing perfect-shape preview runs immediately (no hold), and on pointer-up you commit as a regular stroke—just like your current hold-to-shape flow. This plugs straight into your overlay preview + commit pipeline.
Why this fits your architecture

You already generate a PerfectShapePreview (anchors + live cursor) and commit a polyline from it; we’ll just seed the snap at begin() instead of after a hold.
The overlay loop already pulls the preview from the active tool and draws the perfect shape; we’ll keep that contract.

Below are **unified diffs** touching only what’s needed:

---

1) Add a “Shape” tool mode to the UI store

Give the toolbar a single “Shape” tool with a variant:

// device-ui-store.ts
type ShapeVariant = 'line' | 'rectangle' | 'ellipse' | 'arrow';

interface DeviceUIState {
  activeTool: 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'shape';
  shape: { variant: ShapeVariant };
  // ...
}


In the toolbar, selecting a shape sets:

set({ activeTool: 'shape', shape: { variant: 'ellipse' } });

## 1) `/client/src/lib/tools/types.ts` — add `rect` and `ellipseRect`

```diff
diff --git a/client/src/lib/tools/types.ts b/client/src/lib/tools/types.ts
@@
-export type PerfectShapeAnchors =
-  | { kind: 'line';    A: [number, number] }
-  | { kind: 'circle';  center: [number, number] }
-  | { kind: 'box';     cx: number; cy: number; angle: number; hx0: number; hy0: number };
+export type PerfectShapeAnchors =
+  | { kind: 'line';        A: [number, number] }
+  | { kind: 'circle';      center: [number, number] }
+  | { kind: 'box';         cx: number; cy: number; angle: number; hx0: number; hy0: number } // legacy perfect rectangle (center)
+  | { kind: 'rect';        A: [number, number] }                                             // NEW corner-anchored AABB rectangle
+  | { kind: 'ellipseRect'; A: [number, number] }                                             // NEW corner-anchored ellipse (AABB)
+  | { kind: 'arrow';       A: [number, number] };
 
 export interface PerfectShapePreview {
   kind: 'perfectShape';
-  shape: 'line' | 'circle' | 'box';
+  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow';
   color: string;
   size: number;
   opacity: number;
   anchors: PerfectShapeAnchors;
   cursor: [number, number];
   bbox: null;
 }
```

Why safe: your preview already discriminates on `anchors.kind` and draws each shape; we’re just widening the union. 

---
2) Teach Canvas.tsx to instantiate DrawingTool for shapes

Keep your single branch point in Canvas (no explosion of tool classes): when activeTool === 'shape', create a DrawingTool with a small “forced snap” option so the tool starts snapped on pointer-down. Canvas already routes the preview to the overlay loop via setPreviewProvider, so this is plug-and-play.

## 2) `/client/src/canvas/Canvas.tsx` — map toolbar “Rectangle/Ellipse” → forced kinds

```diff
diff --git a/client/src/canvas/Canvas.tsx b/client/src/canvas/Canvas.tsx
@@
-    } else if (activeTool === 'pen' || activeTool === 'highlighter') {
+    } else if (activeTool === 'pen' || activeTool === 'highlighter') {
       // (existing DrawingTool instantiation for freehand)
@@
-    } else if (activeTool === 'shape') {
-      const variant = shape?.variant ?? 'rectangle'; // 'rectangle'|'ellipse'|'line'|'arrow'
+    } else if (activeTool === 'shape') {
+      const variant = shape?.variant ?? 'rectangle'; // 'rectangle'|'ellipse'|'line'|'arrow'
+      // NEW: both rectangle and ellipse are CORNER-anchored (AABB)
+      const forceSnapKind =
+        variant === 'rectangle' ? 'rect' :
+        variant === 'ellipse'   ? 'ellipseRect' :
+        variant === 'arrow'     ? 'arrow' : 'line';
 
       const settings = pen; // or a dedicated 'shape' style if desired
       tool = new DrawingTool(
         roomDoc,
         settings,
         'pen',
         userId,
         (_b) => overlayLoopRef.current?.invalidateAll(),
         () => overlayLoopRef.current?.invalidateAll(),
         () => viewTransformRef.current,
-        { forceSnapKind }
+        { forceSnapKind }
       );
     }
@@
-    // Set preview provider on overlay loop (both tools implement getPreview())
+    // Set preview provider on overlay loop (all tools implement getPreview())
     if (!isMobile && overlayLoopRef.current) {
       overlayLoopRef.current.setPreviewProvider({
         getPreview: () => {
           if (suppressToolPreviewRef.current) return null;
           return tool?.getPreview() || null;
         },
       });
     }
```

This preserves your “branch once” pattern and existing overlay preview routing. 

---

## 3) `/client/src/lib/tools/DrawingTool.ts` — seed `rect` / `ellipseRect` on down; commit both

### Context: your tool already has (a) **hold → snap** (center-anchored `box`/`circle`/`line`), (b) **overlay preview** from `getPreview()`, and (c) **polyline commit** on `end()`. We reuse all of that and only add new snap kinds + commit math.  

```diff
diff --git a/client/src/lib/tools/DrawingTool.ts b/client/src/lib/tools/DrawingTool.ts
@@
   private snap:
       | null
       | (
         | { kind: 'line';   anchors: { A: [number, number] } }
         | { kind: 'circle'; anchors: { center: [number, number] } }
-        | { kind: 'box';    anchors: { cx: number; cy: number; angle: number; hx0: number; hy0: number } }
+        | { kind: 'box';    anchors: { cx: number; cy: number; angle: number; hx0: number; hy0: number } } // legacy perfect-rect (center)
+        | { kind: 'rect';   anchors: { A: [number, number] } }                                              // NEW corner-anchored AABB
+        | { kind: 'ellipseRect'; anchors: { A: [number, number] } }                                         // NEW corner-anchored ellipse
+        | { kind: 'arrow';  anchors: { A: [number, number] } }
       ) = null;
@@
-  constructor(
+  type ForcedKind = 'line'|'circle'|'box'|'rect'|'ellipseRect'|'arrow';
+  constructor(
     room: IRoomDocManager,
     settings: ToolSettings,
     toolType: 'pen' | 'highlighter',
     userId: string,
     onInvalidate?: (bounds: [number, number, number, number]) => void,
     requestOverlayFrame?: RequestOverlayFrame,
-    getView?: () => ViewTransform
+    getView?: () => ViewTransform,
+    opts?: { forceSnapKind?: ForcedKind }
   ) {
@@
-    this.hold = new HoldDetector(() => this.onHoldFire());
+    this.hold = new HoldDetector(() => this.onHoldFire());
+    this.opts = opts ?? {};
     this.resetState();
   }
+  private opts: { forceSnapKind?: ForcedKind } = {};
@@
   begin(pointerId: number, worldX: number, worldY: number): void {
     this.startDrawing(pointerId, worldX, worldY);
 
-    // NEW: Start hold detector in SCREEN px
-    if (this.getView) {
-      const [sx, sy] = this.getView().worldToCanvas(worldX, worldY);
-      this.hold.start({ x: sx, y: sy });
-    }
-
-    // Reset snap state for new gesture
-    this.snap = null;
-    this.liveCursorWU = [worldX, worldY];
-    this.requestOverlayFrame?.(); // draw first frame
+    // If the Shape tool asked us to force a perfect shape, seed snap immediately.
+    if (this.opts.forceSnapKind) {
+      const k = this.opts.forceSnapKind;
+      this.snap =
+        k === 'line'        ? { kind: 'line',        anchors: { A: [worldX, worldY] } }
+      : k === 'circle'      ? { kind: 'circle',      anchors: { center: [worldX, worldY] } }
+      : k === 'box'         ? { kind: 'box',         anchors: { cx: worldX, cy: worldY, angle: 0, hx0: 0.5, hy0: 0.5 } }
+      : k === 'rect'        ? { kind: 'rect',        anchors: { A: [worldX, worldY] } }            // corner-anchored rect
+      : k === 'ellipseRect' ? { kind: 'ellipseRect', anchors: { A: [worldX, worldY] } }            // corner-anchored ellipse
+      : /* arrow */           { kind: 'arrow',       anchors: { A: [worldX, worldY] } };
+      this.liveCursorWU = [worldX, worldY];
+      this.requestOverlayFrame?.(); // snap preview immediately
+      return; // skip HoldDetector in forced mode
+    }
+
+    // Freehand (unchanged): start HoldDetector in SCREEN px
+    if (this.getView) {
+      const [sx, sy] = this.getView().worldToCanvas(worldX, worldY);
+      this.hold.start({ x: sx, y: sy });
+    }
+    this.snap = null;
+    this.liveCursorWU = [worldX, worldY];
+    this.requestOverlayFrame?.();
   }
@@
   private commitPerfectShapeFromPreview(): void {
     if (!this.snap || !this.liveCursorWU) return;
-    let points: number[];
+    let points: number[] = [];
     const finalCursor = this.liveCursorWU!;
 
     if (this.snap.kind === 'line') {
       const { A } = this.snap.anchors;
       const B = finalCursor;
       points = [A[0], A[1], B[0], B[1]];
 
     } else if (this.snap.kind === 'circle') {
       const { center } = this.snap.anchors;
       const r = Math.hypot(finalCursor[0] - center[0], finalCursor[1] - center[1]);
       const n = Math.max(24, Math.ceil(2 * Math.PI * r / 8));
-      points = [];
       for (let i = 0; i <= n; i++) {
         const angle = (i / n) * 2 * Math.PI;
         points.push(center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle));
       }
 
-    } else {  // box
+    } else if (this.snap.kind === 'box') {  // hold detector perfect-rect (center)
       const { cx, cy, angle, hx0, hy0 } = this.snap.anchors;
       const dx = finalCursor[0] - cx;
       const dy = finalCursor[1] - cy;
       const cos = Math.cos(angle), sin = Math.sin(angle);
       const localX =  dx *  cos + dy *  sin;
       const localY = -dx *  sin + dy *  cos;
       const sx = Math.max(0.0001, Math.abs(localX) / Math.max(1e-6, hx0));
       const sy = Math.max(0.0001, Math.abs(localY) / Math.max(1e-6, hy0));
       const hx = hx0 * sx;
       const hy = hy0 * sy;
       const corners = [[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy],[-hx,-hy]];
-      points = [];
       for (const [lx, ly] of corners) {
         points.push(
           cx + lx * cos - ly * sin,
           cy + lx * sin + ly * cos
         );
       }
+    } else if (this.snap.kind === 'rect') {
+      // Shape tool "Rectangle": Corner-anchored AABB rectangle: A is fixed corner; cursor defines opposite corner
+      const { A } = this.snap.anchors;
+      const C = finalCursor;
+      const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
+      const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
+      // Polyline: A -> (maxX,minY) -> (maxX,maxY) -> (minX,maxY) -> A
+      points.push(
+        A[0], A[1],
+        maxX, minY,
+        maxX, maxY,
+        minX, maxY,
+        A[0], A[1]
+      );
+    } else if (this.snap.kind === 'ellipseRect') {
+      // Corner-anchored ellipse: inscribed in AABB from A to cursor
+      const { A } = this.snap.anchors;
+      const C = finalCursor;
+      const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
+      const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
+      const cx = (minX + maxX) / 2;
+      const cy = (minY + maxY) / 2;
+      const rx = Math.max(0.0001, (maxX - minX) / 2);
+      const ry = Math.max(0.0001, (maxY - minY) / 2);
+      const perim = Math.PI * (3*(rx+ry) - Math.sqrt((3*rx+ry)*(rx+3*ry)));
+      const n = Math.max(24, Math.ceil(perim / 8));
+      for (let i = 0; i <= n; i++) {
+        const t = (i / n) * 2 * Math.PI;
+        points.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
+      }
+    } else if (this.snap.kind === 'arrow') {
+      const { A } = this.snap.anchors;
+      const B = finalCursor;
+      const vx = B[0] - A[0], vy = B[1] - A[1];
+      const len = Math.hypot(vx, vy) || 1;
+      const head = Math.min(40, len * 0.25);
+      const spread = Math.PI / 7;
+      const theta = Math.atan2(vy, vx);
+      const H1: [number,number] = [B[0] - head * Math.cos(theta + spread), B[1] - head * Math.sin(theta + spread)];
+      const H2: [number,number] = [B[0] - head * Math.cos(theta - spread), B[1] - head * Math.sin(theta - spread)];
+      // Single polyline: A -> B -> H1 -> B -> H2
+      points.push(A[0],A[1], B[0],B[1], H1[0],H1[1], B[0],B[1], H2[0],H2[1]);
     }
 
     // One-time bbox + Yjs commit (unchanged)
     const bbox = calculateBBox(points, this.state.config.size);
     // ... size checks + ydoc mutate + invalidate + reset (existing)
   }
```

* `begin()` continues to start the **hold detector** for freehand so your perfect-shape snap still works as before; shape tool bypasses it and seeds `snap` immediately. 
* `getPreview()` already emits `{ kind:'perfectShape', shape: this.snap.kind, ... }`, so overlay picks it up with no new plumbing. 
* Commit path remains your **regular stroke** commit with one-time bbox. 

---

## 4) `/client/src/renderer/layers/perfect-shape-preview.ts` — preview `rect` and `ellipseRect`

Your current renderer draws **line / circle / box** from anchors + cursor; we add two cases. 

```diff
diff --git a/client/src/renderer/layers/perfect-shape-preview.ts b/client/src/renderer/layers/perfect-shape-preview.ts
@@
   if (anchors.kind === 'line') {
@@
   }

+  if (anchors.kind === 'arrow') {
+    // Arrow: shaft A->cursor plus a live arrowhead
+    const { A } = anchors;
+    const B = cursor;
+    // Shaft
+    ctx.beginPath();
+    ctx.moveTo(A[0], A[1]);
+    ctx.lineTo(B[0], B[1]);
+    ctx.stroke();
+    // Head (two legs)
+    const vx = B[0] - A[0], vy = B[1] - A[1];
+    const len = Math.hypot(vx, vy) || 1;
+    const ux = vx / len,  uy = vy / len;
+    const head = Math.min(40, len * 0.25);
+    const spread = Math.PI / 7;
+    const theta = Math.atan2(uy, ux);
+    const ang1 = theta + spread, ang2 = theta - spread;
+    for (const ang of [ang1, ang2]) {
+      ctx.beginPath();
+      ctx.moveTo(B[0], B[1]);
+      ctx.lineTo(B[0] - head * Math.cos(ang), B[1] - head * Math.sin(ang));
+      ctx.stroke();
+    }
+    return;
+  }

+  if (anchors.kind === 'rect') {
+    // Corner-anchored AABB rectangle: first click A is glued, cursor defines opposite corner
+    const { A } = anchors;
+    const C = cursor;
+    const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
+    const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
+    ctx.beginPath();
+    ctx.moveTo(A[0], A[1]);
+    ctx.lineTo(maxX, minY);
+    ctx.lineTo(maxX, maxY);
+    ctx.lineTo(minX, maxY);
+    ctx.closePath();
+    ctx.stroke();
+    return;
+  }
+
   if (anchors.kind === 'circle') {
@@
   }
 
+  if (anchors.kind === 'ellipseRect') {
+    // Corner-anchored ellipse: inscribed in AABB from A to cursor
+    const { A } = anchors;
+    const C = cursor;
+    const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
+    const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
+    const cx = (minX + maxX) / 2;
+    const cy = (minY + maxY) / 2;
+    const rx = Math.max(0.0001, (maxX - minX) / 2);
+    const ry = Math.max(0.0001, (maxY - minY) / 2);
+    ctx.beginPath();
+    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
+    ctx.stroke();
+    return;
+  }
+
   // Box (legacy perfect rectangle): center + half-extents + angle
   const { cx, cy, angle, hx0, hy0 } = anchors;
@@
   ctx.stroke();
```

—

### Event flow check (with your existing pipeline)

* **PointerDown** (Shape→Rectangle/Ellipse): `DrawingTool.begin()` seeds `snap={kind:'rect'|'ellipseRect', anchors:{A:[x0,y0]}}` and starts preview immediately. (Freehand still starts hold detector as before.) 
* **PointerMove**: while snapped, tool updates `liveCursorWU` and requests an overlay frame; overlay pulls `getPreview()` and draws `rect` or `ellipseRect` from **AABB(A,cursor)** (barely visible on tiny motion, “stretchy” as you drag).  
* **PointerUp**: `commitPerfectShapeFromPreview()` converts the preview to a polyline (rectangle corners or discretized ellipse), computes bbox once, and commits to Yjs — exactly like your current perfect shapes. 

Nothing else changes: base/overlay loops, preview provider, one-time bbox at commit, scene ticks, etc., remain intact. 



End result: users can pick any of the 4 from the toolbar, as soon as pointer down->anchor point for all the shapes, then, while still pointer down-> up, down, left right, all scales and stretches, ellipses and rectangles do not anchor via center. the anchor point is the first pointer down, you are "glued". similar to tldrw, excalidraw, etc. 