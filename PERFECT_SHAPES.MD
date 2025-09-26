# Perfect Shapes (350 ms dwell → lock → adjust in preview → commit on pointer‑up)

This spec defines **freehand→perfect‑shape** recognition inside the existing DrawingTool. It is intentionally **simple** and mirrors the current stroke flow: local overlay preview during capture, **single commit on pointer‑up**, and no extra escape hatches or keyboard affordances.

---

## Scope

We recognize and snap only these primitives during a freehand stroke:

* **Line**
* **Rectangle**
* **Square**
* **Triangle (equilateral only)**
* **Circle**

> **Non‑goals:** No arbitrary triangle types; no angle‑snap for lines; no keyboard confirmations; no “replace‑in‑place” semantics (we never stage a scribble in the Y.Doc, so there’s nothing to replace).

---

## Behavioral goals

* **Overlay‑only until commit.** Recognition + adjustment live purely in the overlay preview; the base doc shows nothing until we commit a single canonical stroke on pointer‑up.
* **No ghosts.** Once we switch to a perfect‑shape preview, the scribble preview disappears from overlay.
* **Commit exactly on pointer‑up.** There is **one** way to finish: release the pointer. We do not support **Esc** to cancel or **Enter** to commit.
* **Committed result is a normal Stroke.** We synthesize a polyline for the canonical shape and commit using the same path as regular strokes (simplify → budgets → bbox → `mutate` once).
* **No “sticky lock” concept needed.** When recognition fires (after dwell), the preview simply becomes the perfect shape and stays that way until pointer‑up. There is no unlock path or back‑to‑scribble path in the same gesture.

---

## State machine (within DrawingTool)

```
drawing.capture
  ├─(recognizer score ≥ θ AND dwell τ=350ms)→ perfectShape.locked { kind, canonicalParams, anchor, r0 }
  │     └─(pointermove while down)→ perfectShape.adjust (overlay‑only)
  │          ├─ shapes≠line: params' = params × k(center, pointer)
  │          └─ line:        p1 = pointerNow (angle & length follow pointer)
  └─(pointerup)→ commitOnce(params' | p0→p1) → idle
```

**Notes**

* `anchor` is **center** for rect/square/triangle/circle; for **line** it is the **first world point**.
* `r0` is the baseline distance for scaling, captured at lock time.

---

## Lock trigger (recognizer)

During capture, the recognizer computes a confidence score from the in‑progress point stream. When its **best candidate** satisfies:

* `score ≥ θ` (per‑shape threshold; tune empirically), **and**
* the candidate has remained stable for a **dwell τ = 350 ms**,

…we **lock** to `(kind, canonicalParams)` and compute the **anchor** and **r0**. At that moment we **swap** the preview from `{ kind: 'stroke' }` to `{ kind: 'perfectShape' }` and invalidate the old bounds so the scribble disappears.

> **Rationale:** A fixed 350 ms dwell defers accidental locks and aligns with common drawing‑app behavior without extra velocity/heuristic gates.

### Canonical parameterizations

* **Line:** `(p0, p1)`; `p0 = firstPointWorld`, `p1` evolves with pointer.
* **Rectangle/Square:** `(center, halfW, halfH, rotation=0)`; for **square**, `halfW == halfH`.
* **Triangle (equilateral):** `(center, sideLength, rotation0)`; we only fit an equilateral footprint, oriented by `rotation0` at lock.
* **Circle:** `(center, r)`.

> The recognizer only needs to output **kind + minimal params** plus a **center** (for non‑line shapes). Rotation remains whatever was inferred at lock; no live rotation in this phase.

---

## In‑gesture adjustment (preview‑only)

### Scale derivation for shapes (rect/square/triangle/circle)

* **Anchor:** `center`.
* **Radial scale:**

  ```
  r0 = max(distance(center, pointerAtLock), r_eps_world)   // r_eps_world ≈ 8px_screen → world
  r1 = distance(center, pointerNow)
  k  = clamp(r1 / r0, k_min, k_max)                        // e.g., [0.10, 10.0]
  ```
* **Apply:** multiply canonical size parameters by `k`:

  * Rect/Square: `halfW *= k; halfH *= k` (square keeps `halfW == halfH`)
  * Triangle (equilateral): `sideLength *= k`
  * Circle: `r *= k`

### Adjustment for line

* **Anchor:** `p0 = firstPointWorld`.
* **Live endpoint:** `p1 = pointerNow`. (No angle snapping; angle is unconstrained.)

### Overlay drawing

Overlay draws the **locked + adjusted** shape **in world space** every frame until commit (same world‑space pass as stroke preview). The preview includes a `bbox` for dirty‑rect invalidation.

---

## Commit (single atomic write on pointer‑up)

On **pointer‑up**:

1. **Synthesize a polyline** for the final canonical geometry:

   * **Line:** `[p0.x, p0.y, p1.x, p1.y]`
   * **Rectangle:** four corners + close (axis‑aligned; rotation=0)
   * **Square:** as rectangle with equal halves
   * **Triangle (equilateral):** three vertices + close (use `rotation0` set at lock)
   * **Circle:** round polyline (baseline 32 segments; optional LOD with radius)
2. **Simplify / bounds / size checks:**

   * Run the same pipeline as regular strokes: `simplifyStroke` → `estimateEncodedSize` (transport budget) → `calculateBBox` (inflated by stroke width).
3. **Mutate once:**

   * Append the stroke to `root.strokes[]` with the current scene, same as `commitStroke`.
4. **Redraw polish:**

   * Invalidate preview bounds and the new stroke bounds.
   * Request the overlay to **hold the last preview for one frame**, then clear (prevents flicker as base catches up).

---

## Integration details (what to add/change)

### 1) `types.ts` — add a preview discriminant for perfect shapes

```ts
export interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'rectangle' | 'square' | 'triangle' | 'circle';
  // For shapes≠line
  center?: { x: number; y: number };
  // For line
  p0?: { x: number; y: number };
  p1?: { x: number; y: number }; // live endpoint when shape==='line'
  // Canonical params at lock; scaled by k during adjust
  params: {
    halfW?: number; halfH?: number; // rectangle/square
    sideLength?: number;            // triangle (equilateral)
    r?: number;                     // circle
  };
  k?: number; // live uniform scalar for shapes≠line
  bbox: [number, number, number, number] | null; // for dirty‑rect tracking
}

export type PreviewData = StrokePreview | EraserPreview | PerfectShapePreview;
```

### 2) `OverlayRenderLoop` — render branch for `perfectShape`

* Add a `'perfectShape'` branch in the **world‑space** pass (same transform used for stroke previews).
* Render geometry from `params × k` (or `p0→p1` for line) using current tool style (color/size/opacity) for continuity.
* Keep pass ordering the same: preview (world) → presence → any screen‑space affordances.

### 3) `DrawingTool` — shape‑lock substate (small, self‑contained)

* On each RAF‑coalesced `addPoint`, feed the point stream to the recognizer.
* When `(score ≥ θ) && dwell(350ms)`:

  * Capture `{ kind, canonicalParams }`.
  * Set **Anchor**: `firstPointWorld` for line; `center` for others.
  * Set `r0 = max(dist(anchor, pointerAtLock), r_eps_world)`.
  * **Swap preview** to `{ kind: 'perfectShape', ... }` and immediately invalidate the old stroke preview bounds.
* While pointer is down:

  * **Line:** update `p1 = pointerNow`.
  * **Others:** recompute `k` from radial distance; update preview params + `bbox`.
* On pointer‑up: synthesize polyline → simplify/budget/bbox → **mutate once** → invalidate preview/new bounds → ask overlay to **hold preview for one frame** → clear.

> The DrawingTool remains the preview provider; Canvas doesn’t change. No Y.Doc writes happen until the single commit.

---

## Recognizer notes (minimal, “dumb” rules)

* **Equilateral triangle only.** Fit to an equilateral template; reject if the inferred side‑length ratio between legs deviates beyond a simple tolerance (e.g., ±8%).
* **Lines:** allow any angle; no snap.
* **Rects/Squares:** infer axis‑aligned boxes (rotation fixed at 0). Square if aspect within a tolerance (e.g., |w−h|/max(w,h) ≤ 0.08); otherwise rectangle.
* **Circle:** fit center + radius from least‑squares distance to points; reject if radial variance exceeds a small tolerance.

> Keep thresholds simple and generous at first; accuracy will ride mostly on the dwell.

---

## Constants & defaults

* **Recognition threshold `θ`:** per shape; tune empirically.
* **Dwell `τ`:** **350 ms (required)**.
* **`r_eps_world`:** world distance equivalent of **8 px** at lock time.
* **Scale clamps:** `k_min = 0.10`, `k_max = 10.0`.
* **Circle sampling:** 32 segments baseline; optionally increase with radius (screen‑space chord length target).

---

## Testing checklist (quick)

* Lock occurs only after **≥350 ms**; drawing fast curves should not lock.
* After lock, moving the pointer **adjusts** the shape; releasing commits exactly once.
* No cancel paths; pressing keys doesn’t affect the gesture.
* Commit produces a normal stroke; simplification/transport budgets are enforced; bbox is correct.
* Overlay **does not flicker** at commit (one‑frame hold works).
* Triangle recognizer only accepts **equilateral** cases within tolerance; otherwise no lock occurs.

---

## Appendix: pseudo‑code fragments

### Dwell timing (inside capture loop)

```ts
if (candidate.score >= theta) {
  if (!dwell.armTime) dwell.armTime = now;
  if (now - dwell.armTime >= 350) lock(candidate);
} else {
  dwell.armTime = 0; // reset if best candidate falls below threshold
}
```

### Scaling k for shapes≠line

```ts
const r1 = dist(center, pointerNow);
const k  = clamp(r1 / r0, k_min, k_max);
```

### Commit synthesis (sketch)

```ts
switch (shape) {
  case 'line': points = [p0.x, p0.y, p1.x, p1.y]; break;
  case 'rectangle': points = rectToPolyline(center, halfW*k, halfH*k); break;
  case 'square': points = rectToPolyline(center, half*k, half*k); break;
  case 'triangle': points = equilateralToPolyline(center, sideLength*k, rotation0); break;
  case 'circle': points = circleToPolyline(center, r*k, SEGMENTS); break;
}
```
