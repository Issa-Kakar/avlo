# Two‑Canvas Presence Overlay Refactor — End‑to‑End Implementation Guide

> Goal: Split presence rendering (cursors, labels, trails, HUD‑adjacent chrome) onto a dedicated overlay `<canvas>` so presence updates no longer force a full redraw (or dirty‑rect inflation) of the heavy world content. This removes the need to `invalidateAll` on presence‑only frames, unlocks dirty‑rect optimizations for the base canvas, and improves visual feel on dense boards.

---

## TL;DR Architecture

* **Two canvases stacked** inside the existing stage container:

  * **Base canvas** → World content (strokes, shapes, text, authoring overlays, preview). Uses **DirtyRect**.
  * **Overlay canvas** → Presence only (cursors + trails, and optionally HUD). **Always full‑clear** when presence is invalidated; no dirty‑rects here.
* **Two render loops** (small & decoupled):

  * `RenderLoop` (existing) drives the base canvas.
  * `OverlayRenderLoop` (new) is tiny and draws presence in **screen space** under DPR only; it subscribes to **presence** + **transform/resize**.
* **RoomDocManager** keeps publishing Snapshots on **doc‑dirty** only; **presence‑only** updates **no longer** rebuild/publish Snapshots. UI reads presence via `subscribePresence` for the overlay.
* **Z‑index**: overlay sits above base (`z-index: 2`) and is `pointer-events: none` so it never steals input.

---

## Why this works

* Presence UI is inexpensive to redraw: tiny glyphs + labels + short trails, all in **screen space**. We can afford a full clear of the overlay every presence tick.
* Heavy world content stays under the existing **DirtyRectTracker**; presence updates no longer mark large regions as dirty or force `invalidateAll('snapshot-update')`.
* **Transform changes** (pan/zoom) are handled by *both* loops: base falls back to full clear or tile strategy; overlay is fully cleared and redrawn in screen space (presence positions re‑project with new transform).

---

## File‑by‑file plan

> The steps below are ordered for a minimal, low‑risk refactor.

### 1) `CanvasStage.tsx` — enable stacking two canvases

You already expose `getCanvasElement()`, DPR handling, `withContext()`, and a robust ResizeObserver. We can reuse the same component twice. Ensure the wrapper allows stacking:

```tsx
// Parent layout (container around both stages)
<div className="stage-root" style={{ position: 'relative' }}>
  {/* Base stage */}
  <CanvasStage ref={baseStageRef} className="base-canvas" style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
  {/* Overlay stage */}
  <CanvasStage ref={overlayStageRef} className="overlay-canvas" style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }} />
</div>
```

> Notes
>
> * `pointerEvents: 'none'` ensures overlay never swallows pointer events.
> * The overlay stage keeps its own DPR & resize notifications; we’ll forward both to the corresponding loops.

### 2) `renderer/OverlayRenderLoop.ts` — new tiny loop for presence

Create a minimal loop dedicated to presence. It does **no** world transforms and **no** dirty‑rect tracking — just full clears on demand.

```ts
// renderer/OverlayRenderLoop.ts
import type { PresenceView, Snapshot, ViewTransform } from '@avlo/shared';

export type OverlayLoopConfig = {
  stage: {
    withContext: (fn: (ctx: CanvasRenderingContext2D) => void) => void;
    clear: () => void; // clears the **entire** canvas backing store
  };
  getView: () => ViewTransform;           // pan/scale for projecting world→screen
  getViewport: () => {                     // for HUD/pixel metrics
    cssWidth: number; cssHeight: number; dpr: number;
  };
  getGates: () => { awarenessReady: boolean; firstSnapshot: boolean }; // draw guard
  getPresence: () => PresenceView;         // latest presence view (throttled)
  drawPresence: (
    ctx: CanvasRenderingContext2D,
    presence: PresenceView,
    view: ViewTransform,
    viewport: { cssWidth: number; cssHeight: number; dpr: number },
  ) => void;
};

export class OverlayRenderLoop {
  private config: OverlayLoopConfig | null = null;
  private rafId: number | null = null;
  private needsFrame = false;

  start(config: OverlayLoopConfig) { this.config = config; }
  stop() { if (this.rafId) cancelAnimationFrame(this.rafId); this.rafId = null; this.needsFrame = false; }

  /** Presence/transform/resize events call this */
  invalidateAll() { if (!this.needsFrame) { this.needsFrame = true; this.schedule(); } }

  private schedule() {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.needsFrame = false;
      this.frame();
    });
  }

  private frame() {
    if (!this.config) return;
    const { stage, getView, getViewport, getPresence, getGates, drawPresence } = this.config;
    const gates = getGates();
    if (!gates.awarenessReady || !gates.firstSnapshot) return; // not ready to draw presence

    // FULL CLEAR each overlay frame; overlay is cheap
    stage.clear();

    const view = getView();
    const vp = getViewport();
    const presence = getPresence();

    stage.withContext((ctx) => {
      // withContext already applied DPR in CanvasStage — draw in CSS pixels
      drawPresence(ctx, presence, view, vp);
    });
  }
}
```

> Implementation nits
>
> * `stage.clear()` calls underlying `ctx.clearRect(0, 0, width, height)` in device pixels (CanvasStage already knows DPR and actual buffer size).
> * Keep this loop tiny: rAF scheduling + a single pass. No stats unless you want dev logging.

### 3) `renderer/layers/presence-cursors.ts` — reuse as‑is

* The existing `drawPresenceOverlays()` / `drawCursors()` already operate in **screen space** with DPR awareness and read **PresenceView** + `ViewTransform` for projection. Call the exact same function from the overlay loop.
* If labels/HUD were drawn in the same pass before, you may choose to keep HUD on the overlay as well (optional; see §6).

### 4) `renderer/RenderLoop.ts` — disable presence pass for the base loop

Currently the base loop includes a 2nd pass for presence (screen‑space). Guard it behind a config flag so the base loop no longer draws presence:

```diff
 export type RenderLoopConfig = {
   // ...existing...
   getGates: () => GateStatus;
+  drawPresenceInThisLoop?: boolean; // default true for backwards compat
 };

 // inside frame():
- // Pass 2: Presence overlays (screen space)
- stage.withContext((ctx) => { /* drawPresenceOverlays + HUD */ });
+ if (this.config.drawPresenceInThisLoop !== false) {
+   stage.withContext((ctx) => { /* drawPresenceOverlays + HUD */ });
+ }
```

* In the new world, we will instantiate the base loop with `drawPresenceInThisLoop: false`. The overlay loop will draw presence.

### 5) `RoomDocManager` — decouple presence from snapshot publishing

Minimal change for **Phase 7.1** of this refactor:

* Keep `PresenceView` derivation and `subscribePresence` as is.
* **Change the publish rule** so **presence‑only** frames do **not** rebuild/publish a new `Snapshot`. Two easy heuristics:

  1. Track a `docDirty` bit and a `presenceDirty` bit. On rAF, build **Snapshot** only if `docDirty` is set. Always notify `presenceSubscribers` when presence is throttled/ready.
  2. Or, check `nextDocVersion !== current.docVersion` before snapshot rebuild.

This preserves the invariant that **renderers read frozen Snapshots**, but we stop forcing them to full‑clear on awareness noise. The overlay loop listens to `subscribePresence` directly.

> Optional safety: keep a feature flag `PUBLISH_SNAPSHOT_ON_PRESENCE = false` to flip back if needed.

### 6) `Canvas.tsx` — wire two stages + two loops

Key changes:

1. **Render two `CanvasStage` instances** in the JSX (see §1). Keep `ref`s: `baseStageRef`, `overlayStageRef`.
2. **Instantiate two loops** with `useRef`:

```ts
const baseLoopRef = useRef<RenderLoop | null>(null);
const overlayLoopRef = useRef<OverlayRenderLoop | null>(null);
```

3. **Start base loop** exactly like today, but pass `drawPresenceInThisLoop: false` and keep the `getViewport`, `getView`, `getGates`, resize, and dirty‑rect path unchanged.

4. **Start overlay loop** once overlay stage is ready:

```ts
overlayLoop.start({
  stage: overlayStageRef.current!,
  getView: () => viewTransformRef.current!,
  getViewport: () => currentOverlayViewportRef.current, // mirror from overlay stage onResize
  getGates: () => roomDoc.getGateStatus(),
  getPresence: () => presenceRef.current, // maintained by subscribePresence
  drawPresence: (ctx, presence, view, vp) => drawPresenceOverlays(ctx, snapshotRef.current, view, vp, roomDoc.getGateStatus()),
});
```

5. **Subscriptions:**

   * **Snapshot:** keep current subscription but **do not** invalidate overlay from it. Base loop continues to call `invalidateAll('snapshot-update')` when *document* content changes (we’ll stop publishing on presence‑only in §5).
   * **Presence:** add a `subscribePresence` in `useEffect` that writes into `presenceRef` and calls `overlayLoop.invalidateAll()`.

6. **Resize:** both stages send independent `onResize`. Forward each to its loop:

   * Base → `baseLoop.setResizeInfo({ width: pixelWidth, height: pixelHeight, dpr })`.
   * Overlay → call **overlay** invalidation only (overlay loop doesn’t track size internally; the `stage.clear()` already uses fresh backing dimensions). If you prefer symmetry, expose `setResizeInfo` to overlay too but it’s not required.

7. **Transform changes (pan/zoom):** wherever you currently notify the base loop/dirty‑rects, also call `overlayLoop.invalidateAll()` so presence re‑projects.

8. **Unmount:** stop + destroy both loops; clear stroke caches as you already do.

### 7) Optional: move HUD to overlay

If HUD elements are pure screen‑space and independent of world content (minimap, toasts, FPS badge), render them from the overlay loop right after presence. This ensures base canvas never needs a presence/HUD pass.

### 8) Convenience: `invalidateOverlay()` helper

If you prefer a named helper in `Canvas.tsx`:

```ts
const invalidateOverlay = () => overlayLoopRef.current?.invalidateAll();
```

Use it in:

* `subscribePresence` callback
* Transform change handler
* Overlay resize handler

---

## Step‑by‑step diffs (illustrative)

> Names/paths may vary slightly in your repo; adapt imports accordingly.

### A) Add the overlay loop

```
+ src/renderer/OverlayRenderLoop.ts
+ export { OverlayRenderLoop }
```

### B) Gate presence in the base loop

```diff
// src/renderer/RenderLoop.ts
 export type RenderLoopConfig = {
   // ...
   getGates: () => GateStatus;
+  drawPresenceInThisLoop?: boolean;
 };
 
 // inside frame():
- // Pass 2: Presence overlays (screen space with DPR only)
- stage.withContext((ctx) => { /* presence + HUD */ })
+ if (this.config.drawPresenceInThisLoop !== false) {
+   stage.withContext((ctx) => { /* presence + HUD */ });
+ }
```

### C) Canvas composition

```diff
// src/canvas/Canvas.tsx (inside render)
- <CanvasStage ref={stageRef} ... />
+ <div className="stage-root" style={{ position: 'relative' }}>
+   <CanvasStage ref={baseStageRef} className="base-canvas" style={{ position: 'absolute', inset: 0, zIndex: 1 }} onResize={handleBaseResize} />
+   <CanvasStage ref={overlayStageRef} className="overlay-canvas" style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }} onResize={handleOverlayResize} />
+ </div>
```

### D) Wire loops and subscriptions

```diff
// src/canvas/Canvas.tsx (effects)
- const renderLoop = new RenderLoop();
- renderLoop.start({ stage: stageRef.current!, /* ... */ });
+ const baseLoop = new RenderLoop();
+ baseLoop.start({ stage: baseStageRef.current!, /* ... */, drawPresenceInThisLoop: false });

+ const overlayLoop = new OverlayRenderLoop();
+ overlayLoop.start({ stage: overlayStageRef.current!, getView, getViewport: getOverlayViewport, getGates, getPresence: () => presenceRef.current, drawPresence: drawPresenceOverlays });

// Canvas.tsx — snapshot subscription (corrected)
const unsubscribeSnapshot = roomDoc.subscribeSnapshot((next) => {
  const prev = snapshotRef.current;
  snapshotRef.current = Object.freeze(next);

  // Branch on *document* change only
  const docChanged =
    !prev || next.docVersion !== prev.docVersion; // Y.Doc changed only then

  if (docChanged) {
    // Yes: force a full clear for now (safe & correct)
    baseLoop.invalidateAll('doc-version-change');
    // Dirty-rects still work for local edits you explicitly invalidate with bounds.
  } else {
    // Presence-only update: do NOT touch the world canvas
    // Overlay canvas handles presence; cheap full clear there is fine.
    overlayLoop.invalidateAll(); // this only clears the overlay canvas
  }
});

```
Why: in your codebase, RenderLoop.invalidateAll(...) -> DirtyRectTracker.invalidateAll(...) → fullClearRequired = true; rects = [] (so a full clear next frame). Using that on every snapshot would nullify dirty rects.

```

### E) RoomDocManager publish tweak (presence‑only → no snapshot)

Pseudo‑diff for your rAF publisher:

```diff
- if (docDirty || presenceDirty) buildAndPublishSnapshot();
+ if (docDirty) buildAndPublishSnapshot();
+ if (presenceDirty) notifyPresenceSubscribersThrottled();
```

### F) Transform + resize hooks

```diff
// on pan/zoom or DPR/resize change
 baseLoop.setResizeInfo({ width, height, dpr });
 baseLoop.invalidateAll('geometry-change');
+overlayLoop.invalidateAll(); // overlay full clear + redraw
```

---

## Performance & correctness notes

* **Latency:** Presence renders can run at ≤30 Hz (UI throttle) and feel smooth due to interpolation; the overlay loop simply redraws whenever presence changes or the camera moves. Base loop remains decoupled.
* **Dirty rects preserved:** Base loop keeps `invalidateWorld(bounds)` semantics for previews/authoring; full clears remain on scene change or transform change as you already do. Presence updates never touch base dirty‑state.
* **Z‑fight elimination:** Entire presence/HUD draw order happens above world content; no more inter‑pass ordering worries within a single canvas.
* **Safety on resize/DPR:** Both stages keep independent DPR buffers and resize surfaces, so each loop sees the right pixel geometry. Overlay always full‑clears after resize anyway.
* **Pointer safety:** Because overlay is `pointer-events: none`, hit‑testing and tools remain unchanged.

---

## Future niceties (optional)

* **Blend trails using `globalCompositeOperation`** on overlay without affecting world strokes.
* **GPU‑offload step:** If needed later, the presence overlay can be promoted to a WebGL/OffscreenCanvas worker without touching base rendering.
* **Occlusion culling for name labels** on overlay (trivial bounding in screen space).

---

