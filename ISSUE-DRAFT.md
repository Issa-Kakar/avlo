# Proposal: replace rbush in `SpatialIndexManager` with a flat typed-array R-tree

I have a spatial index I wrote for my own canvas app and I think it is a good
fit for `SpatialIndexManager`. Before doing anything else I want to check
whether you'd want it, and to share one measurement that seems useful to you
either way.

Branch: <FORK_BRANCH_URL>
Numbers, method, and the raw output: `internal/scripts/spatial-bench/RESULTS.md`

## The measurement you may care about most

On a 20,000-shape page a viewport cull costs about **11 ms per camera move**,
and **0.008 ms of that is the spatial search**. The rest is `notVisibleShapes`
building the complement: a walk of every shape on the page, a store lookup and
a shape-util lookup per off-screen shape, and a page-sized `Set`; then
`getCulledShapes` copies that Set, and `getCurrentPageRenderingShapesSorted`
filters the sorted array against it. Three page-sized traversals and two
page-sized Sets per camera move.

So swapping the index does _not_ make culling faster today, and I would rather
say that up front than bury it.

## What the change does do

The index itself, measured at the same boundary `SpatialIndexManager` drives
it through (so rbush still pays for the `SpatialElement` it has to mint per
upsert, since it removes by reference). Whiteboard-shaped data — shapes bunched
into working areas, 13% long thin arrows, a few large frames:

| board, 100,000 shapes      | rbush 3.0.1 | this    |                  |
| -------------------------- | ----------- | ------- | ---------------- |
| heap held by the index     | 36.9 MB     | 8.98 MB | **4.1× smaller** |
| bulk load (a page switch)  | 91.3 ms     | 43.6 ms | **2.1×**         |
| search: 100% viewport      | 134.7 µs    | 28.7 µs | **4.7×**         |
| hit test at a point        | 134.8 µs    | 32.5 µs | **4.1×**         |
| drag 200 shapes, per frame | 6,472 µs    | 26.9 µs | **240×**         |
| remove one shape           | 35.5 µs     | 0.56 µs | **63×**          |

At 10,000 shapes it is 2–45× depending on the operation, and it also wins on
`uniform` — rbush's own benchmark distribution — by 1.5–10×.

The one that seems most worth having is the drag row. tldraw re-upserts every
moved shape on every store update, and rbush has to remove and reinsert each
one; this resolves a move in place, usually as a single overwrite. On a large
page a drag of a big selection currently costs several milliseconds of index
work _per frame_ before any rendering happens.

Through the public `Editor` API on a 20,000-shape page, the parts that are
actually index work move and the rest doesn't:

|                                 | rbush    | this     |                              |
| ------------------------------- | -------- | -------- | ---------------------------- |
| `getShapeIdsInsideBounds`       | 14.4 µs  | 7.9 µs   | 1.82×, 1.66× less allocation |
| page switch (two full rebuilds) | 178 ms   | 147 ms   | 1.21×                        |
| `getShapeAtPoint`               | 1.63 ms  | 1.44 ms  | 1.14×                        |
| cull per camera move            | 11.77 ms | 11.29 ms | 1.04×                        |
| drag 200 shapes, per frame      | 18.70 ms | 17.53 ms | 1.07×                        |

(±5% is the noise floor on that machine — rows that are identical code on both
sides move by 1–2%, and the cull and drag rows sit inside that band.)

## How it works, briefly

rbush's algorithm skeleton — OMT bulk load, R\*-flavoured split,
least-enlargement subtree choice — over flat typed arrays. Every box lives in
one `Float64Array`, every node link in one `Uint32Array`, and items are keyed
by dense integers so a search writes its results into a reused `Uint32Array`.
Nothing on insert / update / remove / search allocates.

Three things differ algorithmically, each for a reason that shows up on
whiteboard data rather than on uniform boxes:

- Entry boxes live in the parent, B-tree style, with the child's entry count
  and leafness in the parent's reference word — so a search loads no per-node
  metadata, and a fully-covered subtree is dumped without touching a box.
- The split scores eight candidates (four split points × sorted-by-lower and
  sorted-by-upper coordinate) rather than lower-coordinate orders only. Sorting
  a split by `minX` files a long arrow under wherever its left end happens to
  be; sorting by `maxX` can put it where its mass is.
- The bulk load partitions `(key, index)` proxies with an MSD radix
  multi-partition instead of quickselecting co-swapped box records, keyed on
  the box centre rather than its lower corner. Payload never moves, so typed
  inputs are read in place.

## Correctness

The branch adds a test that runs 4,000 random operations over a deliberate mix
of tiny, huge, zero-area and extremely elongated boxes, and checks every search
three ways: against a brute-force scan, against rbush fed the identical
sequence, and through both result shapes with membership asked for every id.
A structural `validate()` runs alongside, which is stricter than the answers —
it proves every internal box is the exact union of its children.

The existing suites pass. One test changed: it spied on `RBushIndex.applyBatch`
by name to assert a prop-only diff doesn't touch the index; it now spies on
`upsert`/`remove`, which is the same guarantee one level closer.

## What I'd want your read on

1. **Is this a direction you want at all?** It is a real replacement, not a
   tweak, and I would rather find out now than after polishing it.
2. **Does the page-size range make it worth it?** `maxShapesPerPage` defaults
   to 4,000. Most of what this buys is above that, so if pages are not expected
   to grow, this is headroom rather than a fix.
3. **The cull.** The index can't make that 11 ms smaller, but a slot-keyed
   index is what would make an O(visible) reformulation possible — the
   complement has to be built in shape ids today only because the index can
   only answer in shape ids. That is a separate and bigger change; I'd be
   interested in whether it is one you'd consider.

Things I know are not finished: `RBushIndex` is still in the branch because the
A/B harness runs against it; the cold first bulk load on a small page is about
2× slower than rbush (the loader is more code to get through the interpreter —
it reaches parity around 10,000 shapes and is 1.8× faster at 100,000); and the
api-report needs regenerating, since `SpatialIndexManager` gains four
`@internal` methods.

Two behaviour changes I made on purpose and would want checked: an inverted
bounding box (negative width or height) is now "not indexable" and the shape is
dropped, where `Box.isValid()` accepted it — page bounds can't produce one, but
the guard now lives inside the index where the NaN blackouts this subsystem has
had before can't get past it. And the engine throws on a duplicate insert or an
out-of-range id rather than answering wrongly; those can only fire if the slot
bookkeeping is already broken, but they'd surface from inside a signals
computed.

Happy to cut this down to just the engine swap with no consumer changes if
that's an easier thing to look at.
