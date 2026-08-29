> ## ⚠️ Read `RECAP.md` first
>
> This branch is a **proof of concept whose design and numbers were both later
> found wrong**. The engine (`FlatRTree.ts`) is sound; the wrapper around it
> (`ShapeSpatialIndex.ts`, `SpatialQuery`, the pooled-query API) should not be
> built on, and the speedups in `RESULTS.md` and `ISSUE-DRAFT.md` are inflated.
>
> `RECAP.md` is the handoff document: §0 says what is wrong, §3 is a verified
> map of tldraw's spatial-index architecture, §5 has the measurements that
> replaced the ones here, and §6 records a real hang bug. `harness/` holds the
> scripts that produced §5.

# FlatRTree in tldraw — proof of concept

A slot-keyed, structure-of-arrays R-tree dropped into tldraw's
`SpatialIndexManager` in place of rbush, with the benchmarks and the correctness
oracle that go with it.

This branch shares no history with anything else in this repository and touches
none of its code. It exists because the work was done in a remote container
against a clone of `tldraw/tldraw`, and the container does not survive.

## What is here

| | |
|---|---|
| `RECAP.md` | **Start here.** What is wrong with this branch, a verified map of tldraw's spatial-index architecture, and the measurements that replaced `RESULTS.md`. |
| `patches/` | The eight commits, as a `git am` series against `tldraw/tldraw` at `cbbcf35`. This is the whole change. |
| `new-files/` | The files that did not exist before, at their tldraw paths — easier to read than a patch. |
| `diffs/` | The changes to files that already existed, which is the part a reviewer actually reads. |
| `RESULTS.md` | Method and measurements. |
| `ISSUE-DRAFT.md` | A draft of the tldraw issue, for adapting rather than sending as-is. |
| `raw/` | Unedited benchmark output (superseded — see `RECAP.md` §5). |
| `harness/` | The measurement scripts behind `RECAP.md` §5.2 and §5.3, plus esbuild bundles so plain `node` can run them. |

Ten commits. `packages/editor` passes 1,202 tests, `packages/tldraw` passes
2,912 across the full 213-file suite, and the parity fuzz passes 10.

## Applying it

```bash
git clone https://github.com/tldraw/tldraw
cd tldraw
git checkout -b flat-rtree-spatial-index cbbcf35
git am /path/to/patches/*.patch
corepack enable && yarn
```

Then, from the repo root:

```bash
# index-level A/B, one process per implementation
yarn tsx internal/scripts/spatial-bench/index.ts --sizes 10000,100000 --datasets board,uniform

# in-app, through the public Editor API
cd packages/tldraw
NODE_OPTIONS="--max-semi-space-size=512" SPATIAL_PERF=1 SPATIAL_PERF_N=20000 \
  yarn vitest run src/test/spatialIndexPerf.test.ts

# correctness: 4,000 random ops against a brute-force scan and against rbush
cd packages/editor
yarn vitest run src/lib/editor/managers/SpatialIndexManager/ShapeSpatialIndex.test.ts
```

The in-app A/B runs the same file against either index by checking the six
touched sources back to `cbbcf35` between runs — see `RESULTS.md` for the exact
list.

## Headline

The index gets 2–240× faster and holds a quarter of the memory. The viewport
cull does not get faster, because on a 20,000-shape page the cull costs ~11 ms
per camera move and 0.008 ms of that is the spatial search. `RESULTS.md` has
the accounting for the other 11 ms.

## The bug worth knowing about

The full tldraw suite caught a hang the targeted suites and the fuzz both
missed, and it is the clearest example of where these two structures differ.

The editor registers the index's `dispose` as a disposable but does not tear
down the index computed with it, so a read after disposal schedules a rebuild
against an index that has just been disposed. rbush tolerated that. The flat
engine did not: `dispose()` released the `Float64Array` that box arguments
travel through, every coordinate then read as `undefined`, and the
ancestor-extension walk — whose exit condition is a containment test — never
terminated against NaN.

The fix was to delete `FlatRTree.dispose()` rather than guard it. `clear()`
already returns every growable buffer to newborn size, so all a terminal
teardown bought was a few KB of fixed scratch, in exchange for a structure that
can be made unusable while something still holds it. Worth carrying back into
the avlo copy: the same `dispose()` is there, and the same walk is what would
spin.

## Before sending anything to tldraw

- Pull requests are turned off on `tldraw/tldraw` as a repository setting. The
  sanctioned route is an issue with a link to a fork branch, which is what
  `ISSUE-DRAFT.md` is written for.
- The `FlatRTree.ts` header is dense with V8 vocabulary — Smi, boxing, tiering,
  monomorphism. That vocabulary is essentially absent from tldraw's own code.
  It is accurate but it will read as alien there; worth trimming to the claims
  that are measured rather than the mechanisms that explain them.
- `RBushIndex.ts` is still present so the A/B harness has a baseline to run
  against. It would go with the change.
