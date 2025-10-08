**GOAL**: ADD PERFECT FREEHAND LIBRARY FOR RENDERING FREEHAND(NON-SHAPE) STROKES
- CURRENT RDP SIMPLIFICATION RUNS ONLY ON COMMIT, NOT PREVIEW, AND AGGRESSIVLEY SIMPLIFIES LEADING TO JAGGED EDGES ON HIGH ZOOM
- FOR PREVIEW AND STROKE RENDERING, ADDING PERFECT FREEHAND WILL SMOOTH AND ACCOUNT FOR JITTER, LEADING TO MUCH BETTER VISUAL APPEARANCE
- PERFECT SHAPES ARE TRIGGERED BY "SNAP" IN DRAWINGTOOL.TS. IF SNAPPED, THE PERFECT SHAPE PREVIEW WILL HANDLE IT AS A FINE AS IS. ON COMMIT, WE KEEP THE STROKE COMMIT PATHS SEPERATE.

alright, here’s a systematic take and a concrete plan so you can move fast without breaking visual parity or perf.

# tl;dr (what I recommend)

* **Freehand:** keep storing a simplified **centerline** (RDP on commit), but **render with Perfect Freehand (PF) polygons** in both preview and commit. Disable pressure/thinning; use fixed width; `smoothing=0.5`, `streamline=0.5`. Cache PF **Path2D (filled)** per stroke.
* **Perfect shapes (snap):** **keep current polyline commit + stroke render** for now (preview=commit), no Perfect Freehand pass on shapes for either.
* **Cache:** replace the fragile FIFO with an **ID-keyed LRU** that caches either (a) polyline Path2D or (b) PF polygon Path2D. Add **selective invalidation by IDs**.
* **No preview/commit mismatch:** preview uses PF and, on `last=true` from PF, the committed render uses the **same PF options** → identical visuals.
* **Background fills:** freehand “stroke background fill” becomes trivial (you already have a polygon). Shapes will get dedicated fill logic later (geometry-based, not PF).

Below I walk through the tradeoffs, then list the exact code changes and a phased rollout.

---

## 1) Why PF-for-rendering on freehand fixes the jaggies (and why to keep RDP at commit)

**What causes the jaggies now?** At high zoom, an RDP’d polyline is still a polyline; antialiasing exposes segment joins and small heading changes. You preview with a smooth-ish line, then commit to a simplified polyline that renders with `ctx.stroke()`, so zoomed-in edges look jagged.

**Fix:** Keep the **centerline** as the source of truth (small, robust, easy to edit and diff), but **render an outline polygon** via PF and **fill it**. Filled polygons AA much more gracefully than stroked polylines, and you get consistent geometry for “fixed-width” pen with rounded caps—exactly what PF synthesizes from the centerline.

**Preview parity:** Use PF in the **preview layer** too, with the same config as commit. When the pointer ends, pass PF the “last”/“isComplete” flag so the final polygon is identical between preview and commit. This aligns perfectly with your two-canvas architecture where overlay (preview) is ephemeral and base canvas is event-driven; you’re already set up to do this without a driven loop on the base canvas. 

**Why still run RDP at commit?**

* You want the persisted data to remain compact and bounded (10k points / 128KB caps). RDP is already a commit-time operation in your pipeline; keep it. 
* PF runs at **render** time from the simplified centerline. This gives stable performance (Path2D built once, then reused) and future-proofs editing since the centerline remains the canonical, editable representation. 

---

## 2) Perfect shapes: PF or not?

**Right now:** You commit perfect shapes as **polylines** and render with `ctx.stroke()`; previews compute geometry on-the-fly from anchors + cursor. That system is solid and visually crisp (geometric primitives), and you want to keep it. 

**Should we PF shapes on commit?**

* If we PF a rectangle/circle polyline, we’ll synthesize a rounded-thickness polygon. That’s different from the current “mathematically perfect perimeter with a stroked width.”
* With your proposed PF settings (no pressure, no thinning, 0.5/0.5), **differences will be small but visible** at corner/cap details and at very high zoom (PF creates rounded caps/joins as a filled outline, `ctx.stroke()` conforms to canvas joins/caps).
* Given you plan *shape fills* later (true interiors, not stroked borders), it’s cleaner to keep **shapes as shapes** (geometric stroke + geometric fill later), and keep **freehand as PF polygons**. That yields two clean rendering modes:

  * **Freehand strokes:** *fill PF polygon* (and optionally stroke its outline if you want an edge).
  * **Perfect shapes:** *stroke the shape path* today; later *fill the geometry* with true interior fills (rect, ellipse, etc.), independent of PF.

**Decision:** **Do not PF shapes on commit (yet)**. Keep preview=commit for shapes (your current behavior). Revisit only when you add shape fills and want “uniform stroke-as-fill” visuals across tools.

---

## 3) Single vs dual-pass rendering (and “stroke background fills”)

* **Freehand:** With PF, you inherently have a *closed polygon*. Filling it is a **single pass** (`ctx.fill(polygonPath)`). If you also want an outline, that’s a **second pass** (`ctx.stroke(outlinePath)`), but most pens/highlighters won’t need it.
* **Shapes:** Today they are stroked polylines. Later, when you add **shape interior fills**, that’s **two passes** (fill geometry first, then stroke). That’s normal and efficient; you don’t need PF here.
* **Efficiency:** Two passes for shapes are cheap in your **event-driven + dirty-rect** architecture, and you’re caching Path2D anyway. A dual-pass for shapes won’t be a bottleneck, especially with per-stroke Path2D caching and partial clears. 

**Conclusion:** **No dual-pass for freehand unless you want an outline.** For shapes, a dual-pass (fill + stroke) is expected and fine when you add shape fills.

---

## 4) Cache: from fragile to LRU with ID-keyed invalidation

You already build per-stroke render artifacts (Path2D, Float32Array) and amortize cost across frames; cache is ID-keyed and cleared on scene changes. The doc shows a FIFO of 1000 entries and mentions future single-stroke invalidation (deletion). That’s close to what you want. 

**What to change:**

1. **LRU instead of FIFO:** Evict least-recently-used entries to retain “hot” strokes longer in large scenes. This improves stability when panning/zooming around big boards.
2. **Entry structure must support polygons:**

   ```ts
   type StrokeRenderData =
     | { kind: 'polyline', path: Path2D, polyline: Float32Array, bounds: BBox, pointCount: number }
     | { kind: 'polygon',  path: Path2D, polygon: Float32Array,  bounds: BBox, pointCount: number };
   ```

   * For freehand: build **PF polygon** and `Path2D` from it; render via `ctx.fill(path)`.
   * For shapes: build **polyline `Path2D`**; render via `ctx.stroke(path)`.
3. **ID-keyed invalidation:** Extend your snapshot diff to hand **changedIDs** to `CanvasStage.tsx`. When a stroke’s points/style change (or on delete), call `strokeCache.invalidate(id)`. (Your doc already shows a placeholder for single-stroke invalidation.) 
4. **Scene change:** continue to nuke the cache wholesale on scene flips; you already do this. 

**Why this works well here:**

* Your **strokes are immutable post-commit** today, so cache churn is naturally low. Later, when you add resize/recolor/move, you’ll pass changed IDs up so we can invalidate those entries. This matches your event-driven render and dirty-rect model perfectly. 

---

## 5) Preview/commit parity details (no visual mismatch)

* **Overlay (preview):** use PF with fixed-width config. On each RAF you compute the PF outline from the live centerline buffer and draw it on the overlay canvas.
* **Commit:** you already **flush pending points**, **run RDP once**, then mutate Yjs. Keep that. On the **base canvas**, the stroke renderer will **build (or fetch) the PF polygon Path2D** and **fill** it. Since both preview and commit use **identical PF options**, and you mark PF with `last=true` at pointer-up, the visuals match. Your overlay loop already has the “hold for one frame” on commit to avoid flicker; parity improves further with PF on both sides. 

---

## 6) Will rendering a perfect shape with PF be noticeable?

Short answer: **yes, a little**—rounded cap/joins and tiny curvature differences—especially at corners and at very high zoom. With your 0.5/0.5 smoothing/streamline, the differences are **modest** but **visible** compared to “perfect geometry + `ctx.stroke()`.” If you want to quantify this before deciding to ever PF shapes:

* **Dev-only toggle**: “Render shapes with PF” (off by default).
* **Metric:** compute 2D Hausdorff distance between the shape polyline stroke outline and the PF polygon. Gate on a threshold measured in **screen pixels** at typical zoom (e.g., ≤0.75 px mean, ≤2 px max).
* If it passes your taste test, you *could* unify later—but right now I’d keep shapes as pure geometry.

---

## 7) Future: shape fills, lasso/select, resizing, moving, background fill

These features imply **mutability** of shape objects (size, fill) and selection transforms. The plan above anticipates that:

* **Cache invalidation by ID** handles style/geometry edits.
* **Background fill for shapes**: just fill the *geometric interior* (rect, circle, ellipse) using **their own geometry**, not PF.
* **Lasso/select + resize/move**: once a shape’s points/bbox change, you’ll push its ID into the altered set; `CanvasStage.tsx` does id-keyed invalidation and the dirty-rect tracker confines redraws. Your event-driven renderer and dirty rectangles are explicitly designed for this sort of targeted invalidation.  

---

## 8) Performance considerations

* **PF cost** is O(n) on the simplified centerline; you amortize with **Path2D caching** (build once per stroke per scene). After that, fills are cheap.
* **Dirty-rects + event-driven loop** keep redraw work bounded to changed regions; transform changes trigger **full clears** by design (simple & fast). 
* **Typed arrays at render time only**: keep persisting `number[]` in Yjs; build `Float32Array` when constructing PF input / Path2D. This matches your current snapshot/renderer separation. 
* **LRU size:** keep ~1k–4k entries depending on memory target; your hit rate will be excellent for visible content, and your two-canvas scheme avoids unnecessary rebuilds. 

---

## 9) Concrete changes (file-by-file checklist)

**A. Types / models**

* Add `RenderMode` to stroke view or infer from tool:

  * freehand → `renderMode: 'polygonFill'`
  * shape → `renderMode: 'polylineStroke'`
* Extend cache entry union to support `polygon` variant (see §4).

**B. Preview (overlay)**

* `drawPreview` for freehand → compute PF polygon from live points; `ctx.fill` (no stroke).
* When preview finalizes (pointer-up), call PF with `last=true` (or equivalent flag) to ensure parity.

**C. Commit path**

* Keep **RDP** at pointer-up (you already do this); store simplified **centerline**. 
* Compute bbox from PF or from centerline inflated by half-width; pick one consistently.

**D. Base renderer (strokes layer)**

* When `renderMode==='polygonFill'`:

  * Cache lookup builds or returns **PF polygon Path2D**; `ctx.fill(path)`.
* When `renderMode==='polylineStroke'` (shapes):

  * Build/return **polyline Path2D**; `ctx.stroke(path)`.
* Respect opacity pipeline (same as today).

**E. Cache**

* Swap FIFO for **LRU**; add `invalidate(id)` and `invalidateMany(ids: string[])`.
* On snapshot diff, gather changed IDs alongside bounds; call `strokeCache.invalidateMany(changedIds)`. Your diff already enumerates changed/deleted strokes; add the ID list to the canvas invalidation dispatch. 

**F. Canvas invalidation**

* Keep current **dirty-rect** behavior (world→CSS→device, inflate for AA).
* On content change: in addition to pushing bounds to the dirty tracker, **pass changed IDs** to the renderer so it can drop stale cache entries before drawing. 

**G. Tooling flags**

* PF config object (fixed width, no pressure/thinning) centralized and shared by preview+commit renderers.
* Dev flag: “Render shapes with PF” (off by default).

---

## 10) Risks & mitigations

* **PF visual drift vs shapes:** We’re avoiding it by not PF-ing shapes now. Future unification is optional and test-gated.
* **Memory growth:** LRU prevents unbounded cache; full clear on scene change already in place. 
* **BBox consistency:** If fills come from PF polygons, ensure bbox inflation matches PF geometry to avoid redraw seams.
* **Hit-testing (future eraser/lasso):** Keep using the centerline (and/or existing spatial index) for hits; you don’t need PF polygons for hit-tests. The centerline is faster to query.

---

## 11) Answering your two unknowns explicitly

1. **“Will rendering a perfect shape on commit be noticeable if it’s PF?”**
   Yes, a bit—especially at corners and high zoom. With 0.5/0.5 it’s subtle but **still visible**. I recommend **don’t PF shapes** now. Add a dev toggle to evaluate later.

2. **“Is a dual-pass render for shapes efficient, and does it make stroke background fills easier?”**
   Dual-pass (fill then stroke) on shapes is **efficient** in your architecture (cached Path2D, event-driven, dirty rects). For **freehand stroke backgrounds**, PF polygons already give you a **one-pass fill**; for **shape backgrounds**, use their **geometric fill** (no PF needed). So: dual-pass is fine for shapes when you add fills; freehand doesn’t need it.

---

## 12) Rollout plan (incremental, safe)

**Phase 1 (freehand parity & perf)**

* Add PF in preview (fixed width, no pressure)
* Add PF in base renderer for freehand (renderMode polygonFill)
* Introduce LRU cache + polygon entries
* Keep shapes unchanged
* ID-keyed invalidation plumbing (diff → canvas → cache.invalidateMany)


**FUTURE(NOT IN THIS TASK)**
* Begin background fill for freehand (already trivial with PF polygons)
* Add geometric fills for shapes (fill + stroke dual-pass)
* Lasso/select/resize/move; on edit, emit changed IDs for invalidation

---

If you want, I can sketch the cache interface and draw loop diffs next. But from an architecture standpoint, the plan above aligns cleanly with your **two-canvas** preview/commit model, **commit-time RDP**, **event-driven renderer**, and **Path2D caching with ID-keyed invalidation**—so you get smooth visuals at high zoom, preview=commit parity, and a cache that’s ready for mutability and fills.   


got it. here’s a thorough, file-by-file plan to land the “PF-for-freehand (fixed-width), shapes stay polyline; preview=commit parity; two-pass pipeline (polygon fill for freehand + polyline stroke for shapes); cache infra ready for later invalidation”—without getting ahead of ourselves on lasso or mutation.

i’m anchoring this to your current data flow, overlay loop, and stroke cache as documented, so the diffs drop in cleanly.

---

# Core invariants we will preserve

* **Two-canvas architecture:** base canvas is event-driven + dirty rects; overlay canvas draws preview every frame. 
* **Pointer stream → RAF-coalesced buffer → preview:** we keep the same coalescing mechanism and bounds invalidation for overlay. 
* **Commit path:** pointer-up → flush pending → RDP simplify → Yjs append → snapshot → base-canvas render. Points stay as `number[]` in Yjs (typed arrays only at render).   
* **Base render order and dirty-rect logic** remain unchanged.  

---

# What changes conceptually

* **Freehand (pen/highlighter)**

  * **Preview:** draw with Perfect Freehand (PF) **polygon** on overlay (fixed width; no pressure/thinning).
  * **Commit:** still store **simplified centerline** (RDP) as points, but **render** on base canvas by computing a **PF polygon** from the centerline and **filling** it (Path2D cached).
* **Perfect shapes (snap via hold or shape tool)**

  * **Preview:** keep the existing “perfect shape preview” (geometry-derived).
  * **Commit:** keep **polyline stroke render** (what you have now).
* **Two-pass overall:** In practice you’ll see both a **polygon fill** pass (for freehand strokes) and a **polyline stroke** pass (for shapes). We can add “outline-then-fill” per-stroke later; for now we keep one pass per stroke type.
* **Cache:** extend the **stroke render cache** to support **polygon entries** alongside polyline, and wire in the “ID-keyed invalidation” plumb-lines without activating mutation-driven invalidation yet. 

NOTE: you don’t need to invalidate for **color/opacity** changes—ever—and you don’t need to invalidate for **polyline size** changes either. you only need to rebuild when **geometry** changes. so instead of “two caches,” keep **one LRU cache** keyed by stroke **id**, and inside each entry keep **geometry variants** (polyline vs PF polygon, and any knob that actually alters geometry). that way style-only edits reuse the same geometry, and geometry changes naturally produce (or swap to) the right variant.

here’s the reasoning and the shape of the infra so it drops cleanly into what you have.

---

# what actually forces a rebuild?

| Case                                  | Polyline (perfect shapes)                                              | PF Polygon (freehand)                        |
| ------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| **Recolor / Opacity**                 | No rebuild (Path2D is style-agnostic)                                  | No rebuild                                   |
| **Stroke width (“size”)**             | No rebuild (width is a render-state, not baked)                        | **Rebuild** (PF polygon depends on width)    |
| **Smoothing/Streamline/Thinning**     | N/A                                                                    | **Rebuild** (they change the polygon)        |
| **Fill on/off for shapes**            | Usually **no rebuild** if the path is closed; you can `ctx.fill(path)` | N/A (PF polygon is already a filled outline) |
| **Points mutate (lasso move/resize)** | **Rebuild**                                                            | **Rebuild**                                  |

You already set `strokeStyle`, `lineWidth`, and `globalAlpha` **at render time** and then call `ctx.stroke(path)`—that’s why polyline size/color don’t require new geometry; the Path2D is independent of stroke paint settings. 

---

# Detailed plan, by file (with exact responsibilities)

here’s the top-to-bottom, surgical code diff to replace “RDP stroke (stroked polyline)” with **Perfect Freehand polygon fill for freehand only** (fixed width, no thinning), keep perfect shapes as stroked polylines, and introduce the **ID-keyed LRU stroke render cache with geometry variants** so **style-only edits (color/opacity; polyline width)** don’t invalidate. This slots into your two-canvas architecture and event-driven base renderer.  

---

```diff
*** a/shared/src/types.ts
--- b/shared/src/types.ts
@@
 export interface StrokeView {
   id: StrokeId;
   points: ReadonlyArray<number>;
   style: {
     color: string;
     size: number;     // world units
     opacity: number;  // 0..1
     tool: 'pen' | 'highlighter';
   };
   bbox: [number, number, number, number];
   scene: SceneIdx;
   createdAt: number;
   userId: string;
+  /**
+   * Rendering mode:
+   *  - 'polygon-fill' for freehand (Perfect Freehand polygon, filled)
+   *  - 'polyline-stroke' for perfect/snap shapes (Path2D polyline, stroked)
+   */
+  renderMode: 'polygon-fill' | 'polyline-stroke';
 }
```

```diff
Diff — client/src/lib/tools/DrawingTool.ts

(add renderMode on commit; freehand ⇒ polygon-fill, snapped perfect-shape ⇒ polyline-stroke)

*** a/client/src/lib/tools/DrawingTool.ts
--- b/client/src/lib/tools/DrawingTool.ts
@@
   commitStroke(finalX: number, finalY: number): void {
     if (!this.state.isDrawing) return;
@@
     // Simplify FIRST, then check size
     const { points: simplified } = simplifyStroke(this.state.points, this.state.config.tool);
@@
     // Commit to Y.Doc
     const strokeId = ulid();
     const userId = this.userId; // Use stable ID stored at construction
 
     try {
       this.room.mutate((ydoc) => {
         const root = ydoc.getMap('root');
         const strokes = root.get('strokes') as Y.Array<any>;
         const meta = root.get('meta') as Y.Map<any>;
 
         // Get scene_ticks (MUST be initialized by RoomDocManager in Phase 2)
         const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
         if (!sceneTicks) {
           // This is a CRITICAL error - scene_ticks MUST be initialized in Phase 2
           console.error('CRITICAL: scene_ticks not initialized - Phase 2 implementation is broken');
           // TODO: Show user toast/banner about room metadata not initialized
           // Surface this error visibly so it's not silent
           return;
         }
 
         // Scene assigned AT COMMIT TIME
         const currentScene = sceneTicks.length;
 
         strokes.push([
           {
             id: strokeId,
             tool: this.state.config.tool, // Frozen at start
             color: this.state.config.color, // Frozen at start
             size: this.state.config.size, // Frozen at start
             opacity: this.state.config.opacity, // Frozen at start
             points: simplified, // Plain number[]
             bbox: simplifiedBbox,
             scene: currentScene,
             createdAt: Date.now(),
-            userId,
+            userId,
+            // NEW: explicit render mode for renderer/cache branching
+            // Freehand strokes render as Perfect Freehand POLYGON FILL
+            renderMode: 'polygon-fill',
           },
         ]);
       });
@@
   }
@@
   private commitPerfectShapeFromPreview(): void {
     if (!this.snap || !this.liveCursorWU) return;
@@
     // Commit as regular stroke
     const strokeId = ulid();
     this.room.mutate((ydoc) => {
       const root = ydoc.getMap('root');
       const strokes = root.get('strokes') as Y.Array<any>;
       const meta = root.get('meta') as Y.Map<any>;
       const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
       const currentScene = sceneTicks.length;
 
       strokes.push([{
         id: strokeId,
         tool: this.state.config.tool,
         color: this.state.config.color,
         size: this.state.config.size,
         opacity: this.state.config.opacity,
         points,  // Generated polyline
         bbox,    // Computed at commit
         scene: currentScene,
         createdAt: Date.now(),
-        userId: this.userId
+        userId: this.userId,
+        // NEW: explicit render mode for renderer/cache branching
+        // Perfect shapes render as STROKED POLYLINE
+        renderMode: 'polyline-stroke',
       }]);
     });
@@
   }


```diff
*** a/client/src/renderer/layers/preview.ts
--- b/client/src/renderer/layers/preview.ts
@@
-import type { PreviewData } from '@/lib/tools/types';
+import type { PreviewData } from '@/lib/tools/types';
+import getStroke from 'perfect-freehand';
+import { PF_OPTIONS_BASE } from '../stroke-builder/pf-config';
 
 /**
  * Draw preview stroke
  * CRITICAL: This is called INSIDE world transform scope
  */
 export function drawPreview(ctx: CanvasRenderingContext2D, preview: PreviewData): void {
   if (!preview || preview.points.length < 2) return;
 
   ctx.save();
-  // Apply preview styling (polyline stroke)
-  ctx.strokeStyle = preview.color;
-  ctx.lineWidth = preview.size;
-  ctx.globalAlpha = preview.opacity; // e.g. 0.35
-  ctx.lineCap = 'round';
-  ctx.lineJoin = 'round';
-
-  ctx.beginPath();
-  ctx.moveTo(preview.points[0], preview.points[1]);
-  for (let i = 2; i < preview.points.length; i += 2) {
-    ctx.lineTo(preview.points[i], preview.points[i + 1]);
-  }
-  ctx.stroke();
+  ctx.globalAlpha = preview.opacity; // opacity parity w/ commit
+
+  // Freehand (not snapped) → Perfect Freehand polygon fill
+  if (preview.kind === 'stroke' && !preview.snapActive) {
+    const poly = getStroke(preview.points, {
+      ...PF_OPTIONS_BASE,
+      size: preview.size,
+      // 'last' is false during drag; OverlayRenderLoop will "hold for one frame" after commit
+      last: false,
+    });
+
+    if (poly.length >= 2) {
+      const path = new Path2D();
+      path.moveTo(poly[0], poly[1]);
+      for (let i = 2; i < poly.length; i += 2) path.lineTo(poly[i], poly[i + 1]);
+      path.closePath();
+      ctx.fillStyle = preview.color;
+      ctx.fill(path);
+    }
+  } else {
+    // Perfect shape preview (unchanged): stroked polyline with current size/color
+    ctx.strokeStyle = preview.color;
+    ctx.lineWidth = preview.size;
+    ctx.lineCap = 'round';
+    ctx.lineJoin = 'round';
+    ctx.beginPath();
+    ctx.moveTo(preview.points[0], preview.points[1]);
+    for (let i = 2; i < preview.points.length; i += 2) ctx.lineTo(preview.points[i], preview.points[i + 1]);
+    ctx.stroke();
+  }
   ctx.restore();
 }
```

```diff
*** a/client/src/renderer/stroke-builder/path-builder.ts
--- b/client/src/renderer/stroke-builder/path-builder.ts
@@
-import type { StrokeView } from '@avlo/shared';
+import type { StrokeView } from '@avlo/shared';
+import getStroke from 'perfect-freehand';
+import { PF_OPTIONS_BASE } from './pf-config';
 
-export interface StrokeRenderData {
-  path: Path2D | null; // null when Path2D not available (tests)
-  polyline: Float32Array;
-  bounds: { x: number; y: number; width: number; height: number };
-  pointCount: number;
-}
+export type PolylineData = {
+  kind: 'polyline';
+  path: Path2D | null;
+  polyline: Float32Array;
+  bounds: { x: number; y: number; width: number; height: number };
+  pointCount: number;
+};
+
+export type PolygonData = {
+  kind: 'polygon';
+  path: Path2D | null;
+  polygon: Float32Array;
+  bounds: { x: number; y: number; width: number; height: number };
+  pointCount: number;
+};
+
+export type StrokeRenderData = PolylineData | PolygonData;
 
 /**
- * Builds render data from stroke points (polyline).
+ * Builds POLYLINE render data (for perfect/snap shapes).
  * Creates Float32Array and Path2D at render time only.
  */
-export function buildStrokeRenderData(stroke: StrokeView): StrokeRenderData {
+export function buildPolylineRenderData(stroke: StrokeView): PolylineData {
   const { points } = stroke;
   const stride = 2;
   const pointCount = Math.floor(points.length / stride);
   const polyline = new Float32Array(pointCount * 2);
   // eslint-disable-next-line @typescript-eslint/no-explicit-any
   const hasPath2D = typeof (globalThis as any).Path2D === 'function';
   const path = hasPath2D ? new Path2D() : null;
@@
-  return {
-    path,
-    polyline,
-    bounds,
-    pointCount,
-  };
+  return { kind: 'polyline', path, polyline, bounds, pointCount };
 }
 
+/**
+ * Builds PF POLYGON render data (for freehand).
+ * Uses fixed-width PF (no thinning), polygon is filled at render.
+ */
+export function buildPFPolygonRenderData(stroke: StrokeView): PolygonData {
+  const size = stroke.style.size;
+  const poly = getStroke(stroke.points, {
+    ...PF_OPTIONS_BASE,
+    size,
+    last: true, // commit-time / base-canvas build
+  }) as number[];
+
+  const pointCount = Math.floor(poly.length / 2);
+  const polygon = new Float32Array(poly.length);
+  polygon.set(poly);
+
+  // eslint-disable-next-line @typescript-eslint/no-explicit-any
+  const hasPath2D = typeof (globalThis as any).Path2D === 'function';
+  const path = hasPath2D ? new Path2D() : null;
+  if (path && pointCount > 0) {
+    path.moveTo(polygon[0], polygon[1]);
+    for (let i = 2; i < polygon.length; i += 2) path.lineTo(polygon[i], polygon[i + 1]);
+    path.closePath();
+  }
+
+  // bounds from polygon (not centerline) for accurate dirty-rects
+  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
+  for (let i = 0; i < polygon.length; i += 2) {
+    const x = polygon[i], y = polygon[i + 1];
+    if (x < minX) minX = x;
+    if (y < minY) minY = y;
+    if (x > maxX) maxX = x;
+    if (y > maxY) maxY = y;
+  }
+  const bounds = { x: minX || 0, y: minY || 0, width: (maxX - minX) || 0, height: (maxY - minY) || 0 };
+  return { kind: 'polygon', path, polygon, bounds, pointCount };
+}
+
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
   const halfWidth = stroke.style.size / 2;
   return !(
     maxX + halfWidth < viewportBounds.minX ||
     minX - halfWidth > viewportBounds.maxX ||
     maxY + halfWidth < viewportBounds.minY ||
     minY - halfWidth > viewportBounds.maxY
   );
 }
```

```diff
*** a/client/src/renderer/stroke-builder/stroke-cache.ts
--- b/client/src/renderer/stroke-builder/stroke-cache.ts
@@
-import type { StrokeView } from '@avlo/shared';
-import { buildStrokeRenderData, type StrokeRenderData } from './path-builder';
+import type { StrokeView } from '@avlo/shared';
+import {
+  buildPolylineRenderData,
+  buildPFPolygonRenderData,
+  type StrokeRenderData,
+} from './path-builder';
 
-/**
- * Simple render cache for stroke paths.
- * Keyed by stroke ID since strokes are immutable after commit.
- *
- * This is a UI-local cache only, never persisted.
- * Phase 4 keeps it simple - no style stamping or complex keys.
- */
-export class StrokeRenderCache {
-  private cache = new Map<string, StrokeRenderData>();
-  private maxSize: number;
+/**
+ * Stroke render cache (LRU) with geometry variants per stroke ID.
+ * - Entry keyed by stroke.id
+ * - Variant keyed by a small "geometry key"
+ *   • polyline: independent of style.size (stroke width does not affect geometry)
+ *   • polygon (Perfect Freehand): depends on style.size (width affects geometry)
+ *
+ * Style-only edits (color, opacity, polyline width) DO NOT invalidate geometry.
+ */
+type GeomKey = string;
+type Variants = Map<GeomKey, StrokeRenderData>;
+type Entry = { id: string; variants: Variants };
+
+export class StrokeRenderCache {
+  private lru = new Map<string, Entry>(); // insertion-ordered LRU over stroke IDs
+  private maxSize: number;
 
   constructor(maxSize = 1000) {
-    this.maxSize = maxSize;
+    this.maxSize = Math.max(1, maxSize | 0);
   }
 
-  /**
-   * Get or build render data for a stroke.
-   * Strokes are immutable after commit, so ID is sufficient key.
-   */
-  getOrBuild(stroke: StrokeView): StrokeRenderData {
-    const cached = this.cache.get(stroke.id);
-    if (cached) {
-      return cached;
-    }
-
-    // Build new render data
-    const renderData = buildStrokeRenderData(stroke);
-
-    // FIFO eviction if cache is full (simple for Phase 4)
-    if (this.cache.size >= this.maxSize) {
-      const firstKey = this.cache.keys().next().value;
-      if (firstKey) {
-        this.cache.delete(firstKey);
-      }
-    }
-
-    this.cache.set(stroke.id, renderData);
-    return renderData;
-  }
+  getOrBuild(
+    stroke: StrokeView,
+    want: { kind: 'polyline' | 'polygon'; closed?: boolean } | null = null
+  ): StrokeRenderData {
+    // Default behavior preserves old callers: derive geometry from stroke.renderMode
+    const desired = want ?? (stroke.renderMode === 'polygon-fill'
+      ? { kind: 'polygon' as const }
+      : { kind: 'polyline' as const });
+
+    const key = computeGeomKey(stroke, desired);
+
+    // LRU touch / lookup
+    let entry = this.lru.get(stroke.id);
+    if (entry) {
+      // touch: move to back
+      this.lru.delete(stroke.id);
+      this.lru.set(stroke.id, entry);
+      const hit = entry.variants.get(key);
+      if (hit) return hit;
+    } else {
+      entry = { id: stroke.id, variants: new Map() };
+      this.lru.set(stroke.id, entry);
+    }
+
+    // Build the requested geometry
+    const built =
+      desired.kind === 'polygon'
+        ? buildPFPolygonRenderData(stroke)
+        : buildPolylineRenderData(stroke);
+
+    entry.variants.set(key, built);
+    this.evictIfNeeded();
+    return built;
+  }
 
   /**
-   * Clear a specific stroke from cache.
-   * Called when stroke is deleted (Phase 10).
+   * Invalidate a specific stroke ID (all variants).
    */
   invalidate(strokeId: string): void {
-    this.cache.delete(strokeId);
+    this.lru.delete(strokeId);
+  }
+
+  /**
+   * Invalidate multiple stroke IDs.
+   */
+  invalidateMany(ids: Iterable<string>): void {
+    for (const id of ids) this.lru.delete(id);
   }
 
   /**
    * Clear entire cache.
    * Called on scene change or major updates.
    */
   clear(): void {
-    this.cache.clear();
+    this.lru.clear();
   }
 
   /**
    * Get current cache size for monitoring.
    */
   get size(): number {
-    return this.cache.size;
+    return this.lru.size;
   }
+
+  private evictIfNeeded(): void {
+    while (this.lru.size > this.maxSize) {
+      const firstKey = this.lru.keys().next().value as string | undefined;
+      if (!firstKey) break;
+      this.lru.delete(firstKey);
+    }
+  }
 }
 
 // Add singleton export for shared access
 let globalCacheInstance: StrokeRenderCache | null = null;
 
 export function getStrokeCacheInstance(): StrokeRenderCache {
   if (!globalCacheInstance) {
-    globalCacheInstance = new StrokeRenderCache(1000);
+    globalCacheInstance = new StrokeRenderCache(1000);
   }
   return globalCacheInstance;
 }
+
+// --- helpers ---
+function computeGeomKey(
+  stroke: StrokeView,
+  want: { kind: 'polyline' | 'polygon'; closed?: boolean }
+): GeomKey {
+  if (want.kind === 'polyline') {
+    // Polyline geometry ignores style.size
+    return `pl:${want.closed ? '1' : '0'}`;
+  }
+  // PF polygon geometry depends on width (size). PF knobs are fixed for now.
+  const s = stroke.style.size;
+  return `pf:s=${s};sm=0.5;sl=0.5;th=0;pr=0`;
+}


```diff
*** a/client/src/renderer/layers/strokes.ts
--- b/client/src/renderer/layers/strokes.ts
@@
-import { getStrokeCacheInstance, isStrokeVisible } from '../stroke-builder';
+import { getStrokeCacheInstance, isStrokeVisible } from '../stroke-builder';
@@
 function renderStroke(
   ctx: CanvasRenderingContext2D,
   stroke: StrokeView,
   _viewTransform: ViewTransform,
 ): void {
-  // Get or build render data
-  const renderData = strokeCache.getOrBuild(stroke);
+  // Select geometry kind based on stroke.renderMode
+  const want = stroke.renderMode === 'polygon-fill'
+    ? { kind: 'polygon' as const }
+    : { kind: 'polyline' as const };
+  const renderData = strokeCache.getOrBuild(stroke, want);
 
-  if (renderData.pointCount < 2) {
-    return; // Need at least 2 points for a line
-  }
+  if (renderData.pointCount < 2) return;
 
   ctx.save();
-  // Apply stroke style
-  ctx.strokeStyle = stroke.style.color;
-  ctx.lineWidth = stroke.style.size; // World units - transform handles scaling
-  ctx.globalAlpha = stroke.style.opacity;
-  ctx.lineCap = 'round';
-  ctx.lineJoin = 'round';
-
-  if (stroke.style.tool === 'highlighter') {
-    ctx.globalCompositeOperation = 'source-over';
-  }
-
-  if (renderData.path) {
-    ctx.stroke(renderData.path);
-  } else {
-    ctx.beginPath();
-    const pl = renderData.polyline;
-    ctx.moveTo(pl[0], pl[1]);
-    for (let i = 2; i < pl.length; i += 2) ctx.lineTo(pl[i], pl[i + 1]);
-    ctx.stroke();
-  }
+  ctx.globalAlpha = stroke.style.opacity;
+
+  if (renderData.kind === 'polygon') {
+    // FREEhand (PF polygon) → fill
+    ctx.fillStyle = stroke.style.color;
+    if (renderData.path) {
+      ctx.fill(renderData.path);
+    } else {
+      // rare test fallback (no Path2D)
+      ctx.beginPath();
+      const pg = renderData.polygon;
+      ctx.moveTo(pg[0], pg[1]);
+      for (let i = 2; i < pg.length; i += 2) ctx.lineTo(pg[i], pg[i + 1]);
+      ctx.closePath();
+      ctx.fill();
+    }
+  } else {
+    // SHAPES (polyline) → stroke
+    ctx.strokeStyle = stroke.style.color;
+    ctx.lineWidth = stroke.style.size;
+    ctx.lineCap = 'round';
+    ctx.lineJoin = 'round';
+    if (stroke.style.tool === 'highlighter') {
+      ctx.globalCompositeOperation = 'source-over';
+    }
+    if (renderData.path) {
+      ctx.stroke(renderData.path);
+    } else {
+      ctx.beginPath();
+      const pl = renderData.polyline;
+      ctx.moveTo(pl[0], pl[1]);
+      for (let i = 2; i < pl.length; i += 2) ctx.lineTo(pl[i], pl[i + 1]);
+      ctx.stroke();
+    }
+  }
   ctx.restore();
 }
```

```diff
*** /dev/null
--- b/client/src/renderer/stroke-builder/pf-config.ts
@@
+/**
+ * Shared Perfect Freehand options, fixed-width (no thinning/pressure).
+ * Used by overlay preview (live) and base-canvas (commit).
+ */
+export const PF_OPTIONS_BASE = {
+  // 'size' will be supplied at call-site to match stroke.style.size
+  thinning: 0,
+  smoothing: 0.5,
+  streamline: 0.5,
+  simulatePressure: false,
+} as const;
```

> Notes / invariants this diff intentionally preserves:
>
> • **Two-canvas pipeline & event-driven base render** stay intact: overlay draws preview every frame; base canvas only on doc changes; transforms/DPR unchanged. 
> • **RDP at commit** keeps persisted centerline compact; PF runs at render time (cache builds Path2D once per stroke). 
> • **Freehand preview/commit parity:** both use the same PF config; pass `last=true` on base build; overlay uses `last=false` and the existing “hold preview for one frame” avoids flicker. 
> • **Shapes unchanged:** preview and commit remain polyline stroke; only freehand is PF polygon fill. 
> • **Cache design:** single **LRU**, **ID-keyed**; entries hold **geometry variants** (polyline vs PF polygon). **Color/opacity** never invalidate; **polyline width** never invalidates; **PF polygon width** *does* invalidate via geometry key.   
> • **Path-builder split:** polyline builder retained for shapes; new PF-polygon builder fills and computes bounds from polygon for accurate dirty-rects.  

---

### Minimal wiring expectations (no extra fluff)

* The **renderer import surface** (`../stroke-builder`) should already re-export `getStrokeCacheInstance` and `isStrokeVisible`; with the above changes, its public API remains the same for callers except `getOrBuild(stroke, want)` instead of `get(stroke.id)`. Your `drawStrokes` now passes `want` based on `stroke.renderMode`.  
* The **preview layer** is still called inside the world transform scope and uses CSS-pixel DPR discipline unchanged.  

Great push to simplify. If the only thing Canvas needs is “which cached geometries must be evicted,” the **lowest-churn, most robust** plan is to compute that **locally in Canvas** from the already-available `prev`→`next` snapshot delta—no snapshot/schema changes, no special routing through RoomDocManager, no select-tool-only pathway. Any mutation (local or remote) that changes **geometry** already shows up as a **bbox change** in `diffBounds`; we can re-use that same pass to also produce a small **evict-ID set**:

* **Evict** on: added? (no need), **removed**, **bbox changed** (covers move, resize, PF width change, centerline changes).
* **Do NOT evict** on: color/opacity (stroke or text), polyline stroke width (shapes), z-order only.

Below is a surgical diff that implements this in **Canvas.tsx** and exposes one helper in `renderer/layers`. No RoomDocManager or snapshot changes required. (You’re already doing bounds diff in Canvas; we extend it to also collect IDs.)  

---

# Diff — `client/src/renderer/layers/index.ts`

(Expose a tiny helper to evict by IDs; zero runtime cost otherwise.)

```diff
*** a/client/src/renderer/layers/index.ts
--- b/client/src/renderer/layers/index.ts
@@
 import { getStrokeCacheInstance } from '../stroke-builder/stroke-cache';
 
 export function clearStrokeCache() {
   getStrokeCacheInstance().clear();
 }
+
+// ID-keyed geometry cache eviction (used by Canvas on bbox changes/removals)
+export function invalidateStrokeCacheByIds(ids: Iterable<string>) {
+  getStrokeCacheInstance().invalidateMany(ids);
+}
```

> `invalidateMany` already exists in the LRU cache you merged earlier; if not, add it (one-liner wrapper over `Map.delete`).

---

# Diff — `client/src/canvas/Canvas.tsx`

Add an **ID-aware** diff that also returns an eviction set, and use it right where you already handle `docVersion` changes. This keeps the same event ordering and avoids any schema/API changes.  

```diff
*** a/client/src/canvas/Canvas.tsx
--- b/client/src/canvas/Canvas.tsx
@@
-import { clearStrokeCache, drawPresenceOverlays } from './renderer/layers';
+import {
+  clearStrokeCache,
+  drawPresenceOverlays,
+  invalidateStrokeCacheByIds,
+} from './renderer/layers';
@@
-function diffBounds(prev: Snapshot, next: Snapshot): WorldBounds[] {
+/**
+ * Compute world-space dirty bounds AND which stroke IDs should evict geometry cache.
+ * Evict policy:
+ *  - removed IDs → evict
+ *  - bbox changed (geometry changed) → evict
+ *  - added IDs → no eviction needed (no cache existed)
+ *  - style-only changes → bbox unchanged → no eviction
+ */
+function diffBoundsAndEvicts(
+  prev: Snapshot,
+  next: Snapshot,
+): { bounds: WorldBounds[]; evictIds: string[] } {
   const prevStrokeMap = new Map(prev.strokes.map((s) => [s.id, s]));
   const nextStrokeMap = new Map(next.strokes.map((s) => [s.id, s]));
-  const dirty: WorldBounds[] = [];
+  const dirty: WorldBounds[] = [];
+  const evict = new Set<string>();
 
   // Added/modified strokes
   for (const [id, stroke] of nextStrokeMap) {
     const prevStroke = prevStrokeMap.get(id);
-    if (!prevStroke || !bboxEquals(prevStroke.bbox, stroke.bbox)) {
+    if (!prevStroke || !bboxEquals(prevStroke.bbox, stroke.bbox)) {
       // Don't inflate here - DirtyRectTracker will handle it
       dirty.push({
         minX: stroke.bbox[0],
         minY: stroke.bbox[1],
         maxX: stroke.bbox[2],
         maxY: stroke.bbox[3],
       });
+      // Evict only if it existed before (i.e., geometry changed); adds don't need eviction
+      if (prevStroke && !bboxEquals(prevStroke.bbox, stroke.bbox)) {
+        evict.add(id);
+      }
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
+      evict.add(id);
     }
   }
 
   // Handle text blocks
   const prevTextMap = new Map(prev.texts.map((t) => [t.id, t]));
   const nextTextMap = new Map(next.texts.map((t) => [t.id, t]));
@@
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
+      // If text bbox changed, evict any future text geometry cache (none today; harmless no-op)
+      if (prevText) evict.add(id);
     }
   }
@@
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
+      evict.add(id);
     }
   }
 
-  return dirty; // Let DirtyRectTracker handle coalescing
+  return { bounds: dirty, evictIds: Array.from(evict) }; // Let DirtyRectTracker coalesce
 }
@@
-    const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
+    const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
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
 
         // Hold preview for one frame to prevent flash on commit
         overlayLoopRef.current.holdPreviewForOneFrame();
 
-        // Use bbox diffing for targeted invalidation
-        const changedBounds = diffBounds(prevSnapshot, newSnapshot);
+        // Use bbox diffing for targeted invalidation + compute eviction IDs
+        const { bounds: changedBounds, evictIds } = diffBoundsAndEvicts(prevSnapshot, newSnapshot);
 
         // Use optimized dirty rect invalidation for all changes
         // The translucent check in RenderLoop will promote to full clear when needed
         for (const bounds of changedBounds) {
           renderLoopRef.current.invalidateWorld(bounds);
         }
+
+        // Evict any stale geometry (PF polygon width change, move/resize, deletions, text resize)
+        if (evictIds.length) {
+          invalidateStrokeCacheByIds(evictIds);
+        }
 
         overlayLoopRef.current.invalidateAll(); // Also update overlay for new doc
       } else {
         // Presence-only change - update overlay only
         overlayLoopRef.current.invalidateAll();
       }
     });
```

**Why this is correct & minimal:**

* **Geometry changes ⇒ bbox changes** for your operations: move/translate, resize (polyline or PF polygon), PF width change (polygon), text resize—are already reflected in the stored `bbox`. Style-only edits (color/opacity, polyline stroke width for shapes) do **not** affect geometry, so **no eviction** is needed. This aligns with how Canvas already diffs bounds and with RenderLoop/DirtyRectTracker behavior.   
* We don’t touch `RoomDocManager` or `Snapshot` at all, keeping the **publish/subscribe** surface exactly as-is and avoiding any select-tool-only special plumbing. Canvas can make the decision **deterministically** from `prev`/`next`, which also covers **remote** changes (no “hints” needed). 
* Cache churn stays **extremely low**: we only evict by ID on removals and bbox-detected geometry changes; recolors never touch the geometry cache. (PF polygon geometry depends on width → bbox changes; polyline stroke width does not → no eviction.) This matches the PF+cache plan.

---

## Sanity matrix (how this behaves per change type)
* **Perfect shape (polyline)**
  * Resize/transform/move (points change) → bbox changes → **evict**
  * Stroke width change (style only) → bbox same → **no evict**
  * Color/opacity change → bbox same → **no evict**

* **Freehand (PF polygon)**
  * Move/resize or centerline edit → bbox changes → **evict**
  * Width (size) change → polygon geometry changes, bbox changes → **evict**
  * Color/opacity change → bbox same → **no evict**
* **Text**
  * Move/resize or font-size/content change → bbox changes → **evict** (future text cache)
  * Color change → bbox same → **no evict**
* **Remove element** → **evict**
* **Add element** → no prior cache → **no evict**
This uses only information Canvas already has and preserves your **event-driven render loop + dirty-rect** pipeline.  

---

### Eraser tool?

Nothing to change: it erases via **centerline segment distance with (radius + size/2)** and bbox/spatial prunes. PF polygons remain correctly hit-tested with the centerline+halfWidth rule; no cache interaction needed.  

