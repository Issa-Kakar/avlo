# Spatial System

Hit testing and region queries for every object on the canvas. Answers "what's
under the cursor?", "what's inside this marquee?", "what can this connector
endpoint snap to?". The **only** module in `core/` that imports `getHandle` /
`getSpatialIndex` from `runtime/room-runtime` — every consumer downstream takes
the single value its picker returns.

> Architectural overview, not a changelog. Match surrounding detail when updating.

---

## File Map

```
client/src/core/spatial/
├── object-spatial-index.ts  — RBush wrapper, tuple-first             (~70 LOC)
├── kind-capability.ts       — Per-kind hit predicates + Paint enum  (~155 LOC)
├── object-query.ts          — Picker facade: 4 exports, no options  (~230 LOC)
├── handle-hit.ts            — Resize handles + endpoint dots        (~145 LOC)
└── index.ts                 — Barrel; re-exports `ObjectSpatialIndex` only
```

---

## Pipeline

```
Call site → object-query.ts facade
              ├─ resolveRadius        ({px} ÷ scale | {world} passthrough)
              ├─ regionEnvelope       (rect or point-r → bbox)
              ├─ spatialIndex.queryBBox/queryRadius   (rbush envelope prefilter)
              ├─ collectHits          (kind prefilter? getHandle, cap.hitPoint)
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

### `handle-hit.ts` — non-spatial sibling

Resize handles + endpoint dots don't live in rbush; they're derived from
selection state. Same `Radius` vocabulary, no spatial index, no paint logic.

```ts
hitNearest({ at, radius, probes })           // squared-distance, generic
hitResizeHandle(at, bbox) → HandleId | null  // bespoke: side handles are edge strips
hitEndpointDot(at, selectedIds) → EndpointHit | null
shouldShowHandles(bbox, scale?)              // visibility/hit gate
```

Constants: `HANDLE_HIT_PX = 10`, `ENDPOINT_DOT_HIT_PX = 10`,
`HANDLE_MIN_BBOX_PX = 12` (corner stamps physically meet below this).

### Raw `queryBBox` — three consumers bypass the facade

They want `IndexEntry[]`, not handles, and own their own kind filtering / dedup:

- `renderer/layers/objects.ts` — viewport cull (500+ ids per frame)
- `core/image/image-manager.ts` — viewport decode/evict (image+bookmark only)
- `core/clipboard/clipboard-actions.ts` — smart-duplicate collision probe

**Don't wrap these behind a facade function for uniformity.** They don't need it.

---

## Paint classification (`kind-capability.ts`)

```ts
type Paint = 'ink' | 'fill' | 'seethrough';
hitPoint(h, p, r) → Paint | null     // null = geometric miss
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
4. **`cap.hitRect` may be `null`** — opt-out for kinds whose stored rbush bbox
   equals their tight frame (currently image and code via `tightFramedCap`).
   `queryHandleIds` checks for null and trusts the rbush envelope filter as
   the precision rect check, skipping a redundant `bboxesIntersect` (and the
   Y.Map.get inside the cap's frame resolver). Kinds with stored padding —
   text (italic overhang + 2px vert), note/bookmark (shadow), shape (stroke +
   ellipse/diamond geometry) — keep a real `hitRect` because their cap
   legitimately filters out marquees touching only the padding zone.

### Frame resolution (per kind)

`framedCap` factory closes over a per-subsystem getter at `KIND` table init:

| Kind | Frame source |
|---|---|
| text, note | `getTextFrame(id)` from `core/text/text-system` |
| code | `getCodeFrame(id)` from `core/code/code-system` |
| bookmark | `getBookmarkFrame(id)` from `core/bookmark/bookmark-render` |
| image, shape | `getFrame(h.y)` (stored) |

`null` from a frame getter ("not yet laid out") propagates to `hitPoint` →
`null` → picker skips. Code that needs the frame of any bindable handle outside
hit testing uses `frameOf` from `core/geometry/frame-of.ts` (not a spatial
concern — but it IS used inside `snap`'s accept callback, which is the consumer's
choice, not the picker's).

### `bindable` flag

True for shape/text/code/image/note/bookmark. Read **once at module import** by
`object-query.ts` to seed `BINDABLE_KINDS_SET` — never per-call `new Set`.

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

## `ObjectSpatialIndex` (rbush wrapper)

```ts
class ObjectSpatialIndex {
  insert(id, bbox, kind)
  update(id, oldBBox, newBBox, kind)
  remove(id, bbox)
  queryBBox(bbox)    → IndexEntry[]
  queryRadius(x,y,r) → IndexEntry[]   // axis-aligned-square envelope
  bulkLoad(handles)
  clear()
}
type IndexEntry = { minX, minY, maxX, maxY, id, kind };
```

A single module-scoped scratch bbox is reused across every query — rbush reads
the fields immediately and doesn't hold a reference, so mutation is safe.
Envelope queries are intentionally coarse; tight intersection is the capability
layer's job.

**Lifecycle.** Owned by `RoomDocManager` (`spatialIndex` field, non-null from
construction). Hydrated via `bulkLoad()` on room join, maintained per-object via
`insert/update/remove` in the deep observer, repacked on WS first sync via
`repackSpatialIndex()` for optimal tree packing. Consumers read it via
`getSpatialIndex()` from `runtime/room-runtime`.

---

## When modifying

- **New `ObjectKind`**: add a `KindCapability<K>` to `KIND`. `bindable` is read
  once at import. For framed-rect kinds use `framedCap(getXxxFrame)` — or
  `tightFramedCap` if the new kind's `bbox.ts` entry equals its frame with
  zero padding (no shadow / stroke / overhang), which sets `hitRect: null`
  and skips the redundant marquee precision pass.
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
