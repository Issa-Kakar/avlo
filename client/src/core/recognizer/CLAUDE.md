# Recognizer Subsystem

Single-stroke perfect-shape recognizer fired by the 600 ms hold detector. Maps
a raw point list to one of `circle | box | diamond | line` against 37 fixed
aspect-ratio templates.

**Algorithm (black box):** Vatavu, Anthony, & Wobbrock (2012) "$P Point-Cloud
Recognizer" + Vatavu (2018) $Q optimization. Modernize implementation, never
replace.

## Files

| File | Owns |
|------|------|
| `recognize.ts`       | Public API: `recognizePerfectShapePointCloud`, `computeBboxCenterExtents`. Orchestrator + module scratches (`RAW`, `CANDIDATE`). |
| `types.ts`           | `PerfectShapeKind`, `PerfectShapeMatch`, `PerfectShapeRecognition`, `RecognizerOpts`. |
| `constants.ts`       | `PDOLLAR_CONFIG` (frozen tuning), `TEMPLATE_RATIOS`, per-kind `SHAPE_MAX_DISTANCE` dispatch table, `KIND_FOR_CODE` ABI. |
| `point-buffer.ts`    | `Float64Array` interleaved-xy layout helpers: `bboxInto`, `pathLength`, `copyPointsInto`. |
| `normalize.ts`       | `resampleInto`, `scaleToUnitInPlace`, `translateToOriginInPlace`, `normalizeInto`. Pure on typed arrays. |
| `templates.ts`       | Template construction + lazy module-load `getTemplates()`. ONE packed `Float64Array(37 × 64)`, parallel kind / id arrays. |
| `cloud-distance.ts`  | $Q greedy match — the inner hot loop (1184 iterations / recognition). `Uint16Array(32)` swap-pop unmatched-bookkeeping scratch. |
| `gates.ts`           | `countSignificantTurns`, `quadrantOccupation`. Re-exports `hasSelfIntersection`, `hasNearTouch`. |
| `self-intersect.ts`  | Zero-alloc segment-pair scanners. Pre-bakes per-segment bbox into a module scratch (`SEGS`). |

## Layout invariant

All point buffers are `Float64Array` with **interleaved xy**: `buf[2*i]` = x,
`buf[2*i + 1]` = y. Length is always `2 * n`. The `*Into(out, count, ...)` family
writes `2 * count` floats starting at offset 0 — no header, no length prefix.

The public entry accepts `readonly Point[]` (the format `DrawingTool.points`
holds) and copies once into the `RAW` scratch.

## Hot path

```
recognize()
  ├─ copyPointsInto(rawPointsWU, RAW)
  ├─ bboxInto(RAW, count, RAW_BBOX)
  ├─ hasSelfIntersection(RAW, count, eps)         (gate; reads RAW)
  ├─ hasNearTouch(RAW, count, eps)                (gate; reads RAW)
  ├─ [optional close] RAW[2*count] = RAW[0], RAW[2*count+1] = RAW[1]
  ├─ normalizeInto(RAW, normCount, CANDIDATE, 32) (resample → scale → translate)
  └─ for t in 0..36: greedyCloudMatch(CANDIDATE, 0, TPL, templateOffset(t), eps)
```

The deep loop is `cloudDistance` — 32 outer × ≤32 inner = ≤1024 ops per call,
called `2 × ceil(32 / step)` times per template, 37 templates per recognition.
Roughly 38 K float ops / recognition; sub-millisecond on modern hardware.

## Gates

Pre-normalization (raw points):
- **Self-intersection:** segment-pair crossing test with collinear-skip.
- **Near-touch:** segment-pair min-distance < `eps`.

Post-normalization (only for box/diamond best matches):
- **Turn count:** `MIN_TURNS_BOX = 3`, `MIN_TURNS_DIAMOND = 2`. Relaxed when
  the match distance is very small.
- **Quadrant occupation:** require ≥ 75 % of the four quadrants populated.

## Module scratches & alias contract

| Scratch | Owner | Usage |
|---------|-------|-------|
| `RAW`             | `recognize.ts`      | Raw stroke copy. Read by gates and as resample source. Grows on demand (default capacity = 1024 points). |
| `RAW_BBOX`        | `recognize.ts`      | Reusable `BBoxTuple` for `bboxInto`. |
| `CANDIDATE`       | `recognize.ts`      | Normalized 32-point candidate. Read by all 37 cloud matches + post-gates. |
| `TPL`             | `templates.ts`      | Packed template store. Frozen after first `getTemplates()`. |
| `UNMATCHED`       | `cloud-distance.ts` | `Uint16Array(32)` swap-pop bookkeeping. Used sequentially by both directions of `greedyCloudMatch`. |
| `SEGS`            | `self-intersect.ts` | `Float64Array(1024 × 8)` — per-segment `(x1,y1,x2,y2,minx,miny,maxx,maxy)` for the gate scanners. |
| `RAW_SCRATCH`     | `templates.ts`      | Cold-path scratch for vertex polylines. Used only during template construction. |

All scratches are non-reentrant. `recognize()` is the single entry; it is
synchronous and called once per HoldDetector fire.

## Black-box guarantee

The algorithm and tuning constants are frozen. Any refactor must produce
results byte-identical (modulo float-ordering noise) to the previous
implementation. Verification: the 12-gesture smoke suite in the project's
shape-recognition refactor plan.
