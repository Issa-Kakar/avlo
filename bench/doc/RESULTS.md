# Replacing rbush in tldraw's spatial index: measurements

rbush 3.0.1 (the version `@tldraw/editor` depends on) against FlatRTree, a
mutable structure-of-arrays R-tree. Method, and the four ways an earlier round
of this got fooled, are in `METHOD.md`. Every allocation figure below is an
exact byte count taken in a window proven collection-free, reported as the
slope of allocation against window size so a fixed cost cannot masquerade as a
per-operation one.

Three datasets are reported throughout — **uniform** (rbush's best case),
**clustered** (what a board looks like), **board** (clustered plus frames and
arrows) — because the ratio moves several-fold with data shape, and choosing
the flattering one is how the previous attempt at this went wrong.

Correctness is a gate, not a footnote: brute force, rbush and the tree's own
structural `validate()` agree across 3 datasets × 3 seeds × 60 rounds of mixed
move / resize / remove / reinsert with id reuse.

---

## 1. Raw engine — the headline

No wrapper, no `Set`, no id mapping. rbush is given its best case: element
objects minted outside the measured window and mutated in place, query object
reused, so nothing here charges it for the layer above.

**Allocation per operation, board data, n = 20,000:**

| operation | rbush | FlatRTree | |
|---|---:|---:|---|
| search (192 hits) | 5,231 B | **0.00 B** | — |
| update | 728 B | **0.70 B** | >1000× |
| remove | 430 B | **5.9 B** | 73× |
| insert | 936 B | 222 B | 4.2× |

Flat's search slope is **exactly zero** — the same figure the no-allocation
control measures. Insert is the one place it pays, and 214 of those 222 bytes
are the tree's own typed arrays growing from empty (off-heap), only 6.5 bytes
are managed heap.

The other two datasets agree within a few percent: update 615 B / 622 B for
rbush on uniform / clustered against 0.69 B for flat; remove 430 B against
5.91 B on all three.

**Time per operation, board data, n = 20,000** (minimum of 7 runs):

| operation | rbush | FlatRTree | faster |
|---|---:|---:|---:|
| update | 2,950 ns | 192 ns | **15.4×** |
| remove | 1,780 ns | 138 ns | **12.9×** |
| search (192 hits) | 8,893 ns | 1,862 ns | 4.8× |
| insert | 2,047 ns | 781 ns | 2.6× |

At n = 100,000 the mutation gap widens (update **20.3×**, 4,890 ns → 241 ns)
and search reaches 6.1×.

**Search cost against result size** (board, n = 20,000). rbush's allocation
tracks the number of hits; flat's does not move:

| hits | rbush alloc | flat alloc | rbush time | flat time | faster |
|---:|---:|---:|---:|---:|---:|
| 3 | 328 B | 0.01 B | 1,305 ns | 354 ns | 3.7× |
| 22 | 633 B | 0.00 B | 2,913 ns | 642 ns | 4.5× |
| 192 | 5,231 B | 0.00 B | 8,893 ns | 1,862 ns | 4.8× |
| 1,927 | 62,327 B | 0.00 B | 43,228 ns | 8,634 ns | 5.0× |

**Bulk load, n = 20,000:** rbush 11.14 MB and 11.27 ms; flat 1.635 MB and
3.34 ms — **3.4× faster, 6.8× less allocated**, and none of flat's 1.6 MB is
managed heap, so none of it is GC-visible.

**Memory held by the index**, after a full collection, counting everything each
engine needs in order to answer. For rbush that includes the element objects:
it stores references, not boxes, so one live object per shape is not optional.
Flat's typed arrays are counted too, which a heap-only measurement would have
missed entirely.

| n | rbush | flat | leaner |
|---:|---:|---:|---:|
| 2,000 | 187 B/item | 73 B/item | 2.6× |
| 20,000 | 179 B/item | 53 B/item | **3.4×** |
| 100,000 | 175 B/item | 62 B/item | 2.8× |

A `SpatialElement` costs ~129 bytes retained rather than the 64 an all-integer
probe suggests, because V8 boxes the four float coordinates.

---

## 2. Gestures

A tick is: upsert every selected shape, then run the frame's single viewport
query. One query per frame is measured, not assumed — shipped tldraw does
0.97–1.00 index queries per frame across pan, drag, hover and marquee.

Motion is sustained and directional, reversing every 60 ticks. Board data.

| gesture | rbush alloc/frame | flat | rbush time | flat time | faster |
|---|---:|---:|---:|---:|---:|
| drag 1 of 2,500 | 1.31 KB | ~0 | 0.002 ms | 0.001 ms | 2.4× |
| **drag 2,000 of 2,000** | **1,318 KB** | **~0** | 2.519 ms | 0.217 ms | **11.6×** |
| drag 200 of 20,000 | 122.5 KB | ~0 | 0.275 ms | 0.015 ms | 18.0× |
| **resize 2,000 of 2,000** | **1,329 KB** | **~0** | 2.667 ms | 0.310 ms | 8.6× |
| resize 200 of 20,000 | 126.8 KB | ~0 | 0.331 ms | 0.095 ms | 3.5× |

At 60 fps the 2,000-shape drag has rbush producing **81 MB/s of garbage**, and
takes **15% of a 16.67 ms frame budget** for the index alone. Resize is the
worse case for rbush and the harder one for flat, because scaling changes both
position and extent and breaks the update fast path more often.

### Garbage collection, at production heap settings

Same gesture, three repeat runs, Node's default young generation:

| | rbush | flat |
|---|---:|---:|
| collections | 1,078 – 1,085 (**all scavenges, zero major**) | 14 – 15 |
| total GC time | 331 – 348 ms | 2.0 – 2.1 ms |
| worst single pause | **2.77 / 20.79 / 27.32 ms** | 0.22 / 0.26 / 0.26 ms |

**76× fewer collections and 168× less GC time** are the stable claims. The
worst-pause row is reported as a range on purpose: rbush's tail is long *and
unstable* — the same workload produced 2.8 ms on one run and 27.3 ms on
another, and a fourth run produced a 199 ms scavenge. Flat's tail is tight and
never approaches a third of a millisecond. A scavenge costs in proportion to
what survives it, and rbush's per-frame churn is what it has to copy.

### How much of this is the update fast path

Reported rather than asserted, from a counting build of the engine. A shape in
this dataset is ~220 units wide:

| travel per tick | O(1) path | recalc | relocate | resulting speedup |
|---:|---:|---:|---:|---:|
| 1 unit | 77.5% | 18.0% | 4.5% | 20.2× |
| 4 units | 77.0% | 18.5% | 4.5% | 19.2× |
| 12 units | 75.5% | 17.6% | 6.9% | 18.0× |
| 32 units | 70.1% | 19.2% | 10.7% | 11.7× |
| 96 units | 60.5% | 19.1% | 20.4% | 8.3× |

Three quarters of a realistic drag takes the O(1) path and a quarter does not;
the speedup degrades smoothly as travel grows. It does not depend on parking
every update in the fast tier — which is exactly what a jitter-around-a-point
benchmark does, and why the earlier round of this work reported 240× for a drag
that is really 8–20× depending on how fast the pointer moves.

---

## 3. The wrapper, as the manager drives it

Both sides return a real `Set<TLShapeId>`; the public API does not change.
This tier adds back what tier 1 deliberately excluded: the Set, the id
bookkeeping, and on the rbush side the `SpatialElement` the manager must mint
per upsert because `applyBatch` takes objects.

| scenario | rbush | flat | |
|---|---:|---:|---:|
| drag 2,000 of 2,000 | 1,555,505 B/frame | 169 B | 9,204× |
| drag 200 of 20,000 | 186,104 B/frame | 423 B | 440× |
| search, 1% area | 19,151 B | 12,206 B | 1.6× |
| search, 10% area | 205,294 B | 119,331 B | 1.7× |
| bulk load 20,000 | 16.28 MB | 5.05 MB | 3.2× |

Time: the 2,000-shape drag is **10.8×** (1.518 ms → 0.141 ms), the 200-of-20,000
drag **14.4×**, bulk load **2.2×**. GC over the same drag: 609 collections and
328.8 ms against 6 and 1.2 ms.

**The search rows are the honest caveat.** At this tier search improves only
1.6×, and at 10% area the times are level, because the `Set` both sides must
build dominates everything else — an empty `Set` is 152 bytes and each entry
adds to it. The engine underneath is 4.8× faster and allocates nothing; the
result shape mandated by the API is what hides that. The mutation path has no
such ceiling, which is why it carries the result.

The three tiers are additively consistent — tier 2 equals tier 1 plus the Set
plus the id map, to within a few percent — which is the check that says the
decomposition is real.
