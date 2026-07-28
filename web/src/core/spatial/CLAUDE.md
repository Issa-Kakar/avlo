# Spatial System

Hit testing and region queries for every object on the canvas. Answers "what's
under the cursor?", "what's inside this marquee?", "what can this connector
endpoint snap to?". rbush items ARE `ObjectHandle`s — the handle carries the
four envelope fields (`minX/minY/maxX/maxY` mirroring `bbox[0..3]`) that rbush
reads, so queries return handles directly. No `IndexEntry` indirection, no
`getHandle(e.id)` lookup post-query.

> Architectural overview, not a changelog. Match surrounding detail when updating.

---

## File Map

```
web/src/core/spatial/
├── object-spatial-index.ts  — RBush wrapper, tuple-first             (~70 LOC)
├── hit-dispatch.ts          — Per-kind hit fns + switch dispatchers (~250 LOC)
├── object-query.ts          — Picker facade: 4 exports, no options  (~230 LOC)
├── handle-hit.ts            — Resize handles + endpoint dots        (~140 LOC)
├── index.ts                 — Barrel; re-exports `ObjectSpatialIndex` only
├── flat-rtree.ts            — FlatRTree: mutable SoA R-tree — UNWIRED (~1420 LOC)
└── flat-rtree.selftest.ts   — Its standalone test+bench runner      (~1140 LOC)
```

**`flat-rtree.ts` is a standalone, not-yet-wired rbush replacement candidate**
— a mutable Structure-of-Arrays R-tree (typed-array node pool with
parent-embedded entry boxes, id→leaf reverse map keyed by dense u32 ids =
`handle.slot`, tiered in-place `update()`, exact-MBR invariant licensing O(1)
update/remove fast tiers, OMT bulk load over a Floyd–Rivest co-swapping
selector). Nothing imports it; the live index is still the rbush wrapper
above. Premise and design rationale live in its introducing commit
(`feat(spatial): FlatRTree …`) and the two file headers; the independent
second-pass review (its planned follow-up) is DONE — hardened trust boundary
(id/int32-overflow/batch-duplicate guards), branchless query compaction, and
the fast tiers all landed evidence-first. Proof: 18.6k-check suite — three
de-correlated oracles (brute-mirror queries + rbush parity, per-item readBBox
sweep, structural validate()) across adversarial/degenerate/guard suites,
maxEntries {4,8,32,64}. A/B vs rbush@4 (p50): 1.4–10× across ops at 10k–100k;
at 1M — load 7.7×, queries 4–10.7×, ~half the memory. Pending: the separately
planned integration. The selftest runs via esbuild+node (command in its
header), not in the app bundle.

`hit-dispatch.ts` exposes three switch dispatchers (`hitPointFor` /
`hitRectFor` / `hitCircleFor`) over eight named, monomorphic per-kind
functions. Image + code share the tight-framed body (reads handle
envelope mirrors directly — no `getFrame` call, no FrameTuple alloc).
Stroke / connector / shape have bespoke geometry-aware bodies; text /
note / bookmark close over their frame resolver via small inline helpers.

---

## Pipeline

```
Call site → object-query.ts facade
              ├─ resolveRadius        ({px} ÷ scale | {world} passthrough)
              ├─ regionEnvelope       (rect or point-r → bbox)
              ├─ spatialIndex.queryBBox/queryRadius   (rbush returns ObjectHandle[])
              ├─ collectHits          (kind prefilter, hitPointFor switch — no Map.get)
              ├─ sortTopFirst         (ULID desc, in-place)
              └─ picker walk          (tournament | kind-match | accept+memo)
                       ↓
        ObjectHandle | string | T | null    (no intermediate array escapes)
```

Call sites never materialize a `HitCandidate[]`, never `.map(h => h.id)`, never
allocate a `Set` per call, never pass option bags.

---

## Public API

### `object-query.ts` — four exports

| Export | Returns | Used by |
|---|---|---|
| `queryHandleIds(region)` | `string[]` | `SelectTool` marquee, `EraserTool` sweep |
| `pickTopmostPaint(at, radius)` | `ObjectHandle \| null` | `SelectTool` click |
| `pickTopmostOfKind(at, radius, kind)` | `string \| null` | `TextTool` / `CodeTool` double-click |
| `pickTopmostBindable(at, radius, accept)` | `T \| null` | `connectors/snap` |

```ts
type Radius = { px: number } | { world: number };
type Region = { kind: 'point'; p: Point; r: number }
            | { kind: 'rect';  bbox: BBoxTuple };
const atPoint = (p, radius): Region;
const inBBox  = (bbox):       Region;
```

`Radius` is tagged: `{ px }` is screen-space (divided by camera scale at resolve
time); `{ world }` passes through. Selection/eraser tolerance uses `{ px }` (feels
constant on screen); connector snap uses `{ world }` (stable shape-widths at any
zoom). **No call site does its own `/scale`.** `resolveRadius` is the single
source of truth and is also imported by `handle-hit.ts`.

**Lock filtering.** `collectHits` takes two nullable columns — `lo` (ephemeral
`getLockOwners()`, skip `> 1`) and `lf` (durable `getLockedFlags()`, skip `=== 1`).
Per picker: `pickTopmostPaint` → `(lo, null)` (durably-locked stays click-selectable),
`pickTopmostOfKind` → `(lo, lf)` (create-over, never edit-into), `pickTopmostBindable`
→ `(null, null)` (snap-attach never mutates the target). `queryHandleIds` checks both
inline — one place removes locked objects from marquee AND eraser.

### `handle-hit.ts` — non-spatial sibling

Resize handles + endpoint dots don't live in rbush; they're derived from
selection state. Same `Radius` vocabulary, no spatial index, no paint logic.

```ts
hitResizeHandle(at, bbox) → HandleId | null    // inline 4-corner + 4-edge test
hitEndpointDot(at, selectedIds) → EndpointHit | null   // unrolled 2-slot loop
shouldShowHandles(bbox, scale?)                // visibility/hit gate
```

Corner positions for rendering come from `computeHandles(bbox)` in
`core/types/handles.ts` (module-scope scratch). Constants: `HANDLE_HIT_PX = 10`,
`ENDPOINT_DOT_HIT_PX = 10`, `HANDLE_MIN_BBOX_PX = 12` (corner stamps physically
meet below this).

### Raw `queryBBox` — three consumers bypass the facade

They want `ObjectHandle[]` directly (the rbush item shape) and own their own kind
filtering / dedup:

- `renderer/layers/objects.ts` — viewport cull (500+ handles per frame; reads
  `e.minX/maxX/...` + `e.id/kind` directly off each handle)
- `core/image/image-manager.ts` — viewport decode/evict (image+bookmark only;
  reads `e.minX/maxX/...` for asset marking)
- `core/clipboard/clipboard-actions.ts` — smart-duplicate collision probe
  (reads `r.id` for exclude filtering)

**Don't wrap these behind a facade function for uniformity.** They don't need it.

---

## Paint classification (`hit-dispatch.ts`)

```ts
type Paint = 'ink' | 'fill' | 'seethrough';
hitPointFor(h, p, r) → Paint | null     // null = geometric miss
```

| Paint | Meaning | Source |
|---|---|---|
| `'ink'` | Solid paint; blocks pickers below | All strokes/connectors, filled-shape edges, every framed kind |
| `'fill'` | Filled shape interior; participates in area tournament | Shape with `fillColor` set |
| `'seethrough'` | Unfilled shape interior; transparent to clicks | Shape without `fillColor` |

### Invariants the pickers rely on

1. **Framed kinds (text/code/note/image/bookmark) always return `'ink'` on hit.**
   No glyph-level testing — the whole frame paints. This is why
   `pickTopmostOfKind` skips see-through fallback tracking (would be dead code).
2. **Strokes and connectors are always `'ink'` on hit.** Never see-through.
3. **Only shapes produce `'fill'` / `'seethrough'`.** `shapeArea` (inline
   `f[2]*f[3]`) is only called when `paint ∈ {fill, seethrough}`, so frames of
   non-shape bindables are never read for area.
4. **Tight-bbox fast path.** For kinds whose stored rbush bbox equals their
   tight frame (currently image and code), `hitRectFor` returns `true`
   unconditionally — the envelope filter that produced the candidate IS the
   precision rect check, so a redundant `bboxesIntersect` (and the Y.Map.get
   inside the frame resolver) is skipped. Tight-framed `hitPointFor` and
   `hitCircleFor` read `handle.minX/maxX/minY/maxY` directly (no `getFrame` /
   `getCodeFrame` call, no FrameTuple alloc). Kinds with stored padding —
   text (italic overhang + 2px vert), note/bookmark (shadow), shape (stroke +
   ellipse/diamond geometry) — keep a real switch arm that filters out
   marquees touching only the padding zone.

### Frame resolution (per kind)

| Kind | Frame source |
|---|---|
| text, note | `getTextFrame(id)` from `core/text/text-system` (padded — runs precision pass) |
| bookmark | `getBookmarkFrame(id)` from `core/bookmark/bookmark-render` (padded) |
| shape | `getFrame(h.y)` (stored) — shape-aware geometry, not a generic rect pass |
| image, code | envelope mirrors (`handle.minX/maxX/minY/maxY`) — stored bbox === frame, zero padding |

`null` from a frame getter ("not yet laid out") propagates to `hitPoint` →
`null` → picker skips. Code that needs the frame of any bindable handle outside
hit testing uses `frameOf` from `core/geometry/frame-of.ts` (not a spatial
concern — but it IS used inside `snap`'s accept callback, which is the consumer's
choice, not the picker's).

### Bindable kind set

`BINDABLE_KINDS` is exported from `core/types/objects.ts` and wrapped into a
module-private `BINDABLE_KINDS_SET` by `object-query.ts` **once at module
import** — never per-call `new Set`.

---

## Picker semantics

- **`pickTopmostPaint`** (frame-aware tournament) — Topmost `'ink'` wins outright
  (short-circuits before any area math, the overwhelming majority of clicks).
  Otherwise compare `firstPaint=fill` shape area vs accumulated see-through
  frames above it; smaller wins, ties go to higher Z. If nothing paints, smallest
  see-through frame wins.
- **`pickTopmostOfKind`** — Walk top-first; skip `'seethrough'`; first ink hit
  either matches `kind` (return id) or blocks (return null). No fallback —
  target is always framed → always `'ink'`.
- **`pickTopmostBindable`** — Walk top-first over `BINDABLE_KINDS_SET`. On
  see-through: call `accept`, memoize smallest-area accept result, continue. On
  ink/fill: call `accept`; non-null returns immediately, null returns the
  memoized fallback (handles "nested unfilled rects above a filled rect").

The three walks live inline (~60 LOC total) — they share `collectHits` +
`sortTopFirst` setup, but each terminal condition is genuinely different.
Don't combinator-ize.

Z-order: ULID descending. ULIDs are time-ordered, so later-created objects win
ties. The picker has no opinion about input state — Ctrl-to-suppress-snap lives
in the calling tool, not here.

---

## `ObjectSpatialIndex` (rbush subclass)

```ts
class ObjectSpatialIndex extends RBush<ObjectHandle> {
  // Inherited from RBush<ObjectHandle>:
  insert(handle)            // rbush reads handle.minX/.../maxY
  remove(handle)            // identity match via default === comparator (no comparator fn)
  load(handles)             // bulk load
  clear()
  search(envelope) → ObjectHandle[]
  all()             → ObjectHandle[]

  // Tuple-first conveniences:
  queryBBox(bbox)    → ObjectHandle[]
  queryRadius(x,y,r) → ObjectHandle[]   // axis-aligned-square envelope
  updateHandleBBox(handle, newBBox)     // remove → applyHandleBBox → insert
}
```

The handle IS the rbush item — `minX/minY/maxX/maxY` mirror `bbox[0..3]` and
are kept in sync by `applyHandleBBox` (the only legal post-creation bbox
mutator). Removals use the default `===` comparator — V8 inlines it to a
single pointer compare per leaf check.

A single instance-scoped scratch bbox is reused across every query — rbush reads
the fields immediately and doesn't hold a reference, so mutation is safe.
Envelope queries are intentionally coarse; tight intersection is the capability
layer's job.

**Lifecycle.** Owned by `RoomDocManager` (`spatialIndex` field, non-null from
construction). Hydrated via inherited `load(handles)` on room join, maintained
per-object via `insert(handle)` / `remove(handle)` / `updateHandleBBox(handle, newBBox)`
in the deep observer, repacked on WS first sync via `repackSpatialIndex()` for
optimal tree packing. **Only `RoomDocManager` writes to the index** —
grep `spatialIndex\.(insert|remove|load|clear|updateHandleBBox)` should match
only inside `runtime/room-doc-manager.ts`. Consumers read it via
`getSpatialIndex()` from `runtime/room-runtime`.

---

## When modifying

- **New `ObjectKind`**: add three arms (one per dispatcher) in `hit-dispatch.ts`
  pointing at named `<kind>HitPoint` / `<kind>HitRect` / `<kind>HitCircle`
  functions. If the kind is bindable, append it to `BINDABLE_KINDS` in
  `core/types/objects.ts` (the spatial layer picks it up automatically). For
  a new framed-rect kind:
  - If the `bbox.ts` entry equals its frame with zero padding (no shadow /
    stroke / overhang), join the existing `tightFramedHitPoint` /
    `tightFramedHitCircle` shared functions and add a `case '<kind>':`
    fall-through to the `hitRectFor` `return true` arm.
  - Otherwise close over the frame resolver via `paddedHitPointFromFrame` /
    `paddedHitRectFromFrame` / `paddedHitCircleFromFrame` helpers (see
    text/note/bookmark).
- **New consumer with hit-testing needs**: pick the closest existing picker by
  return shape (handle / id / typed accept result / `string[]`). Don't add a new
  picker export unless the occlusion model genuinely differs.
- **New consumer without hit-testing needs**: call `getSpatialIndex().queryBBox(...)`
  directly. Don't route raw-entry consumers through the facade.
- **Changing paint semantics**: update the `Paint` union AND the branch logic in
  all three pickers in `object-query.ts` simultaneously — they're two sides of
  one contract.
- **Changing scale conversion**: `resolveRadius` is the single source of truth.
  `handle-hit.ts` imports it from `object-query.ts` — keep that edge.
- **Changing z-order**: `sortTopFirst` compares ULIDs lex desc. If creation
  timestamp ever diverges from insertion id, revisit.
