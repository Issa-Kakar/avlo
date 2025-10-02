Yes—two pragmatic add-ons make sense here, and they’re both easy to tuck into the same “about to fallback to line” slot you already used for the self-intersection guard:

1. **Near-closure (“start ~ end”) ⇒ ambiguous**
2. **Near self-touch (no crossing, just a “kiss”) ⇒ ambiguous**

They don’t change any UI flows or storage, and they reuse the recognizer’s existing `ambiguous` flag that your `DrawingTool` already respects to keep the user in freehand when hold fires.  

Below is the quick, realistic take for both—complexity, where to place them, and the tiny amount of code you need.

---

# Where this belongs (same hook as before)

Keep it in `recognizeOpenStroke`, **after** circle/rectangle lose and **before** “Case 5: fallback to line.” That’s where near-miss ambiguity already returns early, and it’s the exact moment you currently snap to a line unconditionally. You’re not touching hold timing (600ms), overlays, or commit logic—just a guard in the recognizer’s fallback path.  

---

# 1) Near-closure check (start and end are “basically the same point”)

**Difficulty:** trivial (5–10 LOC).
**Why it helps:** If someone draws an oval/loop that *nearly* meets, we don’t want that to snap to a line.

You already compute a **stroke diagonal** and use a **micro-closure** idea in the rectangle preprocessing (close the loop if end is within ~6% of diagonal). Reuse that threshold, but here it’s just a *gate to mark ambiguous* on the fallback-to-line path:

* Compute `gap = dist(firstPoint, lastPoint)` in **WORLD** units.
* If `gap <= CLOSE_GAP_RATIO * diag` (start with **0.06** to mirror your rectangle pipeline), return `{ ambiguous: true, kind: 'line', … }`. 

This is super cheap, robust, and completely in character with your near-miss philosophy. It only fires when circle/rect have already failed *and* you were about to snap a line. 

**Suggested constants**

* `CLOSE_GAP_RATIO = 0.06` (same as your rectangle micro-closure). 
* Optional: also require at least a short path (`polyline length ≥ 3 * diag`) so tiny scribbles don’t trip it.

---

# 2) Near self-touch check (no crossing, just “touching”)

**Difficulty:** small (≈30–50 LOC).
**Why it helps:** Catches the “oval brushing itself” or “backtrack that grazes earlier path” cases your proper-intersection test intentionally ignored (you excluded collinear overlaps and tangential grazes to avoid false hits). This is the complementary guard.

**How to do it safely and fast**

* Work on the **decimated** points you already produce for rectangle analysis (jitter-free, few segments). That keeps the pair count low, and you’re already building this list. 
* For each **non-adjacent** segment pair (and skip the `(first,last)` pair), compute **segment-to-segment distance** with an **epsilon** in WORLD units.
* If `dist < epsWU`, return the same ambiguous line result.

**Good epsilon that won’t over-fire**

```text
epsWU = max(1.5, 0.6 * strokeSizeWU, 0.015 * diag)
```

* Anchors to world scale and stroke thickness (prevents “almost straight” lines with small jitter from tripping).
* You can start with `0.015 * diag` and tweak; the stroke-size term makes it behave sensibly across pens. (All of your recognition metrics live in WORLD units already; keep that invariant.) 

**Why this stays simple**

* O(m²) over ~tens of segments after decimation is trivial at hold time.
* No extra state, no renderer changes, no Yjs implications; the `DrawingTool` already short-circuits on `ambiguous` and keeps freehand. 

---

# Drop-in patch sketch (both checks)

```ts
// In recognizeOpenStroke, after near-miss ambiguity and just before line fallback

const diag = strokeDiagonalWU;                  // you already have / can compute this
const closeGapWU = distance(A, lastPoint);
const CLOSE_GAP_RATIO = 0.06;                   // mirror rectangle micro-closure
const epsWU = Math.max(1.5, 0.6 * strokeSizeWU, 0.015 * diag);

if (closeGapWU <= CLOSE_GAP_RATIO * diag) {
  // Near-closure: treat as ambiguous (don’t snap to line)
  return { kind: 'line', score: 1, ambiguous: true, line: { A: [A[0], A[1]], B: pointerNowWU } };
}

// Reuse the decimated flat list you already build for rectangle corner work
const decimatedFlat = /* existing Track-B flat array (RDP + distance decimation) */;

if (hasNearTouch(decimatedFlat, epsWU)) {
  // Non-crossing self-touch: also ambiguous
  return { kind: 'line', score: 1, ambiguous: true, line: { A: [A[0], A[1]], B: pointerNowWU } };
}

// …your existing Case 5 fallback to line continues here
```

Helper (straightforward and fast; early exits on first hit):

```ts
function hasNearTouch(pts: number[], epsWU: number): boolean {
  // Build segments from decimated points (skip degenerate segments)
  const segs = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x1 = pts[i],   y1 = pts[i+1];
    const x2 = pts[i+2], y2 = pts[i+3];
    if (Math.hypot(x2 - x1, y2 - y1) >= epsWU) {
      segs.push([x1, y1, x2, y2]);
    }
  }
  if (segs.length < 3) return false;

  // Segment-to-segment distance with adjacency skips
  const segDist = (a, b) => {
    const [x1,y1,x2,y2] = a, [x3,y3,x4,y4] = b;
    // quick bbox prune (inflate by epsWU)
    const minx1 = Math.min(x1,x2) - epsWU, maxx1 = Math.max(x1,x2) + epsWU;
    const miny1 = Math.min(y1,y2) - epsWU, maxy1 = Math.max(y1,y2) + epsWU;
    const minx2 = Math.min(x3,x4) - epsWU, maxx2 = Math.max(x3,x4) + epsWU;
    const miny2 = Math.min(y3,y4) - epsWU, maxy2 = Math.max(y3,y4) + epsWU;
    if (maxx1 < minx2 || maxx2 < minx1 || maxy1 < miny2 || maxy2 < miny1) return Infinity;

    // Return 0 if they properly intersect (your existing guard may have handled this)
    // Otherwise compute min of point-to-segment distances
    const d = Math.min(
      pointToSegDist(x1,y1,x3,y3,x4,y4),
      pointToSegDist(x2,y2,x3,y3,x4,y4),
      pointToSegDist(x3,y3,x1,y1,x2,y2),
      pointToSegDist(x4,y4,x1,y1,x2,y2),
    );
    return d;
  };

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (j === i + 1) continue;                // adjacent
      if (i === 0 && j === segs.length - 1) continue; // first/last share endpoint
      if (segDist(segs[i], segs[j]) < epsWU) return true;
    }
  }
  return false;
}
```

(Use the same decimated set you already generate for rectangle analysis—RDP + distance decimation + optional micro-closure—so this stays fast and stable. )

---

# Is it worth the complexity?

* **Near-closure:** Absolutely. It’s effectively “free” (few lines), aligns with your existing micro-closure logic, and addresses the classic “oval snapped to line” annoyance. 
* **Near self-touch:** Also yes. It’s a tiny helper, runs on your decimated polyline, and catches a real false-snap class that the intersection-only test misses. Net new code is minimal and fully local to the recognizer.
* **Stability:** No change to snap rules for shapes that pass the confidence threshold; near-miss ambiguity handling remains intact; we’re only affecting the strict line fallback.  
* **Performance:** Trivial at hold time (small O(m²) over decimated segments) and nowhere near your render hot paths. All in WORLD units, so thresholds scale correctly across zoom levels and pens. 

---

# Quick guardrails (so it never over-fires)

* Gate both checks **only** inside the “about to fallback to line” path—never override a confident circle/rectangle, and never interfere with your existing near-miss ambiguity. 
* Start with `CLOSE_GAP_RATIO = 0.06` and `epsWU = max(1.5, 0.6*strokeSizeWU, 0.015*diag)`.
* Optional: require a minimum number of decimated segments (≥3–4) before testing; and/or a minimum path length vs diagonal to avoid short jitter trips.

---

**Bottom line:** both checks are worth it. Near-closure is a slam-dunk; near-touch is a small, robust add that rounds out the “don’t snap to a line when the doodle is clearly loopy” story—without adding meaningful complexity or maintenance risk. And they cleanly plug into your existing hold→recognize→ambiguous flow and `DrawingTool` handling.   
