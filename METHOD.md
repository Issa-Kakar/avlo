# How these numbers were measured

Written so the numbers can be attacked. Every claim below is reproducible from
`/home/user/spatial-bench`, and the instrument checks itself on every run.

## The machine

4 vCPU Intel Xeon @ 2.10 GHz, 16 GB, Node 22.22.2, rbush 3.0.1 (the version
`@tldraw/editor` depends on). Runs are serial and the box is otherwise idle;
`uptime` is checked before a run, because an earlier round of this work was
measured while background jobs were saturating the CPU.

## Measuring allocation exactly

Allocation is the delta in V8's `used_heap_size` (plus `arrayBuffers`, see
below) across a window in which **no garbage collection ran**. Inside such a
window the delta is exactly the bytes allocated: nothing was reclaimed, so it
is a count, not an estimate.

Keeping the window collection-free is the easy half. Proving it was is the half
that matters, and the obvious way to do it is wrong:

- **`PerformanceObserver({entryTypes:['gc']})` delivers its callback two
  macrotask turns after the collection.** Reading its counter straight after a
  synchronous loop reads a stale value and will certify a window that collected
  six times. Measured on this Node: `global.gc()` twice, then the counter still
  reads 0 after the first `setImmediate` and only reaches 2 after the second.
  The instrument therefore spins `setImmediate` until the count has held still
  for three consecutive turns before reading it.
- A second, synchronous detector runs alongside: `used_heap_size` is sampled at
  sixteen checkpoints inside the loop and must never fall. A collection shows up
  immediately as a drop.
- The window is also sized to allocate far under the semi-space
  (`--min-semi-space-size=256 --max-semi-space-size=256`), so a scavenge should
  be impossible by construction rather than by luck. `--min` matters as much as
  `--max`: V8 grows the young generation adaptively, so early in a process the
  semi-space is still small and a large window collects anyway.

A window that fails either detector is discarded, not reported.

## Separating per-op cost from fixed cost

A single window cannot tell the two apart. A gesture tick that allocates nothing
still reports a few hundred bytes per tick, because the window carries a
one-time cost — compiling the closure, first-touching a buffer — and dividing it
by the tick count hands it back as though it were per-tick.

The giveaway is that windows of `n` and `3n` report values in an exact 3:1
ratio: identical totals, three times the divisor. That is precisely what the
gesture cells did.

So every figure is a **slope**: measure at two window sizes, solve
`total(n) = fixed + perOp × n`, and report `perOp`. The intercept is reported
too, so a large fixed cost cannot hide inside a result.

Stateful operations are the exception. `insert` builds a bigger tree as it runs,
so its per-op cost genuinely varies with how many have run and a slope would be
meaningless; those report a single window, repeated to stability.

## Reaching steady state

V8 tiers a function up whenever it decides to, and the optimized code object it
allocates lands in whichever window happens to be running. On the mutation ops
this showed as window 1 reading 62 B/op and window 2 reading 5.8 — a compile,
not a cost. Every window is therefore repeated until two consecutive runs agree,
and the number of windows it took is recorded.

## Counting memory that is not on the heap

`used_heap_size` does **not** include ArrayBuffer backing stores, and a
structure-of-arrays index is almost entirely backing store. Counting only the
managed heap would flatter the flat tree enormously and hide its pool growth
completely. Both are measured and both are reported, split.

## Calibration, printed with every run

The instrument is checked against allocations whose size V8 fixes, not us:

| probe | expected | measured |
|---|---|---|
| `new Array(1000).fill(0)` | ~8048 B | 8055.8 B |
| `new Array(100).fill(0)` | ~848 B | 850.6 B |
| `[]` | — | 32.0 B |
| `new Set()` | — | 152.1 B |
| `{minX,minY,maxX,maxY,id}` | — | 63.9 B (integers) |
| no allocation at all | 0 | 0.00 B |

The last row is the one that matters most: the driver loop itself must measure
zero, or every "allocates nothing" claim is just the harness.

Two calibration findings are load-bearing later:

- **An empty `Set` costs 152 bytes.** That is the floor under any search that
  has to return one, on either engine.
- **A `SpatialElement` costs 64 bytes with integer coordinates but ~129 with
  float ones**, because V8 boxes the doubles. Real page bounds are floats, so
  the shipped structure costs about twice what a naive probe suggests.

## Fairness rules held throughout

- **One engine per process.** Two implementations behind one interface in one
  process makes every call site megamorphic and measures the dispatch.
- **Identical work, identical order.** Both engines are driven from the same
  seeded data through the same permutation, and the driver consumes results the
  same way on both sides.
- **rbush is given its best case.** Element objects are minted outside the
  measured window and mutated in place; the query object is reused. Nothing here
  charges rbush for the layer above it.
- **The accumulator stays inside int32.** An accumulator that leaves smi range
  mints a 16-byte HeapNumber per iteration, which then shows up as the engine's
  allocation. That artifact alone accounted for the whole of the flat tree's
  apparent search cost in an earlier draft.
- **Parity is a gate, not a footnote.** A three-oracle harness (brute force,
  rbush, and the tree's own structural `validate()`) runs the same mixed
  move/resize/remove/reinsert workload with id reuse across three datasets and
  three seeds. A speed number from a tree that answers wrongly is worth nothing.

## Datasets, reported side by side

Not one dataset, because the ratio moves several-fold with data shape and
picking the flattering one is how the earlier round of this work went wrong.

- **uniform** — the classic benchmark distribution and rbush's best case: no
  clustering for a bulk loader to exploit, no size spread.
- **clustered** — what a whiteboard actually looks like. People work in pockets
  and the page is mostly empty.
- **board** — clustered, plus the two things a real tldraw page has that break
  uniformity: frames (huge, overlapping) and arrows (long, thin, high aspect).

## Gestures

A tick is: upsert every selected shape, then run the frame's single viewport
query. One query per frame is not an assumption — it was measured on shipped
tldraw at 0.97–1.00 queries per frame across pan, drag, hover and marquee.

Motion is **sustained and directional**, reversing every 60 ticks so the
selection stays on screen. This is the correction that matters most: nudging
shapes a few percent of their width around a fixed point parks every update in
the tree's O(1) tier and produces a speedup several times larger than a real
drag ever sees. Travel per tick is swept, and the fast-path mix it produces is
reported alongside — measured with a counting build of the engine, not asserted.
