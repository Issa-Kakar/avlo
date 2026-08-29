# What is actually different from rbush

For a reader who trusts rbush — reasonably; it is stable, widely deployed, and
correct — and wants to know what a replacement changes and why any of it should
be believed. Every claim about rbush below is against **rbush 3.0.1**, the
version `@tldraw/editor` depends on, with line references into its `index.js`.

Both structures are R-trees. Same family, same query semantics, same inclusive
intersection test, same answers. The differences are in memory layout, in what
each operation has to *find* before it can act, and in two heuristics.

---

## 1. Layout: heap objects versus flat arrays

rbush is a tree of JavaScript objects. Each node is
`{children, height, leaf, minX, minY, maxX, maxY}`, and each leaf child is the
caller's own item object. Traversal is pointer chasing, and every box read is a
property load on a separate heap object.

This one keeps the whole tree in three flat arrays:

```
cell            = (node << 4) | pos           an entry's address
_boxes[cell<<2] = [minX, minY, maxX, maxY]    every box in ONE Float64Array
_refs[cell]     = leaf:     item id
                  internal: child | count<<24 | leaf<<29
_cellOf[id]     = the cell holding item `id`; 0 means absent
```

Two consequences do most of the work.

**Entry boxes live in the parent**, B-tree style, so scanning a node's entries
is one contiguous run of `Float64Array` reads rather than sixteen pointer
dereferences to sixteen separate objects.

**A child's entry count and leafness ride in the parent's ref word.** A word
popped off the traversal stack fully describes the node it points at, so a
search never loads per-node metadata, and dumping a fully-covered subtree
touches `_refs` only — it never reads a box it has already proven it doesn't
need.

There is also a sentinel: **cell 0 is the root's own parent entry**. `_refs[0]`
is the annotated root word and `_boxes[0..3]` is the root MBR. An empty tree
holds `[+Inf, +Inf, -Inf, -Inf]` there. That single trick removes empty-tree
branching from the entire structure — the same four-compare reject that opens
every search also answers "is the tree empty", the same union-write that
extends any ancestor also seeds the very first root MBR, and because
`_parentCell[0]` is itself 0, the ancestor-extension walk terminates by
revisiting cell 0 and finding the box contained. No root check anywhere in the
hot loop.

---

## 2. Remove: rbush has to go looking

This is the largest structural difference, and it is not tuning.

rbush stores no map from item to location, so `remove(item)` performs a
depth-first descent from the root into **every subtree whose bbox contains the
item's bbox** until a leaf-level linear scan finds it by reference identity
(`index.js:113-150`). On overlapping data — a whiteboard with frames — that is
many subtrees. Before it starts it allocates two arrays, `path` and `indexes`,
unconditionally. Having found the item it `splice`s it out of the leaf's
children array and calls `_condense(path)`, which walks back up and can splice
further.

Here, `_cellOf[id]` *is* the location. Remove reads it, swap-removes the entry,
and then does one of two things: if the removed box was strictly interior to
its leaf's MBR it defines no face of that MBR, so nothing above can have
changed and the operation ends — genuinely O(1), no walk at all. Otherwise it
recomputes exact MBRs bottom-up with an early exit on the first unchanged
level, which usually fires immediately.

> Measured: 430 B and 1,780 ns per remove, against 5.9 B and 138 ns.

## 3. Update: rbush does not have one

Moving a shape in rbush is `remove` then `insert` — the full descent above,
plus a fresh `insertPath` array, plus any split the reinsertion triggers. Every
frame of every drag, for every selected shape.

Here `update` is a first-class operation with three tiers:

1. the old box is strictly interior to its leaf's parent entry and the new box
   still fits inside it → **four stores, no scan, no walk**;
2. the new box still intersects the union of the leaf's *other* entries → write
   in place, then recompute exact MBRs bottom-up with an early exit;
3. only a genuine cluster exit relocates, and only then does it look like
   rbush's remove-plus-insert.

On a realistic drag (a shape ~220 units wide moving 12 units per frame) the mix
is 75.5% tier 1, 17.6% tier 2, 6.9% relocate. Push the pointer to 96 units per
frame and it degrades smoothly to 60.5 / 19.1 / 20.4. The full curve is in
`RESULTS.md`, measured with a counting build of the engine, because a fast path
whose hit rate is asserted rather than reported is not evidence.

> Measured: 728 B and 2,950 ns per update, against 0.70 B and 192 ns.

## 4. Search: what gets allocated before anything is found

rbush's `search` allocates `result = []` and `nodesToSearch = []` on entry
(`index.js:17,22`), before the root intersection test has even run, then grows
`result` by doubling as hits accumulate and returns an array of references to
the caller's item objects. tldraw then maps that array to ids and builds a Set,
so the array and every reference in it are garbage the moment the Set exists.

Here, searches fill a reused `Uint32Array` of item slots and return a count.
Results capacity is maintained to be at least the tree size at *mutation* time,
so a search body never grows, never reallocates, and never touches the
allocator. The wrapper then fills the `Set` directly from that buffer — no
intermediate array, and no `.map()`.

> Measured: 5,231 B per search returning 192 hits, against 0.00 B. rbush's
> allocation scales with hits — 328 B at 3, 62,327 B at 1,927 — and this one
> does not move.

## 5. Bulk load: what gets moved

Both use OMT (Overlap Minimizing Top-down), which needs each level cut into
exact-count chunks. rbush does this with `quickselect` over the item array
itself, co-swapping 36-byte `(box, id)` records with data-dependent branches,
and `_build` calls `items.slice(left, right + 1)` for **every node it creates**
(`index.js:189`), plus `data.slice()` for the whole input up front
(`index.js:74`).

Here the payload never moves. The engine partitions 8-byte *proxy* records —
parallel `(key, index)` `Int32Array` lanes — with an MSD radix multi-partition
that establishes all of a level's boundaries in the same histogram and scatter
passes, and never re-touches a bucket containing no boundary. Leaves gather
boxes and ids by original index at the end. Because nothing moves, `load` reads
typed inputs in place: no defensive copy, no per-item transient, and it neither
mutates nor retains what it is given.

The keys are order-preserving signed-int32 transforms of the high word of
`min + max` — the box **centre's** order. That matters on a whiteboard: slicing
by `minX` cuts a long arrow by where its left end happens to be, while slicing
by centre cuts it by where its mass is.

> Measured: 11.14 MB and 11.27 ms per load of 20,000, against 1.635 MB and
> 3.34 ms — and none of the 1.635 MB is managed heap.

## 6. Split heuristic: rbush only ever sorts by the lower coordinate

rbush chooses its split index by sorting node entries on `minX` and `minY` only
— an artifact of the era when sorting JavaScript objects was the dominant cost
of a split. With typed-array scratch the sorts are cheap enough to afford the
upper-coordinate orders too, and on boards full of elongated items they change
the answer: a distribution sliced by `minX` pins a long arrow to whichever
group holds its left *end*; a slice by `maxX` can put it where its mass is.

So `_split` scores **eight** candidates — `k ∈ [7,10]` over both the min and
max orders of the winning axis — by minimum overlap, tie-broken on minimum
area. Axis choice stays rbush's minimum-margin rule. Cost stays at rbush levels
through three structural moves, all in the source: the snapshot pass fans each
coordinate into contiguous per-axis key streams so sorts touch packed f64 keys
rather than strided boxes; the prefix/suffix tables are reduced to the `k`
window actually read; and the max order is seeded from the min order, so its
insertion sort pays only for inversions, which for interval keys are
containment pairs and therefore rare.

> Measured: max-order distributions win ~30% of organic splits and cut
> leaves-touched-per-probe by ~20%.

## 7. A real defect in rbush's subtree choice

`_chooseSubtree` picks the child with least area enlargement, tie-broken on
smallest area. rbush's tie-break is wrong (`index.js:277-292`):

```js
if (enlargement < minEnlargement) {
    minEnlargement = enlargement;
    minArea = area < minArea ? area : minArea;   // keeps a LOSING entry's area
    targetNode = child;
}
```

When an entry wins outright on enlargement, rbush sets `minArea` to the
*minimum* of that entry's area and whatever it was — which may belong to an
entry that just lost. A later, legitimate tie on enlargement then compares its
area against that stale smaller value and loses, so the tie-break silently
fails to select the smallest-area child.

The equivalent here is a single combined test in which a strict win resets the
tie-break area, which is what the rule says it should do.

This affects tree *quality*, not the correctness of any answer — rbush returns
the right results either way. It is worth naming only because it is the kind of
thing that is invisible unless someone reads the code line by line.

## 8. Things that were tried and rejected on measurement

Both of these are standard R-tree literature, both were implemented here, and
both were removed because they cost more than they returned on this data:

- **Condense-on-delete** (dissolve leaves below `M >> 2`, reinsert survivors).
  Taxed clustered mass-removal by ×1.4–1.6 while buying ≤6% on post-deletion
  searches. It only defers a rebuild. Underfull nodes are tolerated until
  `rebuild()` instead — which is what rbush does too.
- **R\*'s overlap-refined subtree choice at the leaf level.** +36–47% insert
  cost for ~5% on probes and culls, even after a provable zero-enlargement
  skip, branchless clamps and a monotone early exit. On board-shaped data it
  actively herds inserts into large sloppy leaves, because their marginal
  overlap is already ~0.

Neither should be re-added without new numbers. They are recorded here because
what a structure *declined* to do, and why, says more about whether it was
measured than what it does.

## 9. Fanout and MBR discipline

rbush defaults to `M = 9` with 40% minimum fill. This is `M = 16`, fixed, which
is what lets an entry address pack as `(node << 4) | pos`.

The MBR invariant is stronger here: every internal entry box **equals** the
exact union of its children's boxes, and `validate()` asserts equality rather
than containment. Inserts extend ancestors by the inserted box; splits write
exact group MBRs; remove and update either prove in O(1) that nothing above
changed, or recompute exactly bottom-up. Exactness is not decoration — it is
precisely what licenses the O(1) tiers, because "this box is strictly interior
to its parent entry" is only a valid proof that nothing above changes if the
parent entry is exact.

---

## 10. Why this is unusually cheap to verify

A spatial index has a total, cheaply checkable contract: for any query
rectangle, the answer is exactly the set of items whose box intersects it. You
can compute that by brute force in four comparisons per item, for any tree
state, after any sequence of operations. There is no hidden state to reason
about and no invariant a reviewer has to take on trust.

So the parity gate is not a sample of plausible cases — it is the contract
itself, checked exhaustively:

- three oracles, not two: brute force is ground truth, rbush is the incumbent,
  and `validate()` checks the structural invariants a query cannot observe
  (exact MBRs, parent/child agreement, the cell map, the free lists);
- three datasets (uniform, clustered, board-shaped with frames and arrows) ×
  three seeds × sixty rounds of mixed move, resize, remove and reinsert, with
  ids reused the way undo replays them;
- degenerate probes included: zero-area boxes on all four edges, a rect
  covering everything, a rect covering nothing;
- and the tree is re-validated structurally after every round, not just at the
  end.

That gate has already earned its keep twice: it caught a slot-recycling bug
that leaked stale membership into a query result, and later a duplicate-id bug
in the benchmark harness itself.

The honest summary of the risk: swapping a spatial index is one of the few
data-structure replacements where "it returns the same answers" is a statement
you can actually finish proving.
