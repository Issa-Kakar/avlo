# Session 2 handoff — the rebuilt change and how it was measured

Supersedes the design and all numbers in `RECAP.md`. That file's §3 (verified
map of tldraw's spatial architecture), §6 (bugs), §7 (repo conventions) and §8
(contribution route) are still accurate and still worth reading. Its §4, §5 and
§10 are done.

## State

- **`/home/user/tldraw`**, branch **`flat-rtree-v2`**, one commit `cb02ada8` on
  top of `cbbcf357`. Working tree clean. Types build, oxlint clean,
  editor 1202/1202, tldraw 2912/0 in 200 s.
- **`/home/user/spatial-bench`** — the benchmark harness, its own git repo.
- **`github.com/issakakar/avlo` branch `tldraw-flat-rtree`** — everything
  published: patch, new files, diffs, harness, RESULTS.md, METHOD.md, and the
  old attempt under `superseded/`.

## The change

Five files. `FlatRTree.ts` (new, the engine), `ShapeSpatialIndex.ts` (new, 231
lines, the id-to-slot mapping — replaces `RBushIndex`), its test (new),
`SpatialIndexManager.ts` (modified), `spatialIndex.test.ts` (modified, one spy
on a renamed private field), `RBushIndex.ts` (deleted). `rbush` moved to
devDependencies.

No consumer changes. Both query methods keep their signatures and return
`Set<TLShapeId>`. The api-report does not move.

## What to know about the measurements

Read `/home/user/spatial-bench/doc/METHOD.md` before touching the harness. The
four instrument faults it documents are the reason the previous session's
numbers were wrong, and three of them will silently recur in any new harness:

1. **`PerformanceObserver` GC events arrive two macrotask turns late.** One
   `setImmediate` is not enough; the counter will certify a window that
   collected a thousand times as clean.
2. **A fixed per-window cost divided by window size looks exactly like a per-op
   cost.** The tell is windows of n and 3n reporting a 3:1 ratio. Every figure
   is now a regression slope.
3. **V8 tiers functions up mid-window**, so the first window of a body reads
   several times the second. Windows repeat until two consecutive agree.
4. **An accumulator that leaves smi range mints a HeapNumber per iteration** and
   shows up as the engine's allocation.

Also: `used_heap_size` excludes ArrayBuffer backing stores, so a heap-only
measurement flatters a structure-of-arrays index enormously. Both are counted.

## Numbers that are safe to quote

All in `doc/RESULTS.md`. The load-bearing ones:

- Raw engine, board data, n=20,000: search 5,231 B → **0**, update 728 B →
  **0.70 B**, remove 430 B → 5.9 B, insert 936 B → 222 B. Time: update 15.4×,
  remove 12.9×, search 4.8×, insert 2.6×, bulk load 3.4×.
- 2000-shape 60-tick drag: 1,318 KB/frame → ~0; **81 MB/s at 60 fps**;
  1,078–1,085 collections → 14–15; 331–348 ms GC → 2.0–2.1 ms.
- Worst pause is reported as a RANGE because rbush's is unstable: 2.8, 20.8 and
  27.3 ms on three identical runs (and one 199 ms observation). Flat: 0.22–0.26.
  Zero major collections in any run — these are all scavenges.
- Memory: 179 B/item → 53 B/item at n=20,000, counting rbush's element objects
  (it stores references, not boxes) and flat's off-heap arrays.
- Update fast-path mix at 12 units/tick (shape ~220 wide): 75.5% O(1), 17.6%
  recalc, 6.9% relocate. Speedup falls 20× → 8× as travel goes 1 → 96 units.

## One caveat to keep in the pitch

At the wrapper tier, search improves only **1.6×** and at 10% area the times are
level, because the `Set<TLShapeId>` both sides must build dominates (an empty
Set is 152 bytes). The engine underneath is 4.8× faster and allocates nothing;
the mandated result shape hides it. The mutation path has no such ceiling, which
is why it carries the argument. Do not lead with search.

## Left to do

1. Write the tldraw issue. Lead with the gesture allocation and GC table, per
   `RECAP.md` §8 — issue plus a link to this fork branch is the only sanctioned
   route; pull requests are off repo-wide.
2. Consider whether to offer `SnapManager.getSnappableShapes()` as a follow-up:
   `RECAP.md` §3.8 measured it O(page × selection) with an `Array.includes` in
   the inner loop, and it recomputes during drags. It is the largest remaining
   unindexed cost and a separate, smaller contribution.
3. The avlo copy of `FlatRTree.ts` still has the `dispose()` that hangs — see
   `RECAP.md` §6.1. Latent because the singleton never disposes, but real.

## Commit-message note

The tldraw commit deliberately carries no AI attribution trailer: tldraw's
`AGENTS.md` forbids it, and that patch series is meant to be read by their
maintainers. Commits in this repository keep the trailer.
