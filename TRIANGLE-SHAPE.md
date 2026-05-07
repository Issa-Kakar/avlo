# Triangle Shape Integration

Apex-up isoceles triangle, integrated as a first-class `shapeType` alongside
`rect | ellipse | diamond | roundedRect`. No UI surfaces (toolbar / dropdown /
context menu) — entry is keyboard-only by design, focusing this pass on the
geometry, hit-testing, snap, and label-box plumbing. UI work is a separate
follow-up.

---

## TL;DR

- **Entry:** press **`3`** to switch the shape tool to triangle. Drag to size
  (corner-drag), or click to place a 180wu fixed shape (same as other shapes).
- **Frame `[x, y, w, h]`** → apex `(x+w/2, y)`, bottom-right `(x+w, y+h)`,
  bottom-left `(x, y+h)`. `w` is base width, `h` is peak height.
- **Storage:** ordinary `kind: 'shape', shapeType: 'triangle', frame: [...]`
  Y.Map. No new schema, no new accessor — `getShapeType(y)` returns the string.
- **Recognizer:** unchanged. There is no perfect-shape hold detection for
  triangle (intentional — out of scope for this pass).
- **One breaking API change:** `midpointFor` is now shape-type-aware. See
  [Midpoint refactor](#midpoint-refactor-shapetype-aware-midpointfor) below.

---

## Vertex convention

CW traversal in screen y-down, matching `shape-path.ts`'s diamond:

```
                 apex (cx, y)
                 /\
                /  \
               /    \
              /      \
   BL (x, y+h)──────BR (x+w, y+h)
```

Why CW: `core/connectors/shape-geometry.ts`'s outward-normal math derives the
edge normal as the CW rotation of the world tangent for each edge. Using the
same vertex ordering as diamond keeps the rotation convention consistent across
shapes — outward normals fall out without per-shape sign juggling.

`getTriangleVertices(frame): [Point, Point, Point]` lives in
`core/geometry/hit-primitives.ts` and is the canonical accessor.

---

## File map

| File | Change |
|---|---|
| `tools/types.ts` | `'triangle'` added to `ShapeType` and the framed-shape arm of `ShapePreview` |
| `core/geometry/shape-path.ts` | `case 'triangle'` reuses `emitRoundedPolygonIntoSink` + `DIAMOND_CORNER_OFFSET_W` (no new code path) |
| `core/geometry/hit-primitives.ts` | New: `getTriangleVertices`, `pointInTriangle`, `triangleIntersectsBBox`. `case 'triangle'` added in `pointInsideShape`, `shapeEdgeHitTest`, `circleHitsShape` |
| `core/connectors/shape-geometry.ts` | New: `projectAnchorTriangle` (3-edge nearest projection in normalized space, world outward normal), `rayTriangleExitT` (3-segment Cramer). Dispatch added in `projectAnchorToEdge` and `rayShapeExitPoint`. **`midpointFor` signature extended** with `shapeType` — triangle returns true edge centers, others fall through to bbox-side midpoints. |
| `core/connectors/snap.ts` | `nearestMidpoint` / `midpointPoint` / `forceElbowMidpoint` / `computeStraightInterior` / `probeEdgeSnap` thread `shapeType` through |
| `core/spatial/kind-capability.ts` | `case 'triangle'` in `SHAPE_CAP.hitRect` (marquee precision) |
| `core/text/text-system.ts` | `case 'triangle'` in `computeLabelTextBox` — inscribed `w/2 × h/2` rect placed at the lower (wider) half |
| `renderer/layers/connector-render-atoms.ts` | `drawShapeMidpoints` now passes `shapeType` to `midpointFor` (renamed `_shapeType` → `shapeType`) |
| `tools/DrawingTool.ts` | `triangle: 'triangle'` in `SHAPE_VARIANT_TO_TYPE` |
| `stores/device-ui-store.ts` | `'triangle'` in `ShapeVariant` |
| `runtime/keyboard-manager.ts` | `'3': 'triangle'` in `SHAPE_KEYS` |

11 files, +235 / -27 lines.

**Not modified — and the reason** (helpful for future agents who scan grep
results and wonder if they missed something):

- `connector-router.ts`, `reroute-connector.ts`, `connector-topology.ts`,
  `routing-context.ts`, `routing-astar.ts`, `anchor-atoms.ts`,
  `connector-paths.ts`, `connector-utils.ts` — all parametric in `shapeType` /
  `frame`. `Pipeline<E>` factories call `projectAnchorToEdge(shapeType, ...)`
  and forward through unchanged.
- `renderer/layers/objects.ts`, `renderer/geometry-cache.ts` — already
  shapeType-aware; cache invalidates on shapeType change automatically via
  `getOrBuild`.
- `renderer/layers/selection-overlay.ts` — paints from `bbox`, not shape.
- `core/geometry/bbox.ts`, `core/geometry/frame-of.ts`, `core/accessors.ts` —
  generic in `kind: 'shape'`, the shape-type string is opaque to them.
- `core/geometry/recognizer/` — perfect-shape recognizer's `PerfectShapeKind`
  union excludes triangle by design.

---

## Geometry derivations

### Path emission and corner rounding

Reuses the existing rounded-polygon atom (`emitRoundedPolygonIntoSink` in
`shape-path.ts`) with the diamond's corner offset constant. The atom's
per-vertex offset clamp — `min(offset, prevEdgeLen/2, nextEdgeLen/2)` — handles
the sharp apex without special-casing: as the apex angle narrows on tall
triangles, the half-edge clamp tightens the curve to fit. Output looks identical
in flavor to the diamond.

Corner cut visible at `DIAMOND_CORNER_OFFSET_W = 5wu`. No triangle-specific
constant — keeping the rounding language unified across polygonal shapes.

### Outward normals (used by elbow connector projection)

For each edge, world tangent = `vertex[i+1] - vertex[i]`, world outward normal
= CW rotation of that tangent (`(a, b) → (b, -a)`):

| Edge | World tangent | World outward normal |
|---|---|---|
| E0 apex → BR | `(w/2, h)` | `(h, -w/2)` — right and slightly up |
| E1 BR → BL | `(-w, 0)` | `(0, w)` — straight down |
| E2 BL → apex | `(w/2, -h)` | `(-h, -w/2)` — left and slightly up |

The cardinal direction is then `directionFromDelta(outNormal[0],
outNormal[1])` — dominant-axis classifier. The triangle's apex is a vertex (not
an edge), so a connector anchor near the apex projects to either E0 or E2 and
classifies as **E** or **W**, never **N**. This is geometrically correct: the
shape has no north-pointing edge.

For **very wide-and-flat** triangles (`w >> h`), the apex slope normals tilt
toward `(0, -1)` and the cardinal flips to **N** — the slanted sides have become
nearly horizontal, so "outward" really is up. The classifier handles this
automatically; no per-aspect special case is needed.

### Cardinal-midpoint fast path

`projectAnchorToEdge` short-circuits when the normalized anchor is exactly at a
cardinal midpoint `(0.5, 0) | (1, 0.5) | (0.5, 1) | (0, 0.5)`. For triangle:

| Normalized | Maps to | Fast-path correct? |
|---|---|---|
| `(0.5, 0)` | apex | ✓ — apex is the canonical N point |
| `(0.5, 1)` | base center | ✓ — base center is the canonical S point |
| `(1, 0.5)` | bbox-right-mid (outside triangle) | would be wrong — but never reached, see midpoint refactor |
| `(0, 0.5)` | bbox-left-mid (outside triangle) | would be wrong — but never reached |

Because the snap pipeline now stores triangle E/W midpoints with normalized
coords `(0.75, 0.5)` / `(0.25, 0.5)`, the fast-path's exact-match test
(`cardinalMidpointDir`) skips them and the full `projectAnchorTriangle` runs.
N (apex) and S (base center) are real cardinal midpoints on the triangle, so
the fast-path is correct for them.

### Ray-triangle exit (`rayTriangleExitT`)

Straight connectors with interior anchors ray-cast from the anchor through the
shape boundary. Same Cramer's-rule pattern as `rayDiamondExitT`, just with 3
segments instead of 4. The shared `raySegmentT` helper does the work.

### Hit testing

All three hit-test cases — `pointInsideShape`, `shapeEdgeHitTest`,
`circleHitsShape` — gain a `case 'triangle'` that mirrors the diamond branch
with a 3-edge loop. `pointInTriangle` is the standard cross-product sign test
(identical structure to `pointInDiamond`, just 3 vertices).

`triangleIntersectsBBox` (for marquee selection) uses the standard 3-test:
any vertex in bbox? any bbox corner in triangle? any edge crosses? Mirrors
`diamondIntersectsBBox` exactly.

### Label inscribed rect

For an apex-up triangle with frame `[x, y, w, h]`, the slanted edges shrink the
horizontal room as you walk up: at vertical position `v` from the apex, the
triangle's width is `(v / h) · w`. So the **largest axis-aligned rectangle
whose top edge sits at the triangle's mid-height (`v = h/2`)** has width
exactly `w/2` — it kisses both slanted edges at its top-left and top-right.

Rectangle below that mid-height is fully inside since the triangle widens as
`v → h`. Final inscribed rect:

```
x_top_left = (x + w/2) - (w/2)/2  =  x + w/4
y_top      = y + h/2
width      = w/2
height     = h/2
```

After `LABEL_PADDING = 8` inset, this is what `computeLabelTextBox` returns for
triangle. The label sits in the lower (wider) half of the shape — natural fit
for an apex-up triangle.

### Midpoint refactor (shapeType-aware `midpointFor`)

This is the only **API-shape change** in this pass. Worth understanding for
future agents.

**Before:** `midpointFor(frame, side, out)` — bbox-side coordinates for all
shapes. Worked because rect / ellipse / diamond / roundedRect all have their
N/E/S/W midpoints exactly on the bbox edges.

**Why it broke for triangle:** Triangle's right-edge midpoint is at world
`(x + 3w/4, y + h/2)`, not `(x + w, y + h/2)`. Same for left edge. Returning a
bbox-side point for an E/W triangle anchor would (1) place the snap dot
visibly outside the triangle, and (2) store a normalized anchor `(1, 0.5)` that
the cardinal fast-path would happily round-trip on rebake — connector endpoint
permanently floating off the shape.

**After:** `midpointFor(frame, shapeType, side, out)`. Triangle returns true
edge centers; everything else falls through to the bbox-side path. Threaded
`shapeType` through:

- `snap.ts`: `nearestMidpoint`, `midpointPoint`, `forceElbowMidpoint`,
  `computeStraightInterior`, `probeEdgeSnap`.
- `renderer/layers/connector-render-atoms.ts`: `drawShapeMidpoints` (renamed
  the previously-unused `_shapeType` parameter and now actually uses it).

The fast-path naturally handles the rest: triangle E/W normalized coords don't
match the cardinal pattern, so they fall through to `projectAnchorTriangle` on
rebake, which projects to the same edge midpoint deterministically.

---

## Snap pipeline behavior on a triangle

The pipeline in `core/connectors/snap.ts` is unchanged in structure — only
shape-aware values flow through it.

**Elbow connector to a triangle**
- Cursor outside, near edge → `probeNearestEdge` projects to the slanted or
  base edge via `projectAnchorTriangle`. Edge dot follows the cursor.
- Cursor near a midpoint within hysteresis → snap to apex / right-mid / base-
  mid / left-mid. Dot lands ON the triangle (not outside).
- Cursor deep inside → `forceElbowMidpoint` snaps to the nearest of those four.

**Straight connector to a triangle**
- Same edge / midpoint behavior on the outside-and-shallow tier.
- Deep inside → center snap at bbox-center (which is inside the triangle's
  body), then midpoint, then clamped interior anchor with ray-cast exit through
  the triangle boundary.

`isPointInsideShape` and `probeNearestEdge` both delegate through the new
triangle branches in `hit-primitives.ts` and `shape-geometry.ts` respectively.

---

## What was deliberately NOT done

User scope was integration first, polish later. Skipped:

- **Toolbar button** — `ToolPanel.tsx` has individual `ToolButton` rows for
  rectangle / diamond / ellipse. Adding triangle would mean a new row with an
  icon. No-op to add later.
- **Context menu icon** — `ShapeTypeDropdown.tsx` lists 6 entries. Adding a
  triangle entry needs a new SVG icon component in
  `context-menu/icons/ShapeTypeIcons.tsx` and a row in `TYPE_ITEMS`.
- **Selection actions / shape-type conversion** — `setSelectedShapeType` is
  generic and would already accept `'triangle'` via a future menu entry.
- **Perfect-shape recognizer** — `core/geometry/recognizer/types.ts`
  `PerfectShapeKind` doesn't include triangle. Adding it would need a triangle
  template and a $P recognizer pass; user said no perfect-shape recognition
  for triangle in this scope.

---

## Known polish items

User-flagged after first run-through:

1. **Label box placement could shift slightly.** Current rect is `[x + w/4 + pad,
   y + h/2 + pad, w/2 - 2pad, h/2 - 2pad]`. Could nudge top up or sides in to
   feel more centered relative to the triangle's visual mass. Adjust the
   `case 'triangle'` branch in `computeLabelTextBox` (`core/text/text-system.ts`).

2. **Snap-feedback outline could fit the geometry better.** The snap-target
   highlight currently traces the un-rounded triangle edge (or strokes a path
   that doesn't perfectly match the rendered Path2D). Investigate
   `drawSnapFeedback` / shape-highlight path in
   `renderer/layers/connector-render-atoms.ts` — likely wants
   `buildShapePathFromFrame('triangle', frame)` so the highlight tracks the
   rounded-corner path the renderer paints.

Neither blocks usage; both are visual polish.

---

## Cookbook — adding the UI later

If/when adding toolbar + dropdown:

1. **Toolbar button** in `client/src/components/ToolPanel.tsx`:
   add a `<ToolButton isActive={activeTool === 'shape' && shapeVariant === 'triangle'} ...>`
   row with `setShapeVariant('triangle')` on click. Tooltip "Triangle (3)".

2. **Triangle SVG icon** in
   `client/src/components/context-menu/icons/ShapeTypeIcons.tsx`:
   add `IconTriangleType`. Match the 22×22 viewBox and `fill="currentColor"`
   convention of the other icons.

3. **Dropdown entry** in
   `client/src/components/context-menu/ShapeTypeDropdown.tsx`:
   add `triangle: IconTriangleType` to `SHAPE_ICON` and an entry to
   `TYPE_ITEMS`.

4. **(Optional) Perfect-shape recognizer**: extend
   `core/geometry/recognizer/types.ts` `PerfectShapeKind` and add a triangle
   template to `templates.ts`. Then a `case 'triangle'` in `DrawingTool.ts`
   `onHoldFire` to call `enterSnapShape('triangle', ...)`.

None of these touch the geometry / snap / hit-test / label work that lives
behind this commit — they're pure UI plumbing.

---

## Cross-references

- General codebase guide: `CLAUDE.md` (root)
- Connector subsystem: `client/src/core/connectors/CLAUDE.md` — file map's
  "Add a shape kind to snap/route" cheat-sheet entry now matches what was done
- Spatial subsystem: `client/src/core/spatial/CLAUDE.md` — `KIND` capability
  table is the place to add per-kind hit logic; for triangle the dispatch
  lives one level deeper, inside `SHAPE_CAP`'s switch on `getShapeType(h.y)`
- Text subsystem: `client/src/core/text/CLAUDE.md` — `computeLabelTextBox`
  description (the doc's "ellipse / diamond / rect" lineup is now slightly
  stale; add triangle if updating)
