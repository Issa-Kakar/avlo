# Replacing rbush in the spatial index: measurements

A flat, structure-of-arrays R-tree behind `SpatialIndexManager`, in place of
rbush. This file is the evidence: what was measured, on what data, and what it
did and did not change.

Everything below was produced on one machine — 4 vCPU Intel Xeon @ 2.10 GHz,
Node 22.22.2, `NODE_ENV=test`, rbush 3.0.1 (the version `@tldraw/editor`
depends on). The speedups are ratios on that machine; the absolute numbers are
not interesting. Timings are the minimum of repeated runs, which on a shared
machine is the least-perturbed sample.

## What changed

Three files, and a rule about which shape a search result should take.

| File                     | What it is                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlatRTree.ts`           | The storage engine. rbush's algorithm skeleton — OMT bulk load, R\*-flavoured split, least-enlargement subtree choice — over flat typed arrays, with a rebuilt split and bulk loader. Knows nothing about shapes. |
| `ShapeSpatialIndex.ts`   | The `TLShapeId` ↔ slot mapping, bounds validation, and the two result shapes. Replaces `RBushIndex`.                                                                                                              |
| `SpatialIndexManager.ts` | Same reactive shell. Applies upserts as it decides them rather than batching objects, and stages page rebuilds straight into typed buffers.                                                                       |

The tree stores every box in one `Float64Array` and every node link in one
`Uint32Array`. Items are dense integers ("slots") minted by
`ShapeSpatialIndex`, so `_cellOf[slot]` is a flat array rather than a Map and
a search can write its results into a reused `Uint32Array`. Nothing on the
insert / update / remove / search paths allocates.

Three things differ from rbush algorithmically, and each is there for a reason
that shows up on whiteboard data:

- **Entry boxes live in the parent**, B-tree style, and a child's entry count
  and leafness ride in the parent's reference word. A search never loads
  per-node metadata, and a fully-covered subtree is dumped by walking
  references only, never touching a box.
- **The split scores eight candidates** — four split points × {sorted by lower
  coordinate, sorted by upper coordinate} — instead of rbush's lower-coordinate
  orders only. A slice by `minX` files a long arrow under wherever its left end
  happens to be; a slice by `maxX` can put it where its mass is.
- **The bulk load partitions (key, index) proxies with an MSD radix
  multi-partition** instead of quickselecting co-swapped box records. Payload
  never moves, so typed inputs are read in place, and every rank boundary at a
  level resolves in the same histogram and scatter passes. Keys are the box
  _centre_, not its lower corner.

## Correctness

`ShapeSpatialIndex.test.ts` runs 4,000 random operations — inserts, moves,
removals and searches over a mix of tiny, huge, zero-area and extremely
elongated boxes — and after every search checks the answer three ways:

- against a brute-force scan of a plain model map,
- against rbush fed the identical sequence,
- and through both result shapes (`searchToSet` and a `SpatialQuery`), asking
  membership for every id, not just the matched ones.

`validate()` runs alongside. It is stricter than the answers: it proves every
internal box is the _exact_ union of its children, so a tree that returned the
right shapes through slack bounds would still fail.

The suite also covers slot recycling, a search running while another query's
results are being read, the 16-bit generation wrap, page-sized clear and
reload, and the small/large result crossover.

The existing suites pass. On this branch:

- `packages/editor` — 1,202 tests across 56 files.
- `packages/tldraw` — the full suite, 213 files.
- The parity fuzz above — 9 tests.

One existing test changed: it spied on `RBushIndex.applyBatch` by name to assert
that a prop-only diff does not touch the index. It now spies on `upsert` and
`remove` — the same guarantee, checked one level closer.

## Index-level measurements

One implementation per process (two behind one interface would make every call
site polymorphic and measure the dispatch). Both are driven exactly the way
`SpatialIndexManager` drives them, so the rbush side pays for the
`SpatialElement` object it has to mint per upsert — rbush removes by reference,
so it cannot be reused in place without invalidating the tree's boxes.

Two datasets. `uniform` is rbush's own benchmark shape: independent boxes of
one size over a square. `board` is whiteboard-shaped: shapes bunched into
working areas with empty space between them, 13% arrows and connectors whose
bounding boxes are long and thin, and a few large frames.

### board, 10,000 shapes

|                                    | rbush    | flat    |          |
| ---------------------------------- | -------- | ------- | -------- |
| bulk load (warm)                   | 6.13 ms  | 2.84 ms | **2.2×** |
| heap held by the index             | 2.67 MB  | 1.16 MB | **2.3×** |
| search: 100% viewport (31 hits)    | 6.17 µs  | 2.27 µs | **2.7×** |
| search: zoomed out ~10× (176 hits) | 14.3 µs  | 4.2 µs  | **3.4×** |
| search: fit to page (1,290 hits)   | 38.4 µs  | 10.6 µs | **3.6×** |
| hit test at a point                | 8.98 µs  | 3.68 µs | **2.4×** |
| drag 1 shape, per frame            | 8.25 µs  | 1.81 µs | **4.6×** |
| drag 200 shapes, per frame         | 1,134 µs | 25.2 µs | **45×**  |
| relocate a shape across the page   | 6.40 µs  | 1.00 µs | **6.4×** |
| insert one shape                   | 1.65 µs  | 0.87 µs | **1.9×** |
| remove one shape                   | 4.36 µs  | 0.28 µs | **15×**  |

### board, 100,000 shapes

|                                             | rbush    | flat     |          |
| ------------------------------------------- | -------- | -------- | -------- |
| bulk load (cold, first call in the process) | 155.8 ms | 86.7 ms  | **1.8×** |
| bulk load (warm)                            | 91.3 ms  | 43.6 ms  | **2.1×** |
| heap held by the index                      | 36.9 MB  | 8.98 MB  | **4.1×** |
| search: 100% viewport (392 hits)            | 134.7 µs | 28.7 µs  | **4.7×** |
| search: zoomed out ~10× (1,716 hits)        | 269.1 µs | 49.0 µs  | **5.5×** |
| search: fit to page (11,732 hits)           | 673.3 µs | 124.9 µs | **5.4×** |
| hit test at a point                         | 134.8 µs | 32.5 µs  | **4.1×** |
| drag 1 shape, per frame                     | 57.4 µs  | 0.74 µs  | **78×**  |
| drag 200 shapes, per frame                  | 6,472 µs | 26.9 µs  | **240×** |
| relocate a shape across the page            | 37.7 µs  | 1.32 µs  | **29×**  |
| remove one shape                            | 35.5 µs  | 0.56 µs  | **63×**  |

### uniform, 10,000 shapes — rbush's own benchmark shape

|                                  | rbush    | flat    |          |
| -------------------------------- | -------- | ------- | -------- |
| bulk load (warm)                 | 6.24 ms  | 2.77 ms | **2.3×** |
| heap held by the index           | 4.01 MB  | 2.61 MB | **1.5×** |
| search: fit to page (1,049 hits) | 20.7 µs  | 5.94 µs | **3.5×** |
| hit test at a point              | 0.73 µs  | 0.30 µs | **2.4×** |
| drag 200 shapes, per frame       | 267.7 µs | 26.7 µs | **10×**  |
| remove one shape                 | 1.12 µs  | 0.30 µs | **3.7×** |

Two places it is not faster:

- **Cold first load on a small page.** At 1,000 shapes the first bulk load in a
  fresh process is about 2× slower: the radix loader is more code for the
  interpreter to get through before anything is optimised. It is at parity by
  10,000 and 1.8× faster by 100,000. (The loader is written to tier up in small
  independent pieces for exactly this reason; this is what is left after that.)
- **Membership probing at page scale.** Asking "is this shape in the last
  search" for every shape on a 100,000-shape page is _slower_ through a
  slot-keyed index than through a `Set` of the matches — a page-sized
  `Map<TLShapeId, number>` is a bigger table to hit repeatedly than a small
  Set. This decided how the result is returned; see below.

## The result shape, and what measuring the consumers changed

Every consumer of the index does the same thing: it takes a search result, asks
its `size`, then asks `has()` for each shape it is already walking, then throws
the result away. A `Set` is one allocation plus one entry per hit for something
with that lifetime, which is what the allocation-free `SpatialQuery` path is
for — membership as a generation stamp per slot, or, for a small result, a
short list scanned directly.

Measuring it moved one consumer back. Which representation wins depends on the
ratio the caller works at:

- **Probes in the same range as matches** — hit tests, brushing, the eraser's
  line segment. The query wins. A hit test matching two shapes answers `has()`
  in a couple of pointer compares, and an empty result answers it with no work.
- **Probing the whole page for a few hundred matches** — the viewport cull, and
  only the viewport cull. The `Set` wins, because the cost is then all lookups
  and a 300-entry Set is a smaller table than a 20,000-entry map.

The first version put the cull on the query path and made `getShapeAtPoint` 25%
_slower_; both are fixed above. `notVisibleShapes` uses
`getShapeIdsInsideBounds` as before.

## In-app measurements

Through the public `Editor` API only, so the same file runs against either
index (`spatialIndexPerf.test.ts`). Board-shaped page, camera parked on working
areas. Time is the minimum of three runs — on a shared machine the minimum is
the least-perturbed sample. The noise floor is about ±5%: rows that are
identical code on both sides (`createShapes`) move by that much.

### 20,000 shapes

|                                            | rbush    | this     |           | allocation     |
| ------------------------------------------ | -------- | -------- | --------- | -------------- |
| `getShapeIdsInsideBounds`                  | 14.4 µs  | 7.9 µs   | **1.82×** | **1.66× less** |
| page switch round trip (two full rebuilds) | 178.2 ms | 147.4 ms | **1.21×** |                |
| `getShapeAtPoint`                          | 1.63 ms  | 1.44 ms  | **1.14×** | 1.01×          |
| cull per camera move, 100% zoom            | 11.77 ms | 11.29 ms | 1.04×     |                |
| cull per camera move, 10% zoom             | 10.38 ms | 9.95 ms  | 1.04×     | 1.02×          |
| drag 20 shapes, per frame                  | 14.48 ms | 14.01 ms | 1.03×     | 0.99×          |
| drag 200 shapes, per frame                 | 18.70 ms | 17.53 ms | 1.07×     | 1.06×          |
| first cull (index built from scratch)      | 803.2 ms | 812.0 ms | 0.99×     |                |

### 5,000 shapes

|                                       | rbush    | this     |                                   |
| ------------------------------------- | -------- | -------- | --------------------------------- |
| `getShapeIdsInsideBounds`             | 9.0 µs   | 6.6 µs   | **1.36×** (1.66× less allocation) |
| page switch round trip                | 26.2 ms  | 21.6 ms  | **1.21×**                         |
| first cull (index built from scratch) | 286.2 ms | 239.2 ms | **1.20×**                         |
| `getShapeAtPoint`                     | 0.34 ms  | 0.28 ms  | **1.18×**                         |
| cull per camera move, 100% zoom       | 2.52 ms  | 2.56 ms  | 0.98×                             |
| drag 200 shapes, per frame            | 6.90 ms  | 7.16 ms  | 0.96×                             |

The noise floor is about ±5%: `setup: createShapes` is identical code on both
sides and moves by 1–2% between runs, and the drag and cull rows sit inside
that band in both directions.

**The index gets 2–240× faster and the app barely notices.** That is the most
useful thing here, and it is worth stating plainly rather than burying: on a
20,000-shape page a viewport cull costs about 11 ms per camera move, and
_0.008 ms of that is the spatial search_. Making the search five times faster
moves a number that was already three orders of magnitude below the thing it
sits inside.

The rest of the 11 ms is three page-sized traversals and two page-sized `Set`s
per camera move:

1. `notVisibleShapes` walks every shape id on the page. For each one not in the
   viewport it does a store lookup, a shape-util lookup and a `Set` insert —
   four string-keyed hash lookups per off-screen shape.
2. `getCulledShapes` copies that whole Set unconditionally, then re-checks
   membership against the previous one to decide whether it can return the
   cached identity.
3. `getCurrentPageRenderingShapesSorted` filters the sorted array against it
   into a fresh array.

None of that is the index's doing, and none of it gets faster by replacing the
index.

So the case for this change is not "culling gets faster today". It is:

1. **Index operations stop being a cost anyone has to think about**, including
   the ones that scale worst today — dragging a large selection is 45× to 240×
   cheaper, and a drag of 200 shapes on a 100,000-shape page goes from 6.5 ms
   of index work per frame (a dropped frame on its own) to 27 µs.
2. **The index holds a third to a quarter of the memory**, and none of it as
   objects the collector has to trace.
3. **It makes the O(visible) reformulation of culling reachable.** Culling is
   O(page) today partly because the index can only answer in shape ids, so the
   complement has to be built in shape ids too. A slot-keyed index can hand a
   dense integer set to the renderer. That is a separate and bigger change, but
   it is the change that would move the 11 ms.

## Reproducing

```bash
# index-level, both implementations, one process each
yarn tsx internal/scripts/spatial-bench/index.ts --sizes 10000,100000 --datasets board,uniform

# in-app, through the public Editor API
cd packages/tldraw
NODE_OPTIONS="--max-semi-space-size=512" SPATIAL_PERF=1 SPATIAL_PERF_N=20000 \
  yarn vitest run src/test/spatialIndexPerf.test.ts

# correctness
cd packages/editor
yarn vitest run src/lib/editor/managers/SpatialIndexManager/ShapeSpatialIndex.test.ts
```

`RBushIndex.ts` is kept for now so the A/B has a baseline to run against. It
would go with the change.

## Behaviour changes and open questions

The full `packages/tldraw` suite caught one real bug that the targeted suites and
the fuzz both missed, and it is worth recording because it is the kind of thing
that separates the two structures rather than a slip.

`resizing.test.ts` hung. The editor registers the index's `dispose` as a
disposable but does not tear down the index computed with it, so a read after
disposal schedules a rebuild against an index that has just been disposed. rbush
tolerated that — `clear()` plus `bulkLoad` on a fresh tree. The flat engine did
not: `dispose()` released the `Float64Array` that box arguments travel through
(the channel that keeps doubles off call boundaries), every coordinate then read
as `undefined`, and the ancestor-extension walk — whose exit condition is a
containment test — never terminated against NaN.

The fix was to delete `FlatRTree.dispose()` rather than guard it. `clear()`
already returns every growable buffer to newborn size; all a terminal teardown
bought was a few KB of fixed scratch, in exchange for a structure that can be
made unusable while something still holds a reference to it.
`ShapeSpatialIndex.dispose()` is now `clear()` plus dropping the pooled queries
and staging — which is exactly what `RBushIndex.dispose()` always was.

Three other things behave differently, all deliberately:

- **Invalid bounds are defined rather than undefined.** The old gate was
  `Box.isValid()`, which checks finiteness only and therefore accepts an
  inverted box (negative width or height). The index now also requires
  `minX <= maxX`, so an inverted box means "not indexable" and the shape is
  dropped rather than indexed as something that would match everything. Page
  bounds come from `Box.FromPoints`, which cannot produce one, so this is
  unreachable through the normal path — but the guard now lives inside the
  index, where the NaN-blackout bugs this subsystem has had before cannot get
  past it.
- **A removed shape leaves a live query's result.** A `Set` snapshot kept the
  removed id; a query drops it, because the slot it held can be recycled onto a
  different shape immediately. Every consumer uses the result only to filter a
  freshly-read shape list, so the difference is not observable, but it is a
  real semantic change.
- **The engine throws where rbush would not** — duplicate insert, out-of-range
  id, node-pool overflow. These are corruption tripwires: they can only fire if
  the slot bookkeeping is already broken, and they would surface as an
  exception from inside a signals computed. rbush's failure mode for the same
  class of bug is a silently wrong answer. I think the tripwire is the better
  trade, but it is a trade.

Open:

- **Cold load on small pages.** 2× slower at 1,000 shapes, parity at 10,000. If
  opening small documents matters more than large ones, the loader could fall
  back to a simple sort below some size.
- **`maxShapesPerPage` defaults to 4,000.** The interesting numbers here are
  above that. If pages are not expected to grow, most of this is headroom
  rather than a fix for something.
- **The api-report changes.** `SpatialIndexManager` gains `acquireQuery`,
  `searchBounds`, `searchAtPoint` and `validate`, and `ShapeSpatialIndex` and
  `SpatialQuery` are exported from the package entry (api-extractor needs them
  exported, since the manager's signatures reference them). All `@internal`,
  but internal declarations do appear in the checked-in report.
- **`getShapeIdsInsideBounds` stays `Set<TLShapeId>`.** It is public API — and
  the one template that consumes it round-trips the ids through
  `editor.getShape`, so slot integers must not reach userland.
- **`SpatialIndexManager.getShapeIdsAtPoint` now has no caller in the repo.**
  It is `@public` on an exported class, so it stays, but it is untested by
  anything other than its own parity.
