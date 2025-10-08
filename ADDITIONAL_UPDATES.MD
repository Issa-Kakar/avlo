**CRITICAL**: TWO TYPES OF STROKE DATA
Awesome catch—and thanks for spelling out your two types. Given that:

* **`Stroke`** = persisted Yjs row (source of truth)
* **`StrokeView`** = published snapshot struct (render-only, can carry conveniences)

…the simplest, least-confusing, and most robust approach is:

# Core decision

Store a **semantic flag** on the persisted stroke—**not** an implementation detail.

* Add `kind: 'freehand' | 'shape'` to **`Stroke`** (Yjs).

  * `freehand` = captured by drawing tool (pen/highlighter) → render as **PF polygon fill**
  * `shape` = snapped/perfect shape solver output → render as **stroked polyline**
* Mirror the same `kind` to **`StrokeView`** (snapshot) verbatim.

  * Renderer maps `kind → geometry pipeline` (no guessing, no coupling to “RDP happened?”).

Why semantic? Because it survives future renderer changes (e.g., if one day you switch freehand to a different polygon algorithm), while an explicit “renderMode: 'polygon-fill'” bakes in an implementation detail into storage.

This design keeps churn low:

* No heuristics in Canvas/RoomDocManager.
* No select-tool plumbing.
* No extra invalidation data—Canvas continues to do bbox diff; it evicts cache entries by ID when bbox changes or items are removed.

---

Awesome catch—and thanks for spelling out your two types. Given that:

* **`Stroke`** = persisted Yjs row (source of truth)
* **`StrokeView`** = published snapshot struct (render-only, can carry conveniences)

…the simplest, least-confusing, and most robust approach is:

# Core decision

Store a **semantic flag** on the persisted stroke—**not** an implementation detail.

* Add `kind: 'freehand' | 'shape'` to **`Stroke`** (Yjs).

  * `freehand` = captured by drawing tool (pen/highlighter) → render as **PF polygon fill**
  * `shape` = snapped/perfect shape solver output → render as **stroked polyline**
* Mirror the same `kind` to **`StrokeView`** (snapshot) verbatim.

  * Renderer maps `kind → geometry pipeline` (no guessing, no coupling to “RDP happened?”).

Why semantic? Because it survives future renderer changes (e.g., if one day you switch freehand to a different polygon algorithm), while an explicit “renderMode: 'polygon-fill'” bakes in an implementation detail into storage.

This design keeps churn low:

* No heuristics in Canvas/RoomDocManager.
* No select-tool plumbing.
* No extra invalidation data—Canvas continues to do bbox diff; it evicts cache entries by ID when bbox changes or items are removed.

---

# Surgical diffs

## 1) `shared/src/types.ts` — add `kind` to *both* types

```diff
*** a/shared/src/types.ts
--- b/shared/src/types.ts
@@
 export interface Stroke {
   id: StrokeId; // ULID
   tool: 'pen' | 'highlighter';
   color: string; // #RRGGBB
   size: number; // world units
   opacity: number; // 0..1
   points: number[]; // [x0,y0, x1,y1, ...] NEVER Float32Array
   bbox: [number, number, number, number];
   scene: SceneIdx; // assigned at commit from currentScene
   createdAt: number;
   userId: string;
+  /**
+   * Semantic origin of the geometry:
+   *  - 'freehand' => renderer builds a Perfect Freehand polygon and fills it
+   *  - 'shape'    => renderer strokes the polyline as-is (perfect/snap shapes)
+   */
+  kind: 'freehand' | 'shape';
 }
 
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
-  renderMode: 'polygon-fill' | 'polyline-stroke';
+  /**
+   * Same semantic flag as in Stroke (copied through snapshot pipeline).
+   * Renderer maps kind -> geometry pipeline (polygon vs polyline).
+   */
+  kind: 'freehand' | 'shape';
 }
```

> If your codebase doesn’t currently include `StrokeView` as a separate interface file, apply the same change wherever it’s defined.

---

## 2) `client/src/lib/tools/DrawingTool.ts` — stamp `kind` at commit (both paths)

```diff
*** a/client/src/lib/tools/DrawingTool.ts
--- b/client/src/lib/tools/DrawingTool.ts
@@
   commitStroke(finalX: number, finalY: number): void {
     if (!this.state.isDrawing) return;
     this.flushPendingPoint();
 
     // Simplify captured points for freehand
     const { points: simplified } = simplifyStroke(this.state.points, this.state.config.tool);
     const simplifiedBbox = computeBBoxInflated(simplified, this.state.config.size);
@@
     const strokeId = ulid();
     try {
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
           points: simplified,
           bbox: simplifiedBbox,
           scene: currentScene,
           createdAt: Date.now(),
           userId: this.userId,
+          kind: 'freehand',
         }]);
       });
     } finally {
       this.resetAfterCommit();
     }
   }
@@
   private commitPerfectShapeFromPreview(): void {
     if (!this.snap || !this.liveCursorWU) return;
     const { points, bbox } = this.snap.buildCommitPolyline(this.liveCursorWU);
@@
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
         points,   // shape solver polyline (no RDP)
         bbox,
         scene: currentScene,
         createdAt: Date.now(),
         userId: this.userId,
+        kind: 'shape',
       }]);
     });
     this.resetAfterCommit();
   }
```

> No PF import in the tool. Both paths remain “commit centerline polyline”; only the **semantic** changes.

---

## 3) `client/src/room/room-doc-manager.ts` — pass `kind` through to the snapshot (with back-compat)

Where you map Yjs strokes → snapshot strokes, just copy `kind`, and for old data (no `kind` yet) default to `'shape'` to preserve legacy “stroked polyline” rendering:

```diff
*** a/client/src/room/room-doc-manager.ts
--- b/client/src/room/room-doc-manager.ts
@@
-  const strokes = allStrokes
+  const strokes = allStrokes
     .filter((s) => s.scene === currentScene)
     .map((s) => ({
       id: s.id,
       points: s.points,
       polyline: null as unknown as Float32Array | null,
       style: { color: s.color, size: s.size, opacity: s.opacity, tool: s.tool },
       bbox: s.bbox,
       scene: s.scene,
       createdAt: s.createdAt,
       userId: s.userId,
+      kind: (s as any).kind ?? 'shape', // back-compat for old docs
     }));
```

---

# Why this answers your confusion (and keeps it efficient)

* You were right: **perfect shapes don’t run RDP**; that’s irrelevant to rendering. Both paths commit a centerline polyline, and the renderer picks the pipeline based on **semantics** (`kind`), not on whether RDP ran or how many points there are.
* Persisting `kind` in **`Stroke`** means no later part of the system has to guess. It also lets your **select tool** work cleanly (e.g., resizing a `freehand` stroke must evict the PF polygon geometry; resizing a `shape` keeps using the polyline builder).
* **`StrokeView`** merely mirrors `kind`; the renderer never looks at Yjs or infer anything—low coupling, low churn.
* Canvas keeps the simple **bbox diff** invalidation. For cache eviction, Canvas can compute `evictIds` from `prev → next` bbox changes and deletions (as we already wired), independent of `kind`.

---

## Recap

* **Permanent explicitness:** `kind: 'freehand'|'shape'` on `Stroke` and `StrokeView`.
* **Renderer branch:** kind → `{polyline|polygon}`; shapes stroke, freehand fill.
* **Cache:** LRU with per-stroke variants and **geometry-only** keys (no churn on recolor/opacity).
* **Remove**: null `polyline` placeholder and any “renderMode” concept.

If you want, I can generate the same diffs against your exact folder structure as unified patches (`git diff` format) in one bundle.


# Why this answers your confusion (and keeps it efficient)

* You were right: **perfect shapes don’t run RDP**; that’s irrelevant to rendering. Both paths commit a centerline polyline, and the renderer picks the pipeline based on **semantics** (`kind`), not on whether RDP ran or how many points there are.
* Persisting `kind` in **`Stroke`** means no later part of the system has to guess. It also lets your **select tool** work cleanly (e.g., resizing a `freehand` stroke must evict the PF polygon geometry; resizing a `shape` keeps using the polyline builder).
* **`StrokeView`** merely mirrors `kind`; the renderer never looks at Yjs or infer anything—low coupling, low churn.
* Canvas keeps the simple **bbox diff** invalidation. For cache eviction, Canvas can compute `evictIds` from `prev → next` bbox changes and deletions (as we already wired), independent of `kind`.

---


## Perfect Freehand install/import recap (unchanged)

* `pnpm add perfect-freehand` (or npm/yarn).
* Import **only** in renderer code paths (preview + path-builder):
  `import { getStroke } from 'perfect-freehand'`
* No PF import in the drawing tool.

---


Here’s exactly how to add **perfect-freehand** and where to import it in Avlo, plus tiny import-line fixes to keep our diffs consistent with the library’s current API.

# Install

Use the latest published version **1.2.2** (ESM + CJS builds are shipped). ([app.unpkg.com][1])

```bash
# at the web/client package (where your renderer runs)
pnpm add perfect-freehand
# or
yarn add perfect-freehand
# or
npm i perfect-freehand
```

The library’s README shows the install command and its **named export** API: `import { getStroke } from 'perfect-freehand'`. (We’ll use that form.) ([GitHub][2])

# Which files import it?

Only the **rendering** code needs it (preview + path building). The **drawing tool** does **not** import it.

* `client/src/renderer/layers/preview.ts` — live freehand preview (PF polygon)
* `client/src/renderer/stroke-builder/path-builder.ts` — commit-time/baserender PF polygon builder
* `client/src/renderer/stroke-builder/pf-config.ts` — just our shared options (no import from the library here)


---

### Quick sanity notes

* **Version**: 1.2.2 is the current latest on public CDNs (also showing the full version list). ([app.unpkg.com][1])
* **API shape**: use **named export** `getStroke` in ESM; README shows that form along with usage + options. ([GitHub][2])
* **ESM/CJS**: package publishes both module formats; typical bundlers (Vite/Webpack) will pick ESM. ([jsDelivr][3])

