# Phase 5: View Interactions — Zoom‑to‑Cursor (Wheel) & Middle‑Button Pan

This section specifies the exact **behavior**, **math**, and **Canvas.tsx event plumbing** to implement buttery‑smooth zooming that always focuses on the cursor and a precise, responsive pan using the middle mouse button (MMB). It assumes the coordinate system and rendering stack from earlier phases:

- **Pan is in world units** and the forward transform is `canvas = (world − pan) × scale`.
- Device pixel ratio (DPR) is handled **only** in `CanvasStage` (via `setTransform(dpr, 0, 0, dpr, 0, 0)`); everything in this spec uses **CSS pixels** for screen/canvas math and **world units** for pan.
- `ViewTransformProvider` exposes `viewState.scale`, `viewState.pan`, and `setScale(p)`, `setPan(p)` which **clamp** using `PERFORMANCE_CONFIG`.

---

## A. Configuration (tuneable defaults)

Put these next to `PERFORMANCE_CONFIG` in config.ts 

```ts
/** Absolute bounds **/
export const MIN_ZOOM = 0.01;      // 1% (0.01×)
export const MAX_ZOOM = 5;         // 500% (5×)

/** Wheel → zoom mapping **/
// We map one normalized wheel “notch” (see normalizeWheel) to ~9–10% zoom.
export const ZOOM_STEP = Math.log(1.09); // ≈ 0.086177696...

/** Zoom smoothing (critically-damped approach-to-target) **/
export const ZOOM_DAMPING = 14;     // larger = snappier but still smooth (s^-1)
export const ZOOM_EPS = 1e-4;       // stop animation when |s_target − s| < eps

/** MMB pan **/
export const PAN_CURSOR = 'grabbing';
export const PAN_INERTIA_ENABLED = true;
export const PAN_FRICTION = 5.0;    // s^-1 (higher = shorter coast)
export const PAN_EPS = 0.02;        // CSS px/s in screen space below which we stop
```

> **Why exponential mapping?** Using `exp(-δ * ZOOM_STEP)` yields **multiplicative** scaling that is resolution‑independent and consistent across devices. Setting `ZOOM_STEP ≈ ln(1.09)` targets ~9% per standard wheel “step,” which avoids jumpiness yet isn’t sluggish.

---

## B. Canonical formulas

### 1) Zoom‑to‑cursor (instant math)

Given current view `(scale, pan)` and a **cursor** in **canvas space** `c = (cx, cy)`:

- World point under cursor at the start of the event:
  ```ts
  // world = canvas/scale + pan
  const w = { x: cx / scale + pan.x, y: cy / scale + pan.y };
  ```

- Apply a **zoom factor** `f` (clamped). New scale:
  ```ts
  const s1 = clampScale(scale * f); // clamp to [MIN_ZOOM, MAX_ZOOM]
  ```

- Choose **new pan** to keep `w` under the cursor during and after the change:
  ```ts
  // We want cx = (w.x - pan1.x) * s1  ⇒  pan1.x = w.x - cx / s1
  const pan1 = { x: w.x - cx / s1, y: w.y - cy / s1 };
  ```

> This ensures the content under the mouse doesn’t drift; the cursor is a fixed **anchor** in canvas space while you zoom.

### 2) Middle‑mouse panning (drag math)

Let `Δc = (Δx, Δy)` be the drag delta in **canvas CSS pixels** since pan start and `s = current scale`:

```ts
// Derivation from canvas = (world − pan) × s
// Keeping the world point under the pointer glued to the pointer implies:
newPan = startPan − (Δc / s); // component‑wise
```

That is:
```ts
pan.x = pan0.x - Δx / s;
pan.y = pan0.y - Δy / s;
```

> Because **pan is in world units**, divide the screen delta by the scale. Sign is **minus** so content tracks the pointer naturally.

---

## C. Event plumbing in `Canvas.tsx`

### 1) Required listeners

Attach these to the **base canvas element** (not the overlay), with `{ passive: false }` so we can `preventDefault()`:

- `wheel` — wheel/trackpad zoom **to cursor**
- `pointerdown`/`pointermove`/`pointerup`/`pointercancel`/`lostpointercapture` — **MMB pan**
- `auxclick` — `preventDefault` to suppress the browser’s middle‑click autoscroll icon on Windows

> Keep existing tool handlers; **MMB (button === 1)** bypasses tools entirely.

### 2) Utilities you’ll need in the component

```ts
// Refs
const animRef = useRef<{ raf: number | null, scale: number, targetScale: number, anchorCanvas: {x:number,y:number}, anchorWorld: {x:number,y:number} } | null>(null);
const panDragRef = useRef<{ active: boolean, pointerId: number, startClient: {x:number,y:number}, startPan: {x:number,y:number}, velocity: {x:number,y:number}, lastTS: number } | null>(null);

// Helpers
function clampScale(s: number) { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s)); }

function normalizeWheel(e: WheelEvent): number {
  // Normalize to “wheel notches”. Positive for wheel down (zoom out).
  //  - deltaMode: 0=pixels, 1=lines, 2=pages
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 40;
  else if (e.deltaMode === 2) dy *= 800;
  // Standard step ≈ 120; trackpads yield small values. Return in “steps”.
  return dy / 120;
}

function getCanvasPointFromClient(clientX: number, clientY: number) {
  const rect = baseStageRef.current!.getBounds(); // returns CSS client rect
  return { x: clientX - rect.left, y: clientY - rect.top };
}
```

### 3) Wheel → zoom handler (with smoothing)

```ts
const onWheel = (e: WheelEvent) => {
  // We always zoom on wheel (no Ctrl/Meta gating).
  e.preventDefault();

  if (!baseStageRef.current) return;
  const canvasPt = getCanvasPointFromClient(e.clientX, e.clientY);

  // Map wheel to a multiplicative zoom factor.
  const steps = normalizeWheel(e);                   // can be fractional on trackpads
  const factor = Math.exp(-steps * ZOOM_STEP);       // >1 when scrolling up (zoom in)
  const s0 = viewTransform.scale;
  const sTarget = clampScale(s0 * factor);

  // Compute the world anchor under the cursor at event time (once per wheel event).
  const w = {
    x: canvasPt.x / s0 + viewTransform.pan.x,
    y: canvasPt.y / s0 + viewTransform.pan.y,
  };

  // (Re)start zoom animation toward sTarget; pan will be derived per frame from anchor.
  const now = performance.now();
  if (!animRef.current) animRef.current = { raf: null, scale: s0, targetScale: sTarget, anchorCanvas: canvasPt, anchorWorld: w };
  else {
    // Update target and anchor to latest pointer; keep current animated scale.
    animRef.current.targetScale = sTarget;
    animRef.current.anchorCanvas = canvasPt;
    animRef.current.anchorWorld  = w;
  }

  // Kick the RAF loop if not already running.
  if (!animRef.current.raf) {
    let last = now;
    const tick = (ts: number) => {
      const a = animRef.current!;
      const dt = Math.max(0, (ts - last) / 1000); // seconds
      last = ts;

      // Exponential approach-to-target: s += (starget − s) * (1 − e^{−λ dt})
      const alpha = 1 - Math.exp(-ZOOM_DAMPING * dt);
      a.scale = a.scale + (a.targetScale - a.scale) * alpha;

      // Derive pan from the fixed anchor constraint at this instantaneous scale.
      const s = a.scale;
      const cx = a.anchorCanvas.x, cy = a.anchorCanvas.y;
      const pan = { x: a.anchorWorld.x - cx / s, y: a.anchorWorld.y - cy / s };

      setScale(s);     // clamped inside provider as an extra guard
      setPan(pan);

      // Continue until both scale and target are effectively equal.
      const done = Math.abs(a.targetScale - a.scale) < ZOOM_EPS;
      if (!done) a.raf = requestAnimationFrame(tick);
      else { cancelAnimationFrame(a.raf!); a.raf = null; animRef.current = null; }
    };
    animRef.current.raf = requestAnimationFrame(tick);
  }
};
```

**Notes**

- The **anchor‑derived pan per frame** makes the zoom feel perfectly locked to the cursor with **zero wobble**, even while easing.
- Because the transform effect in `Canvas.tsx` already invalidates the render loops on scale/pan changes, the above animation drives smooth redraws without a separate timing system.
- If multiple wheel events arrive during an ongoing animation, we just **retarget** `targetScale` and update the anchor to the latest cursor position; the animation curve continues without pops.

### 4) Middle‑mouse pan handlers

```ts
const onPointerDown = (e: PointerEvent) => {
  // Existing tool logic still runs for LMB; we intercept MMB for pan.
  if (e.button === 1 && e.pointerType === 'mouse') {
    e.preventDefault();
    const canvas = e.currentTarget as HTMLElement;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = PAN_CURSOR;

    const start = { x: e.clientX, y: e.clientY };
    panDragRef.current = {
      active: true,
      pointerId: e.pointerId,
      startClient: start,
      startPan: { ...viewTransform.pan },
      velocity: { x: 0, y: 0 },
      lastTS: performance.now(),
    };
    return; // do NOT forward to tool
  }

  // otherwise fall through to existing tool.begin flow (left button etc.)
};

const onPointerMove = (e: PointerEvent) => {
  // Update MMB pan if active
  const pd = panDragRef.current;
  if (pd?.active && e.pointerId === pd.pointerId) {
    const s = viewTransform.scale; // use live scale for accurate division
    const dx = e.clientX - pd.startClient.x;
    const dy = e.clientY - pd.startClient.y;
    const pan = { x: pd.startPan.x - dx / s, y: pd.startPan.y - dy / s };

    // estimate velocity in CSS px/s for optional inertia
    const now = performance.now();
    const dt = Math.max(1, now - pd.lastTS) / 1000;
    pd.velocity = { x: (dx / dt), y: (dy / dt) };
    pd.lastTS = now;

    setPan(pan);
    return; // bypass tool.move while panning with MMB
  }

  // otherwise keep existing hover/cursor/tool.move behavior
};

const finishPan = (e: PointerEvent) => {
  const pd = panDragRef.current;
  if (pd?.active && e.pointerId === pd.pointerId) {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    (e.currentTarget as HTMLElement).style.cursor = '';
    panDragRef.current = null;

    if (PAN_INERTIA_ENABLED) startPanInertia();
  }
};

const onPointerUp = finishPan;
const onPointerCancel = finishPan;
const onLostPointerCapture = finishPan;

// Suppress Windows autoscroll circle on MMB click
const onAuxClick = (e: MouseEvent) => {
  if (e.button === 1) e.preventDefault();
};
```

**Pan inertia (optional but makes panning feel “finished”)**

```ts
function startPanInertia() {
  // Snapshot a screen-space velocity at release; decay it with friction.
  let vx = 0, vy = 0;
  if (panDragRef.current?.velocity) {
    vx = panDragRef.current.velocity.x;
    vy = panDragRef.current.velocity.y;
  }
  if (Math.hypot(vx, vy) < 1) return; // trivial

  let raf: number | null = null;
  let last = performance.now();
  const tick = (ts: number) => {
    const dt = Math.max(0, (ts - last) / 1000); // seconds
    last = ts;

    // Exponential decay in screen space, then convert to world delta by dividing by scale.
    const decay = Math.exp(-PAN_FRICTION * dt);
    vx *= decay;
    vy *= decay;

    const s = viewTransform.scale;
    setPan({
      x: viewTransform.pan.x - (vx * dt) / s,
      y: viewTransform.pan.y - (vy * dt) / s,
    });

    if (Math.hypot(vx, vy) > PAN_EPS) raf = requestAnimationFrame(tick);
    else if (raf) cancelAnimationFrame(raf);
  };
  raf = requestAnimationFrame(tick);
}
```

### 5) Wiring listeners

Add alongside existing pointer handlers when the canvas is ready (same effect where other listeners are registered):

```ts
canvas.addEventListener('wheel', onWheel, { passive: false });
canvas.addEventListener('auxclick', onAuxClick, { passive: false });

// If you centralize pointer handlers already, graft MMB logic into them;
// otherwise attach dedicated ones just for MMB pan:
canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
canvas.addEventListener('pointermove', onPointerMove, { passive: false });
canvas.addEventListener('pointerup', onPointerUp, { passive: false });
canvas.addEventListener('pointercancel', onPointerCancel, { passive: false });
canvas.addEventListener('lostpointercapture', onLostPointerCapture, { passive: false });
```

And in cleanup:

```ts
canvas.removeEventListener('wheel', onWheel);
canvas.removeEventListener('auxclick', onAuxClick);
canvas.removeEventListener('pointerdown', onPointerDown);
canvas.removeEventListener('pointermove', onPointerMove);
canvas.removeEventListener('pointerup', onPointerUp);
canvas.removeEventListener('pointercancel', onPointerCancel);
canvas.removeEventListener('lostpointercapture', onLostPointerCapture);
```

---

## D. Behavior details & edge cases

1. **Bounds & clamping**  
   Always clamp scale to `[MIN_ZOOM, MAX_ZOOM]` when computing `sTarget` and let `ViewTransformProvider` clamp again on `setScale` for safety. When clamping hits a bound during the wheel animation, the pan derived from the anchor formula remains correct—no snap is needed.

2. **Trackpads vs wheels**  
   `normalizeWheel()` maps both to a common “step” unit. Trackpads emit small fractional deltas; the exponential curve plus smoothing yields **continuous** zoom with no staircase artifacts.

3. **Concurrent wheel events**  
   While animating, new wheel input updates `targetScale` and the anchor to the **latest** cursor position. The smooth solver naturally re‑targets without discontinuities.

4. **Tool interaction**  
   - **MMB pan** short‑circuits tool handling (no `.begin/.move/.end` for tools).  
   - Left button tools remain unchanged.  
   - Presence/cursor updates are unaffected; you may opt to send an activity like `'panning'` during MMB if you want telemetry, but the rendering does not depend on it.

5. **Cursor affordance**  
   During MMB pan, set `canvas.style.cursor = 'grabbing'` (or the configured `PAN_CURSOR`) for immediate feedback; restore on finish.

6. **Passive listeners**  
   All new listeners must be **non‑passive** so `preventDefault()` cancels default scrolling and the Windows autoscroll “wheel click” UX.

7. **Render invalidation**  
   The existing `useEffect` that listens to `viewTransform.scale/pan` already invalidates both render loops. The animation loop thus automatically drives redraws with zero extra work.

---

## E. Minimal façade for reuse (optional)

If you prefer to keep `Canvas.tsx` lean, extract the smoothing loop into a tiny “view animator” so Canvas only sets targets:

```ts
// view-animator.ts
export function animateZoomToCursor({
  setScale, setPan, getView, anchorCanvas, targetScale, dtSec
}: { ... }) {
  // Same math as in onWheel’s RAF loop; returns true if finished.
}
```

Both the wheel zoom and any future “fit to selection”/“zoom to rect” features can then set `targetScale` + `anchorCanvas` and invoke the common animator.

---



I’m keeping this laser-focused on behavior, event routing, and formulas (no testing talk). I’m also calling out the **one mismatch** I noticed (your limits). Citations point to the specific files/lines you shipped so you can cross-check.

---


## 1) View invariants & limits (authoritative)

* **Transform contract (unchanged):**
  `canvas = (world − pan) × scale` ; `world = canvas / scale + pan`. Context order: `ctx.scale(scale,scale)` **then** `ctx.translate(-pan.x, -pan.y)`.   

* **Pan units:** pan is in **world** units (not pixels).  

* **Limits update (‼️ replace):** set `PERFORMANCE_CONFIG.MIN_ZOOM = 0.01`, `MAX_ZOOM = 5`. (Your current doc block says `0.1—10`; fix to match the product requirement.) The clamp path uses `PERFORMANCE_CONFIG`, so the constants alone drive enforcement.  

---

## 2) Event routing in `Canvas.tsx` (tool-agnostic surface)

**Goal:** Wheel = zoom-to-cursor with smooth animation. MMB = pan (bypasses tools). Everything lives at the **Canvas** layer so tool previews remain unchanged.

### 2.1 Add listeners (non-passive where needed)

* **Wheel:** `canvas.addEventListener('wheel', onWheel, { passive: false })` (prevent default scrolling).
* **Auxclick:** `canvas.addEventListener('auxclick', (e)=>{ if (e.button===1) e.preventDefault(); })` to block browser autoscroll.
* **Pointer panning with MMB:** intercept in your existing unified pointer handlers:

  * In `handlePointerDown`, **early-return into “panning mode”** if `e.button === 1 && e.pointerType === 'mouse'` (don’t call `tool.begin`). Set pointer capture and track a small panning state.
  * In `handlePointerMove/Up/Cancel`, branch on `isPanningMMB` to update pan/release instead of forwarding to the tool.

This fits directly into your current pointer surface and effect that attaches listeners with `{ passive: false }`.  

### 2.2 Where the handlers live

Hook these in the same `useEffect` where you currently set up the tool & pointer listeners (right after setting `toolRef.current` and overlay preview provider). Your Canvas already centralizes tool creation and unified handlers, so we extend it there.  

---

## 3) Wheel → zoom-to-cursor (animated, no drift)

**Core invariant:** the **world point under the cursor** stays in the *same canvas pixel* while scale animates.

Let the cursor in **canvas (CSS px)** be `c=(cx,cy)` and current view be `{ scale, pan }`. The world point under the cursor is:

```
w = ( cx/scale + pan.x ,  cy/scale + pan.y )
```

For any intermediate animated scale `s1`, the pan that keeps `w` pinned at `c` is:

```
pan1.x = w.x − cx / s1
pan1.y = w.y − cy / s1
```

(Direct consequence of your transform; same as `calculateZoomTransform`.) 

### 3.1 Wheel normalization → multiplicative target

Normalize deltas to “steps” and derive a multiplicative factor:

```ts
// Normalize to wheel steps
let dy = e.deltaY;
if (e.deltaMode === 1) dy *= 40;      // lines
else if (e.deltaMode === 2) dy *= 800; // pages
const steps = dy / 120;

// Map steps to factor (negative because wheel-down zooms in by default)
const ZOOM_STEP = Math.log(1.09);     // ≈ 9% per step (tweak 0.085–0.10 sweet spot)
const factor = Math.exp(-steps * ZOOM_STEP);

// Coalesce: targetScale *= factor   (clamp to 0.01–5)
```

Your **current scale limits come from `PERFORMANCE_CONFIG`**, so clamp via `setScale(clamp(scale))`. 

### 3.2 Smooth approach (frame-rate independent)

Keep a tiny “zoom animator” in refs:

* `targetScale` (multiplicative coalescer)
* `anchorWorld` (world coord of the cursor captured on the latest wheel event)
* `animRaf` flag
* `ZOOM_DAMPING` (e.g., 12 s⁻¹ → responsive but not springy)

Per frame:

```ts
const now = performance.now();
const dt  = Math.min(0.05, (now - tPrev) / 1000); // clamp for tab hops
const alpha = 1 - Math.exp(-ZOOM_DAMPING * dt);

// s := lerp toward target
const s = scale + (targetScale - scale) * alpha;

// pan := keep anchor locked to current cursor pixel c
const pan = {
  x: anchorWorld.x - c.x / s,
  y: anchorWorld.y - c.y / s,
};

// Commit (these trigger both loops via your transform-change effect)
setScale(s);
setPan(pan);

// Exit when |target - scale|/target < ε (e.g., 0.001)
```

**Why this fits your loops:** updating `scale/pan` fires your `useEffect` that invalidates both renderers (base: 1×1 canvas rect to schedule a tick; overlay: full overlay clear). The base loop detects transform change and **promotes to full clear** automatically, which is what we want during animated zoom. You explicitly said full clears every frame while zooming are fine.  

> **Note:** Do **not** compute pan once and reuse — recompute pan **each frame** from the same `anchorWorld` + the *current* animated scale. That’s what kills “dinosaur” wobble.

### 3.3 Cursor and coordinates

* Get `c=(cx,cy)` in **canvas CSS px** by subtracting the canvas client rect from `e.clientX/Y` (your `useCoordinateTransform` already provides the inverse chain). Capture `anchorWorld = canvasToWorld(cx,cy)` from the **current** view at wheel time. 

---

## 4) Middle-mouse **pan** (tool-bypass mode)

**When:** `pointerdown` with `e.button===1 && e.pointerType==='mouse'`.

**State to track (refs):**

* `isPanningMMB`, `panPointerId`
* `panStartWorld = pan (at down)`
* `downCanvas = (clientX − rect.left, clientY − rect.top)`
* optional velocity for inertia: `vCanvas` EMA

**Formulas (world-unit pan):**

Given current scale `s` and current canvas delta `Δc = (cx − downCanvas.x, cy − downCanvas.y)`:

```
pan.x = panStartWorld.x − Δc.x / s
pan.y = panStartWorld.y − Δc.y / s
```

(Sign is correct for your `(world − pan)*scale` transform.) 

**Pointer handling:**

* On **down**: `canvas.setPointerCapture(id)`, set `isPanningMMB=true`, set body/canvas cursor to `grabbing`, **do not** call `tool.begin`.
* On **move**: if `isPanningMMB`, compute `Δc`, update `setPan()`; optionally track `vCanvas = (currCanvas − prevCanvas) / dt`.
* On **up/cancel/lostcapture**: clear flags, cursor, release pointer capture. Your Canvas already has robust release paths; mirror them for MMB. 

**Optional inertia (nice touch, easy to tune):**

On release, if `|vCanvas|` > threshold, start a short decay:

```
vCanvas *= exp(-K * dt)       // K≈12–16 s⁻¹
pan += -(vCanvas * dt) / scale
stop when |v| < epsilon
```

Commit via `setPan()` inside a small rAF that self-terminates.

---

## 5) Integration with your **RenderLoop** & **OverlayRenderLoop**

* **Base RenderLoop (world):** you’re event-driven. On transform change, your Canvas effect calls `renderLoop.invalidateCanvas({1×1})`, and inside `tick()` you detect different scale/pan and **notifyTransformChange**, which promotes to **full clear** when needed. Perfect for animated zoom.  

* **Overlay loop:** always full-clears; previews and presence read `getView()` during each frame. No extra work — just ensure we call `overlayLoop.invalidateAll()` at least once on the first wheel event (your transform-change effect already does it every frame too). 

* **Two-canvas order & transforms:** world pass applies `scale` then `translate(-pan)`; overlay uses world pass for previews and DPR-only for presence. The zoom anchor math above matches these assumptions exactly.  

---

## 6) Exact `onWheel` flow (pseudo)

```ts
function onWheel(e: WheelEvent) {
  e.preventDefault();

  // Canvas CSS coords of cursor
  const rect = stageRef.current!.getBounds();           // Canvas DOMRect
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  // Normalize to steps
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 40;
  else if (e.deltaMode === 2) dy *= 800;
  const steps = dy / 120;

  // Update target
  const factor = Math.exp(-steps * ZOOM_STEP);          // ZOOM_STEP ≈ ln(1.09)
  targetScale = clampScale(targetScale * factor);       // clamp via PERFORMANCE_CONFIG

  // Capture/refresh anchor world under cursor for THIS event
  const { scale, pan } = viewTransformRef.current;
  anchorWorld = { x: cx / scale + pan.x, y: cy / scale + pan.y };
  cursorCanvas = { x: cx, y: cy };                      // remember c for the animator

  // Start animator if idle
  if (!animating) startZoomAnimator();
}
```

And the animator (per-frame):

```ts
function stepZoom(dt) {
  const { scale } = viewTransformRef.current;

  // Smooth toward target
  const alpha = 1 - Math.exp(-ZOOM_DAMPING * dt);
  const s = scale + (targetScale - scale) * alpha;

  // Keep anchor locked to current cursor canvas coords
  const pan = {
    x: anchorWorld.x - cursorCanvas.x / s,
    y: anchorWorld.y - cursorCanvas.y / s,
  };

  setScale(s);
  setPan(pan);

  if (Math.abs(targetScale - s) / targetScale < 1e-3) stopZoomAnimator();
}
```

> You don’t need to manually ping the renderers here; your **transform-change effect** in `Canvas.tsx` already invalidates both loops whenever `scale`/`pan` change. 

---

## 7) Notes on tools & preview layers

* Tool previews stay **exactly** as-is. The overlay loop reads the same `view` you update during zoom; it already **full-clears every frame** and draws world-space previews under `scale→translate(-pan)`, and presence in screen space after DPR. No coupling changes needed. 

* Your Canvas already routes `setPreviewProvider()` to overlay and seeds previews; leave that intact. 

---

## 8) Trackpads & ctrl-pinch

Browser pinch-to-zoom on many devices surfaces as `WheelEvent` with ctrl/meta modifiers. With the normalization above, you don’t need a separate path; optionally you can **reduce `ZOOM_STEP`** when `e.ctrlKey` to avoid hyperspeed pinch. (Keep behavior consistent cross-platform.)

---

# 🔁 What to **change** 

2. **Add a new subsection** (after 3.3 or as 3.4) titled *“Wheel Zoom-to-Cursor & MMB Pan”* with the exact content from sections 2–6 above (event routing, invariant formulas, animation, and panning math). This ties behavior to your **two-canvas** architecture and explains why full clears during zoom are fine in your loop.  

3. **Call out the Canvas effect** that already invalidates both loops on transform change (no extra work is required by the animator besides `setScale`/`setPan`). That’s the linchpin enabling the smooth animation to drive the renderer. 

---

## Why this fits your architecture (in short)

* Uses your **world-unit pan** contract and transform order, so math is 1:1 with your renderers. 
* Leverages your **event-driven RenderLoop** and overlay loop: transform changes → Canvas effect invalidates → base loop promotes to **full clear** on transform-change; overlay already full-clears.  
* Respects your **tool-agnostic** pointer surface and preview provider pattern — MMB pan simply shortcuts tool begin/move/end when active, without touching tool code.  



Below is a tight spec of what to, end-to-end flow from mouse events in `Canvas.tsx` → controller → view updates → render loops → toolbar state. I’m keeping it focused on behavior, formulas, routing, and file layout (no fluff).

---


## A) “Transient Tool Override & MMB Pan (does not tear down tools)”

1. **Two ways to pan**

   * **Explicit tool (sticky):** selecting “Pan” in the toolbar sets `activeTool='pan'`. Canvas will instantiate a `PanTool` that pans with **LMB** drags until the user switches tools. (Matches your tool architecture where the active tool drives pointer handling.)  
   * **Transient pan (MMB):** pressing **middle mouse** activates a **transient override**; Canvas routes pointer events to *internal* panning code **without** changing `activeTool`. On release/cancel, we exit and the UI remains on the original tool. This avoids re-creating tools mid-gesture (your Canvas effect branches on `activeTool` and would reconstruct the tool if we flipped the store).  

2. **Toolbar indication (optional)**

   * If you want the toolbar to **visually** show Pan while MMB is held, add a *UI-only* hint key in the device store (e.g., `transientHint: Tool | null`) that does **not** drive tool instantiation. Do **not** call `setActiveTool('pan')` for MMB, or Canvas will rebuild tools mid-gesture. (Active tool is the creation switch.)  

3. **Spacebar note (defer)**

   * Your keyboard hook currently flips `activeTool` to `pan` on **space**. That’s fine as a placeholder, but once transient pan is in, consider refactoring keyboard to use the *transient* path (hold-to-pan) instead of changing `activeTool`. Otherwise you’ll still tear down/recreate tools at key down/up. 

4. **Pan math (world-unit pan, consistent with your transform)**

   ```
   // Transform is: canvas = (world - pan) * scale
   // Drag Δc in canvas CSS px; current scale s
   pan.x = pan0.x − Δc.x / s
   pan.y = pan0.y − Δc.y / s
   ```

   This matches your authoritative transform order `scale → translate(-pan)`.  

---

## B) Add: “Unified Zoom/Pan Controller (logic unified, UI separate)”

Create a small controller used by **both** Canvas wheel/pinch and any zoom UI:

* **File:** `/client/src/canvas/useZoomPanController.ts` (hook) or `/client/src/canvas/zoom-pan-controller.ts` (class)
* **Why:** Your keyboard removed zoom shortcuts in favor of UI controls; both should call the same core zoom logic so buttons and wheel feel identical. 

**Public API (suggested):**

```ts
type ZoomPanController = {
  // MMB pan (transient) — Canvas calls these directly
  beginPanMMB(pointerId: number, clientX: number, clientY: number): void;
  movePanMMB(pointerId: number, clientX: number, clientY: number): void;
  endPanMMB(pointerId: number): void;

  // Wheel/pinch zoom
  onWheel(e: WheelEvent, clientX: number, clientY: number): void;

  // Programmatic zoom for buttons, fit, zoom to rect, etc.
  zoomToTargetScale(targetScale: number, anchorCanvas: {x:number;y:number}): void;
  zoomStep(stepCount: number, anchorCanvas?: {x:number;y:number}): void; // +/- buttons
};
```

**Internals:**

* Stores `targetScale`, `cursorCanvas`, and `anchorWorld` refs, and runs an exponential approach each rAF to keep zoom smooth but responsive.
* Derives `pan` **each frame** from `anchorWorld` + animated `scale` to keep the world point under the cursor locked to the same pixel. See math in section D below.
* Uses your `setScale` / `setPan` from `ViewTransformContext` (which already clamps) and relies on your existing “transform changed → invalidate” effect.   

---

## C) Amend: “Zoom limits”

Set **MIN_ZOOM = 0.01, MAX_ZOOM = 5** (matches your stated range) and ensure the ViewTransform provider remains the single clamp point. Your context already clamps `setScale` using `PERFORMANCE_CONFIG`. 

---

## D) Keep (but make explicit): Zoom-to-cursor math & normalization

1. **Invariant (pin world point under cursor):**

   ```
   // current view {scale, pan}; cursor in canvas CSS px c=(cx,cy)
   world = (cx/scale + pan.x, cy/scale + pan.y)

   // for any new scale s1, pan that preserves world at c:
   pan1.x = world.x − cx / s1
   pan1.y = world.y − cy / s1
   ```

   Same constraint your helpers encode (`calculateZoomTransform`)—we use it every animation frame so it never “drifts” while animating. 

2. **Wheel normalization → multiplicative factor:**

   ```
   // Normalize WheelEvent deltas to "steps"
   let dy = e.deltaY;
   if (e.deltaMode === 1) dy *= 40;      // lines
   else if (e.deltaMode === 2) dy *= 800; // pages
   const steps = dy / 120;

   // Map steps to factor (~9%/notch default)
   const ZOOM_STEP = ln(1.09);
   const factor = exp(-steps * ZOOM_STEP);
   ```

   Target range remains clamped by `setScale`. (Controller coalesces multiple wheel events into `targetScale`.) Your “research” sweet spot (8–12%) lines up here. 

3. **Smooth approach (FPS-independent):**

   ```
   alpha = 1 - exp(-ZOOM_DAMPING * dtSec);
   scale = scale + (targetScale - scale) * alpha;
   pan   = anchorWorld - cursorCanvas / scale;
   ```

   Update `scale/pan` each frame; your Canvas effect already invalidates both loops on transform change (base loop promotes to full clear).  

---

# End-to-end pipeline (systematic, from Canvas events)

## 1) Files & responsibilities

* **`Canvas.tsx`**: owns event listeners, pointer capture, and wiring to *ZoomPanController*. It does **not** rebuild tools for MMB pan or zoom; it simply updates view via `setScale/setPan`. It still creates the active tool **once** per `activeTool` change (pen, highlighter, eraser, text, and now **PanTool** for the sticky pan case).  
* **`useZoomPanController.ts`**: pure logic + small animator; no DOM. Consumes `viewTransformRef` (for freshest values), `setScale`, `setPan`, and a `getCanvasBounds()` function.
* **`tools/PanTool.ts` (new)**: implements `PointerTool` so users can left-drag pan when **Pan** is selected in the toolbar (sticky). Internally uses the **same** pan math as MMB. (PointerTool interface already documented.) 
* **Zoom UI** (buttons/fit): call controller APIs; do not implement zoom math themselves.

## 2) Avoiding stale cursor/transform

* `Canvas.tsx` already exposes **stable** coordinate converters that pull **latest** transform from refs; re-use them in event handlers (they read from `viewTransformRef` directly).  
* For wheel: use `e.clientX/Y` + current canvas bounds to compute the anchor on **each** wheel event; store that world point in the controller (`anchorWorld`) and recompute pan as scale animates. (Wheel events include client coords, so you don’t need a separate cursor stream.)
* You’re already tracking the last mouse position for tool seeding; keep that (handy for eraser hover) and it also gives you a fallback anchor if needed. 

## 3) Pointer routing in `Canvas.tsx`

**Wheel (zoom):**

* Listener: `canvas.addEventListener('wheel', onWheel, { passive: false })` and `e.preventDefault()`.
* Compute `cx, cy` in canvas CSS px from `e.clientX/Y` + `getBounds()`. Call `controller.onWheel(e, cx, cy)`; controller sets/animates `targetScale` and derives pan each frame (cursor-locked). (Transform change auto-invalidates both loops via your effect.) 

**Auxclick (block autoscroll):** prevent default on MMB `auxclick`.

**MMB pan (transient):**

* In your unified pointer handlers, **early-branch** for `e.button === 1 && e.pointerType === 'mouse'`:

  * **Down:** `setPointerCapture`, cache starting pan (`pan0`) and starting canvas coords; call `controller.beginPanMMB(...)`. **Do not** call the active tool’s `begin`. Keep toolbar `activeTool` unchanged. 
  * **Move:** if transient pan active, compute Δc and `setPan(pan0 − Δc/s)`. (Controller helper does the math; Canvas just feeds client coords.)
  * **Up/Cancel/LostCapture:** call `controller.endPanMMB(...)`; release capture; revert cursor to whatever the original tool wants. Your Canvas already has robust release paths. 
* **Sticky PanTool:** when `activeTool === 'pan'`, the same pointer path runs on **LMB** instead (handled inside `PanTool` which delegates to the same math).

## 4) Animation & render loops

* You already invalidate on transform change (Canvas effect triggers base‐loop `invalidateCanvas({1×1})` and overlay `invalidateAll()`), and the base loop detects transform changes to promote to **full clear**. That’s perfect for the animated zoom and avoids any “jitter” from partial clears.  
* Overlay loop always full-clears each frame and draws previews/presence against the current view; no work needed. 

## 5) Exact formulas (recap)

* **Transform (authoritative):**
  `canvas = (world − pan) × scale`; inverse `world = canvas/scale + pan`. Context: `ctx.scale(scale); ctx.translate(-pan.x,-pan.y)` for world pass. 
* **Pan (drag Δc in CSS px):**
  `pan = pan0 − Δc/scale`. 
* **Zoom-to-cursor (factor f):**

  ```
  s1   = clamp(scale * f)
  world = (cx/scale + pan.x, cy/scale + pan.y)
  pan1  = ( world.x - cx/s1, world.y - cy/s1 )
  ```

  Apply while **animating** from `scale → s1`. 

## 6) Device-UI store interactions (what we do and don’t do)

* **Sticky:** When the user picks Pan in the toolbar, call `setActiveTool('pan')`. Canvas constructs `PanTool`.  
* **Transient (MMB):** Do **not** call `setActiveTool`. Keep the current tool alive; Canvas routes to transient pan handlers until MMB is released, then falls back to the *same* tool. (No tool teardown; no overlay preview provider churn.) 
* **Optional UI hint:** If you want the toolbar to visually show “Pan” while MMB is down, add a `transientHint` field in the store and set/clear it from Canvas. This shouldn’t affect tool instantiation (don’t put it in the Canvas tool-creation effect deps).

## 7) Zoom UI (buttons / fit)

* Keep Zoom UI in its own component, but have it **call the controller** so it shares the same smoothing and anchor math (anchor = view center when called from buttons). Your keyboard hook already points users to the ZoomControls component; keep that path. 

---

# Minimal glue you’ll add in `Canvas.tsx`

* **Refs**: `viewTransformRef`, `lastMouseClientRef`, plus controller instance ref.
* **Listeners** (non-passive where needed): `wheel`, `auxclick`, and the unified pointer handlers branch for MMB.
* **Transform change effect**: you already have it; it invalidates base & overlay on zoom/pan updates (leave as-is). 

**Coordinate acquisition:** Use your existing stable converters that read fresh transform from refs—no stale transform/cursor issues. 

---

# Why this cleanly fits your architecture

* Honors your world-unit pan contract and transform order, so math is 1:1 with render. 
* Leverages your event-driven loops: transform writes → Canvas effect invalidates → base loop promotes to full clear; overlay always full-clears. Zero extra draw plumbing.  
* Keeps tool-agnostic pointer surface intact and prevents mid-gesture teardown by **not** toggling `activeTool` for MMB pan. (Active tool creation is clearly gated in your Canvas effect.) 

---

## Quick callouts I’d explicitly add/clarify 

1. **Transient Pan (MMB)**: “MMB panning is a Canvas-level override that never sets `activeTool`; it routes pointer events to the controller and reverts automatically on release.”
2. **PanTool (sticky)**: “Selecting Pan in the toolbar sets `activeTool='pan'`; `PanTool` pans with LMB using the same world-unit math.”
3. **Zoom Controller**: “All zoom (wheel/buttons/fit) goes through the shared controller; it uses multiplicative scaling + exponential approach and recomputes `pan` each frame from a fixed `anchorWorld`.”
4. **Limits**: “Clamp via `PERFORMANCE_CONFIG` and set **0.01–5×** range.” 
5. **Transform-change invalidation** (already present): “Canvas effect invalidates both loops on any change to `view.scale` or `view.pan`.” 

Heck yes—let’s give your zoom/pan flows some ✨cursor personality✨ without breaking the tool system.

Below is a drop-in architectural plan that fits your two-canvas model, respects your “tool-agnostic” pointer surface, and keeps MMB pan transient (no tool teardown). I’ll show exactly where to hook this into `Canvas.tsx`, which state to read/write, and how to avoid stale cursor/transform while keeping 60fps.

---

# Goals

1. **Custom pan cursors** (open hand vs. grabbing) with micro-animations and big personality.
2. **Zoom pulse** near the pointer on wheel (plus/minus ring), **without** switching the toolbar tool.
3. **No tool teardown** during MMB pan; PanTool (sticky) still exists for users who select it in the toolbar.
4. **Zero drift** + **no stale data**: pull fresh pointer + view from refs each frame.
5. **No perf regressions**: CSS transforms, pointer-events: none, rAF-coalesced moves.

(Why a DOM cursor overlay vs plain CSS? DOM gives you larger, animated, brandable cursors beyond the 32–128px native cursor cap and can react to state. CSS cursor images are great as a fallback. )

---

## 1) File layout

Add a tiny “cursor HUD” layer that sits **above** your overlay canvas and is completely **pointer transparent**:

```
/client/src/canvas/
  Canvas.tsx                   // existing: wire events + controller
  useZoomPanController.ts      // (from our earlier spec)
  cursor-hud/
    CursorHud.tsx              // DOM overlay that follows pointer
    cursor-hud.css             // animations, themes, prefers-reduced-motion
    icons/                     // inline SVGs (hand-open, hand-closed, magnify +/-)
```

You already host DOM for the Text tool. Reuse that idea (screen-space after DPR) and mount `CursorHud` as a sibling DOM layer above the overlay canvas. Keep it `pointer-events: none` so pointer capture continues to work on the canvas.  

**Z-order (lowest → highest):**

1. Base canvas (world)
2. Overlay canvas (preview + presence) — you already full clear each frame here. 
3. **CursorHud DOM** (our new layer; screen-space, DPR-aware)
4. Text editor host (if active)

---

## 2) Cursor state model (separate from `activeTool`)

Do **not** drive the cursor UI from `activeTool` when MMB panning—MMB is a **transient override** and must not rebuild tools. Your toolbar state lives in Zustand: `activeTool` + setters. We’ll keep that intact.  

Add a **pure UI signal** for the cursor that never triggers tool creation:

```ts
// cursor-hud/cursorTypes.ts
export type CursorMode =
  | 'hidden'              // e.g., eraser shows its own ring; OS cursor hidden
  | 'default'             // crosshair or nothing
  | 'pan-idle'            // open hand
  | 'pan-active'          // closed hand (MMB down or PanTool drag)
  | 'zoom-in-pulse'       // wheel up: + ring pulse
  | 'zoom-out-pulse';     // wheel down: – ring pulse
```

Where to store it:

* **Option A (recommended):** local to `Canvas.tsx` in a ref/state managed by event handlers. This avoids creating new store deps and guarantees **fresh** cursor state tied to the active canvas instance.
* **Option B (if you want toolbar hinting):** add `transientCursorHint: CursorMode | null` to the device UI store purely for **visual indication** (don’t key tool creation off it). The store already holds toolbar state; just make sure **Canvas never reads this to rebuild tools**. 

Your keyboard placeholder currently switches `activeTool` to Pan on **space**. If/when you want “hold space to pan,” convert that to the **transient cursor + transient pan** path instead of flipping `activeTool`. 

---

## 3) CursorHud.tsx (DOM-based cursor)

A tiny React component that:

* Renders one absolutely-positioned, pointer-transparent element (`position: fixed; z-index: HUD; pointer-events: none; transform: translate(-50%, -50%)`).
* Subscribes to a **lightweight signal** from `Canvas.tsx` (props or context) for:

  * `mode: CursorMode`
  * `pos: { x: number; y: number }` (client coords in CSS px)
* Uses CSS classes for animation and state; keep assets inline SVG for crisp scaling.

**CSS (essentials):**

```css
/* cursor-hud.css */
.cursor-hud {
  position: fixed;
  width: 40px; height: 40px;    /* bigger than OS cursor */
  pointer-events: none;
  z-index: 5;                   /* above overlay canvas */
  transform: translate(-50%,-50%);
  will-change: transform, opacity;
}

.cursor-hud__hand { /* pan-idle vs pan-active visuals */ }
.cursor-hud--pan-idle    .cursor-hud__hand { /* open */ }
.cursor-hud--pan-active  .cursor-hud__hand { /* closed + pulse */ }

.cursor-hud--zoom-in-pulse .cursor-hud__ring { /* + icon + quick scale/opacity keyframe */ }
.cursor-hud--zoom-out-pulse .cursor-hud__ring { /* − icon + quick scale/opacity keyframe */ }

@media (prefers-reduced-motion: reduce) {
  .cursor-hud { transition: none; animation: none; }
}
```

Why DOM? You get large, animated, branded cursors and subtle states (open→closed hand, springy zoom ring) that feel premium. When DOM is disabled (reduced motion, perf constraints), fall back to CSS cursors (`grab`/`grabbing`) so users still see affordance. 

---

## 4) Canvas.tsx: wiring (no stale info, no tool teardown)

You already **hide** the OS cursor for eraser and show crosshair otherwise: `canvas.style.cursor = activeTool === 'eraser' ? 'none' : 'crosshair'`. We’ll refine this so the OS cursor is hidden whenever the **CursorHud** is active, not just for the eraser. 

### 4.1 Replacing the cursor style line

Replace your single line with:

```ts
// If HUD is active (any CursorMode !== 'default'), hide OS cursor for consistency.
// Else fallback to tool-default (eraser: none; others: crosshair).
const hudActive = cursorModeRef.current && cursorModeRef.current !== 'default';
if (hudActive) {
  canvas.style.cursor = 'none';
} else {
  canvas.style.cursor = activeTool === 'eraser' ? 'none' : 'crosshair';
}
```

(Where `cursorModeRef` is a ref you control in `Canvas.tsx`.)

### 4.2 Keeping the HUD in sync (fresh position + fresh view)

* On **pointermove**, you already store `lastMouseClientRef`—keep doing that; feed it into the HUD. 

* On **wheel**, compute `(cx, cy)` from `e.clientX/Y + getBounds()` and forward to both:

  1. **zoom controller** (so zoom anim is anchored to `anchorWorld`)
  2. **cursor HUD**: set `mode` to `'zoom-in-pulse'` or `'zoom-out-pulse'`, and start a 150–250ms debounce to revert to `'default'` (or `'pan-idle'` if PanTool is active). This is purely visual and doesn’t touch tools or preview providers. (Overlay still full-clears each frame; HUD is DOM.)  

* On **MMB down** (our transient pan path in the unified pointer handlers), set `cursorMode = 'pan-active'` until release/cancel/lost capture, then snap back to the pre-existing tool’s implied cursor (`'default'` or `'pan-idle'` if the sticky PanTool is the active tool). **Do not** call `setActiveTool('pan')` here; that would rebuild tools—your tool creation branch runs once on `activeTool` change.  

* When **PanTool is actually selected** in the toolbar (`activeTool === 'pan'`), set HUD to `'pan-idle'` on hover and `'pan-active'` while dragging (LMB). This version of pan lives inside the tool (sticky), but it should still emit cursor HUD state.

### 4.3 “No stale” rule of thumb

* **Positions:** always read `e.clientX/Y` → compute canvas CSS `(cx, cy)` from the current element bounds; don’t cache bounds across zoom because CSS layout can change (safe to read per event).
* **Transform:** the zoom controller already uses `viewTransformRef.current` at the exact moment we receive wheel/pan, and then recomputes pan each frame from **the same** `anchorWorld` + current animated `scale`. The HUD only needs **screen** coords; it doesn’t use world at all, so it won’t drift.

---

## 5) States & transitions (MMB, PanTool, wheel)

**MMB (transient pan, tool unchanged):**

* `pointerdown (button === 1)` → `cursorMode = 'pan-active'` → `setPointerCapture` → pan math in world units → `cursor follows client coords` → `pointerup/cancel` → `cursorMode = backTo(toolImpliedMode)`; no tool teardown. 

**Sticky PanTool (toolbar):**

* On hover: `cursorMode = 'pan-idle'` (open hand).
* On drag: `cursorMode = 'pan-active'` (closed hand).
* Tool created **once** because `activeTool` changed. 

**Wheel zoom:**

* Normalize → set zoom target → start anim; **also**: set `cursorMode` to `'zoom-in-pulse'` if zooming in (negative steps → factor > 1), `'zoom-out-pulse'` if zooming out, with a short pulse animation and a timer to revert. Overlay continues its full clear; HUD is independent. (Wheel normalization and zoom-to-cursor math from our earlier spec.)  

---

## 6) Visual design notes (quick)

* **Pan:** big hand (36–44px), subtle tilt on grab, micro-scale (1.05→1.1) with a 120–180ms ease.
* **Zoom:** ring (32–40px) with +/- glyph, short “breathing” pulse on each wheel batch (debounced).
* **Eraser:** keep your “circle preview” in overlay; set OS cursor to `'none'` (already in your code). 
* **Accessibility:** obey `prefers-reduced-motion` and allow a setting to switch to OS cursors only.
* **Fallbacks:** when HUD disabled, use CSS `cursor: grab/grabbing` (or custom PNG at 32×32 with hotspot) and class toggle on the canvas element. 

---

## 7) Minimal code hooks (where to put things)

**In `Canvas.tsx` (same effect that creates the tool & sets preview provider):**

1. **Mount the HUD** as a sibling element (React portal or component in the Canvas tree) and pass it:

   * `cursorModeRef.current`
   * `lastMouseClientRef.current` (client coords)
   * `enabled: !isMobile`

2. **Replace** the single `canvas.style.cursor = ...` line with the “HUD aware” logic above. 

3. **Wheel handler**:

   * `preventDefault()`, compute `(cx, cy)`; forward to zoom controller **and** call `pulseZoom(mode)` to set `cursorMode` + debounce back to previous.

4. **Unified pointer handlers**:

   * Branch MMB: set capture, `cursorMode='pan-active'`, pan in world units, on release revert to previous. Keep LMB routed to the current tool (or PanTool if sticky pan is selected). 

5. **Overlay loop**: No changes. You already full-clear each frame and draw previews/presence; the HUD is separate DOM. 

---

## 8) Pan/Zoom math (unchanged, included here for completeness)

* **Pan (MMB or PanTool):** with drag Δ in **canvas CSS px**, `s = current scale`
  `pan = pan0 − Δ/s` (component-wise). (World-unit pan consistent with your transform.)
* **Zoom-to-cursor (every animation step):**
  `world = (cx/scale + pan.x, cy/scale + pan.y)` → at `s1` =>
  `pan1 = (world.x − cx/s1, world.y − cy/s1)`
  (Use exponential approach for `scale` and recompute `pan` each frame from **the same** anchorWorld.)
  These formulas match your transform contract & order. 

---

## 9) Why this cleanly fits your architecture

* **Tool-agnostic surface stays tool-agnostic**: MMB never toggles `activeTool` → no tool rebuild; sticky PanTool still works when selected. 
* **Render loops unaffected**: we still only mutate `scale/pan` and your existing effect invalidates both loops, promoting to full clear on transform change (which you said is fine every frame during zoom). 
* **HUD is purely DOM**: pointer-transparent, updated at rAF with client coords, avoids mixing with world transforms and keeps FPS silky. Presence cursors remain in the overlay canvas; local cursor is HUD. 

---

love it — let’s wire this up cleanly and keep it in the shape your canvas architecture already expects. Below is **implementation-level pseudocode** (not copy-paste TS), tied to your files and patterns. I’m leaning on your existing transform math, render loop invalidation, and unified pointer surface so zoom/pan feel buttery without fighting your tools.

I’ll call out spots I’m piggybacking on your code with inline references.

---

# — Zoom-to-Cursor + Middle-Mouse Pan (Pseudo-Spec)

## Files & responsibilities

* `Canvas.tsx`

  * Attach **wheel** and **MMB pan** handlers on the canvas element.
  * Maintain **transient pan gesture** state (for MMB), **without** toggling the toolbar tool.
  * Route pointer events to the active `PointerTool` (unchanged), but *intercept* MMB when panning.
  * Keep live `lastMouseClientRef` for zoom anchor (you already update this in `pointermove`). 
  * Trigger frames by simply updating view transform; your `useEffect([scale, pan])` already invalidates both loops. 
  * Important: **do not include** view transform in tool-construction effect deps (you already don’t), so we never teardown tools mid-zoom. 

* `ViewTransformContext.tsx`

  * Source of truth for `{ scale, pan }` with clamp helpers.
  * Expose `setView(scale, pan)` (or `setScale`/`setPan`) that we call per animation tick.
  * Keep your transform formulas:
    `canvas = (world - pan) * scale` and inverse `world = canvas/scale + pan`. 

* `internal/transforms.ts` (already present as `transform.ts.md`)

  * Use **authoritative** zoom-to-point math here (see `calculateZoomTransform`). 
  * Keep `clampScale()` with your global MIN/MAX (adjust to `.01x → 5x` if that’s the final product requirement). 

* `OverlayRenderLoop` / `RenderLoop`

  * No changes needed; they already **full-clear overlay** and **promote full clear** on transform change. We just set the transform and their existing invalidation handles the rest.  

* `device-ui-stores.ts`

  * Keep `activeTool` as-is (pen/highlighter/eraser/text/select/pan). 
  * **Do not** switch `activeTool` for **MMB pan**; treat that as a **transient gesture** only. If the user clicks the pan icon in the toolbar, then `activeTool = 'pan'` (persistent). Store already exposes `setActiveTool`. 

---

## Input model

### Wheel zoom (zoom-to-cursor)

* **Event**: `wheel` on the canvas element (non-passive so we can `preventDefault()`).
* **Anchor**: cursor position at event time. Use `screenToWorld(e.clientX, e.clientY)` to get **world** anchor (you already have that helper in `Canvas.tsx`). Use `lastMouseClientRef` if wheel events can arrive when pointer isn’t moving.  
* **Delta normalization**: convert varied `deltaY` to unit “ticks”. Your research suggests the classic normalization; we’ll adopt the normalized “wheel units” and then map to a **percentage step**. 
* **Step size**: target **8–12% per wheel tick** (sweet spot), with a mild adaptive multiplier by current zoom (slower at high zoom, faster at low). 
* **Zoom factor per event**: compute `zoomFactor = 1 + (-normalizedDelta * step)`, clamp to min/max, and compute the corresponding **pan** so the anchor stays fixed (formula below).

### Middle-mouse pan (MMB + drag)

* **Event**: `pointerdown` with `button === 1` (mouse wheel press) → **transient pan mode starts** (no toolbar change).
* **Movement**: `pointermove` updates `pan` in **world units** based on screen delta and **scale at gesture start**.
* **End**: on `pointerup`/`pointercancel`/`lostpointercapture` → **transient pan ends**, cursor returns to normal, tools unchanged. (You already have the capture/release and cancel scaffolding.)  

### Toolbar Pan tool (persistent)

* If the user explicitly selects the Pan tool in the toolbar (`activeTool = 'pan'`), we run the **exact same pan gesture** logic — but this time it’s **not transient**, and we can keep a **pan cursor** until tool changes. (Store already supports `activeTool: 'pan'`.) 

---

## Core formulas

* **Transform** (authoritative):
  `worldToCanvas = [(x - pan.x) * scale, (y - pan.y) * scale]`
  `canvasToWorld = [x / scale + pan.x, y / scale + pan.y]` 

* **Zoom-to-point pan update** (keep world anchor under the cursor):
  Given current `scale`, `pan`, `zoomFactor`, and **canvas-space** zoom center `C = (cx, cy)`, compute:

  * `newScale = clampScale(scale * zoomFactor)`
  * `world = C / scale + pan`
  * `newPan = world - C / newScale`
    This is exactly your `calculateZoomTransform`. Use it. 

* **Pan by dragging** (MMB):

  * Cache at `pointerdown`: `startPan = pan`, `startScale = scale`, `startClient = (sx, sy)`.
  * On move: `deltaCanvas = (cx - sx, cy - sy)`.
  * Convert to **world** delta: `deltaWorld = (deltaCanvas.x / startScale, deltaCanvas.y / startScale)`.
  * Update: `pan = { x: startPan.x - deltaWorld.x, y: startPan.y - deltaWorld.y }`.

---

## Smoothing model

**Goal:** Feel immediate (no dinosaur lag) but still “buttery”. Use a short **critically-damped** approach for zoom and a light **inertia-less** pan.

### Zoom smoothing (event → short animation)

* Maintain an internal **ZoomAnimator** state:

  * `currentScale`, `currentPan` (from context)
  * `targetScale`, `targetPan`
  * `active` boolean
* On each `wheel`:

  1. Normalize delta to “ticks”.
  2. Compute **instant** `targetScale/targetPan` with the formula above (using cursor as anchor).
  3. Start/continue an rAF **tween** for ~90–140 ms to approach target.
* Per-frame step (`dt` seconds):

  * Use exponential approach:
    `λ = 18` (≈ ~120 ms half-life),
    `blend = 1 - exp(-λ * dt)`
    `scale = lerp(scale, targetScale, blend)`
    `pan = lerp(pan, targetPan, blend)`
* Write back via context setters. Your `useEffect([scale, pan])` will invalidate both loops each time (no extra invalidation calls needed). 

> Why this model? It’s **state-less** with respect to the loops; we only change the view transform. Overlay/full clears while zooming are fine per your perf note, and your base loop already promotes transform changes to full clear. 

### Pan smoothing

* **MMB drag** should feel 1:1 with the pointer (no spring or inertia by default).
* Optional: apply a tiny **micro-filter** for noisy devices: `pan = pan + (rawPan - pan) * 0.25` once per frame while dragging — but keep it minimal to avoid “laggy” feel.

---

## Wheel handler (pseudocode)

```ts
// Inside Canvas.tsx setup (same effect where you attach pointer listeners)
// NOTE: keep as non-passive; do not re-run effect mid-gesture (you already exclude viewTransform).
function handleWheel(e: WheelEvent) {
  // ignore if mobile; ignore while an active pointer tool is drawing (optional)
  e.preventDefault();

  // 1) Normalize delta to "ticks"
  // normalizedDelta ≈ +1 per notch (positive = scroll down)
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 40;       // lines → px
  else if (e.deltaMode === 2) d *= 800; // pages → px
  const ticks = d / 120;

  // 2) Choose base step (8–12%). Add mild adaptivity by current scale.
  const baseStep = 0.10; // 10%
  const adaptive = clamp(0.75, 1.25, Math.sqrt(view.scale)); 
  const step = baseStep * (1 / adaptive);

  // 3) Convert to zoom factor. Scroll up = zoom in.
  const zoomFactor = 1 + (-ticks * step);

  // 4) Cursor anchor in canvas & world space
  const cx = e.clientX, cy = e.clientY;
  const world = screenToWorld(cx, cy); // already in Canvas.tsx
  if (!world) return;

  // 5) Compute target scale/pan with your helper (cursor-locked)
  const C = clientToCanvasPoint(cx, cy); // canvas coords relative to top-left of canvas element
  const { scale: sT, pan: pT } =
    calculateZoomTransform(view.scale, view.pan, zoomFactor, C); // from transforms.ts

  // 6) Submit to ZoomAnimator targets and kick rAF tween (90–140ms easing)
  zoomAnimator.to(sT, pT); // will rAF and call setView() each frame
}
```

> Notes:
>
> * Use your existing **world/canvas conversion** helpers (they already exist around `screenToWorld`). 
> * If your canvas is positioned/scaled, `client → canvas` is simply `client - canvas.getBoundingClientRect().left/top` (unscaled CSS px, which is what `calculateZoomTransform` expects for `zoomCenter`). 

Attach the handler once (non-passive) alongside your pointer listeners:

```ts
canvas.addEventListener('wheel', handleWheel, { passive: false });
```

Cleanup in the same effect teardown (you already do this pattern for pointers). 

---

## ZoomAnimator (pseudocode)

```ts
class ZoomAnimator {
  constructor(getView, setView) { /* refs to context */ }
  to(targetScale, targetPan) {
    this.targetScale = clampScale(targetScale); // use your clamp
    this.targetPan = targetPan;
    if (!this.active) { this.active = true; requestAnimationFrame(this.tick); }
  }
  tick = (tNow) => {
    const dt = secondsSinceLastTick();
    const blend = 1 - Math.exp(-18 * dt); // ~120ms
    const v = getView(); // current scale/pan from context ref

    const s = v.scale + (this.targetScale - v.scale) * blend;
    const p = {
      x: v.pan.x + (this.targetPan.x - v.pan.x) * blend,
      y: v.pan.y + (this.targetPan.y - v.pan.y) * blend,
    };

    setView(s, p); // triggers Canvas.tsx transform-change effect → invalidates both loops
    if (near(v, { scale: this.targetScale, pan: this.targetPan })) {
      setView(this.targetScale, this.targetPan);
      this.active = false;
      return;
    }
    requestAnimationFrame(this.tick);
  }
}
```

* `setView(s, p)` is just your `setScale`/`setPan` pair; the **effect** in `Canvas.tsx` already triggers `renderLoop.invalidateCanvas()` and `overlayLoop.invalidateAll()` when scale/pan change. 
* Use your `clampScale()` from transforms. 

---

## Middle-mouse pan (transient) — unified pointer pipeline

**Do not** change `activeTool` for MMB. Keep your “branch once, unified handlers” pattern intact. 

Add an **MMB gate** inside the unified handlers:

```ts
// in the same effect where other pointer listeners live

let mmb = { active: false, pointerId: null, startClient: {x:0,y:0}, startPan: {x:0,y:0}, startScale: 1 };

function handlePointerDown(e) {
  if (isMobile) return;

  if (e.button === 1) {
    // TRANSIENT PAN START (no toolbar change)
    e.preventDefault();
    mmb.active = true;
    mmb.pointerId = e.pointerId;
    mmb.startClient = { x: e.clientX, y: e.clientY };
    mmb.startPan = view.pan;
    mmb.startScale = view.scale;
    canvas.setPointerCapture(e.pointerId);
    setCursorMode('pan-grabbing'); // see cursor section
    return;
  }

  // else: route to active tool (your existing code)
  // tool.begin(...)
}

function handlePointerMove(e) {
  lastMouseClientRef.current = { x: e.clientX, y: e.clientY }; // you already do this

  if (mmb.active && e.pointerId === mmb.pointerId) {
    const dx = e.clientX - mmb.startClient.x;
    const dy = e.clientY - mmb.startClient.y;

    // convert screen delta → world delta using scale at gesture start
    const wx = dx / mmb.startScale;
    const wy = dy / mmb.startScale;

    setView(view.scale, { x: mmb.startPan.x - wx, y: mmb.startPan.y - wy });
    return;
  }

  // else: your existing awareness + tool.move(...)
}

function endMMB(e) {
  if (!mmb.active || e.pointerId !== mmb.pointerId) return;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  mmb.active = false;
  mmb.pointerId = null;
  setCursorMode('default');
}

canvas.addEventListener('pointerup', endMMB, { passive: false });
canvas.addEventListener('pointercancel', endMMB, { passive: false });
canvas.addEventListener('lostpointercapture', endMMB, { passive: false });
```

* This ignores tools during MMB pan and **doesn’t recreate** anything (no store changes).
* When the user selects **Pan** from the toolbar (`activeTool='pan'`), you can instead instantiate a tiny `PanTool` that does the same math above inside `begin/move/end`, just to remain strictly tool-polymorphic. But it’s not required; the transient MMB path can live in `Canvas.tsx`.

---

## Tool switching rules

* **MMB pan**: never updates `device-ui` `activeTool`. Toolbar remains on the previous tool and **snaps back** visually as soon as the drag ends (because we never left it).
* **Toolbar pan**: sets `activeTool='pan'` persistently. Cursor adopts pan mode until the user picks another tool. Store supports `setActiveTool`. 
* **Spacebar**: your keyboard file currently sets `'pan'` on key **down** and doesn’t revert on **up** (placeholder). For now, **do not** rely on it; we’ll keep zoom logic in `Canvas.tsx` per your note, and treat Space integration as a future refinement.

---

## Cursor personality (CSS/DOM)

You already hide the OS cursor for eraser by setting `canvas.style.cursor`. 

For pan/zoom, add a **cursor manager** that toggles CSS classes on the canvas container (or a small DOM cursor element). Two options:

### A) Simple, fast (CSS image cursor)

* Default: `cursor: crosshair` (or your current).
* Pan hover: `cursor: url(hand-open-32.png) 16 16, grab;`
* Pan dragging: `cursor: url(hand-closed-32.png) 16 16, grabbing;`
  (Recommended sizes/limits in your cursor doc.) 

### B) Fancy, DOM-based cursor (Figma-style)

* A `div.custom-cursor` following the mouse (`pointer-events:none`) to allow animation states (open/closed hand, pulse on grab). 
* Toggle `.grabbing` while panning to animate. 

**Hook point:** in the same effect where you attach listeners, call `setCursorMode('pan')` on `pointerdown` MMB and `setCursorMode('default')` on end. For persistent toolbar pan, call `setCursorMode('pan')` when `activeTool==='pan'` changes.

---

## Canvas.tsx — wiring checklist (pseudocode)

```ts
useEffect(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas) return;

  // Wheel zoom
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  // Pointer (you already attach these)
  canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
  canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
  canvas.addEventListener('pointerup', handlePointerUp, { passive: false });
  canvas.addEventListener('pointercancel', handlePointerCancel, { passive: false });
  canvas.addEventListener('lostpointercapture', handleLostPointerCapture, { passive: false });

  return () => {
    canvas.removeEventListener('wheel', handleWheel);
    // ...remove others (you already do this in your cleanup)
  };
}, [/* same deps as your unified pointer effect; importantly, NOT viewTransform */]);
// You already exclude viewTransform from deps to avoid mid-gesture teardown. :contentReference[oaicite:32]{index=32}
```

And rely on your transform-change effect to invalidate both render loops per frame during the animation: 

---

## Parameters worth locking in (product feel)

* **Zoom limits**: clamp **0.01x → 5x** (your stated range). Update `PERFORMANCE_CONFIG` or your `clampScale` sources accordingly. 
* **Wheel step**: base 10% per normalized tick, adaptivity ~±25% across the range. Derived per event from current `scale`. 
* **Zoom animation**: 90–140 ms crit-damp exponential, frame-driven by rAF.
* **Pan sensitivity**: 1:1 with pixels / scale (world-accurate), **no inertia** by default.

---

## Things I’m purposely not changing

* **Unified pointer surface**: still branch once to pick tool instance; we just detect MMB in Canvas and short-circuit to pan math. Your unified handlers remain the single surface.  
* **Overlay/Base render loops**: no extra scheduling; transform changes already force frames and promote full clear when needed. 

---


