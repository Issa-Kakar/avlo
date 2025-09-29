# Lasso Selection & Transform: End-to-End Behavior, Contracts, and Guardrails

## 0) Alignment with Avlo’s architecture (what this plugs into)

* **Authoritative state** lives in a single Yjs doc under `root` (`strokes[]`, `texts[]`, `meta`, etc.). All user edits occur via one `room.mutate(fn)` that wraps a single `yjs.transact`. UI never touches live Y types; it consumes **immutable Snapshots** published ≤ 60 FPS.  
* **Two-canvas renderer.** Base canvas draws world layers (strokes → text) using only committed snapshot data. Overlay canvas draws *local previews* (world-space) and presence (screen-space), and is always `pointer-events: none`. Export excludes overlay. 
* **Gating.** Writes are allowed offline-first; presence draws only once `G_AWARENESS_READY` *and* `G_FIRST_SNAPSHOT` are open; export/minimap gated on `G_FIRST_SNAPSHOT`. Lasso follows these same gates.  
* **Mobile is view-only.** The tool is disabled on mobile (show banner). 

---

## 1) Tool Goals (Behavioral summary)

* **Freeform lasso** captures an arbitrary polygon in **world space**, supports self-intersections and “donut” shapes via **even–odd** point-in-polygon (PIP). 
* **Selection, move, uniform scale** — no resize handles. Move anywhere inside; scale via Right-drag *or* Shift+Left (trackpad/stylus fallback). Uniform (isotropic) only; no shear. 
* **Local-only preview during transform.** Other users never see “ghosts”; they only see the atomic post-commit result. Base filters out selected IDs while overlay draws the transformed copies. 
* **Atomic commit.** One `mutate(fn)` that replaces the selected items **in place** (delete originals in descending index; insert transformed versions at the same indices). 

---

## 2) State machine & input map

### States

`idle → lassoCapture → selected → transforming(move|scale) → commit → selected → …` with `Esc` to cancel active transform, click-away/tool-change/new-lasso to exit to `idle`. Enter commits. Entering `transforming` happens on the *first* pointer-move inside the selection. 

### Input map

* **Move:** Left-drag (button `0`) anywhere inside selection area.
* **Uniform scale:** Right-drag (button `2`) *or* `Shift+Left-drag`. Suppress the native context menu on Right-drag.
* **Keyboard:** `Esc` cancels transform back to `selected`; `Enter` commits (same as `pointerup`). 

---

## 3) Coordinate spaces (strict contracts)

* Everything the tool captures and previews is **world space**. Pointer positions convert via `view.canvasToWorld(x, y)`. Never ad-hoc arithmetic. 
* Ants width is specified in **world units** (`antsWidthWU`), so lines scale naturally with zoom.
* **Auto-close threshold** is computed in world units from a screen pixel constant: `px12_world = 12 / view.scale`. Same for `r_eps_world` (derived from ~8px_screen at gesture start).  

---

## 4) Preview types (overlay contract)

Extend your existing `PreviewData` union with:

```ts
export type PreviewData = StrokePreview | EraserPreview | LassoPreview;

export interface LassoPreview {
  kind: 'lasso';
  polygon: number[]; // simplified world polygon [x0,y0, x1,y1, ...]
  selectedIds: { strokes: string[]; texts: string[] };
  isDragging: boolean; // when true, ants are hidden
  transform?: {
    dx: number; dy: number; scale: number;
    origin: { x: number; y: number };
  };
}
```

* **Ants show only when `mode==='selected'`.** Hide them during `transforming`.
* **Overlay draws in world space** using the shared view transform. Base is filtered to hide selected IDs during transform.   

---

## 5) Capture phase (building the polygon)

1. On `pointerdown`, start capture in **world** coords; coalesce `pointermove` at rAF cadence.
2. **Auto-close** when the last point is within `12px_screen → 12/view.scale` of the first point *and* there are ≥ 8 points.
3. On `pointerup`, run **Douglas–Peucker** simplification (ε≈`0.75 WU`). Store `lassoPolygon:number[]` (world). 

### Selection hit-test (two-phase)

* Phase A: Query **spatial index** with polygon AABB → candidate IDs.
* Phase B: Per candidate, apply **even–odd PIP**.
* **Selection rule:**

  * Strokes: selected if **any** point of the stroke lies inside (even–odd).
  * Texts: selected if the **rect center** lies inside (even–odd).  

> Guardrail: if the polygon is degenerate (< 3 distinct world points after simplify) → fail selection gracefully (no state change) and keep tool in `idle`.

---

## 6) Transform semantics (math & invariants)

* **Transform origin**: center of selection **AABB** at transform start; capture once per gesture.
* **Move** (Left-drag): `dx = now.x - start.x`, `dy = now.y - start.y`.
* **Uniform scale** (Right-drag or Shift+Left):

  ```
  r0 = max(distance(center, pointerStart), r_eps_world)   // r_eps ≈ 8px_screen in world
  r1 = distance(center, pointerNow)
  s  = clamp(r1 / r0, s_min=0.10, s_max=10.0)
  ```
* **What changes:**

  * **Strokes**: transform **all points** around `origin` by translation/scale; multiply `style.size` by `scale`.
  * **Texts**: transform `(x,y,w,h)` around `origin`; set `text.size *= scale` clamped `[8,256]`. Editing later preserves this scaled size as the authoritative value. 

During transform:

* **Lock** the selection ID set + a **baseline copy** of geometry/styles.
* **Base** filters out those IDs.
* **Overlay** draws only the transformed baseline copies.
* **Ants hidden** until commit/cancel. 

---

## 7) Commit: CRDT write, replace-in-place

**When:** `pointerup`

**How:** one `mutate(fn)` that:

1. Finds the **current indices** for each selected ID (do not assume stale indices).
2. Deletes originals in **descending index** order.
3. Inserts the transformed versions at the **same indices**.

**After commit:**

* Apply the same transform to the saved `lassoPolygon` so ants re-match.
* Ants **reappear**; selection remains active; hold overlay for one frame while base catches up, then clear overlay. 

> * If any selected item was remotely deleted mid-drag, silently **skip** it at commit. 

---

## 8) Pointer event behavior (precise mechanics)

* **Pointer capture:** on `pointerdown`, call `canvas.setPointerCapture(pointerId)`; release on `pointerup/cancel`.
* **Context menu:** suppress during Right-drag transforms.
* **Lost pointer / `pointercancel`:** if in `transforming`, revert to `selected` and keep ants; if in `lassoCapture`, discard polygon and return to `idle`.
* **OS cursor:** crosshair in capture, **none** while transforming (optional), normal otherwise. (You already hide cursor for eraser; reuse the pattern.) 
* **rAF coalescing:** only one preview build per frame; drop stale motion events under load (consistent with backpressure policy). 

---

## 9) Rendering details (overlay + ants)

* **Ants**: overlay draws the simplified world polygon with animated dash (`ctx.setLineDash([5,5])`, time-based offset). Width in world units (`antsWidthWU = 1.5`), with optional min **0.5px** screen clamp for legibility. Ants visible only in `selected`.  
* **Transformed copies**: while `transforming`, overlay draws copies of selected strokes/texts using `overlayTransform`. Base filters those IDs out until commit. 
* **Layering** (unchanged): base = world layers; overlay = live preview then presence (screen-space). Export includes base only. 

---

## 10) Integration with `RoomDocManager`, snapshots, and spatial index

* The tool never imports Yjs; it communicates through the **manager** and reads only **Snapshots**. Writes go through `room.mutate`. 
* **Spatial index**: reuse the same uniform grid used by eraser/hit-testing: AABB pre-filter → precise PIP. Add a `queryPolygonAABB()` helper or compute AABB client-side and pass to `queryBox`. 
* **Snapshot contract**: ensure the snapshot includes `spatialIndex` (nullable) and `view` so the tool can hit-test and render previews correctly. (It’s already there.) 
* **Doc versioning**: dirty the base canvas only on Y.Doc change; overlay is invalidated by preview changes. This avoids unnecessary base clears while transforming. 

---

## 11) API surface & class sketch

### Pointer-tool polymorphism (unchanged pattern)

Keep the existing `PointerTool` interface so Canvas can swap tools without changing routing or event wiring:

```ts
type PointerTool = {
  canBegin(): boolean;
  begin(pointerId: number, xWorld: number, yWorld: number): void;
  move(xWorld: number, yWorld: number): void;
  end(xWorld?: number, yWorld?: number): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  destroy(): void;
};
```

The **LassoTool** will implement this interface (mirroring Eraser/Drawing tools). 

### LassoTool data model (internal)

```ts
interface LassoState {
  mode: 'idle'|'lassoCapture'|'selected'|'transforming';
  pointerId: number|null;
  points: number[];             // raw capture, world; cleared on simplify
  polygon: number[]|null;       // simplified world poly when selected
  antsVisible: boolean;         // derived from mode
  selected: { strokes: string[]; texts: string[] };
  baseline: {                    // captured on entering transforming
    strokes: Map<string, StrokeView>;
    texts: Map<string, TextView>;
  }|null;
  center: { x:number; y:number }|null;   // AABB center at transform start
  startWorld: { x:number; y:number }|null;
  transform: { dx:number; dy:number; scale:number }|null;
}
```

---

## 12) Guardrails & limits (hard requirements)

* **Write policy**: No writes until commit; all writes inside a single `yjs.transact` via `room.mutate`. Block on mobile or when room is read-only (≥ 15 MB).  
* **Backpressure**: keep preview at rAF cadence; drop stale pointer events; do not throttle base beyond doc-driven invalidations. Awareness pacing already degrades independently. 
* **Size caps**: respect WS frame cap (2 MB). If replacing a very large selection risks exceeding the cap, cancel with a toast. (You already display oversize messages elsewhere.) 
* **Undo/Redo**: a single commit yields one entry in the user’s Yjs UndoManager history (origin=userId). Scene ticks remain excluded. 
* **Concurrency**: selection set and baseline are **frozen** for the gesture. Remotely deleted items are skipped on commit; trivial z-reordering is acceptable. 

### Thresholds & constants

* Auto-close: **12 px (screen)** → world via `1/view.scale`, require ≥ 8 points.
* Simplify ε: **≈0.75 WU**.
* Scale clamps: `s ∈ [0.10, 10.0]`; `r_eps_world` from **8 px (screen)** at gesture start.
* Ants width: **1.5 WU** (min **0.5 px** on screen). 

---

## 13) Rendering & routing (app-level integration)

* **Rendering:** no changes to base pipeline. Ensure the base renderer supports an **ID filter** (set of IDs to skip) driven by the overlay loop while `transforming`. That filter lives in the overlay loop’s state, not in RoomDocManager. (The spec explicitly says base filters out selected IDs while overlay draws transformed copies.) 
* **Routing:** keep URLs stable — rooms remain `/r/<roomId>`; websockets `/ws/<roomId>`. Do **not** encode selection state or tool state in the route to avoid broadcast noise and URL churn. Tool selection stays in device-local UI (Zustand) exactly as with other tools.  
* **Service Worker:** overlay previews/presence never touch the network; no SW changes (don’t cache `/yjs/**` or `wss:`). 

---

## 14) Accessibility & UX polish

* Keyboard: `Esc` to cancel, `Enter` to commit (normative); optional: arrow keys “nudge” when selected (post-MVP, as it requires additional commit semantics). 
* Cursor & affordances: while in `selected`, show ants + subtle interior hover highlight; while `transforming`, hide ants to avoid dual visuals.
* Touch/stylus: Shift+Left-drag fallback for uniform scale covers trackpads/stylus; on touch devices (if not mobile-gated), provide a **two-finger pinch** mapping to uniform scale (post-MVP; keep MVP desktop-first per scope).

---

## 15) Error cases & recovery

* **Degenerate polygon** (fewer than 3 distinct points after simplify) → show toast “Lasso is too small” and return to `idle`.
* **Frame cap risk** → toast “Selection is too large to move/scale at once.” (No partial commits.)
* **Pointer cancel / blur** → if transforming, revert to `selected`; if capturing, discard.

---

## 16) Testing plan (unit + E2E)

* **Geometry units**

  * PIP even–odd tests on complex shapes (self-intersections, holes).
  * Simplification preserves winding and yields stable ants (golden fixtures).
* **Transform math**

  * Move/scale invariants: scaling about AABB center; `text.size` and `stroke.style.size` scale uniformly with clamping.
* **Concurrency**

  * Remote deletion mid-drag → commit skips missing IDs (no throw). 
* **Renderer diffing**

  * While transforming, base excludes selected IDs; after commit, base draws new geometry; overlay clears after one frame.
* **Gates**

  * No presence/preview before `G_FIRST_SNAPSHOT`; writes still allowed offline-first; mobile gating blocks writes. 

Use Playwright to drive pointer sequences and snapshots; reuse the existing registry pattern to isolate managers in tests (already mandated broadly). 

---

## 17) Step-by-step implementation checklist

1. **Types & state**

   * Add `LassoPreview` to your overlay union.
   * Implement `LassoTool` class that conforms to `PointerTool`.  

2. **Canvas integration**

   * In `Canvas.tsx`, when `activeTool==='select'`, instantiate `new LassoTool(roomDoc, getSnapshot, getView, onInvalidate)`.
   * Wire the same event handlers you use for Eraser/Drawing; set preview provider to return `LassoPreview`. 

3. **Capture**

   * On `begin()`: store startWorld, push first point.
   * On `move()`: rAF-coalesce, append world point; check auto-close (12px_screen).
   * On `end()`: simplify (ε≈0.75WU), compute polygon AABB, query spatial index → candidates, run even–odd PIP → build `selected` sets. If empty, return to `idle`; else `selected`.

4. **Transform**

   * On first drag inside selection: set mode `transforming`, compute AABB center → origin; capture baseline maps; compute transform (`dx,dy` or `scale`).
   * While moving: update transform; overlay draws copies; base filters selected IDs.

5. **Commit**

   * On `end()`: build transformed strokes/texts; in `room.mutate` delete originals (descending indices), insert transformed at same indices.
   * Update polygon by same transform; show ants again (`selected`); clear overlay after one frame. 

6. **Guardrails**

   * Enforce mobile read-only, frame cap, and drop stale events. Reuse the global banners/toasts you already have.  

---

## 18) Exact math snippets (pseudo-TS)

**AABB center**

```ts
function aabbCenter(poly:number[]): {x:number;y:number} {
  let minX=+Infinity, minY=+Infinity, maxX=-Infinity, maxY=-Infinity;
  for (let i=0;i<poly.length;i+=2) {
    const x=poly[i], y=poly[i+1];
    if (x<minX) minX=x; if (x>maxX) maxX=x;
    if (y<minY) minY=y; if (y>maxY) maxY=y;
  }
  return { x:(minX+maxX)/2, y:(minY+maxY)/2 };
}
```

**Even–odd PIP** (for holes)

```ts
function pipEvenOdd(poly:number[], x:number, y:number): boolean {
  let inside=false;
  for (let i=0, j=poly.length-2; i<poly.length; i+=2) {
    const xi=poly[i], yi=poly[i+1], xj=poly[j], yj=poly[j+1];
    const intersect = ((yi>y)!==(yj>y)) &&
      (x < (xj-xi)*(y-yi)/(yj-yi+Number.EPSILON)+xi);
    if (intersect) inside = !inside;
    j=i;
  }
  return inside;
}
```

**Uniform scale around origin**

```ts
function scalePoint(p:[number,number], origin:{x:number;y:number}, s:number):[number,number]{
  return [origin.x + (p[0]-origin.x)*s, origin.y + (p[1]-origin.y)*s];
}
```

> These match the “radial uniform model” (no handles) and even–odd semantics in your spec.  

---

## 19) Performance notes

* Capture and transform work should stay under the overlay loop’s ~6 ms prep budget. If polygon candidate sets are large, *chunk* PIP work across frames until selection finalizes (cap ~10 ms per frame like eraser’s resume index pattern).  
* Always rebuild overlay drawing from **baseline** + `overlayTransform`. Never mutate snapshot data. One preview publish per frame; reuse typed paths/buffers where possible (similar to eraser’s Path2D cache). 

---



---

## 21) What not to do (non-goals)

* No non-uniform scaling, rotation, or shear.
* No per-keystroke CRDT writes for text (text commit already uses atomic append/replace). 
* No presence broadcast of the lasso polygon itself; it remains strictly local preview. (Awareness stays world-space cursors only.) 

---

### Appendix A — Why this fits Avlo’s broader constraints

* **Snapshot-only rendering** and **one-transact commits** keep CRDT consistency and Undo entries sane.  
* **Two-canvas isolation** preserves smooth previews at 60 FPS while protecting base redraws (only when `docVersion` changes). 
* **Offline-first** still works: all edits happen at commit; if WS isn’t up, Yjs/IDB will merge later. 
* **Room caps & TTL** unaffected: lasso commits are normal doc updates (extend TTL on accepted writes), and awareness pacing/backpressure stays independent. 

---

If you want, I can follow this with a concrete `LassoTool.ts` skeleton wired to your canvas loop and a tiny PIP + simplify utility module — but this is the complete behavior + integration guide with the exact guardrails you asked for.
