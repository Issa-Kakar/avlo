# `renderer/freehand/` — self-contained freehand stroke → Path2D / canvas

Replaces the `perfect-freehand` package. A struct-of-arrays freehand pipeline emitting Canvas
2D path commands directly — no SVG string round-trip. Solves the "hot elbows" bug via elbow
partitioning.

**Credit** (full note in `pipeline.ts` header): based on the perfect-freehand algorithm by
Steve Ruiz ([MIT](https://github.com/steveruizok/perfect-freehand)); the elbow-partitioning
that avoids "hot elbows" follows [tldraw](https://github.com/tldraw/tldraw)'s approach.

## File map
| File | Responsibility |
|------|----------------|
| `pipeline.ts` | SoA `Float64Array` buffers + per-build scalar params (`setParams`) + `ingest` (streamline) → `computeRadii` (pressure→radius) → `loadSrcFromPipeline`/`loadSrcPartition` → `buildTracks` (left/right outline tracks + `simplifyTrack`). Ports `core.ts` + the track builder from `getStrokeOutlinePoints.ts` (taper dropped — no consumer used it). |
| `stroke-path.ts` | `traceStroke` / `traceEraserTrail` — emit the partitioned, capped outline into a `CanvasPath` sink. `strokeToPath2D` wraps `traceStroke` for a standalone `Path2D`. `partitionAtElbows` cuts the stroke at sharp turns. Ports `svgInk.ts`. |
| `types.ts` | `StrokeInputPoint` (`[x,y]`/`[x,y,z]`), `STROKE_OPTIONS_BASE` (pen/highlighter tuning). |
| `index.ts` | Barrel: `traceStroke`, `traceEraserTrail`, `strokeToPath2D`, `STROKE_OPTIONS_BASE`, `StrokeInputPoint`. |

## API
- `traceStroke(sink, points, size, last)` — pen/highlighter (constant width). `last:false` = live tail.
- `traceEraserTrail(sink, points, size)` — velocity-tapered trail (thinning + simulated pressure).
- `strokeToPath2D(points, size, last): Path2D` — `= new Path2D()` + `traceStroke`.

`sink` is a `CanvasPath`, satisfied by both `Path2D` and `CanvasRenderingContext2D`:
- **Committed strokes** (`geometry-cache.ts`) build a cached `Path2D` via `strokeToPath2D`.
- **Live preview** (`stroke-preview.ts`) and **eraser trail** (`EraserTrailAnimation.ts`) trace
  straight into the ctx — `ctx.beginPath()` → `traceStroke/traceEraserTrail(ctx, …)` →
  `ctx.fill()` — so **no per-frame `Path2D` is allocated**.

## Contracts / invariants
- **Zero per-call allocation.** All state is module-level: reusable typed-array buffers +
  scalar per-build params set by `setParams`. No options object, no default-param closures.
  The only allocation is the `Path2D` in `strokeToPath2D` (cached). Both the buffers and the
  params are **non-reentrant** — each build fully consumes them before returning.
- **One path, many subpaths.** Each elbow partition is its own closed subpath, all with the
  same winding, so a default **nonzero** fill unions them into one solid shape. A single fill
  applies `globalAlpha` once — highlighter overlaps within a stroke do not double-darken.
- **Constant radius for pen/highlighter.** `traceStroke` uses `thinning:0` +
  `simulatePressure:false`, so radius ≡ `size/2` everywhere. This is what lets the stroke bbox
  pad by a fixed `width/2 + 1` (`core/geometry/bbox.ts`). Do **not** give committed strokes
  `thinning`/`simulatePressure` without widening that padding — it was the source of historical
  stale-pixel bbox bugs. (The eraser trail uses them, but it's a transient overlay with no
  dirty-rect / bbox.)
- **Direct-to-ctx sinks assume the beginPath convention.** Callers `beginPath()` before and
  `fill()` after; every overlay drawer follows this, so a traced subpath never leaks between
  drawers.

## SVG → Canvas 2D mapping (in `renderPartitionInto`)
`M`→`moveTo`; smooth-quad `t`→`quadraticCurveTo(prevTrackPoint, midpoint)` (the SVG `t`
chain's implied controls resolve to the track points — emitted explicitly, no reflection
state); arc `a r,r 0 0 1`→`arc(srcPoint, radius, startAngle, endAngle, false)` (SVG sweep-1 =
canvas clockwise); `Z`→`closePath`. Single point → a `arc(…, 0, 2π)` dot.
