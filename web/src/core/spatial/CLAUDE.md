# Spatial System

Hit testing and region queries for every object on the canvas. Answers "what's
under the cursor?", "what's inside this marquee?", "what can this connector
endpoint snap to?". The live index is `spatialTree` — a module-level
**FlatRTree** singleton keyed by `handle.slot`. Queries fill a reused
`Uint32Array` of dense u32 slots; consumers recover handles via the slot
table's reverse map (`getHandlesBySlot`) and read envelopes off the global
bbox column (`getBBoxColumn()`, `slot * 4`). No wrapper class, no tuple-first
shims — call sites pass 4 scalars straight to the tree's twin query methods.

> Architectural overview, not a changelog. Match surrounding detail when updating.

---

## File Map

```
web/src/core/spatial/
├── spatial-tree.ts          — the FlatRTree singleton + contracts header  (~70 LOC)
├── FlatRTree.ts             — FlatRTree: mutable SoA R-tree              (~2030 LOC)
├── hit-dispatch.ts          — Per-kind hit fns + switch dispatchers      (~270 LOC)
├── object-query.ts          — Picker facade: 4 exports, no options       (~290 LOC)
├── handle-hit.ts            — Resize handles + endpoint dots             (~140 LOC)
├── index.ts                 — Barrel; re-exports `spatialTree` only
└── FlatRTree.selftest.ts    — Standalone test+bench runner               (~1190 LOC)
```

**`FlatRTree.ts` is the WIRED index engine** — a mutable Structure-of-Arrays
R-tree keyed by dense u32 ids = `handle.slot` < 2^30 (fourth-generation "v4":
typed-array node pool with parent-embedded entry boxes; `cell = node<<4 | pos`
addressing with stored positions — `_cellOf[id]` / `_parentCell[node]` — so
`readBBox` is O(1) and no mutation ever re-scans for a position; annotated
ref words carry child+count+leaf, so queries load zero per-node metadata;
sentinel node 0 holds the root's parent entry + MBR — uniform up-walks, O(1)
update/remove tiers at the root, 4-compare whole-tree reject; exact-MBR
invariant licensing those tiers; EIGHT-candidate split — k ∈ [7,10] × {min,
max order of the winning axis} over an arena-scratched reduced-table scorer,
placing elongated items by mass instead of left end; OMT bulk load over an
MSD-radix multi-partition of (signed-int32 center-key, index) proxy LANES —
payload never moves, leaves gather by original index, so typed load inputs
are read IN PLACE (no defensive copy, never mutated or retained) — with the
same exact node-count dry-run reserve, no pow2 pool rounding. The load path
is shaped for the low tiers it actually runs in (hydrate is commonly the
first call in a fresh context): per-element passes are tiny parameter-fed
leaf functions, copy-backs are native copyWithin, keys stay int32 (the u32
transform was a measured per-context Maglev deopt), and engine scratch is
build-transient instance state — nothing module-scoped, nothing retained
after load returns. Growth-free query bodies — results capacity ≥ size
maintained at mutation time, fixed 1024-word stack; doubles never cross a
call boundary — Smi/ref args only, boxes travel via instance `Float64Array`
channels (the loader passes derived Smi shifts, never key values);
steady-state data paths are genuinely allocation-free; `dispose()` exists
for embedders — avlo's singleton never calls it). M is FIXED at 16 as
source literals (module consts don't constant-fold — measured; chasing
another M means regenerating the literals, the ctor knob is gone). Design
rationale lives in its file header + the landing commit; the measurement
studies behind it are retired from the repo — do NOT re-add measured-out
mechanisms (quantized u16 mirror, condense-on-delete, ArrayBuffer.transfer
growth, R*-overlap subtree refinement, pooled module load-scratch, unsigned
sort keys) without new numbers. Twin query bodies — **`queryPrecise()` for narrow probes (hit
tests), `query()` for viewport-scale rects (culls); callers pick by
construction**. Proof: 21.1k-check selftest — three de-correlated oracles
(brute-mirror queries through BOTH query bodies + rbush parity, per-item
readBBox sweep, structural validate()) across adversarial/degenerate/guard
suites, 0 failures; V8-verified: hot methods TurboFanned, no recurring
deopts (cold-load deopts are one-shot feedback learning in per-call
epilogues, none in per-element loops). Measured vs the v3 engine it
replaced (board-shaped data, fresh-process colds, Node 24+26): cold first
load ×0.82 @30k / ×0.94 @50k, warm loads ×0.71–1.01 (par @30k, −29% @100k),
fresh-tree queries ×0.80–0.94 and organic ×0.74–0.88 (center keys + the
split), paste ×0.87, inserts/removes/wiggle-updates par; medium-travel drag
updates ×1.1–1.5 — structure-caused (tighter leaves relocate travelling
boxes sooner), absolute ~0.1–0.2 ms per second of continuous drag. The
selftest runs via esbuild+node at fixed M=16 (command in its header), not
in the app bundle; rbush remains a devDependency solely as its A/B oracle.

`hit-dispatch.ts` exposes three switch dispatchers (`hitPointFor` /
`hitRectFor` / `hitCircleFor`) over eight named, monomorphic per-kind
functions. Image + code share the tight-framed body (reads the global bbox
column at `slot * 4` directly — no `getFrame` call, no FrameTuple alloc).
Stroke / connector / shape have bespoke geometry-aware bodies; text /
note / bookmark close over their frame resolver via small inline helpers.

---

## `spatialTree` contract (spatial-tree.ts)

The singleton's header is the authority; summary:

1. **Results lifetime.** Queries fill `spatialTree.results` and return the
   count; fetch `results` AFTER each call, valid `[0, n)`, consume before the
   next query/mutation. Buffer identity changes only at MUTATION time
   (queries never grow it), so hoisting across back-to-back queries is legal;
   multi-query loops (slideClear, clipboard probe) keep the refetch-inside-
   the-loop idiom anyway. `getBBoxColumn()` / `getHandlesBySlot()` refs ARE
   hoistable across queries — but never across anything that can create
   objects.
2. **No nested queries (transitive).** Nothing reachable from hit fns, frame
   resolvers, or picker `accept` callbacks may query or mutate the tree —
   callers are mid-consume of the shared results buffer. (rbush's fresh-array-
   per-call accidentally allowed this; the shared buffer does not.)
3. **Mutation = RoomDocManager only.** Grep contract:
   `spatialTree.(insert|remove|update|load|rebuild|clear)` matches only in
   `runtime/room-doc-manager.ts`.
4. **`remove(slot)` before `releaseSlot(slot)`** — Phase B of the same
   observer fire can recycle the slot (LIFO); a late remove would delete the
   recycled entry.
5. **Twin rule — pick by RECT SIZE, not site category.** `query()` for
   viewport-scale / unbounded rects (renderer cull, image-manager padded
   viewport, z-actions, context-serializer, marquee rects via
   `queryHandleIds`, clipboard's selection-sized probe); `queryPrecise()` for
   bounded-small probes (radius picks, eraser circles via `queryHandleIds`'
   point branch, connector-flow slideClear). Rect size predicts the leaf hit
   rate — wide rects favor the branchless compaction, narrow probes the
   mask+branch.
6. **Live slots only.** Query results are always live ⇒ `bySlot[res[i]]!` is
   non-null by contract; freed slots' column lanes are stale — never index.
7. **`slot * 4`, never `slot << 2`** for column offsets.
8. **No-room semantics.** The singleton silently answers 0 over a cleared
   tree (the old `getSpatialIndex()` threw). Safe: RDM's destroy + hydrate-top
   double clear makes it silent-empty, never silent-stale.
9. Singleton survives room switches; `clear()` releases buffers to newborn
   sizes (no high-water retention — hydrate's exact-reserve `load()` makes
   release free).

`search()` / `all()` are **off-limits** for avlo consumers — hardwire one
twin and alias `results`.

**Lifecycle.** Cleared by RDM `destroy()` and at hydrate top; bulk-loaded at
hydrate tail straight off the global bbox column (dense slots ⇒ item-index
=== slot; v4's `load` reads typed inputs in place — no defensive copy, the
column is neither mutated nor retained); maintained per-object via
`insert(slot, …)` / `remove(slot)` /
`update(slot, …)` in the deep observer (`upsertHandle`'s tripartite write:
`copyBbox` tuple → `writeSlotBBox` column → `spatialTree.update` tree);
repacked on WS first sync via `rebuild()`.

---

## Pipeline

```
Call site → object-query.ts facade
              ├─ resolveRadius        ({px} ÷ scale | {world} passthrough)
              ├─ spatialTree query — twin by rect size   (4 scalars, inline per branch)
              ├─ collectHits          (consumes results slots: slot lock checks →
              │                        slot kind-mask → bySlot recovery → hitPointFor —
              │                        packs u32 keys `rank * 4 + paintCode`)
              ├─ sortU32Range         (packed keys, ascending, in-place — utils/sort-u32)
              └─ picker walk          (DESCENDING over keys = top-first; recover
                                       paint = key & 3, handle via slotsByRank + the
                                       slot table's reverse map)
                       ↓
        ObjectHandle | string | T | null    (no intermediate array escapes)
```

Call sites never materialize a `HitCandidate[]`, never `.map(h => h.id)`, never
allocate a `Set` per call, never pass option bags. `collectHits` validates the
rank table FIRST (`ensureRanksValid()` — keys embed ranks), then per passing hit
packs one u32; no per-hit candidate object, no comparator anywhere. Lock checks
run on the raw slot before handle recovery — cheapest filters first.

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

Resize handles + endpoint dots don't live in the tree; they're derived from
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

### Raw tree consumers — six bypass the facade

They own their own kind filtering / dedup and consume slots directly
(`bySlot[res[i]]!` for handles, `col[slot * 4 …]` for boxes):

- `renderer/layers/objects.ts` — viewport cull (`query`; packs ranks straight
  from slots, clip tests on the raw column — zero handle touches pre-sort on a
  steady non-transform frame)
- `core/image/image-manager.ts` — viewport decode/evict (`query` on the
  padded viewport; image+bookmark kinds, boxes off the column)
- `core/z-order/z-actions.ts` — visible-partition for forward/backward
  (`query`; needs full handles for the rankAsc sort + `.y.set`)
- `core/ai/context-serializer.ts` — viewport tier membership (`query`; slot
  `Set`), `readCanvas` area query (cold — materializes handles)
- `core/clipboard/clipboard-actions.ts` — smart-duplicate collision probe
  (wide `query` per direction — selection-sized rects; refetches `results`
  per iteration)
- `tools/selection/connector-flow.ts` — flow-candidate prefilter + slideClear
  clear-spot search (`queryPrecise`; blocker edges off the column, `results`
  refetched per slide iteration)

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
4. **Tight-bbox fast path.** For kinds whose stored envelope equals their
   tight frame (currently image and code), `hitRectFor` returns `true`
   unconditionally — the envelope filter that produced the candidate IS the
   precision rect check, so a redundant `bboxesIntersect` (and the Y.Map.get
   inside the frame resolver) is skipped. Tight-framed `hitPointFor` and
   `hitCircleFor` read the global bbox column at `slot * 4` directly (no
   `getFrame` / `getCodeFrame` call, no FrameTuple alloc). Kinds with stored
   padding — text (italic overhang + 2px vert), note/bookmark (shadow), shape
   (stroke + ellipse/diamond geometry) — keep a real switch arm that filters
   out marquees touching only the padding zone.

### Frame resolution (per kind)

| Kind | Frame source |
|---|---|
| text, note | `getTextFrame(id)` from `core/text/text-system` (padded — runs precision pass) |
| bookmark | `getBookmarkFrame(id)` from `core/bookmark/bookmark-render` (padded) |
| shape | `getFrame(h.y)` (stored) — shape-aware geometry, not a generic rect pass |
| image, code | global bbox column at `slot * 4` — stored bbox === frame, zero padding |

`null` from a frame getter ("not yet laid out") propagates to `hitPoint` →
`null` → picker skips. Code that needs the frame of any bindable handle outside
hit testing uses `frameOf` from `core/geometry/frame-of.ts` (not a spatial
concern — but it IS used inside `snap`'s accept callback, which is the consumer's
choice, not the picker's). Frame resolvers and hit fns are under the transitive
no-nested-query contract (see `spatialTree` contract 2 above).

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

The three walks live inline (~60 LOC total) — they share the query +
`collectHits` + `sortU32Range` setup, but each terminal condition is genuinely
different. Don't combinator-ize.

Z-order: packed rank keys (`rank * 4 + paintCode` from `ZRankTable`), walked
descending — higher key ⇔ higher rank ⇔ higher stack position, and the rank
sort's (z, id) tie-break already decided collisions at rebuild time. The picker
has no opinion about input state — Ctrl-to-suppress-snap lives in the calling
tool, not here.

### Bindable kind set

`BINDABLE_KIND_MASK` (bit per kind code, derived from `BINDABLE_KINDS` +
`KIND_CODE` in `core/types/objects.ts`) feeds `collectHits`' slot-column kind
prefilter — one shift+mask on the raw slot, before handle recovery. No Set,
no string compares.

---

## When modifying

- **New `ObjectKind`**: add three arms (one per dispatcher) in `hit-dispatch.ts`
  pointing at named `<kind>HitPoint` / `<kind>HitRect` / `<kind>HitCircle`
  functions. If the kind is bindable, append it to `BINDABLE_KINDS` in
  `core/types/objects.ts` (the spatial layer picks it up automatically). For
  a new framed-rect kind:
  - If the `bbox.ts` entry equals its frame with zero padding (no shadow /
    stroke / overhang), join the existing `tightFramedHitPoint` /
    `tightFramedHitCircle` shared functions (column reads) and add a
    `case '<kind>':` fall-through to the `hitRectFor` `return true` arm.
  - Otherwise close over the frame resolver via `paddedHitPointFromFrame` /
    `paddedHitRectFromFrame` / `paddedHitCircleFromFrame` helpers (see
    text/note/bookmark).
- **New consumer with hit-testing needs**: pick the closest existing picker by
  return shape (handle / id / typed accept result / `string[]`). Don't add a new
  picker export unless the occlusion model genuinely differs.
- **New consumer without hit-testing needs**: call `spatialTree.query(...)` /
  `queryPrecise(...)` directly (twin per the rule above), consume slots via
  `getHandlesBySlot` / `getBBoxColumn`. Don't route raw consumers through the
  facade — and never mutate: writer discipline is the grep contract
  (`spatialTree.(insert|remove|update|load|rebuild|clear)` only in
  `room-doc-manager.ts`).
- **Changing paint semantics**: update the `Paint` union AND the paint-code
  mapping in `collectHits` AND the branch logic in all three pickers in
  `object-query.ts` simultaneously — they're two sides of one contract. Codes
  must stay < 4 (`key & 3` recovery; the pack multiplies rank by 4).
- **Changing scale conversion**: `resolveRadius` is the single source of truth.
  `handle-hit.ts` imports it from `object-query.ts` — keep that edge.
- **Changing z-order**: pickers order by `ZRankTable` ranks packed into u32
  keys — ordering policy (incl. the (z, id) tie-break) lives entirely in the
  rank table's rebuild, not here.
