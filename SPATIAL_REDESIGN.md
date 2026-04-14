# Spatial Query & Hit Testing — Type System Redesign

> **Status:** Foundation landed (untracked, typecheck clean). Legacy code still
> co-exists. Integration is partial by design. **Not finalized** — open questions
> remain on capability surface, picker shape, and the non-spatial handle-hit
> sibling layer.

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
parameter shape and its own per-kind glue. Consumers had to know *which one*
to call, and then do their own:

- kind filtering
- z-order picking
- per-candidate transformation

The user's intent (verbatim from `OVERVIEW.MD`):

> *"the goal with truly maximizing generics and utility types is that the
> external consumers barely need to know what to call, as calling their own
> methods is used with a proper generic so we can distinguish based on input.
> ... the purpose of generics is to update a single place when an additional
> method is needed, and updating the call site is not verbose as the logic is
> abstracted away by the spatial index hit testing code, the consumer just
> calls with the method he needs."*

The reference for type-system elegance was `prompt.md` — a small example of
generic option-bag query types where the *return shape* is inferred from the
input. The mandate: **focus on system design, not call-site rewrites**;
"a fully proper complete base ... integration can be partial."

---

## 2. Concrete symptoms flagged

1. **SelectTool marquee re-enter dance.** `setSelection(ids)` clobbered
   `marquee` on every cursor move during a marquee drag, forcing
   `SelectTool.updateMarqueeSelection` to call `beginMarquee` + `updateMarquee`
   again to "re-enable" it (literal comment: *"Re-enable marquee since
   setSelection clears it"*). Symptom of selection store owning state it
   shouldn't.

2. **EraserTool's per-kind dispatch loop.** `EraserTool.updateHitTest` had its
   own switch over `stroke` / `shape` / framed kinds, calling
   `circleHitsShape` / `circleRectIntersect` / `strokeHitTest` directly —
   duplicating the semantics already encoded in `HIT_BY_KIND`. Done that way
   because eraser wanted *"all handles within a circle"* and there was no
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
- **Non-spatial handle hits live in a sibling layer** (`hitNearestHandle<T>`)
  with the same vocabulary but no spatial-index involvement. Honest about
  the architecture: resize handles aren't in the index because they're
  derived from selection state.
- **Marquee state is gesture-owned, not selection-owned.** One-line
  `selection-store.ts` fix.

### Layer breakdown

| Layer | File | Role |
|---|---|---|
| 0 | `core/types/geometry.ts` (existing) | `Point`, `BBoxTuple`, `FrameTuple` |
| 1 | `core/spatial/region.ts` | `Region` tagged union, `atPoint`, `inBBox`, `regionEnvelope` |
| 2 | `core/spatial/atoms.ts` | `HandleOf<K>`, `Predicate`, `NarrowingPredicate`, `Picker`, `Scorer`, `Comparator`, `Paint` |
| 3 | `core/spatial/kind-capability.ts` | `KindCapability<K>` interface + `KIND` exhaustive table |
| 4 | `core/spatial/filters.ts` + `pickers.ts` | `byKind`, `byKinds`, `isBindable`, combinators / `firstCandidate`, `pickBestBy`, `scanTopmostWithMemo`, `pickFrameAware` |
| 5 | `core/spatial/object-query.ts` | `queryHits`, `queryHandles` (modify) |
| 6 | `core/spatial/handle-hit.ts` | `HandleProbe<T>`, `hitNearestHandle<T>` (sibling, non-spatial) |

### KindCapability shape

```typescript
interface KindCapability<K extends ObjectKind> {
  readonly bindable: boolean
  readonly frame:     (h: HandleOf<K>) => FrameTuple | null
  readonly hitPoint:  (h: HandleOf<K>, p: Point, r: number) => HitFields<K> | null
  readonly hitRect:   (h: HandleOf<K>, bbox: BBoxTuple) => boolean
  readonly hitCircle: (h: HandleOf<K>, c: Point, r: number) => boolean
  readonly classify:  (c: HitCandidate<K>) => Paint
}

const KIND: { readonly [K in ObjectKind]: KindCapability<K> } = { ... }
```

`hitPoint` returns just the classification fields (`HitFields<K> = Omit<HitCandidate<K>, 'handle'>`); the scanner composes `{ handle, ...fields }`. Less boilerplate per cap entry.

### Variadic narrowing

```typescript
function byKinds<const K extends readonly ObjectKind[]>(...ks: K)
  : NarrowingPredicate<ObjectHandle, HandleOf<K[number]>>

queryHits({ at, radius, filter: byKinds('shape', 'text') })
//  → HitCandidate<'shape' | 'text'>[]
//  cs[0]?.handle.kind  // 'shape' | 'text', inferred
```

The kind set also flows through a hidden `__kinds` brand on the filter
function, which `queryHits`/`queryHandles` reads at runtime to push the
prefilter down to the spatial-index `IndexEntry` layer — skipping whole
kinds *before* any `getHandle()` lookup. Untagged predicates work too;
they just lose that pushdown.

---

## 4. What's actually landed (current state)

### Files created (all untracked — `git status`)

```
client/src/core/spatial/region.ts          — Region union + atPoint/inBBox/regionEnvelope
client/src/core/spatial/atoms.ts           — Type atoms (HandleOf, Predicate, Paint, ...)
client/src/core/spatial/kind-capability.ts — KindCapability<K> + KIND table (8 entries)
client/src/core/spatial/filters.ts         — byKind/byKinds/isBindable + and/or/not/guardAnd
client/src/core/spatial/pickers.ts         — classifyPaint, scanTopmostWithMemo, pickFrameAware, ...
client/src/core/spatial/handle-hit.ts      — HandleProbe<T> + hitNearestHandle<T>
client/src/core/spatial/__type_tests__.ts  — Compile-time assertions (dead code at runtime)
```

### Files modified

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
*before* `getHandle()`. This matches the old `queryHitCandidates(..., kinds)`
optimization. Untagged filters lose only the pushdown, not correctness.

**`queryHandles({ precise: 'rect' / 'circle' })` silently skips entries
when the region kind doesn't match** the requested precision. So
`{ region: inBBox(b), precise: 'circle' }` returns `[]`. Could be a
design wart — see Open Questions.

---

## 5. What's still legacy (intentional parallel-living)

The plan said "Old entry points can live alongside new ones during the
transition, with `@deprecated` JSDoc, and be deleted in a follow-up once all
call sites are migrated." None of the legacy code has `@deprecated` tags
yet, but it's all still present:

### Still present in `core/geometry/hit-testing.ts`
- `HIT_BY_KIND` table + `hitTestStrokeLike` / `hitTestShape` / `hitTestFramed`
- `testObjectHit`
- `objectIntersectsRect`
- `hitTestVisibleText` / `hitTestVisibleNote` / `hitTestVisibleCode` (+ shared `hitTestVisibleKind`)
- `hitTestHandle` (NOT yet rewritten as wrapper over `hitNearestHandle`)
- `hitTestEndpointDots` (same — still bespoke)
- `HitCandidate<K>` type (intentionally kept — shared vocabulary)

### Still present in `core/geometry/object-pick.ts`
- `classifyPaint` (four-branch switch — duplicated by the cap-routed one in `spatial/pickers.ts`)
- `isSeeThrough` (hardcodes shape — equivalent in result to the new one but different shape)
- `sortZTopFirst`
- `scanTopmost` (older `ScanOptions` shape — `scanTopmostWithMemo` is the new variant)
- `pickFrameAware` (duplicated in `spatial/pickers.ts`)

### Still present in `core/geometry/frame-of.ts`
- `FRAME_BY_KIND` + `frameOf` — fully duplicated by `KIND[k].frame`

### Still present in `core/types/objects.ts`
- `BINDABLE_KINDS` (used by `snap.ts`)
- `isBindableKind` / `isBindableHandle`
- `INTERIOR_PAINT` (used by `hit-testing.ts:hitTestFramed`)

### Still present in `core/spatial/object-query.ts`
- `queryHitCandidates(x, y, r, kinds?)` — shim; now internally dispatches through `KIND[k].hitPoint`
- `queryHandlesInBBox(bbox, kinds?)` — shim

### Call sites still on legacy
- `core/connectors/snap.ts:71` — `queryHitCandidates(cx, cy, edgeRadius, BINDABLE_KINDS)` + `scanTopmost`
- `tools/TextTool.ts:105` — `hitTestVisibleText` / `hitTestVisibleNote`
- `tools/CodeTool.ts:90` — `hitTestVisibleCode`
- `tools/selection/SelectTool.ts` — `hitTestHandle` and `hitTestEndpointDots` (call sites unchanged in shape; the wrappers themselves are still bespoke)

### Not yet built
- `iterResizeHandles(bounds)` generator — promised in the plan, would feed `hitNearestHandle`
- `iterEndpointDots(selectedIds)` generator — same
- The thin two-line wrappers that turn `hitTestHandle` / `hitTestEndpointDots` into `hitNearestHandle(p, r, gen)` calls
- Unit tests for the capability table

---

## 6. How the new type system actually works

End-to-end for the two query functions:

### `queryHits<K>(opts)` — point probe → classified, Z-sorted

```typescript
queryHits({
  at: [wx, wy],
  radius: r,
  filter?: NarrowingPredicate<ObjectHandle, HandleOf<K>>,
  where?:  Predicate<HitCandidate<K>>,
  comparator?: Comparator<HitCandidate<K>>,  // default Z top-first
  limit?: number,
}): HitCandidate<K>[]
```

Pipeline (per `object-query.ts`):

1. `getSpatialIndex().queryRadius(wx, wy, radius)` — coarse rbush envelope
2. `readKindBrand(filter)` → kindSet → entry-level prefilter
3. `getHandle(entry.id)` — null guard
4. `filter(handle)` — narrows; `K` flows from filter return type
5. `KIND[h.kind].hitPoint(h, [wx, wy], radius)` — per-kind cap dispatch (one cast per loop)
6. Compose `{ handle: h, ...fields }` into `HitCandidate<K>`
7. `where?(candidate)` post-filter
8. `sortZTopFirst` (or custom comparator)
9. `limit?` truncate

### `queryHandles<K>(opts)` — region membership → handle list

```typescript
queryHandles({
  region: Region,                         // atPoint | inBBox
  precise?: 'bbox' | 'rect' | 'circle',   // default 'bbox'
  filter?, where?, limit?,
}): HandleOf<K>[]
```

Pipeline:

1. `regionEnvelope(region)` → `getSpatialIndex().queryBBox(env)`
2. KindSet prefilter
3. `getHandle(entry.id)` + `filter` narrow
4. **Precise phase:**
   - `'bbox'` → always pass (envelope-only)
   - `'rect'` → only if `region.kind === 'rect'`, then `cap.hitRect(h, region.bbox)`
   - `'circle'` → only if `region.kind === 'point'`, then `cap.hitCircle(h, region.p, region.r)`
5. `where?` → push → `limit?` → return

### Variadic narrowing carries through

```typescript
const cs = queryHits({ at, radius, filter: byKinds('shape', 'text') })
// cs: HitCandidate<'shape' | 'text'>[]   ← inferred, no manual cast
```

`byKinds<const K extends readonly ObjectKind[]>(...ks: K)` produces a
`NarrowingPredicate<ObjectHandle, HandleOf<K[number]>>`, the `K` flows
through `queryHits<K>` → `HitCandidate<K[number]>`. `__type_tests__.ts`
asserts this with `expectType` / `assertEq`.

### Picker layer

```typescript
classifyPaint(c)        // shim → KIND[c.handle.kind].classify(c)
isSeeThrough(c)         // === classifyPaint(c) === null
firstCandidate(cs)      // cs[0] ?? null
pickBestBy(scorer)(cs)  // max-by scorer
scanTopmostWithMemo(cs, accept, onSeeThrough?)
                        // see-through memoization + paint-blocker termination
pickFrameAware(cs)      // bestFrame/firstPaint two-phase tournament (preserved verbatim)
```

All of these consume Z-sorted top-first candidates (which `queryHits`
produces by default). They're all `Picker<HitCandidate>` shaped so consumers
can pick by name.

### Sibling: non-spatial `hitNearestHandle`

```typescript
interface HandleProbe<T> { center: Point; value: T }

hitNearestHandle<T>(p: Point, r: number, probes: Iterable<HandleProbe<T>>): T | null
```

Squared-distance comparison, no `Math.hypot`. Designed to be fed by
generators (`iterResizeHandles` / `iterEndpointDots` — *not yet built*).
Same mental model as the spatial pipeline; honest about not touching the
spatial index.

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
const overlapping = queryHandles({ region: inBBox(marqueeBBox), precise: 'rect' })
const selectedIds = overlapping.map((h) => h.id).sort()
const current = store.selectedIds.slice().sort()
const changed =
  selectedIds.length !== current.length || selectedIds.some((id, i) => id !== current[i])
if (changed) store.setSelection(selectedIds)  // marquee survives
```

No `JSON.stringify` churn, no re-enter dance, no comment justifying a
workaround.

---

## 8. Future direction — what this design accommodates

These are *not built* but the type shape was chosen so they slot in cleanly:

1. **Bookmark link sub-regions** (the original motivating use case for
   "I'll be adding hit testing for the bookmark links too soon"):
   `BOOKMARK_CAP.hitPoint` would extend `HitCandidate<'bookmark'>` with an
   optional `region?: BookmarkLinkRegion` field. Consumers that care read
   `picked.region`; consumers that don't ignore it. **Zero changes** to
   `queryHits`, filters, pickers.

2. **Multi-select rect with classification:** add `queryHitsInRect` that
   iterates entries, calls `KIND[k].hitRect`, and synthesizes a
   `HitCandidate` with `distance: 0, insideInterior: true`. Cap table
   already has `hitRect`. Don't build until a real consumer needs it.

3. **Capability subsets:** `ResizableKind`, `RotatableKind`, `LabelableKind`
   derive via `{ [K in ObjectKind]: K extends ... ? K : never }[ObjectKind]`
   mapped types. Add `KIND[k].resizable` etc. when a third capability subset
   actually emerges. Premature today.

4. **Composite scorers for hover prioritization:**
   `compositeScorer([scoreByZOrder, 1.0], [scoreByProximity, 0.3])` — typed,
   but no consumer needs it yet. Wire to `queryHits.comparator` when one
   does.

---

## 9. Open questions (things the user is still figuring out)

These are not in the plan as decisions — they're open and the user has
flagged that things will be tweaked.

1. **`hitNearestHandle` sibling layer — does it stay sibling, or does it
   merge?** Right now it's deliberately separate: resize handles aren't in
   the spatial index because they're derived from selection state. But the
   call-site vocabulary should match. Question: do we want a unified
   `hitNearest({ region, probes? })` with an optional `probes` slot, or is
   the sibling honest? Plan said sibling; user may want to revisit.

2. **`queryHandles({ precise })` silent-skip behavior.** When
   `precise: 'circle'` is passed with `region.kind === 'rect'`, the scanner
   currently skips every entry silently → returns `[]`. Should this be a
   compile error? Could enforce via discriminated `precise` field per
   region kind:
   ```typescript
   QueryHandlesOpts<K> =
     | { region: PointRegion; precise?: 'bbox' | 'circle'; ... }
     | { region: RectRegion;  precise?: 'bbox' | 'rect';   ... }
   ```
   More type safety, slightly more verbose option type. User to decide.

3. **`STROKE_CAP` / `CONNECTOR_CAP` duplication.** Identical bodies. Factor
   to a shared `polylineCap()` helper, leave as-is, or wait until they
   actually diverge?

4. **`pickFrameAware` lives in two places.** Old in `object-pick.ts`, new
   in `spatial/pickers.ts`. They're behaviorally identical (the new one
   was preserved verbatim) but the new one routes through `KIND[k].classify`
   while the old one has a hardcoded switch. Decision pending: delete old
   when call sites migrate, or keep for transition?

5. **`HitCandidate<K>` lives in `core/geometry/hit-testing.ts`** and is
   imported by `core/spatial/kind-capability.ts`. This creates a type-only
   dependency from spatial → geometry. Works fine, but if we want
   `core/spatial/` to be self-contained, the type should re-home to
   `atoms.ts` or `kind-capability.ts`. Cosmetic.

6. **Cap entry organization.** All 8 entries currently live in
   `kind-capability.ts` (~250 lines, tight). Plan said: *"if they grow, a
   `client/src/core/spatial/caps/` subfolder with one file per kind."*
   Threshold not yet hit. User may prefer split-now for navigability.

7. **Capability table is currently hand-derived from the existing scattered
   sources. No unit tests yet** to prove byte-for-byte equivalence. The
   plan said "for each kind, construct a dummy handle and assert..." —
   not done. Risk: a subtle classify regression that only manifests in a
   nested-frame edge case.

8. **`BINDABLE_KINDS` / `INTERIOR_PAINT` derivation.** Plan said these
   should derive from `KIND[k].bindable` / `KIND[k].classify`. Currently
   they still live as standalone constants in `types/objects.ts`. The new
   `isBindable` filter in `filters.ts` does derive from `KIND` — but only
   for the filter, not for the public exports. Cleanup to do or keep
   parallel?

---

## 10. Scope — what's in this refactor, what's out

### In scope (foundation phase — landed)
- All 6 layers from the plan exist.
- Type tests prove the inference paths.
- Two integration sites (SelectTool, EraserTool) exercise the new functions
  in production code paths.
- Marquee bug fixed.
- Typecheck passes.
- No geometry math moved — only the dispatch tables reorganized.
- Spatial-index entry-level prefilter optimization preserved.

### Out of scope for this phase (deliberate — partial integration OK)
- `snap.ts` migration to `queryHits + isBindable + scanTopmostWithMemo`
- `TextTool.ts` / `CodeTool.ts` migration to inline `firstCandidate(queryHits({ filter: byKind(...) }))`
- `hitTestHandle` / `hitTestEndpointDots` rewrite as `hitNearestHandle` wrappers
- `iterResizeHandles` / `iterEndpointDots` generators
- Unit tests for the capability table
- Runtime smoke test in dev
- Deletion sweep of legacy code (`HIT_BY_KIND`, `frameOf`, `INTERIOR_PAINT`,
  `objectIntersectsRect`, `hitTestVisibleKind`, `pickFrameAware` in
  `object-pick.ts`, `frame-of.ts` itself)
- `BINDABLE_KINDS` / `INTERIOR_PAINT` derivation cleanup

### Explicitly out of scope (forever, per plan)
- `core/geometry/hit-primitives.ts` — pure tuple math, correctly scoped
- `core/spatial/object-spatial-index.ts` — pure rbush wrapper
- Connector routing / bookmark / image / text subsystems — orthogonal

---

## 11. Where to start the next session

The foundation is in. Before integration sweeps, the open questions in §9
should be resolved — particularly:

- **(2)** Discriminated `precise` per region kind, or keep silent-skip?
- **(1)** Sibling `hitNearestHandle`, or merge into `queryHandles`?
- **(8)** Derive `BINDABLE_KINDS` from `KIND` or keep parallel?
- **(7)** Capability table unit tests — should land before the legacy
  delete sweep, otherwise byte-for-byte equivalence is unverified.

Once those are settled, the integration sweep is mechanical:

1. `iterResizeHandles` + `iterEndpointDots` generators in `handle-hit.ts`
2. Rewrite `hitTestHandle` / `hitTestEndpointDots` as wrappers (in
   `hit-testing.ts` initially, can move to `handle-hit.ts` in a follow-up)
3. Migrate `snap.ts` (one-for-one swap)
4. Migrate `TextTool` / `CodeTool` (one-for-one swap)
5. Cap table unit tests
6. Delete sweep: `HIT_BY_KIND`, `testObjectHit`, `objectIntersectsRect`,
   `hitTestFramed/Shape/StrokeLike`, `hitTestVisibleKind` + 3 wrappers,
   `frameOf` / `frame-of.ts`, `INTERIOR_PAINT`, `pickFrameAware` in
   `object-pick.ts`, `classifyPaint` / `scanTopmost` / `sortZTopFirst` /
   `isSeeThrough` in `object-pick.ts`, both legacy shims in
   `object-query.ts`
7. Eventually: bookmark link sub-region cap extension (the original
   motivator)

Each of those can be a clean single-purpose diff.
