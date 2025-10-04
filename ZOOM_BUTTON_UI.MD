Awesome question — and I agree with your instincts. Here’s the behavior I’d ship for buttons vs. wheel, plus the smallest set of code changes to get you there without fighting your current transform model.

---

## TL;DR behavior (what the user will feel)

1. **Wheel/trackpad zoom = zoom-to-cursor (already your plan):** the world point under the cursor stays pinned to the same pixel while the scale animates. 

2. **Zoom buttons = zoom-to-viewport-center (fixed steps):** clicking **+**/**–** zooms around the **viewport center** (not the cursor) so it feels like “zoom where I’m looking.” Use **fixed multiplicative steps** (e.g., **×1.25** in, **÷1.25** out). No adaptivity on buttons. Clamp to 0.01×–5×. 

3. **Zoom to Fit** button: fits **content bounds** (or the base board if empty) with a little padding, centered. The pan/scale pair should be computed analytically so the result is exact. (Math below.)

4. **Initial view = centered, not left-anchored:** on first mount, if there’s no content, center the world origin in the viewport; if there is content or a base board, do a one-time **zoom-to-fit**. (You already expose `meta.canvas?: { baseW, baseH }` for a base board.) 

All of this plugs neatly into your existing transform contract:

```
canvas = (world - pan) * scale
// inverse:
world  = canvas/scale + pan
```

…and your helpers already encode it. 

---

## Implementation plan (small, surgical)

### 0) Keep using your authoritative math

You already have `calculateZoomTransform(currentScale, currentPan, zoomFactor, zoomCenterCanvas)` — use that for both wheel and buttons so they **feel the same** (only the anchor differs). 

---

### 1) Give the buttons a center anchor (no cursor)

Right now your buttons directly scale by ×1.2 and call `setScale`, which changes zoom but **doesn’t** update `pan` to keep a point fixed — that’s why we need the math path. 

Minimal fix:

* Compute the **canvas center** once per click.
* Run `calculateZoomTransform` with that center.
* Apply the returned `{ scale, pan }`.

**Where to get the center?** The `Canvas` already tracks its CSS size/DOMRect; expose a tiny API to consumers:

```ts
// Canvas.tsx — add a stable getter
const getCanvasCenter = useCallback(() => {
  const r = baseStageRef.current!.getBounds(); // CSS px
  return { x: r.width / 2, y: r.height / 2 };
}, []);
```

(You already have `baseStageRef` and resize plumbing.) 

Now expose a **Zoom API** via context or props so `ZoomControls` can call it:

```ts
// Canvas.tsx (same file)
import { calculateZoomTransform } from './internal/transforms'; // your transform.ts
// also get setScale/setPan from useViewTransform()
const { transform, setScale, setPan } = useViewTransform();  :contentReference[oaicite:7]{index=7}

const zoomByCentered = useCallback((factor: number) => {
  const C = getCanvasCenter();           // canvas anchor, CSS px
  const { scale, pan } = transform;
  const next = calculateZoomTransform(scale, pan, factor, C);
  setScale(next.scale);
  setPan(next.pan);
}, [getCanvasCenter, transform, setScale, setPan]);
```

(The helper preserves the anchor point: world under `C` stays at `C` after zoom.) 

In `ZoomControls.tsx`, replace the direct 1.2 math with **fixed steps** (e.g., 1.25):

```ts
// ZoomControls.tsx
// get zoomByCentered() from a small ZoomApi context you provide above Canvas
const STEP = 1.25; // 25% steps

const handleZoomIn  = () => zoomByCentered(STEP);
const handleZoomOut = () => zoomByCentered(1 / STEP);
```

Your current file shows the direct 1.2 multiplier — swap that out to call the API instead of `setScale` directly. 

> If you prefer a **ladder** of discrete stops (…75%, 100%, 125%, 150%, etc.), compute the next step using base-STEP logs:
>
> ```
> const logStep = Math.log(STEP);
> const up   = Math.exp(Math.ceil(Math.log(scale)/logStep)   * logStep);
> const down = Math.exp(Math.floor(Math.log(scale)/logStep)  * logStep);
> ```
>
> then target `up` or `down` and feed it to the same math path (`zoomFactor = target/scale`).

---

### 2) Keep wheel zoom exactly as you documented (cursor anchor)

Your Phase notes already spell out the invariant and even an animator; just be sure the handler funnels through the same `calculateZoomTransform` (as your pseudocode suggests) so both wheel and buttons share one source of truth. 

The invariant for **zoom-to-cursor** (also what `calculateZoomTransform` enforces):

```
world = (cx/scale + pan.x, cy/scale + pan.y)
pan'  = (world.x - cx/scale', world.y - cy/scale')
```

---

### 3) Add **Zoom to Fit** (content or base board)

Compute a tight world-space bounds `B = [minX,minY,maxX,maxY]` from your snapshot (strokes/texts), or fall back to `meta.canvas.baseW/baseH` when empty. 

Given a viewport of **CSS** size `(vw, vh)` and padding `p` (CSS px), let:

```
bw = B.maxX - B.minX
bh = B.maxY - B.minY
s  = clamp( min( (vw - 2p)/bw, (vh - 2p)/bh ) )
cx = vw/2
cy = vh/2
wx = (B.minX + B.maxX)/2
wy = (B.minY + B.maxY)/2
pan.x = wx - cx/s
pan.y = wy - cy/s
```

This centers the bounds and guarantees it fits. (You already expose viewport size through `CanvasStage.getBounds()` and have transform helpers if you need visible-bounds math.)  

Hook this up as a third button in `ZoomControls` (e.g., “Fit”), and wire it through the same Zoom API. (If you later add smoothing, you can animate `scale` → `s` while deriving `pan` from the center invariant per frame, just like the wheel animator.) 

---

### 4) Start centered, not left-anchored

On first mount:

* If there’s content (or base board): call **zoom-to-fit** once.
* Else: **center world origin** in the viewport. With `scale=1`, set:

  ```
  pan.x = -vw/2
  pan.y = -vh/2
  ```

  so world (0,0) is in the middle. (Because `canvas = (world - pan)*scale`, this maps world (0,0) → canvas (vw/2, vh/2).) You already have the resize callbacks and `baseStageRef` to read size.  

Your `ViewTransformContext` remains the single clamp point for min/max; no changes there. 

---

## Why viewport-center anchor for buttons?

* It matches user expectation: clicking **+** is “zoom into what I’m looking at” even if the mouse is far away (e.g., keyboard/touchpad users).
* It avoids accidental “jump-to-mouse” when the pointer is parked at an edge.
* It stays consistent with pan: users pan to frame an area, then jab **+** a couple times — the area stays centered and magnifies.

Your wheel path is already “zoom-to-cursor,” which is great for precision work; the button path complements it for coarse framing. The core math is identical — only the anchor point changes. 

---

## Small UI details to ship

* **Fixed steps:** choose **25%** (×1.25 / ÷1.25). It’s punchy without being jarring and lands on familiar percents (100%, 125%, 150%). Swap your current **1.2** multipliers to **1.25** and route through the center-anchor math. 
* **Label stays truthful:** your label already shows `Math.round(scale * 100)` — keep that, and keep the reset to 100%. 
* **Disabled states:** you already guard against min/max in the buttons; keep that. 
* **Optional:** hold **Alt** while clicking a zoom button to anchor at **last cursor** (nice power-user perk) — it’s the same call but you pass the cursor’s canvas point instead of viewport center. You already store `lastMouseClientRef` in `Canvas.tsx`, so you can compute that canvas point at call time. 

---

## “Do we snap to center first?” (answer)

No snap needed. **Zoom buttons should always anchor at the current viewport center** and apply the transform in place. If the user wants a different focal point, they’ll pan first (or put the cursor there and use the wheel). This keeps the mental model simple and avoids surprise jumps.

---

## Recap of the only code you *must* change right now

* Replace direct scale tweaks in **`ZoomControls.tsx`** with calls to a **center-anchored** zoom function (`zoomByCentered`), using **×1.25** steps. 
* In **`Canvas.tsx`**, add a tiny **Zoom API** (compute canvas center → call `calculateZoomTransform` → `setScale`/`setPan`), and provide it via context/prop to `ZoomControls`. 
* Add a **Zoom to Fit** helper using the bounds formula above (content or `meta.canvas` when empty). 
* On first mount, **center** (or **fit** if content/board present).

All math & clamping remain aligned with your current `ViewTransformContext` and transform helpers; you’re not inventing anything new — just choosing the correct anchor per control.  

