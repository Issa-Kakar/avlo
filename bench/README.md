# Spatial index benchmarks: rbush vs FlatRTree

Measurements for replacing rbush behind tldraw's `SpatialIndexManager`.

- **`doc/METHOD.md`** — how the numbers were taken, and the four ways an
  earlier attempt at this produced confident wrong ones. Read this first if you
  intend to disbelieve anything in RESULTS.
- **`doc/RESULTS.md`** — the numbers.
- **`results/*.jsonl`** — every raw measurement, one JSON record per cell.
- **`results/report-*.txt`** — rendered tables.

## Reproducing

```bash
ln -s /path/to/tldraw/node_modules node_modules   # for rbush + esbuild

node bench/verify.mjs --n=4000 --rounds=60        # correctness gate, run first
node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 probe-calib.mjs
node run.mjs           && node report.mjs           # tier 1: raw engine
node run-gesture.mjs   && node report-gesture.mjs   # gestures
node run-wrapper.mjs   && node report-wrapper.mjs   # tier 2: the wrapper
node bench/tiers.mjs                                # update fast-path mix
```

`lib/flatrtree.mjs`, `lib/shapeindex.mjs` and `lib/rbushindex.mjs` are esbuild
bundles of the TypeScript sources, so plain `node` can run them. Regenerate
them after editing the TypeScript — the commands are in `doc/METHOD.md`.
`lib/flatrtree-instr.mjs` is a counting build produced by `make-instr.mjs`; it
is used only by `bench/tiers.mjs` and never by a timed or measured cell.

## The one thing worth knowing about the harness

Every figure is checked three ways before it is reported: the instrument
calibrates against allocations whose size V8 fixes, each window is proven
collection-free by two independent detectors, and each number is a regression
slope across two window sizes so a fixed cost cannot be reported as a per-op
one. A cell that cannot satisfy those prints its failure reason instead of a
number.
