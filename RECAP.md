# Handoff: porting a flat SoA R-tree into tldraw's spatial index

Written at the end of a long session whose later half invalidated most of its
earlier half. Read §0 before trusting anything else in this file or on disk.

---

## 0. Status — the work is a starting point, not a base to build on

A working implementation exists and all tests pass, but **two things are wrong
with it and both are structural**:

1. **The design exposes an API it never should have.** It adds `SpatialQuery`,
   `acquireQuery`/`release`, generation stamps, query pooling, a three-call bulk
   load, and four new exports from `@tldraw/editor`. Measurement later showed
   that entire surface buys nothing (§5.2). The correct shape is an engine swap
   with **zero API change**: `search(bounds): Set<TLShapeId>` stays exactly as
   it is and everything else is private.

2. **The published numbers are not trustworthy.** `RESULTS.md`, `ISSUE-DRAFT.md`
   and the artifact all quote speedups inflated by workload choice, and a GC
   comparison that measured process setup rather than the loop (§5.4).

**Recommendation: restart the implementation from `FlatRTree.ts` and the
architecture map in §3. Do not extend the existing wrapper.** The engine itself
is fine; the layer above it is not.

What *is* trustworthy and worth keeping:
- The architecture map in §3 — verified against source, file by file.
- The allocation decomposition in §5.2 — self-validating, and it is the headline.
- The query-count measurement in §5.3.
- The `dispose` bug in §6.1 — a real defect that also exists in the avlo copy.
- The measurement pitfalls in §5.4 — each one cost real time.

---

## 1. Where everything is

| Path | What |
|---|---|
| `/home/user/tldraw` | tldraw clone, branch `flat-rtree-spatial-index`, 10 commits on top of `cbbcf357`, head `849c416b`. `node_modules` installed (3 GB), types built. Working tree clean. |
| `/home/user/spatial-recap/RECAP.md` | this file |
| `/home/user/spatial-recap/harness/` | the measurement scripts that produced the numbers in §5.2 and §5.3 (also pushed to the branch below, under `harness/`) |
| `/home/user/avlo` | the user's own repo, branch `spatial-parallel`, **untouched** — this work never modified it |
| `github.com/issakakar/avlo` branch `tldraw-flat-rtree` | the same work pushed as an orphan branch: patches, new files, diffs, the harness, this file, and `RESULTS.md` / `ISSUE-DRAFT.md` (**stale numbers, banner-flagged**) |

The source of `FlatRTree.ts` is `/home/user/avlo/web/src/core/spatial/FlatRTree.ts`
(the original) and the tldraw-adapted copy is at
`/home/user/tldraw/packages/editor/src/lib/editor/managers/SpatialIndexManager/FlatRTree.ts`.

Harness contents:
- `decompose.mjs` + `drive.mjs` / `drive2.mjs` — the allocation decomposition. **This is the good one.**
- `bench.mjs` — rbush's own benchmark shape, for calibrating the machine.
- `fair.mjs` — bounded-workload op comparison at the tree level.
- `flatrtree.mjs`, `shapeindex.mjs` — esbuild bundles of the TS sources, so plain `node` can run them with no `tsx` in the loop. **Regenerate these after editing the TS** (command in §5.1).
- `old-*-DISTRUST.txt` — the superseded numbers, kept only so nobody re-derives them.

---

## 2. The task

Replace rbush behind `packages/editor/src/lib/editor/managers/SpatialIndexManager/`
with a flat structure-of-arrays R-tree. The goal is an issue on `tldraw/tldraw`
linking a fork branch — **pull requests are turned off on that repo as a
platform setting**, and `CONTRIBUTING.md` names issue + fork-branch link as the
only sanctioned route.

The pitch that the evidence actually supports is **allocation**, not wall time.
See §5.2. Steve Ruiz's own perf PRs use exactly this framing ("the hot loop is
now allocation-free… 3.5x faster on average and removes a 10ms worst-case GC
tick"), so it lands in their idiom.

---

## 3. tldraw's spatial architecture — verified against source

Everything in this section was read in the source during the session. File and
line references are against `cbbcf35`.

### 3.1 The index's surface, and every caller

`SpatialIndexManager` exposes exactly two query methods, both returning
`Set<TLShapeId>`, both `@public` in the checked-in api-report:
`getShapeIdsInsideBounds(bounds)` and `getShapeIdsAtPoint(point, margin)`.
`Editor` re-exports only the first. `Editor` holds the manager as
`private readonly _spatialIndex` — there is no public accessor.

Eight non-test call sites, complete:

| Call site | Rect | Use of the result |
|---|---|---|
| `editor/derivations/notVisibleShapes.ts:19` | viewport | `.size` fast path, then `.has()` per page shape |
| `Editor.getShapeAtPoint` (~5895) | point + margin | `.has()` only, inside a full sorted-shape loop |
| `Editor.getShapesAtPoint` (~6097) | point + margin | `.has()` only, same shape |
| `Editor.getShapeIdsInsideBounds` (~6130) | caller's | passthrough to userland |
| `tldraw/.../SelectTool/childStates/Brushing.ts` | marquee box | `.size === 0` early out, then `.has()` as a `.filter` predicate |
| `tldraw/.../SelectTool/childStates/ScribbleBrushing.ts` | segment, 0 margin | identical shape |
| `tldraw/.../EraserTool/childStates/Erasing.ts` | segment + hit margin | identical shape |
| `templates/image-pipeline/src/nodes/types/CaptureNode.tsx` | — | the only consumer that iterates; converts to array immediately |

Nothing depends on result ordering. Nothing mutates the Set. Nothing retains it
past the enclosing synchronous function. **Every in-repo consumer wants only
`size` and `has`.**

### 3.2 What notifies the index (the reactive pipeline)

This has no equivalent in avlo and is the part most worth studying.

`SpatialIndexManager` wraps everything in one `computed<number>('spatialIndex')`
whose value is a private `_boundsEpoch` counter — **not** the diff. It has
**exactly three tracked dependencies**, all read unconditionally at the top:

```ts
const shapeDiff   = shapeHistory.getDiffSince(lastComputedEpoch)
const bindingDiff = bindingHistory.getDiffSince(lastComputedEpoch)
const currentPageId = this.editor.getCurrentPageId()
```

`getDiffSince` is itself what registers the dependency, so **both history reads
must happen before any early return**. Everything after runs inside
`unsafe__withoutCapture` so the index does not register a dependency per shape
it touches.

`store.query.filterHistory('shape')` is memoized per typeName with
`{ historyLength: 100 }` (`packages/store/src/lib/StoreQueries.ts:208`), over
`store.history` which keeps `1000` (`Store.ts:362`). **Exceed either since the
last read and you get `RESET_VALUE` → full rebuild.** 100 store transactions
without anyone pulling the index is enough, so full rebuilds are common — bulk
load speed matters more here than intuition suggests.

Returning the identical `_boundsEpoch` number means `lastChangedEpoch` does not
advance and downstream consumers do not invalidate. That is the whole point of
the decoupling and there is a test counting reactor re-runs to protect it
(`packages/tldraw/src/test/spatialIndex.test.ts`, `trackSpatialIndexInvalidations`).

Then `processIncrementalUpdate` does a four-step dirty-set expansion, because
**a shape's page bounds can move without its own record changing**:

1. **Seed** from the diffs. Added/updated → `transformChanged` + dirty. Removed
   → pending remove, and dirty the old parent (a group shrinks). Binding
   add/remove/update → dirty both ends, plus the old ends on reassignment.
2. **Descendants.** A moved record moves the page transform of everything under
   it → walk `getSortedChildIdsForParent` transitively, dirty all.
3. **Fixpoint upward.** Anything whose bounds may have changed can resize
   ancestor groups and move bound arrows → walk parents and
   `getBindingsInvolvingShape` to a fixpoint. Descendants are deliberately *not*
   re-expanded here (a derived bounds change does not move the shape's own transform).
4. **Recheck** only the dirty set: fresh `getShapePageBounds` vs the indexed
   bounds; upsert on a real change, remove if gone or moved to another page.

Step 4's four-scalar comparison (`areBoundsEqualToSpatialElement`) is why
`RBushIndex.getElement` exists — a zero-alloc read of the stored bounds.
It is load-bearing because `_getShapePageBoundsCache` (`Editor.ts:5461`) has
**no `areResultsEqual`**, so a colour change allocates a fresh, numerically
identical `Box`. Without the compare, every prop edit would touch the tree.

Documented limitation, in the class doc: a custom shape whose geometry reads
other shapes outside parent/child and binding relationships is never rechecked.

### 3.3 Bounds

`getShapePageBounds` → `ComputedCache<Box, TLShape>` →
`Box.FromPoints(pageTransform.applyToPoints(geometry.boundsVertices))`.
Memoized, shared instance, stable identity between invalidations.

`Box.isValid()` (`Box.ts:183`) is **finiteness of x/y/w/h only** — it does not
check `w >= 0`. Since `FromPoints` derives w,h as max−min, inverted boxes are
unreachable through this path, but the gate itself would accept one.

The index uses **unmasked** page bounds deliberately; consumers re-apply masking
(`getShapeMask` + `pointInPolygon`) and re-admit frame-likes unconditionally.

Zero-area boxes are legal and reachable — `getShapeIdsAtPoint(point, 0)` builds
a literal 0×0 box. **rbush's intersection is inclusive on all four edges**;
any replacement must keep non-strict comparisons or zero-area probes stop hitting.

### 3.4 Hit testing — imperative, on pointer move, not DOM

`packages/tldraw/src/lib/tools/selection-logic/updateHoveredShapeId.ts` →
`getShapeAtPoint(currentPagePoint, { renderingOnly: true, margin: getHitTestMargin() })`,
**throttled to 32 ms** (`THROTTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 32`).
Called from `SelectTool/Idle`, `EditingShape`, text tool `Idle`, `PointingShape`,
`arrowTargetState`, `ArrowShapeUtil.onTranslate`, and a UI action.

Its file header says *"Hit-testing shapes is expensive in large documents"* and
it carries a hover-lock `WeakMap` that stops hit-testing entirely while the
camera moves. The maintainers already treat this as a hot path.

Inside `getShapeAtPoint`: the index supplies candidates, then it walks
`getCurrentPageShapesSorted()` (or `RenderingShapesSorted` under `renderingOnly`)
**top-down in full**, and per shape:

```ts
if (!candidateIds.has(shape.id) && !this.isShapeFrameLike(shape)) continue
```

**Frame-like shapes bypass the index entirely** — every frame on the page is
hit-tested regardless, because frame labels sit outside the frame's bounds. So
point queries stay O(frames) on a frame-heavy page. Then per surviving shape:
lock/hidden/group filters, `getShapeMask` + `pointInPolygon`, the caller's
`filter`, `getShapeGeometry`, distance/containment with separate inner and outer
margins, plus label-child checks for notes, arrows and unfilled geo.

**Two hooks inside that loop run user code**: `opts.filter` and
`getShapeGeometry`. This is what makes any shared/singleton query result unsafe.

`EraserTool/childStates/Pointing.ts` is the outlier: it walks
`getCurrentPageRenderingShapesSorted()` with `isPointInShape` and **uses no
index at all**. Low-risk win available there.

### 3.5 Culling — a DOM visibility toggle, not a render skip

`getRenderingShapes()` returns **every** shape on the page, sorted by id
(deliberately id-sorted so DOM nodes never move and iframes never reload; there
is a permutation cache above a size threshold). Every shape gets a `<Shape>`
mounted with its own `useQuickReactor`. **Culled shapes just get
`display: none`** — see `packages/editor/src/lib/hooks/useShapeCulling.tsx`.

Per camera move, four page-sized passes:

1. `notVisibleShapes` — iterate all page shape ids; `visibleIds.has(id)`; per
   off-screen shape a `store.unsafeGetWithoutCapture(id)`, a
   `getShapeUtil(type)`, and a `notVisibleIds.add(id)`. A
   `util.canCull === defaultCanCull` check skips per-shape subscription for
   >99% of shapes. Then a prev-value equality re-check to preserve identity —
   another full `has()` pass.
2. `getCulledShapes` — `new Set(notVisibleShapes)` **unconditional full copy**,
   delete the editing shape and all selected, then *another* full membership
   pass against the cached previous Set to decide whether the old identity can
   be returned.
3. `updateCulling` — a single reactor iterates **every registered container**
   and does `culledShapes.has(id)`, toggling `display` on change.
4. `getCurrentPageRenderingShapesSorted` — when pulled, `.filter()` over all
   sorted shapes on `culledShapes.has(id) && !isShapeHidden(id)` into a fresh array.

`PerformanceManager` pulls `getCulledShapes()` per frame **only if** a `'frame'`
listener is attached (`listenerCount('frame') > 0`). Any benchmark that attaches
one is measuring the cull, not the index.

**Consequence:** on a 20k-shape page a cull costs ~11 ms per camera move and the
spatial search is ~0.008 ms of it. Replacing the index does not make culling
faster. Do not lead with this — but know it, because a maintainer will.

### 3.6 Marquee and eraser

`Brushing.hitTestShapes()` runs on every pointer move, **and** on shift/ctrl
keydown/keyup, **and** on complete. Flow: build the brush box → index query →
`.size === 0` early out (explicitly to avoid `getCurrentPageShapesSorted()`) →
pick `RenderingShapesSorted` if the brush is inside the viewport and the
viewport has not scrolled, else all sorted → `.filter(has)` → per candidate:
`brush.contains(pageBounds)` fast path; skip in wrap mode or for frame-likes;
else `brush.collides(pageBounds)` → invert the page transform, map the four
brush corners into shape space, `geometry.hitTestLineSegment` per edge. A
comment notes on-screen hit tests are ~2× faster than testing all shapes on a
~5000-shape page.

`ScribbleBrushing` and `Erasing` are structurally identical but their rect is
the segment between previous and current pointer position — tiny, so very few
hits. `Erasing.onEnter` additionally does an unindexed O(page) pass to build the
excluded set (locks, plus group/frame containment of the origin point).

### 3.7 Ids, pages, lifecycle

`TLShapeId` is the literal string `shape:${uniqueId()}` (nanoid by default, but
`createShapeId(id?)` accepts any suffix). **Ids are reused after deletion** —
undo replays the exact removed records, and sync clears tombstones. A shape can
be removed and re-added inside one diff batch; the manager handles that explicitly.

Page membership is a `parentId` chain, not a field; `getAncestorPageId` walks up
to a `page:` prefix. `reparentShapes` to another page is an **update**, not a
delete, so a shape can leave the index while its record still exists.
`moveShapesToPage` is a real delete + create with `preserveIds`.

**Multiple `Editor` instances coexist** (the shipped examples mount three).
Nothing can be a module singleton. The manager is per-editor and registered as a
disposable — but the index computed is **not** torn down with it. See §6.1.

`maxShapesPerPage` defaults to **4000** (`packages/editor/src/lib/options.ts:291`),
enforced only on create/paste, so loaded documents can exceed it. Docs discuss
10k canvases; Brushing's comment cites ~5000. **No evidence anywhere of hundreds
of thousands of shapes per page** — calibrate claims accordingly.

There is **no existing dense integer id** for shapes anywhere to piggyback on.

### 3.8 Other unindexed O(n) spatial work

- **`SnapManager.getSnappableShapes()`** — walks the whole subtree under the
  selection's common ancestor and per child does `selectedShapeIds.includes(childId)`
  — an **array** scan inside the loop, so **O(page × selection)** — plus
  `renderingBounds.includes(pageBounds)` (full containment, not intersection).
  `@computed`, but invalidated by camera movement and selection, so it
  recomputes during drags. Biggest remaining opportunity.
- `elbowArrowSnapLines` — viewport containment per unselected arrow, unindexed.
- `EraserTool/Pointing` and `Erasing.onEnter` — above.
- `getCurrentPageBounds` — O(page), but uses *masked* bounds and skips hidden
  shapes, so a root-MBR shortcut is not a drop-in.

`findShapeAncestor`, selection bounds and frame child containment have no index
opportunity.

---

## 4. Design — what to build instead

The user's own critique, which the measurements confirmed:

1. **Zero API change.** `RBushIndex` is replaced by an internal class with the
   same method shapes. `search(bounds): Set<TLShapeId>` stays. No `SpatialQuery`,
   no generations, no pooling, no acquire/release, no new package exports. The
   consumers should not be touched at all in the first pass.
2. **The `Set` is unavoidable and is not the index's problem.** `getCulledShapes`
   needs a real Set with stable identity (`ReflowIfNeeded` compares by identity),
   and `getShapeIdsInsideBounds` is public API whose one template consumer
   round-trips ids through `editor.getShape`. Build it as cheaply as possible
   and stop there. It measured 5.07 KB/frame on both sides — a fixed cost.
3. **Keep the id→slot bookkeeping internal and cheap.** `RBushIndex` already
   carries a `Map<TLShapeId, SpatialElement>`, so a `Map<TLShapeId, number>` is
   parity on mutation, not a regression. The mistake was using it *per probe*
   in a membership path. Never do that.
4. **Typed arrays throughout.** The old wrapper used `freeSlots: number[]` — use
   a `Uint32Array` + length counter. `idBySlot` must hold strings, but can be a
   plain `string[]` with a tombstone rather than `(TLShapeId | undefined)[]`.
5. **Simplify the load.** The three-call `beginLoad`/`stage`/`commitLoad` is more
   surface than needed. Populate internally.
6. **`FlatRTree.load(count, ids: ArrayLike<number>, boxes: ArrayLike<number>)`
   has a polymorphic site**: the `count < 7` fallback reads straight off the
   `ArrayLike` (the main path normalizes to typed arrays first). Cold, but that
   file is otherwise careful about exactly this.

---

## 5. Measurement

### 5.1 The method that works

Everything below ran on this container: 4 vCPU Intel Xeon @ 2.10 GHz, Node
22.22.2, rbush 3.0.1, machine idle. **Verify idleness first** — earlier numbers
in this session were taken while background agents were saturating the CPU.

```bash
# regenerate the plain-JS bundles after editing any TS source
cd /home/user/tldraw
node_modules/.bin/esbuild packages/editor/src/lib/editor/managers/SpatialIndexManager/FlatRTree.ts \
  --bundle --format=esm --outfile=/home/user/spatial-recap/harness/flatrtree.mjs
node_modules/.bin/esbuild packages/editor/src/lib/editor/managers/SpatialIndexManager/ShapeSpatialIndex.ts \
  --bundle --format=esm --external:@tldraw/tlschema --outfile=/home/user/spatial-recap/harness/shapeindex.mjs

# the allocation decomposition
cd /home/user/spatial-recap/harness && node drive.mjs

# calibrate the machine against rbush's own published benchmark
node bench.mjs 1000000
```

The decomposition works like this, and the shape of it is the important part:

- **One mode per process.** Two implementations behind one interface in one
  process makes every call site polymorphic and measures the dispatch.
- **`--trace-gc --max-semi-space-size=1`**, and attribute allocation from
  `before_i − after_{i−1}` heap deltas between consecutive collections.
- **Bracket the measured window** with markers printed to stdout
  (`###LOOP_START` / `###LOOP_END`) and count only GCs inside it. Skipping this
  is what broke the first attempt — it counted process setup.
- **Run each mode long enough** that many collections fall inside the window.
  20,000 frames for cheap modes, 6,000 for the expensive ones.
- **Check additivity.** The parts must sum to the whole. They did, within 0.2%,
  which is what makes the result believable.

### 5.2 Trustworthy numbers — allocation, 100k shapes, per frame

One viewport search returning ~95 shapes, plus 200 upserts (a 200-shape drag).

| mode | KB/frame | interpretation |
|---|---|---|
| control (loop only, no index) | 0.05 | the floor |
| **flat engine search** | **0.05** | **indistinguishable from the empty loop — zero** |
| **rbush engine search** | **2.00** | 1.95 above the floor |
| flat search → `Set` | 5.12 | the Set costs 5.07 |
| rbush search → `Set` (as `RBushIndex` writes it) | 7.83 | |
| rbush search → `Set`, no intermediate `.map` array | 7.27 | the `.map` is only 0.56 of it |
| **flat 200 upserts (raw engine)** | **0.25** | |
| **flat 200 upserts (through the wrapper)** | **0.21** | |
| **rbush 200 upserts, best case** (remove → mutate in place → reinsert) | **119.06** | synthetic; the manager cannot do this |
| **rbush 200 upserts as the manager must** (mint an element each) | **143.58** | |
| flat full frame | **5.35** | |
| rbush full frame | **151.21** | |

Per operation:
- **rbush upsert: 735 bytes.** Best case, denying it the object mint: 610 bytes.
- **flat upsert: ~1 byte** — below the method's resolution; amortised node-pool
  growth. The honest claim is "indistinguishable from zero", which is stronger.
- rbush search (95 hits): 2.00 KB. **flat search: zero.**
- the `Set`: 5.07 KB, identical on both sides.

GC and time (same runs): rbush-full 0.1255 scavenges/frame, 0.025 ms GC/frame,
0.768 ms/frame. Flat-full 0.00525 scavenges/frame, 0.001 ms GC/frame,
0.155 ms/frame. **24× fewer collections, 25× less GC time, 5.0× faster.**

Subtract the `Set` — the manager's cost, which neither engine controls — and the
index-attributable allocation is **146.1 KB/frame vs 0.28 KB/frame, ~520×**. On
the mutation path alone, **684×**. At 60 fps during a 200-shape drag:
**8.8 MB/s vs 17 KB/s**.

**This is the headline.** Not wall time, not the cull.

### 5.3 Trustworthy numbers — queries per frame

Measured on the **shipped** code (the six touched files checked out at `cbbcf35`,
counters wrapped around the manager's methods, then reverted):

| interaction | bounds queries/frame | point queries/frame |
|---|---|---|
| pan | 0.99 | 0.00 |
| drag 200 shapes | 1.00 | 0.00 |
| hover pointer move | 0.00 | 0.97 |
| marquee drag | 1.00 | 0.02 |

**Exactly one index query per frame, in every interaction.** (Hover reads 0.97
because `THROTTLE_MS` is 0 under `NODE_ENV=test`; production is 32 ms → ~0.5/frame.)

So the search runs **once** per frame and `upsert` runs **200 times** in a
200-shape drag. Optimising search is nearly irrelevant to allocation; the
mutation path is the whole story.

### 5.4 Numbers that are NOT trustworthy, and why

**Everything in `internal/scripts/spatial-bench/RESULTS.md`, `ISSUE-DRAFT.md`,
and the published artifact.** Specifically:

- **"drag 200 shapes 240×"** — the harness nudged the same 200 shapes by 3% of
  their width for 120 frames, which parks every update in the tree's O(1) tier.
  With a realistic travel step it is **39×** (7757 µs → 197 µs).
- **"remove 63×"** — the harness drained the whole tree one-by-one, which is
  rbush's worst case (condense + reinsert as it empties) and the flat tree's
  best (no condensing at all, by design). Bounded and rebuilt between passes:
  **51×** on board data but only **3.7×** on uniform data. The ratio swings ~4×
  on data shape alone.
- **"bulk load 2.1×"** — measured at the adapter level, where both sides carry
  non-tree work. Tree-only it is **3.4×**.
- **"71 → 31 scavenges"** — counted every GC in the process including setup, at
  600 frames and a 4 MB semi-space where the loop produced ~1 scavenge of real
  signal. Meaningless. Superseded by §5.2.
- **In-app A/B numbers** (`getShapeIdsInsideBounds` 1.82×, page switch 1.21×,
  cull ~1.0×) — these were taken correctly (min of 3 runs, ±5% noise floor
  calibrated against identical code on both sides) and are probably fine, but
  they were measured against the *wrong design* and should be redone.

**The board data generator is skewed.** Its 5% giant overlapping frames
(1200–4200 × 900–3100 units) are pathological for rbush's remove descent and do
a lot of the work in the mutation ratios. Use it, but report uniform alongside.

### 5.5 Measurement pitfalls that cost hours

- `PerformanceObserver({ entryTypes: ['gc'] })` **never fires inside a vitest
  worker**. Don't try.
- `process.memoryUsage().heapUsed` deltas as an allocation proxy are **useless**
  even with a 1 GB semi-space — the same code measured 29.6 MB and 13.9 MB on
  consecutive runs. Only the trace-gc delta method is stable.
- vitest's default and `dot` reporters **buffer**; a hung run looks identical to
  a slow one. Use `--reporter=verbose`. `--reporter=basic` does not exist in
  vitest 4.
- `timeout N cmd; echo EXIT=$?` inside a subshell reports the **echo's** exit
  code, not the command's. A 70-minute hang reported "exit code 0".
- Never run benchmarks while background agents are alive. Check `uptime` first;
  concurrency here is capped at 2 agents but each can peg a core.
- The whole `packages/tldraw` suite is **213 files, 2912 tests, ~197 s** at
  `--maxWorkers=2`. If it takes longer, something is hanging.

---

## 6. Bugs and traps found

### 6.1 `dispose()` must not be terminal — this bug also exists in avlo

`packages/tldraw/src/test/resizing.test.ts` **hung forever**. The editor
registers the index's `dispose` as a disposable but does **not** tear down the
index computed with it, so a read after disposal schedules a rebuild against a
just-disposed index. rbush tolerated it (`clear()` + `bulkLoad` on a fresh tree).
The flat engine did not: `dispose()` released the `Float64Array` that box
arguments travel through, every coordinate then read as `undefined`, and the
ancestor-extension walk in `_insertEntry` — whose exit condition is a
containment test — never terminates against NaN.

Fixed by **deleting `FlatRTree.dispose()`** rather than guarding it. `clear()`
already returns every growable buffer to newborn size, so a terminal teardown
only bought a few KB of fixed scratch in exchange for a structure that can be
made unusable while something still holds it.

**The same `dispose()` is in `/home/user/avlo/web/src/core/spatial/FlatRTree.ts`
and the same walk is what would spin.** Latent there only because the singleton
never disposes.

### 6.2 Re-entrancy

`getShapeAtPoint` calls `opts.filter` and `getShapeGeometry` — both user code —
while holding a search result. A nested `getShapeAtPoint` from either corrupts a
shared result. This is real, not hypothetical. If the redesign returns a plain
`Set` (as recommended), the hazard disappears entirely.

### 6.3 Behaviour differences to keep in mind

- Rejecting inverted boxes (`minX > maxX`) is stricter than `Box.isValid()`.
  Unreachable via `Box.FromPoints`, but it is a change.
- A removed shape drops out of a live slot-keyed result (the slot recycles); a
  `Set` snapshot keeps it. Not observable in-repo, but real.
- The engine **throws** on duplicate insert / out-of-range id / pool overflow,
  where rbush would silently answer wrongly. Corruption tripwires, but they fire
  from inside a signals computed.

---

## 7. Repo conventions that will bite you

- **Formatting is `oxfmt`, not Prettier at the command level** (though
  `.prettierrc` exists with matching settings): tabs, single quotes, no
  semicolons, width 100, sorted imports. Run
  `node_modules/.bin/oxfmt --write <files>`.
- **`oxlint` with a custom `tldraw` plugin.** The rule that will bite:
  **`no-setter-getter` — property getters are not allowed.** Use `getX()`
  methods. (`Box` uses per-line eslint-disables for its own.)
- Per-directory overrides ban global `fetch`/`Image`/`setTimeout`/
  `requestAnimationFrame` in `packages/editor|tldraw|utils`.
- Every import must be declared in the owning workspace's `package.json`.
- **api-extractor**: rejects unqualified `{@link member}` (must be
  `{@link Class.member}`) and unescaped `<`, `>`, `{`, `}` in tsdoc — wrap in
  backticks. Any type a public signature mentions must be exported from the
  package entry. **`@internal` members DO appear in the checked-in
  `api-report.api.md`**, so any addition changes it. Regenerate with
  `yarn build-types` then `cd packages/editor && yarn build-api`.
- A `.bench.ts` under `packages/editor/src/` **gets transpiled into the
  published tarball** with a live `require('vitest')` in it — the build's
  test-file filter only excludes `/__tests__/`, `.test.`, `.spec.`.
- `AGENTS.md` is the canonical rulebook. Sentence case everywhere. **No AI
  attribution anywhere, no AI co-authors.**

Test commands:
```bash
cd packages/editor && yarn run -T vitest run --maxWorkers=2         # 1202 tests, ~60s
cd packages/tldraw && yarn run -T vitest run --maxWorkers=2         # 2912 tests, ~197s
```

---

## 8. Contribution route

`CONTRIBUTING.md`, verbatim: *"We are **not accepting contributions**… Pull
requests are turned off for this repository."* and *"If a code example would
help the discussion, fork the repository and link to your branch in the issue."*

Verified: there is **no auto-close automation** in `.github/workflows`; the
block is a repo setting, so a fork PR cannot be opened at all. New issues are
auto-triaged by a Claude action that retitles, retypes and relabels on open.

**Framing note from the user, which overrides the earlier draft:** do not open
by telling tldraw that their own system barely uses the spatial search, and do
not downplay the work. Lead with the raw op-level engine comparison —
specifically the allocation numbers in §5.2.

---

## 9. Confidence boundary

**Verified by reading source in this session:** everything in §3, §6, §7's lint
and api-extractor items, the `CONTRIBUTING.md` text, `smi` at
`packages/store/src/lib/ImmutableMap.ts:6` (vendored from Immutable.js, with an
attribution header — but present, and an earlier claim that "engine vocabulary is
absent from tldraw" was wrong and should not be repeated).

**Measured in this session with a method that self-validates:** §5.2, §5.3.

**Reported by research subagents and NOT independently verified — treat as leads:**
the index's commit history and PR numbers (#7676, #8799, #8804, #9093, #9183),
the specific perf-commit quotes, the "19 rules" count in the oxlint plugin, and
the claim that `getShapeIdsInsideBounds` went public as a side effect of the
image-pipeline PR. One unverified subagent claim already turned out wrong in
this session. Check before citing.

---

## 10. Suggested plan for the next session

1. Read this file. Confirm `/home/user/tldraw` is clean and on
   `flat-rtree-spatial-index`.
2. **Do not extend the existing wrapper.** Start a new branch from `cbbcf35`.
   Keep `FlatRTree.ts` (minus `dispose()`, per §6.1); rewrite the layer above it
   per §4 — internal only, `Set` return, zero consumer changes.
3. Port the parity fuzz test from
   `packages/editor/src/lib/editor/managers/SpatialIndexManager/ShapeSpatialIndex.test.ts`
   on the old branch — it is good and it caught a real bug (slot recycling
   leaking membership). Add the dispose-then-reuse case.
4. Re-run the decomposition (§5.1) against the new implementation. Expect the
   search column to stay at zero and the mutation column to stay ~1 byte/op.
5. Run the **full** `packages/tldraw` suite with `--reporter=verbose`. It must
   finish in ~200 s. Anything longer is a hang.
6. Only then write the issue, leading with §5.2.
