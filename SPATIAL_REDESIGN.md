# Spatial Query & Hit Testing — Type System Redesign

> **Status:** Foundation (§3–§6), paint-class correction (§4a), and query
> cleanup + call-site consolidation (§4b) all landed. Typecheck clean across
> shared + client + worker. Most legacy deleted (`core/geometry/object-pick.ts`
> and `core/geometry/hit-testing.ts` gone). All listed consumers migrated —
> SelectTool click/marquee/handles/endpoints, EraserTool, TextTool, CodeTool,
> snap, viewport culling, image viewport, clipboard smart-duplicate. Remaining
> legacy: `core/geometry/frame-of.ts` (`frameOf` still consumed by connector
> internals — `connector-utils.ts`, `reroute-connector.ts`, `anchor-atoms.ts`).
> `BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle` still standalone.
> Still open: capability-table unit tests, `queryHandles({ precise })`
> silent-skip shape, cap-kind subfolder split threshold.

This document captures the full scope of the in-flight refactor of AVLO's
spatial-query and hit-testing layer: what was wrong, why it was wrong, the
plan that was drawn up, what's actually been built so far, how the new type
system is shaped, and what's still open. It's the load-context doc for the
next planning/implementation session.

---

## 1. Origin — what the user wanted to fix

The codebase had been moving toward a tuple-native spatial index and a
mapped-dispatch hit-testing layer. The plumbing had improved (`HIT_BY_KIND`,
`frameOf`, tuple bboxes), but the **call sites and entry points** had not.
Hit testing had accreted **5+ distinct entry points**, each with its own
parameter shape and its own per-kind glue. Consumers had to know _which one_
to call, and then do their own:

- kind filtering
- z-order picking
- per-candidate transformation

The user's intent (verbatim from `OVERVIEW.MD`):

> _"the goal with truly maximizing generics and utility types is that the
> external consumers barely need to know what to call, as calling their own
> methods is used with a proper generic so we can distinguish based on input.
> ... the purpose of generics is to update a single place when an additional
> method is needed, and updating the call site is not verbose as the logic is
> abstracted away by the spatial index hit testing code, the consumer just
> calls with the method he needs."_

The reference for type-system elegance was `prompt.md` — a small example of
generic option-bag query types where the _return shape_ is inferred from the
input. The mandate: **focus on system design, not call-site rewrites**;
"a fully proper complete base ... integration can be partial."

---

## 2. Concrete symptoms flagged

1. **SelectTool marquee re-enter dance.** `setSelection(ids)` clobbered
   `marquee` on every cursor move during a marquee drag, forcing
   `SelectTool.updateMarqueeSelection` to call `beginMarquee` + `updateMarquee`
   again to "re-enable" it (literal comment: _"Re-enable marquee since
   setSelection clears it"_). Symptom of selection store owning state it
   shouldn't.

2. **EraserTool's per-kind dispatch loop.** `EraserTool.updateHitTest` had its
   own switch over `stroke` / `shape` / framed kinds, calling
   `circleHitsShape` / `circleRectIntersect` / `strokeHitTest` directly —
   duplicating the semantics already encoded in `HIT_BY_KIND`. Done that way
   because eraser wanted _"all handles within a circle"_ and there was no
   query function for that.

3. **`hitTestVisibleText` / `hitTestVisibleNote` / `hitTestVisibleCode`** —
   three sibling functions, each with the same body modulo a kind constant.

4. **`queryHitCandidates(x, y, r, kinds?)` ergonomics** — required passing a
   plain `readonly ObjectKind[]`, then `scanTopmost` did the z-order pick,
   then the consumer added their own classifier. Multiple ad-hoc kind sets
   floated around (`BINDABLE_KINDS` for snap, hardcoded `[kind]` for visible-
   kind helpers, etc.).

5. **`hitTestHandle` and `hitTestEndpointDots`** — bespoke functions for
   resize handles and connector endpoint dots. Same mental model ("walk a
   small probe set, return nearest within radius") but disjoint vocabulary
   from the spatial pipeline. Orphan layer.

6. **Per-kind rules scattered across 5 files**: `hit-testing.ts`
   (`HIT_BY_KIND`, `objectIntersectsRect` switch), `frame-of.ts`
   (`FRAME_BY_KIND`), `object-pick.ts` (`classifyPaint` four-branch switch),
   `types/objects.ts` (`INTERIOR_PAINT`, `BINDABLE_KINDS`), and
   `EraserTool.ts` (the per-kind eraser loop). Adding a new kind required
   touching all five.

7. **Future bookmark sub-region hit testing** (cursor over a link inside a
   bookmark card) needs to slot in cleanly without growing yet another
   entry point.

---

## 3. The plan (architectural shape)

Plan file: `~/.claude/plans/radiant-riding-micali.md`. Six-layer design.

### Design principles (tightened from OVERVIEW)

- **One source of truth for per-kind rules** — a `KindCapability<K>` table
  (mapped over `ObjectKind`) replaces every per-kind switch in the codebase.
  Adding a kind is a compile error until a cap entry is added.
- **Two query functions, not one.** `queryHandles` returns raw handles for
  region membership (marquee, eraser, count). `queryHits` returns classified
  z-sorted candidates for point probes (clicks, snap, visible-kind lookup).
  Forcing them through one conditional-typed function makes inference
  fragile and call sites need `if ('at' in region)` coercion to use
  classified results.
- **Filter / picker / transform are separate composable stages**, not a
  single merged callback.
- **Filters narrow the generic; `where` is a non-narrowing post-filter.**
  Keeps the happy-path return type predictable.
- **Region is a tagged discriminated union** (`'point' | 'rect'`) — extensible
  to `'circle'` later without breaking exhaustive switches.
- **Non-spatial handle hits live in a sibling layer** (`hitNearest<T>`)
  with the same vocabulary (tagged `Radius`) but no spatial-index
  involvement. Honest about the architecture: resize handles aren't in
  the index because they're derived from selection state.
- **Marquee state is gesture-owned, not selection-owned.** One-line
  `selection-store.ts` fix.

### Layer breakdown (current, post-§4b)

| Layer | File                                     | Role                                                                                                                                                                     |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | `core/types/geometry.ts` (existing)      | `Point`, `BBoxTuple`, `FrameTuple`                                                                                                                                       |
| 1     | `core/spatial/region.ts`                 | `Region` tagged union, `atPoint` (takes `Radius`), `inBBox`, `regionEnvelope`                                                                                            |
| 1.5   | `core/spatial/radius.ts`                 | `Radius = { px } \| { world }` + `resolveRadius` (reads `camera-store`)                                                                                                  |
| 2     | `core/spatial/atoms.ts`                  | `HandleOf<K>`, `Predicate`, `NarrowingPredicate`, `Picker`, `Scorer`, `Comparator`, `Paint`                                                                              |
| 3     | `core/spatial/kind-capability.ts`        | `HitCandidate<K>` + `KindCapability<K>` interface + `KIND` exhaustive table                                                                                              |
| 4     | `core/spatial/filters.ts` + `pickers.ts` | `byKind`, `byKinds`, `isBindable`, combinators / `firstCandidate`, `pickBestBy`, `scanTopmostWithMemo`, `pickFrameAware`, `pickTopmostByKind`, `areaOf`, `sortZTopFirst` |
| 5     | `core/spatial/object-query.ts`           | `queryEntries`, `queryHandles`, `queryHits`                                                                                                                              |
| 6     | `core/spatial/handle-hit.ts`             | `HandleProbe<T>`, `hitNearest<T>` (generic), `hitResizeHandle` (bespoke), `hitEndpointDot` (wraps `hitNearest`)                                                          |

### KindCapability shape

```typescript
interface KindCapability<K extends ObjectKind> {
  readonly bindable: boolean
  readonly frame:     (h: HandleOf<K>) => FrameTuple | null
  readonly hitPoint:  (h: HandleOf<K>, p: Point, r: number) => HitFields<K> | null
  readonly hitRect:   (h: HandleOf<K>, bbox: BBoxTuple) => boolean
  readonly hitCircle: (h: HandleOf<K>, c: Point, r: number) => boolean
  readonly area:      (h: HandleOf<K>) => number        // lazy, called only by pickers
}

const KIND: { readonly [K in ObjectKind]: KindCapability<K> } = { ... }
```

`hitPoint` returns the classification fields (`HitFields<K> = Omit<HitCandidate<K>, 'handle'>` — currently `{ paint }` after §4a/§4b); the scanner composes `{ handle, ...fields }`. `classify` is gone (§4a dropped it; paint is computed inline in `hitPoint`). `area` is lazy (§4a); pickers only pay the cost when the tournament actually compares.

### Variadic narrowing

```typescript
function byKinds<const K extends readonly ObjectKind[]>(...ks: K): NarrowingPredicate<ObjectHandle, HandleOf<K[number]>>;

queryHits({ at, radius, filter: byKinds('shape', 'text') });
//  → HitCandidate<'shape' | 'text'>[]
//  cs[0]?.handle.kind  // 'shape' | 'text', inferred
```

The kind set also flows through a hidden `__kinds` brand on the filter
function, which `queryHits`/`queryHandles` reads at runtime to push the
prefilter down to the spatial-index `IndexEntry` layer — skipping whole
kinds _before_ any `getHandle()` lookup. Untagged predicates work too;
they just lose that pushdown.

---

## 4. Foundation round — what landed

> Historical record of the first round. See §4a for the paint-class
> correction and §4b for the query-cleanup + call-site migration that
> completed the architecture.

### Files created in the foundation round

```
client/src/core/spatial/region.ts          — Region union + atPoint/inBBox/regionEnvelope
client/src/core/spatial/atoms.ts           — Type atoms (HandleOf, Predicate, Paint, ...)
client/src/core/spatial/kind-capability.ts — KindCapability<K> + KIND table (8 entries)
client/src/core/spatial/filters.ts         — byKind/byKinds/isBindable + and/or/not/guardAnd
client/src/core/spatial/pickers.ts         — classifyPaint, scanTopmostWithMemo, pickFrameAware, ...
client/src/core/spatial/handle-hit.ts      — HandleProbe<T> + hitNearestHandle<T>
client/src/core/spatial/__type_tests__.ts  — Compile-time assertions (dead code at runtime)
```

### Files modified in the foundation round

```
client/src/core/spatial/object-query.ts   — added queryHits/queryHandles, kept legacy shims
client/src/stores/selection-store.ts      — removed marquee reset from setSelection (1 line)
client/src/tools/EraserTool.ts            — replaced per-kind dispatch loop with queryHandles+circle
client/src/tools/selection/SelectTool.ts  — marquee + click hit testing using new functions
```

### Verification status

- `npm run typecheck` passes from repo root (shared + client + worker).
- `__type_tests__.ts` exercises all the inference paths declared in the
  plan's verification section.
- No runtime smoke test yet (CLAUDE.md says don't start dev server without
  permission).
- No unit tests written for the capability table.

### Key implementation notes / nuances

**`STROKE_CAP` vs `CONNECTOR_CAP` are duplicated.** Both polyline-based,
identical bodies. The plan called this out as acceptable until / unless a
real divergence emerges. Could later be factored via a shared helper or a
`polylineCap()` factory.

**`framedCap<K>` factory** collapses text / note / code / image / bookmark
into one shared body — they all share `rectFrameHit` against a derived
frame. Per-kind variation: the frame getter and the `isFilled` rule.
Classify functions stay per-cap because they encode opacity semantics.

**Stroke tolerance preserved exactly:**

- `hitPoint` uses `r + strokeWidth / 2` (matches old `hitTestStrokeLike`).
- `hitCircle` uses just `r` (matches old `EraserTool` behavior).
  This was important — silent tolerance regressions would be very hard to
  spot.

**Classify semantics preserved verbatim** from `object-pick.ts`:

- stroke / connector / image / note / bookmark → `'ink'`
- text → `isFilled && insideInterior ? 'fill' : 'ink'`
- code → `insideInterior ? 'fill' : 'ink'`
- shape → `isFilled ? 'fill' : !insideInterior ? 'ink' : null`

**Spatial-index pushdown preserved.** `readKindBrand(filter)` extracts the
`__kinds` set, scanner skips entries whose `e.kind` isn't in the set
_before_ `getHandle()`. This matches the old `queryHitCandidates(..., kinds)`
optimization. Untagged filters lose only the pushdown, not correctness.

**`queryHandles({ precise: 'rect' / 'circle' })` silently skips entries
when the region kind doesn't match** the requested precision. So
`{ region: inBBox(b), precise: 'circle' }` returns `[]`. Could be a
design wart — see Open Questions.

---

## 4a. Paint-class correction (follow-up, landed)

The foundation shipped with `HitCandidate` carrying `{ area, isFilled,
insideInterior }` eagerly per hit, and `KindCapability.classify` dispatched
per candidate through a 7-branch per-kind table. Review revealed most of
that storage and most of that dispatch wasn't earning its keep:

- **`area`** is only read inside `pickFrameAware`'s tournament and
  `scanTopmost`'s see-through fallback. Computing it on every hit (polyline
  bbox for stroke/connector, `frame[2]*frame[3]` for every framed kind) was
  waste.
- **`isFilled`** is only meaningful to one classify path — `SHAPE_CAP`.
  Every other cap hardcoded a constant. Passing it per candidate paid
  storage cost for nothing.
- **`insideInterior`** was consumed by `TEXT_CAP.classify` /
  `CODE_CAP.classify`, but those per-kind distinctions only matter if hit
  testing goes to glyph level (which it doesn't). Without character-level
  testing, a click anywhere inside a text or code frame is a paint hit
  regardless of fill color — there's no see-through concept for them. Text
  and code should follow the same trivial `'ink'` rule as strokes, notes,
  images, bookmarks.

The real rule is compact: **only an unfilled shape's interior is
see-through.** Everything else is `'ink'`. A filled shape interior is
`'fill'` (still a paint blocker, but area-comparable in the tournament
against the tightest unfilled frame it sits under — preserves the existing
smaller-frame-wins heuristic). A shape hit on the stroke edge is `'ink'`
(short-circuits the tournament, like any other paint).

### What changed

- **`HitCandidate`** → `{ handle, distance, paint: Paint }`. Dropped `area`,
  `isFilled`, `insideInterior`.
- **`KindCapability.classify`** removed. The paint class is computed inline
  by each cap's `hitPoint` and returned as part of `HitFields`. Pickers read
  `c.paint` directly — no runtime redispatch at tournament time.
- **`KindCapability.area(h)`** added as a lazy getter; pickers only pay the
  cost when the tournament actually compares.
- **`framedCap` factory** collapses to a single argument (`resolveFrame`).
  All five framed kinds (text/note/code/image/bookmark) now return
  `paint: 'ink'` uniformly.
- **`SHAPE_CAP.hitPoint`** is the only non-trivial paint computation:
  `isFilled ? 'fill' : insideInterior ? null : 'ink'`.
- **`scanTopmost{WithMemo,}`** and **`pickFrameAware`** (both new and legacy
  copies) read `c.paint` directly and call `areaOf(h) = KIND[h.kind].area(h)`
  on demand, tracking `bestFrameArea` through the loop so the tournament
  computes at most two area values per pick.

### Behavior delta (intentional, narrow)

- **Shape-only scenarios** (tournament, nesting, stroke-edge pick,
  smallest-unfilled-over-filled): preserved bit-for-bit.
- **Text / code stacked above an unfilled shape**: now short-circuit on
  `'ink'` (text/code wins). Previously the old `TEXT_CAP.classify` /
  `CODE_CAP.classify` could return `'fill'` when the hit was inside the
  frame, letting a smaller-area unfilled shape below beat the text/code via
  the area tournament. That's the only user-visible change.

This aligns text/code with note/image/bookmark/strokes — every non-shape
object is just visible paint that blocks.

### Files touched

- `core/geometry/hit-testing.ts` — slim `HitCandidate`;
  `hitTestStrokeLike` / `hitTestShape` / `hitTestFramed` return precomputed
  `paint`. Dropped `INTERIOR_PAINT` / `computePolylineArea` imports.
- `core/spatial/kind-capability.ts` — interface change (drop `classify`,
  add `area`); all 8 caps rewritten; `framedCap` factory simplified.
- `core/spatial/pickers.ts` — `classifyPaint` / `isSeeThrough` are shims
  over `c.paint`; `areaOf` helper added; `scanTopmostWithMemo` and
  `pickFrameAware` use lazy `areaOf` with tracked `bestFrameArea`.
- `core/geometry/object-pick.ts` — legacy scanners migrated to `c.paint` +
  `areaOf` (imported from `core/spatial/pickers` — a small legacy→new dep
  that evaporates when the legacy file is deleted).

### What's still parallel-living (unchanged)

Everything in §5. No legacy file deleted. No consumer migrated. The
`HIT_BY_KIND` / `testObjectHit` / `hitTestVisibleKind` wrappers,
`objectIntersectsRect`, `INTERIOR_PAINT` (now dead but exported), `frameOf`,
and the `queryHitCandidates` / `queryHandlesInBBox` shims all remain.

### Verification

- `npm run typecheck` passes clean across shared + client + worker. Field
  removals statically catch any stray reader of `c.area` / `c.isFilled` /
  `c.insideInterior` — none existed.
- `__type_tests__.ts` still compiles (the assertions were shape-level, not
  field-level).
- No unit tests written for the new cap table — §9.7 still open.

---

## 4b. Query cleanup & call-site consolidation (follow-up, landed)

After §4a, the foundation had a two-tier query surface (`queryHits` +
`queryHandles`), plus a deprecated rbush `.query(WorldBounds)` passthrough
used by viewport culling, plus a parallel `core/geometry/object-pick.ts` +
`core/geometry/hit-testing.ts` duplicate set kept alive by the last
consumers on legacy helpers (snap, TextTool, CodeTool, viewport culling,
image viewport, resize handles, endpoint dots). Every hot-path consumer
did its own `/scale` math at the call site. `HitCandidate` carried a
`distance` field no picker read.

This slice: clean up the spatial folder, collapse those into a clear
three-tier query surface, move `/scale` math into the query layer behind
a tagged `Radius` opt, migrate every listed consumer, delete every
legacy duplicate that's now unreachable.

### What changed

**Three query tiers, each with a distinct return shape.**

| Tier           | Returns             | Use case                                     | Cost per result                                  |
| -------------- | ------------------- | -------------------------------------------- | ------------------------------------------------ |
| `queryEntries` | `IndexEntry[]`      | viewport culling, image/bookmark decode loop | rbush search only                                |
| `queryHandles` | `HandleOf<K>[]`     | marquee, eraser, region membership           | + `getHandle` + optional precise intersect       |
| `queryHits`    | `HitCandidate<K>[]` | click picking, snap                          | + `cap.hitPoint` + paint classification + Z-sort |

Consumers pay only for the tier they actually read.

**Tagged `Radius` in `core/spatial/radius.ts`.** `{ px }` resolves to
world units via `resolveRadius` (reads camera scale); `{ world }` passes
through. Every call site that did `(SOME_PX + SLACK) / scale` locally is
now `{ px: SOME_PX + SLACK }`. `radius.ts` is the single spatial module
that imports `camera-store`.

**`HitCandidate = { handle, paint }`.** `distance` dropped (no picker
consumed it — it was dead bytes per hit). `KindCapability.hitPoint`
returns `HitFields<K> | null` where `HitFields<K> = Omit<HitCandidate<K>,
'handle'>`, which now collapses to `{ paint: Paint }`. Shim on the hit
side is one less allocation per candidate.

**Handle-hit sibling layer rewritten.**

- `hitNearest<T>({ at, radius: Radius, probes })` — the canonical
  point-probe nearest-lookup. Supersedes the orphan `hitNearestHandle(p,
r, probes)` API.
- `hitEndpointDot(at, selectedIds)` — thin wrapper over
  `hitNearest({ at, radius: { px: ENDPOINT_DOT_HIT_PX }, probes })` with
  an inline generator reading `getEndpointEdgePosition(h, 'start'|'end')`.
- `hitResizeHandle(at, bbox)` — stayed bespoke. Side handles are edge
  strips (hit anywhere along the edge), not midpoint circle probes — a
  generator-only model would be a UX regression.

**Picker cleanup.** `classifyPaint` / `isSeeThrough` shims deleted —
callers read `c.paint` / `c.paint === null` directly. Added
`pickTopmostByKind(cands, kind)` as the canonical visible-kind helper;
replaces `hitTestVisibleKind`.

**Memory.**

- `ObjectSpatialIndex.queryBBox` / `queryRadius` reuse a module-scoped
  scratch `{ minX, minY, maxX, maxY }` envelope mutated before each
  `tree.search`. Zero allocation per query at the rbush boundary.
- `camera-store.getVisibleBoundsTuple()` returns a shared module-scoped
  tuple overwritten on each call. Hot consumers (`objects.ts` culling,
  `image-manager.manageImageViewport`) stop allocating per frame.
  `getVisibleWorldBounds()` (object shape) retained for cold consumers.

**Shims + deprecated API deleted.** `queryHitCandidates`,
`queryHandlesInBBox`, the deprecated `spatialIndex.query(WorldBounds)`
method — all gone. `core/geometry/object-pick.ts` and
`core/geometry/hit-testing.ts` deleted entirely (the last consumers
migrated).

**Lint.** `filters.ts:brand` generic changed from `F extends Function`
to `F extends (...args: never[]) => unknown` — satisfies
`@typescript-eslint/no-unsafe-function-type` while preserving type-
predicate inference.

### Call-site migrations

| Consumer                                 | Before                                                                 | After                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| SelectTool click                         | `(HIT_PX + SLACK) / scale` + `queryHits({ radius })`                   | `queryHits({ at, radius: { px: HIT_PX + SLACK } })`                                                   |
| SelectTool resize handle                 | `hitTestHandle(wx, wy, bbox)`                                          | `hitResizeHandle([wx, wy], bbox)`                                                                     |
| SelectTool endpoint dots                 | `hitTestEndpointDots(wx, wy, ids)`                                     | `hitEndpointDot([wx, wy], ids)`                                                                       |
| EraserTool circle                        | `atPoint(p, (PX + SLACK) / scale)`                                     | `atPoint(p, { px: PX + SLACK })`                                                                      |
| TextTool visible text/note               | `hitTestVisibleText/Note(wx, wy)`                                      | `pickTopmostByKind(queryHits({ at, radius: { px: 8 } }), 'text'\|'note')`                             |
| CodeTool visible code                    | `hitTestVisibleCode(wx, wy)`                                           | `pickTopmostByKind(queryHits({ at, radius: { px: 8 } }), 'code')`                                     |
| snap.ts                                  | `queryHitCandidates(cx, cy, r, BINDABLE_KINDS)` + legacy `scanTopmost` | `queryHits({ at, radius: { world: r }, filter: isBindable })` + `scanTopmostWithMemo(cands, trySnap)` |
| Viewport cull (`objects.ts`)             | `spatialIndex.query(getVisibleWorldBounds())`                          | `spatialIndex.queryBBox(getVisibleBoundsTuple())`                                                     |
| Image viewport (`image-manager.ts`)      | `spatialIndex.query(padded)` (WorldBounds)                             | `spatialIndex.queryBBox(padViewport(getVisibleBoundsTuple()))` (tuple)                                |
| Smart duplicate (`clipboard-actions.ts`) | `spatialIndex.query(queryBounds)`                                      | `spatialIndex.queryBBox([queryBounds.minX, …])`                                                       |

### Behavior delta (intentional, narrow)

- snap.ts: preserved — `scanTopmostWithMemo` defaults `onSeeThrough` to
  `accept`, matching the legacy `scanTopmost({ accept, onSeeThrough })`
  pattern with both handlers pointing at `trySnap`.
- Text/code visible-kind click: preserved — occlusion model intact (filled
  shape above text still blocks).
- Viewport culling + image decode: identical entry sets. Only the bbox
  shape at the rbush boundary changed.
- Endpoint-dot tolerance: unchanged (`ENDPOINT_DOT_HIT_PX = 10`).

### Files touched

- **New:** `client/src/core/spatial/radius.ts`.
- **Rewritten:** `client/src/core/spatial/handle-hit.ts` (new API:
  `hitNearest` / `hitResizeHandle` / `hitEndpointDot`).
- **Modified:** `core/spatial/region.ts` (`atPoint` takes `Radius`),
  `core/spatial/object-query.ts` (+`queryEntries`; `queryHits` takes
  `Radius`; shims dropped), `core/spatial/kind-capability.ts` (owns
  `HitCandidate`; `hitPoint` returns `{ paint } | null`),
  `core/spatial/pickers.ts` (+`pickTopmostByKind`; shims dropped),
  `core/spatial/object-spatial-index.ts` (scratch envelope; deprecated
  `query()` dropped), `core/spatial/__type_tests__.ts` (new
  `HitCandidate` import, `Radius` in opts), `core/spatial/filters.ts`
  (lint fix).
- **Modified call sites:** `tools/selection/SelectTool.ts`,
  `tools/EraserTool.ts`, `tools/TextTool.ts`, `tools/CodeTool.ts`,
  `core/connectors/snap.ts`, `renderer/layers/objects.ts`,
  `core/image/image-manager.ts`,
  `core/clipboard/clipboard-actions.ts`.
- **Modified store:** `stores/camera-store.ts`
  (+`getVisibleBoundsTuple`).
- **Deleted:** `core/geometry/object-pick.ts`,
  `core/geometry/hit-testing.ts`.
- **Types:** dropped `INTERIOR_PAINT` from `core/types/objects.ts` (dead
  since §4a) and its re-export in `core/index.ts`.

### Verification

- `npm run typecheck` passes clean across shared + client + worker.
  Deletions statically catch any stray reader of dropped exports — none
  existed.
- `__type_tests__.ts` exercises the new `Radius` shape end-to-end.
  Narrowing through `byKind` / `byKinds` / `isBindable` preserved.
- No unit tests added for the cap table — §9.7 still open.
- No runtime smoke test yet.

---

## 5. What's still legacy (intentional parallel-living)

Most of what this section originally listed is gone — see §4b. What
remains:

### Still present in `core/geometry/frame-of.ts`

- `FRAME_BY_KIND` + `frameOf(handle)` — fully duplicated by
  `KIND[k].frame` in the capability table, but still consumed by:
  - `core/connectors/snap.ts` (inside `trySnap`)
  - `core/connectors/connector-utils.ts`
  - `core/connectors/reroute-connector.ts`
  - `core/connectors/anchor-atoms.ts`

These were outside the slice's listed consumer set. Their migration +
`frame-of.ts` deletion is a follow-up — straightforward mechanical swap
to `KIND[h.kind].frame(h)` or a thin re-export.

### Still present in `core/types/objects.ts`

- `BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle` — still
  consumed by connector internals (`reroute-connector.ts`,
  `connector-lookup.ts`). The filter-layer `isBindable` in
  `core/spatial/filters.ts` already derives from `KIND[k].bindable` (so
  the new path has a single source of truth); these standalone exports
  are the legacy shape used outside the filter context. Cleanup follows
  the same pattern as the `frame-of.ts` migration.

### Not yet built

- Unit tests for the capability table (§9.7 in the open-questions list).
- Runtime smoke test.
- Generators weren't needed — `hitEndpointDot` inlines its probe
  generator in `handle-hit.ts`. No standalone `iterResizeHandleProbes` /
  `iterEndpointDotProbes` exports; if a future consumer needs them, pull
  them out then.

---

## 6. How the new type system actually works

End-to-end for the three query tiers + the sibling non-spatial layer.

### `queryEntries(opts)` — raw IndexEntry list

```typescript
queryEntries({
  region: Region,                          // atPoint | inBBox
  kinds?: readonly ObjectKind[],           // optional entry-level prefilter
}): IndexEntry[]
```

Pipeline:

1. `regionEnvelope(region)` → `getSpatialIndex().queryBBox(env)`
2. If `kinds` given, filter `entry.kind ∈ set`
3. Return — no `getHandle`, no cap dispatch, no classification.

Cheapest tier. Used by viewport culling (`objects.ts`) and image decode
(`image-manager.ts`), which iterate `{ id, kind }` directly.

### `queryHandles<K>(opts)` — region membership → handle list

```typescript
queryHandles({
  region: Region,                          // atPoint | inBBox
  precise?: 'bbox' | 'rect' | 'circle',    // default 'bbox'
  filter?: NarrowingPredicate<ObjectHandle, HandleOf<K>>,
  where?:  Predicate<HandleOf<K>>,
  limit?:  number,
}): HandleOf<K>[]
```

Pipeline:

1. `regionEnvelope(region)` → `getSpatialIndex().queryBBox(env)`
2. KindSet prefilter (from `__kinds` brand on filter)
3. `getHandle(entry.id)` + `filter` narrow
4. **Precise phase:**
   - `'bbox'` → always pass (envelope-only)
   - `'rect'` → only if `region.kind === 'rect'`, then `cap.hitRect(h, region.bbox)`
   - `'circle'` → only if `region.kind === 'point'`, then `cap.hitCircle(h, region.p, region.r)`
5. `where?` → push → `limit?` → return

### `queryHits<K>(opts)` — point probe → classified, Z-sorted

```typescript
queryHits({
  at: [wx, wy],
  radius: Radius,                          // { px } | { world }
  filter?: NarrowingPredicate<ObjectHandle, HandleOf<K>>,
  where?:  Predicate<HitCandidate<K>>,
  comparator?: Comparator<HitCandidate<K>>,  // default Z top-first
  limit?: number,
}): HitCandidate<K>[]
```

Pipeline (per `object-query.ts`):

1. `r = resolveRadius(radius)` — `{ px }` → `px / scale`, `{ world }` passthrough
2. `getSpatialIndex().queryRadius(wx, wy, r)` — coarse rbush envelope
3. `readKindBrand(filter)` → kindSet → entry-level prefilter
4. `getHandle(entry.id)` — null guard
5. `filter(handle)` — narrows; `K` flows from filter return type
6. `KIND[h.kind].hitPoint(h, [wx, wy], r)` — per-kind cap dispatch (one cast per loop)
7. Compose `{ handle: h, ...fields }` → `HitCandidate<K>` (`fields = { paint }`)
8. `where?(candidate)` post-filter
9. `sortZTopFirst` (or custom comparator)
10. `limit?` truncate

### Radius resolution (one place)

```typescript
// core/spatial/radius.ts
export type Radius = { readonly px: number } | { readonly world: number };
export function resolveRadius(r: Radius): number {
  if ('world' in r) return r.world;
  return r.px / Math.max(0.001, useCameraStore.getState().scale);
}
```

`atPoint(p: Point, radius: Radius): Region` calls `resolveRadius` once at
construction — the stored `region.r` is always world-units. `queryHits`
calls it at the top of its pipeline. Call sites never touch scale.

### Variadic narrowing carries through

```typescript
const cs = queryHits({ at, radius: { px: 8 }, filter: byKinds('shape', 'text') });
// cs: HitCandidate<'shape' | 'text'>[]   ← inferred, no manual cast
```

`byKinds<const K extends readonly ObjectKind[]>(...ks: K)` produces a
`NarrowingPredicate<ObjectHandle, HandleOf<K[number]>>`; `K` flows through
`queryHits<K>` → `HitCandidate<K[number]>`. `__type_tests__.ts` asserts
this with `expectType` / `assertEq`.

### Picker layer

```typescript
firstCandidate(cs)          // cs[0] ?? null
pickBestBy(scorer)(cs)      // max-by scorer
scanTopmostWithMemo(cs, accept, onSeeThrough?)
                            // see-through memoization + paint-blocker termination
pickFrameAware(cs)          // bestFrame/firstPaint two-phase tournament
pickTopmostByKind(cs, kind) // visible-kind helper (replaces hitTestVisibleKind)
areaOf(handle)              // lazy per-handle area dispatch (via KIND[k].area)
sortZTopFirst(cs)           // in-place ULID-desc sort (used by queryHits default)
byZOrderTopFirst            // comparator (exposed for callers that pass one)
```

All multi-candidate pickers consume Z-sorted top-first lists (`queryHits`
produces this by default). They read `c.paint` directly — no shim
redispatch.

### Sibling: non-spatial `hitNearest`

```typescript
interface HandleProbe<T> { center: Point; value: T }

hitNearest<T>(opts: {
  at: Point;
  radius: Radius;
  probes: Iterable<HandleProbe<T>>;
}): T | null
```

Squared-distance comparison, no `Math.hypot`. `radius` is the same tagged
`Radius` — screen vs world semantics are consistent with the spatial
pipeline. Uses:

- `hitEndpointDot(at, selectedIds)` — connector endpoint dots. Inlines a
  generator reading `getEndpointEdgePosition(h, 'start'|'end')` and calls
  `hitNearest({ at, radius: { px: ENDPOINT_DOT_HIT_PX }, probes })`.
- `hitResizeHandle(at, bbox)` — bespoke (corners + edge strips). Not
  routed through `hitNearest` because N/S/E/W handles are edge-distance
  probes, not center probes; reducing them to midpoint circles would
  hurt UX.

---

## 7. The marquee fix (one-line, explained)

**Bug:** `selection-store.ts:setSelection` unconditionally reset
`marquee: { active: false, anchor: null, current: null }`. SelectTool then
called `beginMarquee(...)` + `updateMarquee(...)` on every cursor move
during a marquee drag to "re-enable" it.

**Fix:** Removed the marquee reset from `setSelection`. Marquee lifecycle
is now exclusively gesture-owned: `beginMarquee` / `updateMarquee` /
`endMarquee` / `cancelMarquee`. `clearSelection` still resets marquee
(correct — Escape / click-empty should clear both).

**Result:** SelectTool's `updateMarqueeSelection` is now a clean diff:

```typescript
const overlapping = queryHandles({ region: inBBox(marqueeBBox), precise: 'rect' });
const selectedIds = overlapping.map((h) => h.id).sort();
const current = store.selectedIds.slice().sort();
const changed = selectedIds.length !== current.length || selectedIds.some((id, i) => id !== current[i]);
if (changed) store.setSelection(selectedIds); // marquee survives
```

No `JSON.stringify` churn, no re-enter dance, no comment justifying a
workaround.

---

## 8. Next direction (subject to change — to be spec'd in a follow-up session)

§4b closed the call-site-surface side of the original two-move plan: the
three-tier API (`queryEntries` / `queryHandles` / `queryHits`) + tagged
`Radius` gives consumers a lean shape, and every listed call site is on
it. What's still on deck:

- **Make `ObjectSpatialIndex` the direct method caller.** Today there's a
  facade (`core/spatial/object-query.ts`) over a wrapper
  (`ObjectSpatialIndex`) over rbush. Plan: the index itself takes an
  rbush `toBBox` override, stores bboxes natively as tuples, and exposes
  the hit-test entry points directly. One less layer; one file to touch
  when adding a new query method. **Not started** — user explicitly
  deferred "we won't be storing `toBBox` or anything yet."

- **`frame-of.ts` deletion sweep.** Migrate
  `connector-utils.ts`/`reroute-connector.ts`/`anchor-atoms.ts` from
  `frameOf(h)` to `KIND[h.kind].frame(h)`, then delete the file. Pure
  mechanical swap; blocked only on touching the connector layer.

- **`BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle` cleanup.**
  The filter-layer `isBindable` already derives from `KIND[k].bindable`.
  Delete the standalone constant + the type guards once the
  connector-internal consumers migrate to `isBindable` (or to a
  narrowing helper re-exported from the capability layer).

Downstream ideas the foundation still accommodates (bookmark
sub-regions, capability subsets, `queryHitsInRect`, composite scorers,
the new "create-connector-from-selected-shape" handle kind) all slot in
cleanly on top of what's landed — none of them block each other.

---

## 9. Open questions (things the user is still figuring out)

**Resolved in §4b:**

- ~~**(1)** `hitNearestHandle` sibling vs merge.~~ Resolved: the sibling
  API is now `hitNearest<T>({ at, radius: Radius, probes })` — same
  tagged `Radius` as the spatial pipeline, so call-site vocabulary
  matches even though the implementation is non-spatial. Resize handles
  stay bespoke (edge-strip semantics would regress under a
  center-probe-only model); endpoint dots migrated.
- ~~**(4)** `pickFrameAware` duplication.~~ Resolved: legacy copy in
  `core/geometry/object-pick.ts` deleted. Only `core/spatial/pickers.ts`
  version remains.
- ~~**(5)** `HitCandidate<K>` home.~~ Resolved: moved to
  `core/spatial/kind-capability.ts`. `core/spatial/` is now self-
  contained (no geometry imports in the type-surface path).

**Still open:**

2. **`queryHandles({ precise })` silent-skip behavior.** When
   `precise: 'circle'` is passed with `region.kind === 'rect'`, the
   scanner currently skips every entry silently → returns `[]`. Should
   this be a compile error? Could enforce via discriminated `precise`
   field per region kind:

   ```typescript
   QueryHandlesOpts<K> =
     | { region: PointRegion; precise?: 'bbox' | 'circle'; ... }
     | { region: RectRegion;  precise?: 'bbox' | 'rect';   ... }
   ```

   More type safety, slightly more verbose option type. User to decide.

3. **`STROKE_CAP` / `CONNECTOR_CAP` duplication.** Identical bodies.
   Factor to a shared `polylineCap()` helper, leave as-is, or wait until
   they actually diverge? (Unchanged from previous round.)

4. **Cap entry organization.** All 8 entries live in
   `kind-capability.ts` (~230 lines after §4b). Plan said: _"if they
   grow, a `client/src/core/spatial/caps/` subfolder with one file per
   kind."_ Threshold not yet hit. User may prefer split-now for
   navigability.

5. **No unit tests for the capability table.** Byte-for-byte equivalence
   vs the legacy scattered sources is narrower after §4a (classify
   dropped, area lazy) and §4b (legacy deleted), but still unverified by
   tests. Risk: a subtle per-kind regression surfacing only in a
   nested-frame edge case.

6. **`BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle`
   derivation.** The `isBindable` filter in `filters.ts` derives from
   `KIND[k].bindable`, but the standalone exports in
   `core/types/objects.ts` are still maintained manually. Cleanup waits
   on the connector-internal migration (`connector-lookup.ts`,
   `reroute-connector.ts`) moving to the filter or to a narrowing
   helper re-exported from the capability layer.

---

## 10. Scope — what's in this refactor, what's out

### Landed (foundation + §4a + §4b)

- All 6 layers from the plan exist, plus `core/spatial/radius.ts` (new).
- Type tests prove the inference paths (with updated `Radius` shape).
- Marquee bug fixed (gesture-owned).
- Paint-class correction (§4a).
- Query cleanup & call-site consolidation (§4b) — three tiers
  (`queryEntries` / `queryHandles` / `queryHits`), tagged `Radius`
  replacing `/scale` boilerplate, `HitCandidate` slimmed to
  `{ handle, paint }`, scratch-envelope on the rbush boundary, shared
  visible-bounds tuple, `hitNearest` unifying the non-spatial layer.
- Consumers migrated: `SelectTool` click/handles/endpoints, `EraserTool`,
  `TextTool`, `CodeTool`, `snap.ts`, viewport culling (`objects.ts`),
  image viewport (`image-manager.ts`), smart duplicate
  (`clipboard-actions.ts`).
- Legacy deleted: `core/geometry/object-pick.ts`,
  `core/geometry/hit-testing.ts`, `INTERIOR_PAINT`, deprecated
  `ObjectSpatialIndex.query(WorldBounds)`, `queryHitCandidates`,
  `queryHandlesInBBox`, `hitNearestHandle` (renamed to `hitNearest`).
- Typecheck passes across shared + client + worker.

### Still out of scope (deferred to follow-up slice)

- `core/geometry/frame-of.ts` deletion + connector-internal migrations
  (`connector-utils.ts`, `reroute-connector.ts`, `anchor-atoms.ts`).
- `BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle` cleanup.
- `ObjectSpatialIndex` becoming the direct facade (rbush `toBBox`
  override, tuple-native entries).
- Unit tests for the capability table.
- Runtime smoke test.
- `STROKE_CAP` / `CONNECTOR_CAP` factoring.
- Cap subfolder split threshold.
- `queryHandles({ precise })` silent-skip → compile error shape (§9.2).

### Explicitly out of scope (forever, per plan)

- `core/geometry/hit-primitives.ts` — pure tuple math, correctly scoped.
- Connector routing / bookmark / image / text subsystems — orthogonal.

---

## 11. Handoff notes

Foundation (§3–§6), paint-class correction (§4a), and query cleanup +
call-site consolidation (§4b) all landed. Typecheck passes across shared

- client + worker. Every consumer listed in the original refactor set is
  on the new API.

Live architecture:

- **`core/spatial/` is self-contained** (no imports from
  `core/geometry/hit-testing` or `object-pick` — both deleted).
  `core/spatial/radius.ts` is the single module that imports
  `camera-store` (for `resolveRadius`).
- **Three query tiers** (`queryEntries` / `queryHandles` / `queryHits`)
  — consumers pick the cheapest tier that answers their question.
- **Tagged `Radius` in opts** — `{ px }` or `{ world }`. No `/scale`
  math at call sites.
- **Scratch envelope at rbush boundary** + **shared visible-bounds
  tuple** in camera-store — zero per-call allocation in hot paths.
- **`hitNearest` sibling** with same `Radius` vocabulary for resize
  handles + endpoint dots.

For the next slice — items on deck:

- `frame-of.ts` deletion sweep (connector-internal migrations).
- `BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle` cleanup.
- `ObjectSpatialIndex` as direct facade (rbush `toBBox` + tuple-native
  entries).
- Capability-table unit tests (§9.7).
- `queryHandles({ precise })` compile-time enforcement (§9.2).
- `STROKE_CAP` / `CONNECTOR_CAP` factoring (§9.3).
- Cap subfolder split (§9.6).

Items resolved this round (see §9): #1, #4, #5. Items still open: #2,
#3, #6, #7, #8.
