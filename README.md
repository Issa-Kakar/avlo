# Replacing rbush in tldraw's spatial index

A flat, structure-of-arrays R-tree behind `SpatialIndexManager` in place of
rbush, with the measurements and the correctness oracle that go with it.

This branch shares no history with anything else in this repository and touches
none of its code. It exists because the work was done in a remote container
against a clone of `tldraw/tldraw`, and the container does not survive.

## Read in this order

| | |
|---|---|
| **`RESULTS.md`** | The numbers. Three tiers — raw engine, gestures, and the wrapper as the manager drives it — across three datasets. |
| **`VS-RBUSH.md`** | What is actually different from rbush, mechanism by mechanism, with every rbush-side claim referenced into its `index.js`. Read this if the question is "why would this be faster". |
| **`METHOD.md`** | How they were measured, and the four ways an earlier attempt produced confident wrong ones. Read this if you intend to disbelieve anything in RESULTS. |
| `patches/` | The change as a `git am` series against `tldraw/tldraw` at `cbbcf357`. One commit. |
| `new-files/` | The three new files, at their tldraw paths. |
| `diffs/` | The two modified files plus the `package.json` change. |
| `bench/` | The benchmark harness and every raw measurement. |
| `superseded/` | An earlier attempt, kept only so nobody re-derives its numbers. See below. |
| `RECAP.md` | Handoff notes from the session that produced `superseded/`, including a verified map of tldraw's spatial-index architecture that is still accurate. |

## The change

Three new files, two modified, one deleted. **No consumer changes**:
`getShapeIdsInsideBounds` and `getShapeIdsAtPoint` keep their signatures and
keep returning `Set<TLShapeId>`, and the public API report does not move.
`rbush` moves from `dependencies` to `devDependencies`, where it remains as the
oracle the parity test checks against.

Headline, from a 2000-shape 60-tick drag at production heap settings:

| | rbush | this |
|---|---:|---:|
| allocation per frame | 1,318 KB | ~0 |
| at 60 fps | 81 MB/s | ~0 |
| collections | 1,078–1,085 | 14–15 |
| total GC time | 331–348 ms | 2.0–2.1 ms |
| worst single pause | 2.8–27.3 ms | 0.22–0.26 ms |
| index time per frame | 2.52 ms | 0.22 ms |

Verified: `packages/editor` 1,202 tests pass, `packages/tldraw` 2,912 pass,
types build, oxlint clean.

## Applying it

```bash
git clone https://github.com/tldraw/tldraw && cd tldraw
git checkout cbbcf357
git am /path/to/patches/*.patch
yarn && yarn build-types
cd packages/editor && yarn run -T vitest run
```

## About `superseded/`

An earlier round of this work reached the same engine through a worse design
and measured it badly. Both problems were structural, and both are fixed here:

- **The design exposed machinery it never should have** — a pooled query
  object, generation stamps, acquire/release, and four new package exports,
  pushed onto consumers. None of it was necessary. The index returns a plain
  `Set` and everything else is private.
- **The numbers were inflated by workload choice**, and a GC comparison counted
  process setup rather than the measured loop. A drag reported at 240× is
  8–20× depending on how fast the pointer moves; that whole curve is now
  reported rather than one point on it.

`superseded/` is kept so those numbers can be recognised and discarded if they
turn up somewhere. Do not quote them.
