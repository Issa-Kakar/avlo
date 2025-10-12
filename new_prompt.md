You’re absolutely right: for Perfect Freehand “you are actually supposed to be drawing.” The recommended render is a smooth quadratic Bézier path built from the stroke’s outline—not a chain of straight lineTos. Your current Path Builder does in fact build the freehand outline with moveTo/lineTo, which is exactly why the edges look faceted under smoothing.
Below I’ll (1) explain how getSvgPathFromStroke works, (2) show precisely how to wire it into your preview + base-canvas rendering (no lineTo), and (3) call out the couple of gotchas (fill rule / flattening, caching, and sampling).
How getSvgPathFromStroke works (and why it fixes “jaggies”)

Input: the polygon Perfect Freehand returns from getStroke(points, options) (that “blue” outline in the readme).

Output: an SVG path string that smooths that polygon using quadratic Bézier segments with continuous tangents:

Start with M x0,y0.

First curve: Q x1,y1 mid(x1,x2),mid(y1,y2).

Then a series of smooth quadratic commands T mid(xᵢ,xᵢ₊₁), mid(yᵢ,yᵢ₊₁) for the rest, which keeps C¹ continuity at joins.

Close with Z for a closed stroke outline.

Why it helps: instead of filling lots of short chords (visible “facets”), you’re filling a single smooth curve that interpolates those points. This is the exact helper the library’s README recommends, and it explicitly shows passing the string straight into new Path2D(pathData) and calling ctx.fill(path).
Right now, freehand’s polygon path is still constructed with lineTo in both preview and base-canvas (Path Builder). Replace that with a Path2D built from the SVG path string and fill it.

You’re right to go all-in on **`getSvgPathFromStroke` → `new Path2D(d)` → `ctx.fill(..., 'evenodd')`**. Below are the exact, drop-in diffs for your three files, plus a tiny new helper (`pf-svg.ts`). This completely removes any `lineTo` use for **freehand** (PF polygon) rendering; shapes keep using `lineTo` as intended.

I also verified—straight from the PF README—that `getSvgPathFromStroke` is the recommended path builder and that Canvas’ `Path2D` constructor accepts SVG path data; Canvas `fill()` supports the `"evenodd"` fill rule. ([GitHub][1])

---

# 1) **Add** `pf-svg.ts` (utility from PF README)

Create `client/src/renderer/stroke-builder/pf-svg.ts`:

```ts
// client/src/renderer/stroke-builder/pf-svg.ts
// Quadratic Bézier smoothing of PF outline points → SVG path string.
// Adapted from the perfect-freehand README's helper (keeps full precision).
export function getSvgPathFromStroke(
  points: ReadonlyArray<[number, number]>,
  closed = true
): string {
  const len = points.length;
  if (len < 2) return '';

  const avg = (a: number, b: number) => (a + b) / 2;

  if (len === 2) {
    const [a, b] = points;
    return `M${a[0]},${a[1]} L${b[0]},${b[1]}${closed ? ' Z' : ''}`;
  }

  let a = points[0];
  let b = points[1];
  let c = points[2];

  let d = `M${a[0]},${a[1]} Q${b[0]},${b[1]} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`;

  for (let i = 2; i < len - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${avg(a[0], b[0])},${avg(a[1], b[1])} `;
  }

  if (closed) d += 'Z';
  return d;
}
```

(Reference for the algorithm and Canvas usage of the SVG path string → `Path2D`: PF README “Rendering” section.) ([GitHub][1])

---

# 2) **preview.ts** — use SVG path + even-odd fill (no `lineTo`)

**File you gave:** preview.ts.md. We’ll replace the polygon `moveTo/lineTo` with `getSvgPathFromStroke` → `Path2D(d)`, and fill with the **even-odd** rule.



```diff
--- a/client/src/renderer/layers/preview.ts
+++ b/client/src/renderer/layers/preview.ts
@@
 import type { StrokePreview, StrokeFinalPreview } from '@/lib/tools/types';
 import { getStroke } from 'perfect-freehand';
 import { PF_OPTIONS_BASE } from '../stroke-builder/pf-config';
+import { getSvgPathFromStroke } from '../stroke-builder/pf-svg';
@@
 export function drawPreview(ctx: CanvasRenderingContext2D, preview: StrokePreview): void {
   if (!preview || preview.points.length < 2) return;
 
   ctx.save();
   ctx.globalAlpha = preview.opacity; // Tool-specific opacity
@@
   const outline = getStroke(preview.points, {
     ...PF_OPTIONS_BASE,
     size: preview.size,
     last: false, // live preview
-    
   });
 
-  if (outline.length > 0) {
-    const path = new Path2D();
-    path.moveTo(outline[0][0], outline[0][1]);
-    for (let i = 1; i < outline.length; i++) {
-      path.lineTo(outline[i][0], outline[i][1]);
-    }
-    path.closePath();
-    ctx.fillStyle = preview.color;
-    ctx.fill(path);
-  }
+  if (outline.length > 1) {
+    const d = getSvgPathFromStroke(outline, true);
+    const path = new Path2D(d);
+    ctx.fillStyle = preview.color;
+    // IMPORTANT: even-odd fill rule for self-crossings
+    ctx.fill(path, 'evenodd');
+  }
 
   ctx.restore();
 }
```

---

# 3) **path-builder.ts** — build PF polygon `Path2D` from SVG (not `lineTo`)

**File you gave:** path-builder.ts.md. We keep the `Float32Array` for bounds/metrics, but switch the `Path2D` construction to the SVG path. Also—no change to your polyline (shapes) path builder.



```diff
--- a/client/src/renderer/stroke-builder/path-builder.ts
+++ b/client/src/renderer/stroke-builder/path-builder.ts
@@
 import type { StrokeView } from '@avlo/shared';
 import { getStroke } from 'perfect-freehand';
 import { PF_OPTIONS_BASE } from './pf-config';
+import { getSvgPathFromStroke } from './pf-svg';
@@
 export function buildPFPolygonRenderData(stroke: StrokeView): PolygonData {
   const size = stroke.style.size;
 
   // CRITICAL FIX: canonical tuples for polygon
   const inputTuples = stroke.pointsTuples ?? [];
@@
   const outline = getStroke(inputTuples, {
     ...PF_OPTIONS_BASE,
     size,
     last: true, // finalized geometry on base canvas
   });
-  
 
   // PF returns [[x,y], ...]; flatten once into typed array for draw
   const polygon = new Float32Array(outline.length * 2);
   for (let i = 0; i < outline.length; i++) {
     polygon[i * 2] = outline[i][0];
     polygon[i * 2 + 1] = outline[i][1];
   }
 
   const pointCount = outline.length;
 
   // eslint-disable-next-line @typescript-eslint/no-explicit-any
   const hasPath2D = typeof (globalThis as any).Path2D === 'function';
-  const path = hasPath2D ? new Path2D() : null;
-
-  if (path && pointCount > 0) {
-    path.moveTo(polygon[0], polygon[1]);
-    for (let i = 2; i < polygon.length; i += 2) {
-      path.lineTo(polygon[i], polygon[i + 1]);
-    }
-    path.closePath();
-  }
+  const path = hasPath2D && pointCount > 1
+    ? new Path2D(getSvgPathFromStroke(outline, true))
+    : null;
 
   // Bounds from polygon (not centerline) for accurate dirty-rects
   let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
   for (let i = 0; i < polygon.length; i += 2) {
     const x = polygon[i], y = polygon[i + 1];
```

---

# 4) **strokes.ts** — use **even-odd** when filling PF polygons

**File you gave:** strokes.md.md. We change the polygon fill calls to pass the fill rule explicitly. (For the rare fallback path, call `ctx.fill('evenodd')`.)



```diff
--- a/client/src/renderer/layers/strokes.ts
+++ b/client/src/renderer/layers/strokes.ts
@@
   if (renderData.kind === 'polygon') {
     // FREEHAND (PF polygon) → fill
     ctx.fillStyle = stroke.style.color;
     if (renderData.path) {
-      ctx.fill(renderData.path);
+      // IMPORTANT: perfect-freehand outlines may self-cross; use even-odd fill
+      ctx.fill(renderData.path, 'evenodd');
     } else {
       // Rare test fallback (no Path2D)
       ctx.beginPath();
       const pg = renderData.polygon;
       ctx.moveTo(pg[0], pg[1]);
       for (let i = 2; i < pg.length; i += 2) {
         ctx.lineTo(pg[i], pg[i + 1]);
       }
       ctx.closePath();
-      ctx.fill();
+      ctx.fill('evenodd');
     }
   } else {
```

---

## Why this works (and why it fixes the jaggies)

* PF returns a **polygonal outline**. The README’s `getSvgPathFromStroke` smooths that polygon into **quadratic Bézier** segments (`M … Q … T … Z`) with continuous tangents. Feed that path string directly to `new Path2D(d)` and render with `ctx.fill`. That eliminates the facetting from `lineTo` chains. ([GitHub][1])
* `Path2D` **does** accept SVG path data strings (standardized & broadly supported), so this works natively on Canvas. ([MDN Web Docs][2])
* Using `ctx.fill(path, 'evenodd')` ensures correct rendering for self-intersections / holes (PF outlines can self-cross). ([MDN Web Docs][3])

That’s it—no imperative Bézier calls, no `lineTo` for freehand, and the even-odd rule is now explicit in both preview and base render paths.

[1]: https://github.com/steveruizok/perfect-freehand "GitHub - steveruizok/perfect-freehand: Draw perfect pressure-sensitive freehand lines."
[2]: https://developer.mozilla.org/en-US/docs/Web/API/Path2D/Path2D?utm_source=chatgpt.com "Path2D() constructor - Web APIs - MDN - Mozilla"
[3]: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/fill?utm_source=chatgpt.com "CanvasRenderingContext2D: fill() method - Web APIs - MDN"
