Got it—thanks for the concrete logs. The behavior you’re seeing (“random”, lots of `angle < 45°`, sometimes only 1–2 corners) actually makes sense given how the rectangle gate works:

* **Corner detector requires** a turn **> 45°** and that **both adjacent segments are ≥ 10 world units**. If either neighbor segment is short, that corner is skipped. 
* **Rectangle scoring hard-gates** on **≥ 3 right-angle corners (±20°)**. If we don’t get 3, the rect path is dead-on-arrival. 

Your new logs show RDP helped reduce the candidate set (20–39 “potential corners”), but the gate still fails because **too many of those candidate corners are disqualified**:

* “Skipped (short segments)” still shows up (6–10), which means **adjacent segments < 10 WU**.
* The rest show “angle < 45°,” which happens a lot when RDP keeps **a few extra points around rounded corners**; the immediate neighbor vectors don’t span enough of the turn to cross 45°. See the hard gate failing each time: **`Required: 3, Found: 0–2`**.  

So: **RDP alone isn’t enough.** In fact, depending on where it kept points, it can *accidentally* make a corner look like a series of sub-45° bends with short neighbor segments—exactly what your logs show.

---

## Minimal churn fix (inside `recognize-open-stroke.ts` only)

Keep the RDP step you added, but immediately **distance-decimate** the simplified copy so that consecutive points are **at least the corner-detector’s segment threshold** apart (≈10 WU) and optionally **micro-close** the path if the end is almost back at the start. This guarantees that when `detectEdgesAndCorners` examines triple points, **both neighbor segments are long enough** and the angular change spans the real corner.

> This keeps the architecture intact: we still pass raw preview points into the recognizer, we only mutate a **local copy** for the rectangle branch, circles stay untouched, and we don’t change any geometry helpers or constants.  

### Patch (smallest viable diff)

Add the distance-decimation + near-closure right after your RDP pre-pass, and **only** for the rectangle analysis:

```ts
// After: const circleScore = scoreCircle(points, circleFit);

// -----------------------------
// Rectangle path: RDP + distance decimation on a COPY
// -----------------------------
let rectFlat = pointsWU.slice();

// Reuse existing RDP (world-unit tol from STROKE_CONFIG)
const rdp = simplifyStroke(rectFlat, 'pen'); // returns { points, simplified, retries }
if (rdp.points.length >= 4) rectFlat = rdp.points;

// Size-aware distance decimation: ensure neighbor segs are long enough for corner gate
const diag = Math.hypot(width, height);
const minSegWU = Math.max(10, Math.min(18, 0.08 * diag)); // ≥10WU, scale with size a bit

const decimated: number[] = [];
let lastX = rectFlat[0], lastY = rectFlat[1];
decimated.push(lastX, lastY);

for (let i = 2; i < rectFlat.length; i += 2) {
  const x = rectFlat[i], y = rectFlat[i + 1];
  const dx = x - lastX, dy = y - lastY;
  if (dx * dx + dy * dy >= minSegWU * minSegWU) {
    decimated.push(x, y);
    lastX = x; lastY = y;
  }
}

// Always include the last original point
const lx = rectFlat[rectFlat.length - 2], ly = rectFlat[rectFlat.length - 1];
if (decimated[decimated.length - 2] !== lx || decimated[decimated.length - 1] !== ly) {
  decimated.push(lx, ly);
}

// Micro-closure across the seam to recover the 4th corner if nearly closed
const sx = decimated[0], sy = decimated[1];
const ex = decimated[decimated.length - 2], ey = decimated[decimated.length - 1];
const gap = Math.hypot(ex - sx, ey - sy);
const closeEps = 0.06 * diag; // ~6% of box diagonal
if (gap <= closeEps) decimated.push(sx, sy);

// Convert to Vec2 for geometry helpers
const rectPoints: Vec2[] = [];
for (let i = 0; i < decimated.length; i += 2) rectPoints.push([decimated[i], decimated[i + 1]]);

// (optional) debug
console.log('🧮 Rect prep', {
  orig: pointsWU.length / 2,
  rdp: rdp.points.length / 2,
  decimated: decimated.length / 2,
  minSegWU: +minSegWU.toFixed(2),
  closed: gap <= closeEps
});

// Now analyze rectangle with cleaned points
const boxFit = fitOBB(rectPoints);
const { edges, corners } = detectEdgesAndCorners(rectPoints);
const boxScore = scoreRectangle(rectPoints, boxFit, edges, corners);
```

**Why this works**

* **Satisfies the corner gate by construction.** After decimation, consecutive segments are ≥ 10 WU, so corners aren’t dropped as “short segment.” 
* **Restores true 90° spans.** Because neighbors are farther apart, the turn angle measured at the vertex spans the corner instead of two near-collinear micro-bends (“angle < 45°”). Your gate for **≥ 3 right-angle corners (±20°)** now has a fair chance to pass. 
* **Seam problem solved.** If the user nearly closes the box, the “seam” between end and start used to hide one corner from analysis; the **micro-closure** appends the first point when the gap is tiny, letting corner/edge detection see all four corners.

---

## “Would a uniform sample fix it?”

**Mostly yes—but only if “uniform” means “uniform *by distance* and ≥ 10 WU spacing.”**
Plain index-based downsampling (e.g., keep every Nth point) is not enough; it can still produce neighbor segments shorter than 10 WU on slow segments and longer elsewhere, so you’ll continue to see “Skipped (short segments).” The decimation above is **distance-based in world units**, aligned with the detector’s thresholds, which is the key.

If you prefer to think of it as a “uniform sample,” the decimator is exactly a uniform spatial sampler at step `minSegWU`. (We keep the very last point too, so OBB and coverage stay stable.)

---

## Why your staircase test still under-counted right angles

In the staircase, each “step” likely has **very short legs** relative to 10 WU. The detector throws those away as “short segments,” so many 90° turns never qualify as corners; depending on where RDP put the kept points, you can get a *random-looking* handful of corners (e.g., 4) rather than all the steps. The logs show this same pattern on rectangles: mixes of “short segment” and “angle < 45°” skips, then the hard gate fails.  

---

## Sanity checks to add (temporary)

Print these just before scoring to verify the prep is doing its job:

* The `🧮 Rect prep` line (counts + `minSegWU`). You want **`decimated` ≈ 10–30 points** for normal boxes.
* The corner summary should read **`Corners found: 3–4`**, and **`Skipped (short segments)` should be ~0–2**, not double digits.
* **Edge count** should be ≥ 3. (You had 1–3 earlier.) 

---

## Why keep RDP at all?

Two reasons:

1. It removes tiny wiggles that would otherwise produce spurious “potential corners.”
2. It stabilizes OBB: PCA on a still-dense, jittery path wobbles the axes, hurting parallel/orthogonal scoring—even after the corner gate. RDP → distance-decimate makes OBB much more stable. 

---

## Recap

* The problem wasn’t just noise; it was **mismatch between your corner detector’s thresholds and the spacing of input points.**
* Fix = **RDP → distance-decimate (≥10 WU) → micro-close** → then run the same geometry helpers/score.
* All changes live **only in `recognize-open-stroke.ts`**; we’re **not** touching preview points or modifying `simplification.ts`. We’re still using your **existing RDP** implementation.  

