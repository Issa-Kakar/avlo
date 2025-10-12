# Pixi Canvas (Phase 1: Strokes Only) — Refined Notes

> Goal: stand up the very first slice of infrastructure for drawing **pen / highlighter strokes** with a **Perfect Freehand preview** and a **committed state**. Shapes, culling, Yjs deltas, spatial indexing, etc. are deferred. 

---

## Scope & Non‑Goals (Phase 1)

* In-scope: pen + highlighter tools, local preview, commit to Yjs, render committed strokes.
* Out-of-scope *for now*: viewport culling, eraser dim-layer, text, shapes, spatial index, minimap, cache textures.

---


1. **DOM pointer events on the canvas element** (not Pixi’s interaction events) so we keep stable `setPointerCapture`, wheel zoom behavior, and predictable cancel/lost-capture handling across browsers.
2. **Single PIXI.Application** with `autoStart: false`; we render **on demand** when something actually changes (local preview, doc update, transform, presence).
3. **Three containers**:

   * `world` (all committed content; pan/zoom lives here)
   * `overlayWorld` (live preview in world space)
   * `overlayHUD` (screen-space presence/cursors, optional in P1)
4
5. **Perfect Freehand**: live preview is a stylus-like centerline; commit builds + fills the **PF polygon** from **canonical tuples**. Storage keeps `pointsTuples` for PF and also a flattened `points` for shapes.

---

## Initialization & Layout

```ts
// 1) Create the PIXI app once, do not auto-start
const app = new PIXI.Application({
  view: canvasEl,           // <canvas ref>
  autoStart: false,         // we call render() manually
  antialias: true,
  resolution: devicePixelRatio, // Pixi handles DPR; keep view math in world units
  backgroundAlpha: 1
});

// 2) Container structure
const world = new PIXI.Container();
const overlayWorld = new PIXI.Container();      // inherits world transform for previews
const overlayHUD = new PIXI.Container();        // screen-space HUD, no transform

app.stage.addChild(world);
world.addChild(overlayWorld);    // preview follows world pan/zoom
app.stage.addChild(overlayHUD);  // cursors & HUD

// 3) Apply ViewTransform by mutating `world` only
function applyTransform(scale: number, pan: {x:number;y:number}) {
  world.scale.set(scale, scale);
  world.position.set(-pan.x * scale, -pan.y * scale);
  app.renderer.render(app.stage);
}
```

**Why DOM events (not Pixi’s)?**

* We want **pointer capture** to behave identically across tools.
* Wheel zoom shouldn’t be swallowed by an internal interaction layer.
* Our existing event glue (MMB pan, touch-action rules, cursor overrides) is DOM-first — keeping it avoids the “monster” from effect dependency churn.

Attach **stable** listeners directly to `canvasEl` with `{ passive:false }`, **never** depend on `viewTransform` so React doesn’t rebind handlers mid-gesture.

---

## Tool Manager (imperative ref)

```ts
class ToolManager {
  private current: PointerTool | null = null;
  constructor(private deps: {
    room: RoomDocManager,
    overlayWorld: PIXI.Container,
    renderNow: () => void,
    getView: () => ViewTransform,
    userId: string,
  }) {}

  setActive(kind: 'pen'|'highlighter'|'pan') {
    this.current?.destroy?.();
    if (kind === 'pen' || kind === 'highlighter') {
      this.current = new DrawingToolPixi({
        room: this.deps.room,
        overlayWorld: this.deps.overlayWorld,
        renderNow: this.deps.renderNow,
        getView: this.deps.getView,
        toolType: kind,
        settings: getSettings(kind) // from UI store
      });
    } else if (kind === 'pan') {
      this.current = new PanTool(/* ... */);
    }
  }

  // DOM handlers delegate to the active tool
  pointerDown(id: number, wx: number, wy: number) { this.current?.begin(id, wx, wy); }
  pointerMove(wx: number, wy: number) { this.current?.move(wx, wy); }
  pointerUp(wx: number, wy: number) { this.current?.end(wx, wy); }
  cancel() { this.current?.cancel(); }
}
```

**Where is this created?** In the React canvas host (e.g. `PixiCanvas.tsx`) once, stored in a `useRef`, not in state.

---

## Pointer Events (DOM → world) & Wheel Zoom

```ts
function screenToWorld(clientX: number, clientY: number): [number, number] {
  const rect = canvasEl.getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  const v = viewRef.current; // latest transform (ref, not state)
  return [x / v.scale + v.pan.x, y / v.scale + v.pan.y];
}

canvasEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  canvasEl.setPointerCapture(e.pointerId);
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  tools.pointerDown(e.pointerId, wx, wy);
  room.updateActivity('drawing');
  app.renderer.render(app.stage);
}, { passive: false });

canvasEl.addEventListener('pointermove', (e) => {
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  room.updateCursor(wx, wy);           // awareness
  tools.pointerMove(wx, wy);           // preview updates overlayWorld
  app.renderer.render(app.stage);
}, { passive: false });

canvasEl.addEventListener('pointerup', (e) => {
  try { canvasEl.releasePointerCapture(e.pointerId); } catch {}
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  tools.pointerUp(wx, wy);             // commits → Yjs
  room.updateActivity('idle');
  app.renderer.render(app.stage);
}, { passive: false });

canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (middleMousePan.active) return;   // our MMB override
  const rect = canvasEl.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  const { scale, pan } = computeZoomAroundCursor(viewRef.current, e.deltaX, e.deltaY, { x: cx, y: cy });
  applyTransform(scale, pan);
}, { passive: false });
```

> **MMB pan** and **touch-action**: keep desktop `touch-action: none` for the canvas; on mobile, allow scrolling (no draw tools yet on mobile), so do **not** globally set `touch-action: none`.

---

## DrawingToolPixi (preview + commit)

**Preview** draws directly in `overlayWorld` as a centerline (fast). **Commit** builds a Perfect Freehand polygon using **canonical tuples** and appends the stroke to Yjs.

```ts
class DrawingToolPixi implements PointerTool {
  private overlay = new PIXI.Graphics();
  private id: number | null = null;
  private tuples: [number, number][] = [];

  constructor(private opts: {
    room: RoomDocManager,
    toolType: 'pen'|'highlighter',
    settings: { size: number; color: string; opacity: number },
    overlayWorld: PIXI.Container,
    renderNow: () => void,
    getView: () => ViewTransform,
  }) {
    opts.overlayWorld.addChild(this.overlay);
  }

  begin(pointerId: number, wx: number, wy: number) {
    this.id = pointerId;
    this.tuples = [[wx, wy]];
    const g = this.overlay;
    g.clear();
    g.lineStyle(this.opts.settings.size, parseHex(this.opts.settings.color), this.opts.settings.opacity);
    g.moveTo(wx, wy);
    this.opts.renderNow();
  }

  move(wx: number, wy: number) {
    if (this.id == null) return;
    this.tuples.push([wx, wy]);
    this.overlay.lineTo(wx, wy);
    this.opts.renderNow();
  }

  end(wx?: number, wy?: number) {
    if (this.id == null) return;
    if (wx != null && wy != null) { this.tuples.push([wx, wy]); this.overlay.lineTo(wx, wy); }

    // Build bbox (inflate by size)
    const bbox = computeInflatedBBox(this.tuples, this.opts.settings.size);

    // Build flattened points alongside tuples for compatibility
    const flat: number[] = new Array(this.tuples.length * 2);
    for (let i = 0; i < this.tuples.length; i++) { flat[i*2] = this.tuples[i][0]; flat[i*2+1] = this.tuples[i][1]; }

    this.opts.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const strokes = root.get('strokes');
      const meta = root.get('meta');
      const sceneTicks = meta.get('scene_ticks');
      const currentScene = sceneTicks.length;
      strokes.push([{
        id: ulid(),
        tool: this.opts.toolType,
        color: this.opts.settings.color,
        size: this.opts.settings.size,
        opacity: this.opts.settings.opacity,
        kind: 'freehand',
        points: flat,                // flattened centerline
        pointsTuples: this.tuples,   // canonical PF tuples (authoritative for polygon)
        bbox,
        scene: currentScene,
        createdAt: Date.now(),
        userId: getAwarenessUserId(),
      }]);
    });

    this.overlay.clear();
    this.id = null;
    this.opts.renderNow();
  }

  cancel() { this.overlay.clear(); this.id = null; this.opts.renderNow(); }
}
```
.

---

## Avoiding the “monster” (mount/unmount churn)

* Keep **pointer listeners** attached exactly once to the canvas (no dependencies on transform or tool functions; use refs inside handlers).
* Keep **transform** in a ref and mutate only `world.scale/position`.
* Overlay preview lives in `overlayWorld` so it naturally follows pan/zoom.
* Keep **wheel zoom math** in one place and call `applyTransform()`; do not cause React re-renders during gestures.

---

## Yjs Write Path (Authoritative)

* Capture tuples in world units.
* On commit:

  * compute bbox (inflated by size),
  * assign `scene` using current tick count,
  * push a single stroke item with `{ kind:'freehand', tool, color, size, opacity, points, pointsTuples, bbox, scene, createdAt, userId }`.
* The manager’s providers sync and Snapshot publishes on the next frame.

---

## Open TODOs (post‑Phase‑1)

* Viewport culling by bbox (+ margin),
* LOD to skip <2px strokes in screen space,
* Stroke geometry cache keyed by (id, size) for PF polygon,
* Eraser (dim layer + hit-tests),
* Presence sprites in `overlayHUD`,
* Shapes (polyline pipeline),
* Export + scene ticks UI.

---

## Checklist to Ship Phase 1

* [ ] DOM pointer events on the canvas element with pointer capture and `{ passive:false }`
* [ ] Stable refs for transform, tool manager, and room
* [ ] PIXI app + containers (`world`, `overlayWorld`, `overlayHUD`)
* [ ] DrawingToolPixi (preview + commit with PF tuples)
* [ ] Snapshot subscription → id diff → (re)draw → single render
* [ ] Wheel zoom around cursor + MMB pan preserved
* [ ] No culling/caches yet; keep it straightforward


---

# 0) Ground rules (from your docs I am honoring)

* **No Snapshots in Pixi path.** Truth lives in Yjs; bind Y arrays/maps directly to the Pixi scene graph; render on events (Yjs / awareness / preview / transform). Your `PIXI.md` states this explicitly. 
* **Render-on-event.** No RAF loop; stop the ticker; call `render()` only when something happened. Your doc already lists these triggers. 
* **Pointer + wheel are DOM-first** (capture, `{passive:false}`, wheel-around-cursor) and already work in your 2D path; we keep that exactly when we swap in Pixi.  

Those are the invariants I’m not changing.

---

# 1) The missing piece in `PIXI.md`: **PixiManager** (and how it differs from the Binder)

Your current `PIXI.md` sketches a **RoomBinder** that listens to Yjs and mutates the Pixi scene graph (create/update/destroy display objects), along with some scattered app/containers setup. What’s missing is the **explicit owner** of the runtime and the stable API the rest of the app calls. That owner is **PixiManager**. Think of it as:

* **PixiManager** — life-cycle, stage graph, render scheduling, transform application, binder creation, and a tiny surface the host (React `PixiCanvas`) calls.
* **RoomBinder** — *only* Yjs wiring and scene-graph mutation (strokes/text/presence).

### PixiManager — responsibilities and public API

**Owns & boots PIXI:**

* `PIXI.Application` (ticker stopped), stage, renderer options; creates three containers (see below).
* Stage graph:
  `stage → world (pan/zoom) → [strokes, texts]`, `overlayWorld` (world-space preview), `overlayHUD` (screen-space presence). You already imply this; make it canonical in `PIXI.md`.  

**Creates the binder(s):**

* Instantiates **RoomBinder** with `{ ydoc, awareness, world, overlayHUD }`. Binder attaches **Yjs observers** and mutates scene objects.

**Render scheduling (event-driven only):**

* `render()` is called by: binder (after it handles an event), preview updates from the active tool, presence changes, and `applyTransform()`.

**Applies transform:**

* Mutates only `world.scale` / `world.position` and then `render()`.

**Public API (what `PixiCanvas` or tools call):**

* `mount(view: HTMLCanvasElement)`, `destroy()`
* `applyTransform(scale, pan)`
* `setActiveTool(toolKind)` (so manager can expose the correct **preview targets**: `overlayWorld` for the tool to draw in)
* `renderNow(reason)` — escape hatch for preview/presence

> This is “owner → binder → scene graph”. No snapshots. No per-tx coalescing logic. Just events → mutations → render. Exactly your model. 

---

# 2) **PixiCanvas ⇄ PixiManager** handshake (clear split of concerns)

Your `Canvas.tsx` already *nails* DOM pointer semantics (capture, lost-capture, MMB pan, wheel zoom) and awareness emission. We keep that unchanged and make the connections explicit:

**PixiCanvas (React host) does:**

* **Mount**: create the `<canvas>`, pass it to `PixiManager.mount(view)`.
* **DOM input**: keep all DOM pointer/wheel listeners you already have; on pointer events:

  * Convert to world coords using your current math (invert scale/pan). 
  * Route to the **active tool** (preview only; world-space drawing into `overlayWorld`).
  * On **commit** (pointerup): call `roomDoc.mutate(fn)` (your write path) and **do not** touch Pixi; the binder will hear Yjs and create the node. 
* **Transforms**: compute target zoom/pan (your wheel code) and call `PixiManager.applyTransform(scale, pan)` once per wheel event. 

**PixiManager does:**

* Owns Pixi app/containers, creates RoomBinder, exposes `overlayWorld` to the tool for previews, and calls `render()` when told (or when binder tells it to).

This split lets you preserve all the DOM correctness you’ve already beaten into shape, while making the Pixi runtime a black box you can replace later.

---

# 3) **Yjs observers** in RoomBinder (incremental mapping, no coalescing talk)

You asked for specifics. Here are the observer wires I would **state explicitly in `PIXI.md`**:

* **Strokes (Y.Array of Y.Maps)**

  * `yStrokes.forEach(...)` on mount for initial build (respect `scene`).
  * `yStrokes.observe(e => { for each delta: insert/delete/move → apply; render(); })`

    * **Insert**: create a `Graphics` and draw the stroke.
    * **Delete**: destroy/remove `Graphics` by id (see “ids” note below).
    * **Move**: if array reorders, we can re-add children in order or ignore (z-order stable if you don’t depend on index).
  * `yStrokes.observeDeep(events => { for each map change → update; render(); })`

    * **Style** (color/opacity/width) → mutate `Graphics` styling or rebuild only if width affects PF geometry.
    * **Geometry** (`pointsTuples` or `size`) → rebuild that one stroke’s geometry and update its `Graphics`.

  Your current `PIXI.md` has the right *shape* but draws **freehand** incorrectly (centerline). I’ll fix that in §4 and propose exact text to replace. 

* **Meta / scene ticks (Y.Map / Y.Array)**

  * `meta.observe` → recompute `currentScene` = `scene_ticks.length`, set `graphics.visible = (stroke.scene === currentScene)` (no rebuild), then `render()`. (You already call this out.) 

* **Awareness**

  * `awareness.on('change', ...)` → update HUD cursors and `render()` (you already have this pattern in the doc).  

> **Important:** you said “the idea of the observers and the delta is just to incrementally find out what has changed… skip some of the mapping logic.” Agreed. The above is that: **handle each delta in place and render.** No per-transaction aggregator. Full stop.

---

# 4) Fix the **Perfect Freehand** section in `PIXI.md` (Get SVG from outline)

Right now your `createStrokeGraphics` for `freehand` does:

```ts
g.poly(stroke.points)  // “points are tuples”
g.fill({ color, alpha })
```

That is wrong for PF: it draws/ﬁlls a **centerline** polygon, not the PF **outline**. Your own overview shows the correct PF pipeline: **tuples → outline → `getSvgPathFromStroke(outline, closed?)` → Path2D/SVG**.  

Here’s the precise correction you should bake into `PIXI.md`:

### 4.1 Canonical shape (authoritative)

* **Store** `pointsTuples: [x,y,(pressure?)][]` as the canonical stroke input.
* **Compute** `outline = getStroke(pointsTuples, { …PF_OPTIONS_BASE, size, last: true })`.
* **Build SVG path**: `const d = getSvgPathFromStroke(outline, /* closed? see below */)` — you already have this utility in your overview code. 

### 4.2 Rendering in **Pixi** (v8+ recommended)

* Pixi v8 can **parse SVG** into vector geometry directly, either via `Graphics.svg(<svg>...</svg>)` or via `GraphicsPath` constructed from an SVG path string. This lets us use your **SVG path as the canonical** and avoid bespoke polygon drawing. ([pixijs.com][1])
* So for each stroke (create or geometry-update):

  * Build `const svg = \`<svg xmlns="[http://www.w3.org/2000/svg\">](http://www.w3.org/2000/svg\%22>)<path d="${d}" fill="${hex}" fill-opacity="${alpha}"/></svg>`;`
  * Apply to a single `Graphics`:

    * **Option A (simple):** `g.clear(); g.svg(svg);`
    * **Option B (path-only):** construct a `GraphicsPath` from `d` and add it to `g`.

> **Version note**: if you’re on Pixi v7, there’s no built-in `graphics.svg`; either (a) use a small SVG-path→graphics parser or (b) temporarily draw the PF **outline** as a polygon fill (`beginFill` + `moveTo/lineTo`) until you jump to v8. (Built-in polygon drawing has always been supported. ([pixijs.download][2]))

### 4.3 “Closed” or not?

Your overview’s PF note says: *“Do NOT close the path — PF outline is complete.”* i.e. `getSvgPathFromStroke(outline, false)`. Keep that choice consistent with your renderer elsewhere (you already use that value for Path2D in the base canvas). 
If you hit fill oddities in SVG parsing, you can toggle `closed=true` (adds `Z`)—PF’s outline typically returns to the start anyway. Either way, the **outline** is the source; we never fill a centerline.

### 4.4 Concrete `PIXI.md` edits (freehand)

Replace this block in your doc (freehand create): 

```diff
- if (stroke.kind === 'freehand') {
-   g.poly(stroke.points); // points are tuples
-   g.fill({ color: stroke.color, alpha: stroke.opacity });
- }
+ if (stroke.kind === 'freehand') {
+   const outline = getStroke(stroke.pointsTuples, {
+     ...PF_OPTIONS_BASE,
+     size: stroke.size,
+     last: true,
+   });
+   const d = getSvgPathFromStroke(outline, /* closed? */ false);
+   // Pixi v8 path: keep SVG canonical
+   g.clear();
+   g.svg(`<svg xmlns="http://www.w3.org/2000/svg">
+            <path d="${d}" fill="${toHex(stroke.color)}" fill-opacity="${stroke.opacity}"/>
+          </svg>`);
+ }
```

(Where `PF_OPTIONS_BASE` and your `getSvgPathFromStroke` impl are exactly as in your overview. )

---

# 5) Stroke updates (what changes redraw vs restyle)

Make this explicit in `PIXI.md` so the Binder logic is obvious:

* **Geometry changes** → recompute outline + SVG path; re-apply `g.svg(...)`.

  * Triggers: `pointsTuples`, `size` (PF polygon depends on width).
* **Style-only changes** → do not recompute outline; just re-apply fill / alpha.

  * Triggers: `color`, `opacity`.

This is consistent with your own PF caching/render pipeline in the overview (width + points drive geometry; color/opacity don’t). 

---

# 6) ID mapping and deletion

Call this out in `PIXI.md` to avoid hand-waving:

* Maintain a **Map `strokeId → Graphics`**. On `insert`, create Graphics and store; on `delete`, `graphics.destroy()` + `world.removeChild(g)` + `map.delete(id)`.
* For deletes, Yjs `changes.delta` does not give the actual deleted **objects**—so either (a) store ids elsewhere (e.g., a parallel Y.Map index) or (b) capture ids through your own write path (e.g., write a tombstone structure or a last-known id list). Your current pseudo-code glosses over this part; add a sentence acknowledging the id source. 

---

# 7) Presence (overlayHUD) stays screen-space

You already have a correct pattern: awareness `change` → update HUD nodes (dot + label), convert world → screen using current transform, `render()`. Keep that and make it explicit that **tools own overlayWorld** (preview) while **binder owns overlayHUD** (presence).  

---

# 8) Make the container/layer story explicit (it’s correct—just finalize it)

In `PIXI.md`, collapse the scattered notes into one “Container Structure” section:

* `world` — all committed content; **only** this gets scale/position (pan/zoom).
* `overlayWorld` — world-space previews (so previews line up with content under zoom).
* `overlayHUD` — screen-space presence (labels stay crisp). 

This mirrors your 2-canvas split in `Canvas.tsx` (base vs overlay) even though we’re in a single Pixi stage. 

---

# 9) Versioning call (so the GetSVG plan actually runs)

Because you insist on **GetSVG from Outline** as the canonical stroke—and I agree—**prefer Pixi v8** here. v8 has first-party SVG→Graphics parsing; you can feed it an `<svg><path d="…"></svg>` and it builds vector geometry (no rasterization), exactly what you want for PF. ([pixijs.com][1])

If you must ship on v7, say so in `PIXI.md` and give the fallback:

* “For v7, we temporarily draw the PF outline as a polygon fill; when we upgrade to v8 we will switch to `Graphics.svg(...)` and keep the SVG path as the canonical geometry.” ([pixijs.download][3])

---

# 10) Precise edits I would land in your `PIXI.md` now

1. **Add a “PixiManager” section** (before the Binder): responsibilities, stage graph ownership, render scheduling, public API, and the fact that tools draw only in `overlayWorld`. (Binder owns Yjs observers and committed nodes.) 
2. **Replace the Freehand draw code** as in §4.4; remove centerline fill. 
3. **Spell out the observer set** and when to call `render()` (after each event), including `observeDeep` for maps (style/geometry edits). (You already have a partial; make it explicit.) 
4. **Document update policy**: geometry vs style (recompute path vs restyle only). 
5. **Add the deletion note** (how ids are discovered) so the binder can actually remove Graphics. 
6. **Lock the layer model** (world / overlayWorld / overlayHUD) in one place and tie it to who owns what (tools vs binder). 

---

# 11) Why this meets your prompt

* You asked: *“how do we wire the Yjs observers and draw the strokes.”*
  → I’ve laid out the exact observers (`observe`, `observeDeep`) and the exact create/update/destroy policy for strokes, including PF outline → **GetSVG** and how to feed it into **Pixi**. (No snapshots, no transaction coalescing beyond what Yjs already does.)  
* You asked: *“how the Pixi canvas should initialize, create the tool manager ref, handle pointer events, create a preview/commit container, and wire Yjs.”*
  → I separated **PixiManager** (init/runtime/render) from **RoomBinder** (Yjs) and made **PixiCanvas** responsibilities explicit: DOM events flow exactly like your current Canvas, preview draws in **overlayWorld**, commit writes to Y, binder updates Pixi.  
* You said: *“we use GetSVG from Outline; the polygon approach is wrong.”*
  → Corrected. And because Pixi v8 understands SVG paths as vector graphics, we can keep **SVG path as canonical** while rendering purely vector in Pixi (no raster sprites). ([pixijs.com][1]) 

---

Alright—clean, systematic, zero hand-waving. Here’s exactly what you asked for:

---

# What to install for **PixiJS v8**

* **Minimal**:

  ```bash
  npm install pixi.js@^8
  ```

  (Pixi v8 reverted to a **single package**; you import from `"pixi.js"`.) ([PixiJS][1])

* **Pin to a current v8 release** (as of today):

  ```bash
  npm install pixi.js@8.14.0
  ```

  (Official release notes use this exact `npm install` form and show the current series.) ([GitHub][2])

* **SVG path rendering in v8**: `Graphics().svg(<svg-string>)` is supported directly in v8, so you can feed your **GetSVG-from-Stroke** output into Pixi **as a path**, not a polygon. ([PixiJS][3])

---

# How the pieces connect (RoomDocManager ⇄ RoomBinder ⇄ PixiManager ⇄ PixiCanvas)

You said **no snapshots for the Pixi path** and **use Yjs observers for incremental mapping**. The RoomDocManager you shared already encapsulates Yjs, awareness, mutate(), etc., but does **not** expose raw Y types (by design). We’ll keep that encapsulation and introduce **one narrow adapter** for the binder.

* **RoomDocManager** (existing): the collaboration authority; exposes `mutate`, presence updates, and subscriptions, hides Y internals. 
* **RoomBinder** (new, renderer-facing): attaches **Yjs observers** to `root.strokes` (and `meta.scene_ticks`), and **mutates Pixi scene objects** incrementally (create/update/destroy) per event. **No per-transaction coalescing.**
* **PixiManager** (new): owns the **Pixi app**, stage graph (`world`, `overlayWorld`, `overlayHUD`), and **render scheduling** (event-driven only). It constructs the RoomBinder with a **read-only Y access adapter** and a `renderNow()` callback.
* **PixiCanvas (React host)**: your DOM pointer/wheel glue (unchanged), gets a manager instance via `useRoomDoc(roomId)` + `new PixiManager(...)`, uses `room.mutate(...)` on commit; preview is drawn in `overlayWorld`.

> The only addition to RoomDocManager is a **tiny, read-only adapter** that RoomBinder uses to reach `root.strokes` / `meta` and attach observers. Everything else stays exactly as you’ve architected it. 

---

# Pseudocode — **useRoomDoc hook wiring**

```ts
// React host — logic only (no DOM code here)
function PixiCanvasHost({ roomId }: { roomId: string }) {
  // Get the collaboration authority
  const room = useRoomDoc(roomId); // returns IRoomDocManager

  // Create once
  const pixiMgrRef = useRef<PixiManager | null>(null);
  if (!pixiMgrRef.current) {
    pixiMgrRef.current = new PixiManager({
      room,
      getSvgPathFromStroke,      // your canonical GetSVG-from-Outline
      pfOptionsBase: { /* your PF base options */ },
    });
  }

  // On mount: PixiManager.mount(<canvas>) happens in your actual canvas component.
  // On unmount:
  useEffect(() => () => pixiMgrRef.current?.destroy(), []);

  // DOM event handlers you already have will call:
  // - room.mutate(...) to commit strokes
  // - pixiMgrRef.current.applyTransform(scale, pan) on wheel/pan
  // - pixiMgrRef.current.renderNow('preview') on local tool preview
}
```

---

# Pseudocode — **PixiManager** (owner of Pixi runtime & binder)

```ts
type PixiManagerOpts = {
  room: IRoomDocManager;                       // from useRoomDoc

};

class PixiManager {
  private app: Application;
  private world = new Container();
  private overlayWorld = new Container();      // world-space previews
  private overlayHUD = new Container();        // screen-space presence
  private binder: RoomBinder;

  constructor(private opts: PixiManagerOpts) {
    // 1) Create Pixi app (v8 single package)
    //    (Stop the ticker; render on demand)
    this.app = new Application();
    this.app.ticker.stop?.();

    // 2) Stage graph
    this.app.stage.addChild(this.world);
    this.world.addChild(this.overlayWorld);
    this.app.stage.addChild(this.overlayHUD);

    // 3) Make a very narrow read-only Y adapter for the binder.
    //    We do NOT leak Y.Doc elsewhere.
    const yAccess: YAccess = this.createReadOnlyYAccess(opts.room);

    // 4) Construct binder with containers and callbacks
    this.binder = new RoomBinder({
      y: yAccess,
      containers: { world: this.world, overlayHUD: this.overlayHUD },
      renderNow: () => this.renderNow('binder'),
    });
  }

  mount(view: HTMLCanvasElement) {
    // Bind to the <canvas>
    this.app.init({ view, antialias: true /* + any DPR/resolution policy you use */ });
    // Attach Y observers
    this.binder.attach();
    // Initial render (after initial build)
    this.renderNow('mount');
  }

  destroy() {
    this.binder.detach();
    this.app.destroy(true, { children: true });
  }

  applyTransform(scale: number, pan: {x:number;y:number}) {
    this.world.scale.set(scale);
    this.world.position.set(-pan.x * scale, -pan.y * scale);
    this.renderNow('transform');
  }

  renderNow(_reason: string) {
    this.app.renderer.render(this.app.stage);
  }

  // The only bridge the binder needs: *read-only* reach into the
  // specific Y containers + observe/unobserve helpers.
  private createReadOnlyYAccess(room: IRoomDocManager): YAccess {
    // Provide a strictly limited capability surface; your impl can be:
    //   - a privileged method inside RoomDocManager, or
    //   - a tiny internal module that closes over manager.ydoc.
    // DO NOT expose the Y.Doc anywhere else.
    return {
      getRoot: () => /* Y.Map<unknown> */      __internal__getRoot(room),
      getMeta: () => /* Y.Map<unknown> */      __internal__getMeta(room),
      getStrokes: () => /* Y.Array<Stroke> */  __internal__getStrokes(room),
      observe: (target, fn) => target.observe(fn),
      observeDeep: (target, fn) => target.observeDeep(fn),
      unobserve: (target, fn) => target.unobserve(fn),
      unobserveDeep: (target, fn) => target.unobserveDeep(fn),
    };
  }

  // Expose preview target for tools (world-space overlays)
  getOverlayWorld(): Container { return this.overlayWorld; }
}
```

> Why an adapter? Your manager’s interface intentionally hides Y internals (good!). We keep that by adding an **internal, read-only bridge** used only by the renderer path; no snapshots involved; `mutate()` remains the only write path for tools. 

---

---

# Pseudocode — **Commit path** (how tools write; binder renders)

*(For completeness; this is the bit your DOM tool calls—unchanged from your intent.)*

```ts
// On pointerup (pen), the host/tool commits through the manager:
room.mutate((ydoc) => {
  const root = ydoc.getMap('root');
  const strokes = root.get('strokes') as Y.Array<Stroke>;

  const tuples: [number,number][] = collectedPoints;  // world units
  const bbox = computeInflatedBBox(tuples, size);

  strokes.push([{
    id: ulid(),
    kind: 'freehand',
    tool: 'pen',
    color, size, opacity,
    points: flatten(tuples),         // optional legacy field; NOT used for PF geometry
    pointsTuples: tuples,            // authoritative PF input
    bbox,
    scene: (root.get('meta').get('scene_ticks') as Y.Array<number>).length,
    createdAt: Date.now(),
    userId: getLocalUserId(),
  }]);
});

// The binder hears the Yjs insert delta, builds the PF SVG path,
// updates/creates the Graphics, and PixiManager.renderNow() is called.
```

---

## What to literally change in your `PIXI.md`

1. Add a **“PixiManager”** section (owner of app, stage, render policy) and show the public API used by the host; keep `world / overlayWorld / overlayHUD` as the canonical three layers (pan/zoom only on `world`).
2. Replace any freehand example that does `g.poly(points); g.fill(...)` with the **PF-outline → SVG path → `Graphics().svg(...)`** flow (or a polygon fallback if you temporarily stay on v7). ([PixiJS][4])
3. Spell out the **Yjs observers** you’re wiring:

   * `strokes.observe(…)` for insert/delete/move;
   * `strokes.observeDeep(…)` for in-place map edits (style / pointsTuples / size);
   * `meta.observe(…)` to recompute `currentScene` and flip `visible`;
   * Call `renderNow()` after each observer event (no transaction fusion).
4. Document the **read-only Y adapter** (narrow capability just for the binder) to preserve RoomDocManager encapsulation. 

---

## Final notes on imports (Pixi v8)

* Import from the single package:

  ```ts
  import { Application, Container, Graphics } from "pixi.js";
  ```

  (This reflects the v8 **single-package** structure.) ([PixiJS][1])

* Feeding **SVG**:

  ```ts
  const g = new Graphics().svg(`<svg ...><path d="${d}" .../></svg>`);
  ```

  (Exactly how the v8 docs and examples demonstrate SVG usage.) ([PixiJS][4])

---


You’re right. I put the PF SVG path logic in the wrong conceptual place. It belongs **only** where we *materialize geometry*—i.e., when we create a Pixi `Graphics` for a stroke (and again only if geometry changes). It does **not** belong in unrelated update paths or presence/scene logic. Your own notes reinforce that the PF outline → **GetSVGFromStroke** is the canonical geometry step, and that the filled polygon must come from **PF outline**, not the centerline—exactly as you wrote in your overview (use `getSvgPathFromStroke(outline, false)`, do **not** close the path)  .

Also: your current `PIXI.md`’s freehand snippet **does** fill a centerline (`g.poly(stroke.points)`), which is the bug you called out. We will replace that with “PF outline → SVG path → apply to Graphics” **only in the stroke materializer**. (See the patch at the end.) 

Below is a no-BS, explicit wiring plan that matches your files, followed by precise pseudocode for **PixiManager** and **RoomBinder**, and a targeted patch for `PIXI.md`.

---

# 0) Install for Pixi v8

Use the single-package v8 form:

```bash
npm install pixi.js@^8
```

Import like:

```ts
import { Application, Container, Graphics } from "pixi.js";
```

*(No need to pin a patch here; v8 is a single package and exposes `Graphics.svg(...)` in v8.)*

---

# 1) Roles and boundaries (as they should be in your repo)

* **RoomDocManager** (you already have it): the authority over Y.Doc/Awareness; provides `mutate()`; owns transport/storage; React code gets it via `useRoomDoc(roomId)`.  
* **PixiManager**: owns the Pixi `Application`, the three containers (`world`, `overlayWorld`, `overlayHUD`), render policy, and constructs a **RoomBinder**. It exposes a minimal API to the React host (mount/destroy, applyTransform, renderNow, getOverlayWorld).
* **RoomBinder**: attaches **Yjs observers** to *only* the collections it cares about (strokes now; texts later). On Y deltas, it:

  * **Insert** → *materialize* stroke: build PF outline → **getSvgPathFromStroke** → apply to a `Graphics`, add to `world`.
  * **Delete** → destroy/remove the `Graphics`.
  * **Update** → if **geometry-affecting** (`pointsTuples`, `size`), **re-materialize geometry** (re-run PF + path); if **style-only** (`color`, `opacity`), restyle (no PF call).
  * Then **render once** at the end of handling that observer call (you explicitly *do not* want transaction-level coalescing; fine).
* **PixiCanvas (React host)**: your DOM pointer/wheel glue stays as-is; **preview** draws into `overlayWorld` (world space) and **commit** goes through `room.mutate()`. Presence stays in `overlayHUD`. See your current pointer/wheel patterns—they already do the right thing.  

This matches your stated architecture: one **Graphics per stroke**, built from PF outline; no snapshot layer on the Pixi path; event-driven render; three-layer stage. (And yes, the specific buggy bit in `PIXI.md` is the centerline fill we’re replacing.)  

---

# 2) Wiring `useRoomDoc` → PixiManager → RoomBinder

## Use hook in host (sketch)

```ts
function PixiCanvasHost({ roomId }: { roomId: string }) {
  const room = useRoomDoc(roomId);           // IRoomDocManager (your API)

  const pixi = useRef<PixiManager>();
  if (!pixi.current) {
    pixi.current = new PixiManager({
      room,
      // optional: you can pass a read-only Y access adapter if RoomDocManager
      // exposes one internally; otherwise PixiManager itself will obtain it.
    });
  }

  // DOM events keep doing what your Canvas.tsx does today:
  // - preview draws in overlayWorld via a tool (not shown here)
  // - commit uses room.mutate(() => strokes.push(...))

  useEffect(() => () => pixi.current?.destroy(), []);
}
```

*(This preserves your DOM event model; we’re not rewriting that.)* See your existing pointer/lost-capture/wheel code.  

---

# 3) **PixiManager** pseudocode (no snapshots, event-driven)

```ts
type PixiManagerOpts = { room: IRoomDocManager };

class PixiManager {
  private app: Application;
  private world = new Container();
  private overlayWorld = new Container();
  private overlayHUD = new Container();
  private binder: RoomBinder;

  constructor(private opts: PixiManagerOpts) {
    this.app = new Application();         // v8 single package
    this.app.ticker.stop?.();

    // Stage graph
    this.app.stage.addChild(this.world);
    this.world.addChild(this.overlayWorld);   // world-space preview
    this.app.stage.addChild(this.overlayHUD); // screen-space presence

    // Create binder. Internally, it will attach Y observers and
    // call back into renderNow() after each change it handles.
    this.binder = new RoomBinder({
      y: this.getReadOnlyYAccess(opts.room),  // minimal internal bridge
      world: this.world,
      overlayHUD: this.overlayHUD,
      renderNow: () => this.renderNow('binder'),
    });
  }

  mount(view: HTMLCanvasElement) {
    this.app.init({ view, antialias: true });
    this.binder.attach();       // initial materialization from current Y state
    this.renderNow('mount');
  }

  destroy() {
    this.binder.detach();
    this.app.destroy(true, { children: true });
  }

  applyTransform(scale: number, pan: {x:number;y:number}) {
    this.world.scale.set(scale);
    this.world.position.set(-pan.x * scale, -pan.y * scale);
    this.renderNow('transform');
  }

  getOverlayWorld(): Container { return this.overlayWorld; } // for tool preview

  private renderNow(_reason: string) {
    this.app.renderer.render(this.app.stage);
  }

  // Create a *read-only* Y access bridge for the binder.
  private getReadOnlyYAccess(room: IRoomDocManager): YAccess {
    // This can be implemented inside the same module as RoomDocManager
    // to legally reach its internals without exposing them globally.
    return __internal__createReadOnlyYAccess(room);
  }
}
```

> Note: that tiny **read-only Y adapter** is the only “bridge” the binder needs. It preserves your encapsulation and still lets the binder attach to `root.strokes` and `meta.scene_ticks`. (You already type-alias Y arrays/maps internally.) 

---

# 4) **RoomBinder** pseudocode (Y observers → Pixi scene)

The **only** places where **Perfect Freehand** outline and `getSvgPathFromStroke` are used are:

* `materializeStroke(s)` — when an insert arrives (first creation of Graphics).
* `updateStrokeGeometry(s)` — when **geometry changes** (`pointsTuples` or `size`).

They are **not** called for presence changes, scene filter flips, color/opacity-only updates, or awareness updates.

```ts
type RoomBinderCtor = {
  y: YAccess;
  world: Container;
  overlayHUD: Container;
  renderNow: () => void;
};

class RoomBinder {
  private world: Container;
  private y: YAccess;
  private renderNow: () => void;

  private currentScene = 0;
  private strokeGfx = new Map<string, Graphics>();  // id -> Graphics

  constructor({ y, world, overlayHUD, renderNow }: RoomBinderCtor) {
    this.world = world;
    this.y = y;
    this.renderNow = renderNow;
  }

  attach() {
    const root = this.y.getRoot();
    const meta = this.y.getMeta();
    const yStrokes = this.y.getStrokes();

    // Init scene + initial materialization
    this.currentScene = getCurrentScene(meta);   // scene_ticks.length
    yStrokes.forEach((s) => this.materializeStroke(s));
    this.renderNow();

    // Array splices (insert/delete/move)
    this.y.observe(yStrokes, (ev) => {
      for (const d of ev.changes.delta) {
        if (d.insert) for (const s of d.insert as Stroke[]) this.materializeStroke(s);
        if (d.delete) removeDeletedByIndexRange(this.strokeGfx, yStrokes, d);
      }
      this.renderNow();
    });

    // In-place edits on a stroke (map changes): style or geometry
    this.y.observeDeep(yStrokes, (events) => {
      for (const e of events) {
        if (!isStrokeMapChange(e)) continue;
        const s = toStroke(e.target);              // POJO snapshot of the Y.Map

        // Geometry-affecting?
        if (e.keysChanged.has('pointsTuples') || e.keysChanged.has('size')) {
          this.updateStrokeGeometry(s);            // **PF outline + GetSVG ONLY here**
        } else if (e.keysChanged.has('color') || e.keysChanged.has('opacity')) {
          this.updateStrokeStyle(s);               // restyle; NO PF call
        }
      }
      this.renderNow();
    });

    // Scene ticks → visibility only
    this.y.observe(meta, () => {
      const next = getCurrentScene(meta);
      if (next === this.currentScene) return;
      this.currentScene = next;
      for (const [id, g] of this.strokeGfx) {
        const s = findStrokeById(this.y.getStrokes(), id);
        g.visible = !!s && s.scene === this.currentScene;
      }
      this.renderNow();
    });

    // Awareness → overlayHUD cursors (not shown); ends with renderNow()
  }

  detach() {
    // unobserve handlers (store them when attaching)
  }

  // ————— MATERIALIZATION —————

  private materializeStroke(s: Stroke) {
    // Create once
    let g = this.strokeGfx.get(s.id);
    if (!g) {
      g = new Graphics();
      this.strokeGfx.set(s.id, g);
      this.world.addChild(g);
    }

    // Scene filter
    g.visible = (s.scene === this.currentScene);

    if (s.kind === 'freehand') {
      this.updateStrokeGeometry(s, g);  // PF outline + GetSVG happens **here**
      this.updateStrokeStyle(s, g);     // sets color/opacity (no PF)
    } else {
      // Future shapes: stroke a polyline, no PF
      drawPolylineGeometryIntoGraphics(g, s.points, s.size);
      this.updateStrokeStyle(s, g);
    }
  }

  private updateStrokeGeometry(s: Stroke, g?: Graphics) {
    const node = g ?? this.strokeGfx.get(s.id);
    if (!node) return;

    // Build Perfect Freehand outline from canonical tuples
    const outline = getStroke(s.pointsTuples, {
      thinning: 0.60, smoothing: 0.6, streamline: 0.5, simulatePressure: true,
      size: s.size, last: true,
    });

    // Convert to SVG path **once** here
    const d = getSvgPathFromStroke(outline, /* closed */ false); // your overview rule
    node.clear();

    // Pixi v8: feed SVG directly (keeps geometry canonical)
    node.svg(`<svg xmlns="http://www.w3.org/2000/svg">
               <path d="${d}" fill="#000" />
              </svg>`);
  }

  private updateStrokeStyle(s: Stroke, g?: Graphics) {
    const node = g ?? this.strokeGfx.get(s.id);
    if (!node) return;
    // If Pixi's `Graphics.svg` doesn’t expose dynamic restyle,
    // simplest is to re-call `node.svg(...)` with same `d` and new attrs,
    // or (better) cache `d` per strokeId and rebuild node.svg quickly.
    node.alpha = s.opacity;             // quick, safe
    // For color: either rebuild `node.svg` with new fill, or keep a
    // path ref if you wrap this in a small helper.
  }
}
```

> **Key compliance with your request:** `getSvgPathFromStroke` is **only** used in `updateStrokeGeometry()` (called by `materializeStroke()` and when geometry changes). It is **not** in unrelated observer paths, not in presence, not in color/opacity-only updates. This corrects the current `PIXI.md` bug where freehand is drawn by filling a centerline (`g.poly(stroke.points)`) instead of PF polygon. 

---

# 5) Exact fix you should apply to `PIXI.md` (freehand block)

Replace the buggy centerline fill:

> Current (incorrect):
> `g.poly(stroke.points); g.fill({ color: stroke.color, alpha: stroke.opacity });` 

With the **materialization-time** PF outline → SVG path:

```diff
- if (stroke.kind === 'freehand') {
-   // Perfect Freehand polygon - fill only
-   g.poly(stroke.points); // points are tuples
-   g.fill({ color: stroke.color, alpha: stroke.opacity });
- } else {
+ if (stroke.kind === 'freehand') {
+   // Build PF outline **only here** (materialization) and draw via SVG path.
+   const outline = getStroke(stroke.pointsTuples, {
+     thinning: 0.60, smoothing: 0.6, streamline: 0.5, simulatePressure: true,
+     size: stroke.size, last: true,
+   });
+   const d = getSvgPathFromStroke(outline, /* closed */ false); // per overview
+   g.clear();
+   g.svg(`<svg xmlns="http://www.w3.org/2000/svg">
+            <path d="${d}" fill="${toHex(stroke.color)}" fill-opacity="${stroke.opacity}"/>
+          </svg>`);
+ } else {
    // Shape...
```

This aligns `PIXI.md` with your overview’s PF pipeline and the “do not close path; PF already provides complete outline” rule.  

---

# 6) Where **not** to call PF/`getSvgPathFromStroke`
* **Not** in presence/HUD updates.
* **Not** on color/opacity-only updates (style-only). Your overview already says style-only edits do **not** invalidate geometry; we stick to that. 
* **Not** when flipping scenes (visibility only).
* **Not** for centerline-based shapes (future polyline tools).

Only **materialization** and **geometry changes** for freehand invoke PF + SVG.

---

## TL;DR (what I’m changing in your doc)

* Add explicit **PixiManager** section (owner of app/containers/render, builds RoomBinder).
* In **RoomBinder**, wire Y observers exactly as above; call `renderNow()` after each observed event (no tx coalescing).
* Fix **freehand** drawing: use PF outline → `getSvgPathFromStroke(outline, false)` → `Graphics.svg(<svg>)` **inside** `materializeStroke()` (and `updateStrokeGeometry()`), nowhere else. Replace the current centerline fill. 
* Keep your DOM pointer/wheel logic unchanged in host; preview draws into `overlayWorld` and commit goes to Y via `mutate()`.  


