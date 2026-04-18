# Spatial System

Hit testing and region queries for every object on the canvas. This is the module that answers
"what's under the cursor?", "what's inside this marquee?", "what can this connector endpoint
snap to?". It is the **only** place in `core/` that imports `getHandle`/`getSpatialIndex` from
`runtime/room-runtime` — everything downstream works with the single value each picker returns.

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail when
> updating — don't inflate coverage of one change at the expense of the big-picture pipeline
> flow and consumer needs that make this document useful.

---

## Why the system is shaped the way it is

Consumers don't want a hit-candidate array. They want the single answer their tool needs:

| Consumer                    | What it actually wants                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `SelectTool` click          | topmost paint hit with frame-aware tournament → `ObjectHandle \| null`       |
| `SelectTool` marquee        | IDs of objects whose geometry intersects a rect → `string[]`                 |
| `EraserTool` sweep          | IDs of objects whose geometry intersects a circle → `string[]`               |
| `TextTool` double-click     | topmost `'text' \| 'note'` occluded by paint blockers → `string \| null`     |
| `CodeTool` double-click     | topmost `'code'` occluded by paint blockers → `string \| null`               |
| `snap.ts` endpoint          | topmost bindable that `accept()` likes, with see-through memo → `T \| null`  |
| `renderer/layers/objects.ts`| raw `IndexEntry[]` from the viewport bbox (no hit logic, no getHandle)       |
| `image-manager.ts` viewport | raw `IndexEntry[]` from a padded viewport (same pattern)                     |
| `clipboard-actions.ts`      | raw `IndexEntry[]` from candidate offset slots (collision probe)             |

The top six call into **one function each** in `object-query.ts` and receive exactly the value
they use. The bottom three bypass the facade entirely and hit `ObjectSpatialIndex.queryBBox`
directly because they don't want handles, don't want hit-testing, and already handle their own
kind filtering / scratch bboxes. That split is intentional — don't wrap the raw bbox query
behind a facade wrapper just for uniformity.

---

## File Map

```
client/src/core/spatial/
├── object-spatial-index.ts  — Pure RBush wrapper (~70 LOC)
├── kind-capability.ts        — Per-kind hit predicates + Paint class (~155 LOC)
├── object-query.ts           — Picker facade: Region, Radius, 4 exports (~240 LOC)
├── handle-hit.ts             — Non-spatial sibling: resize handles, endpoint dots (~120 LOC)
└── index.ts                  — Barrel — only re-exports `ObjectSpatialIndex`
```

Five files, ~580 LOC. Current shape is the result of collapsing 11 files / 925 LOC of generic
combinator infrastructure (combinators, type-test files, multi-tier query facades, picker
libraries, options-bag API) that real consumers never used. Any new addition should be weighed
against that collapse: if it can live inline inside one of the existing pickers, it should.

---

## Pipeline

Every query goes through the same three-layer pipeline, baked into the four `object-query.ts`
exports so call sites never see the intermediate steps:

```
     Call site (1 call, 2-3 args, no options bag)
              │
              ▼
┌───────────────────────────────────────────────┐
│ object-query.ts facade                        │
│  1. resolveRadius  (px → world via camera)    │
│  2. regionEnvelope (rect or point-r → bbox)   │
│  3. getSpatialIndex().queryBBox/queryRadius   │ ← rbush envelope prefilter
│  4. collectHits    (kind prefilter optional,  │
│                     getHandle, cap.hitPoint)  │
│  5. sortTopFirst   (ULID desc, in-place)      │
│  6. picker walk    (frame-aware tournament /  │
│                     kind-match / accept+memo) │
└───────────────────────────────────────────────┘
              │
              ▼
   Single result: ObjectHandle | string | T | null
```

The facade owns scale conversion, envelope math, kind prefiltering, handle resolution, paint
classification, z-sorting, and picker logic. **Call sites never materialize a `HitCandidate[]`,
never call `.map(h => h.id)`, never allocate a new `Set` per call, never pass options.**

---

## Layer 1 — `ObjectSpatialIndex` (pure RBush wrapper)

Tuple-first RBush wrapper. Single module-scoped scratch bbox object (`_scratchBBox`) reused
for every query — the tree's `.search()` reads the fields immediately and doesn't hold a
reference, so mutation is safe.

```ts
class ObjectSpatialIndex {
  insert(id, bbox, kind): void
  update(id, oldBBox, newBBox, kind): void
  remove(id, bbox): void
  queryBBox(bbox: BBoxTuple): IndexEntry[]       // rect envelope
  queryRadius(x, y, r): IndexEntry[]             // circle envelope (axis-aligned square)
  bulkLoad(handles: ObjectHandle[]): void        // packed bulk-load (hydrate / resync)
  clear(): void
}
```

`IndexEntry` is the rbush record: `{ minX, minY, maxX, maxY, id, kind }`. Both queries return
`IndexEntry[]` — no handles, no hit classification. This is the layer the three non-facade
consumers (`objects.ts`, `image-manager.ts`, `clipboard-actions.ts`) talk to directly.

**Lifecycle.** Owned by `RoomDocManager` — hydrated via `bulkLoad()` on room join, maintained
per-object via `insert/update/remove` in the deep observer, repacked on WS first sync for
optimal tree packing. Consumers read it via `getSpatialIndex()` from `runtime/room-runtime`.

**Intentional coarseness.** An rbush envelope query returns any entry whose stored bbox overlaps
the query bbox — no tight geometry test. Fine-grained intersection is the capability layer's
job.

---

## Layer 2 — `kind-capability.ts` (per-kind hit predicates)

Single source of truth for how each object kind hit-tests. One `KindCapability<K>` per kind,
indexed by a `KIND` table typed `{ [K in ObjectKind]: KindCapability<K> }`.

### Paint classification

```ts
export type Paint = 'ink' | 'fill' | 'seethrough';
```

Returned by `hitPoint` on a geometric hit; `null` means miss. The literal encodes what the
hit **blocks** for the picker logic downstream:

- **`'ink'`** — solid paint (any stroke, connector line, filled-shape edge, text frame, code
  frame, image, bookmark body, note body). Short-circuits the frame-aware tournament; nothing
  under it matters.
- **`'fill'`** — filled shape interior. Participates in the area tournament against overlapping
  unfilled frames above it — a smaller unfilled shape above a big filled rect still wins the
  click.
- **`'seethrough'`** — unfilled shape interior. Transparent to clicks: see-through kinds don't
  block `pickTopmostOfKind`, and they accumulate as area-tracked fallbacks in the other two
  pickers.

Only unfilled shape interiors produce `'seethrough'`. Everything else is `'ink'` at minimum,
because text/code/note/image/bookmark paint their whole frame (no glyph-level testing), and
strokes/connectors are always ink.

### KindCapability interface

```ts
interface KindCapability<K extends ObjectKind> {
  readonly bindable: boolean;
  readonly hitPoint:  (h: HandleOf<K>, p: Point, r: number)  => Paint | null;
  readonly hitRect:   (h: HandleOf<K>, bbox: BBoxTuple)      => boolean;
  readonly hitCircle: (h: HandleOf<K>, c: Point, r: number)  => boolean;
}
```

- `bindable` — connector endpoint target? Read **once at import time** by `object-query.ts` to
  seed the bindable-kind set (`BINDABLE_KINDS_SET`). Never read again at runtime. True for
  shape/text/code/image/note/bookmark; false for stroke/connector.
- `hitPoint` — point-probe with a hit radius. Used by the three pickers.
- `hitRect` — rect-vs-geometry tight intersection. Used by marquee (rect region).
- `hitCircle` — circle-vs-geometry tight intersection, fill-aware. Used by eraser (point region).

No `area` field, no `frame` field. The frame-aware tournament inlines `f[2]*f[3]` at the two
places it needs shape area (always shape-only — see below). Frame resolution for bindable kinds
is done via `frameOf` from `core/geometry/frame-of.ts`, a separate utility that handles connector
topology and rendering atoms.

### The three types of caps

```
STROKE_CAP / CONNECTOR_CAP
  bindable: false
  hitPoint  → polyline distance test, always 'ink' on hit
  hitRect   → polylineIntersectsBBox on points
  hitCircle → strokeHitTest (polyline-radius test) on points

SHAPE_CAP
  bindable: true
  hitPoint  → shapeHitTest (fill-aware, interior vs edge) → maps to Paint:
                filled + any hit                → 'fill'
                unfilled + interior             → 'seethrough'
                unfilled + edge-only            → 'ink'
  hitRect   → shapeType-aware (ellipse/diamond/rect) bbox/geometry intersect
  hitCircle → circleHitsShape (shapeType + fill-aware)

framedCap<K>(resolveFrame)  — text / note / code / image / bookmark
  bindable: true
  hitPoint  → rectFrameHit(frame), always 'ink' on hit (frame always paints)
  hitRect   → bbox intersect against resolved frame
  hitCircle → circleRectIntersect against resolved frame
```

The framed-rect factory is parametrized by `resolveFrame`, which pulls the derived frame from
the appropriate subsystem: `getTextFrame(id)` for text + note, `getCodeFrame(id)` for code,
`getBookmarkFrame(id)` for bookmark, `getFrame(h.y)` (stored) for image. Each returns
`FrameTuple | null` — `null` means "not yet laid out", which propagates to `hitPoint` → `null`
so the picker skips it.

### Invariants the pickers rely on

1. **Framed kinds never produce `'seethrough'` or `'fill'`.** They always return `'ink'` on hit.
   This is why `pickTopmostOfKind` (which targets a framed kind) can skip see-through fallback
   tracking — the target always paints `'ink'`, so the fallback branch would be dead.
2. **Strokes and connectors are always `'ink'` on hit.** Never see-through. Never participate in
   the area tournament.
3. **Only shapes produce `'fill'` and `'seethrough'`.** `shapeArea(h)` in `object-query.ts` reads
   `getFrame(h.y)` directly — the only call sites are the two area comparisons in
   `pickTopmostPaint` / `pickTopmostBindable`, and both only fire when `paint` is `'fill'` or
   `'seethrough'`. Frames for non-shape bindables are never read for area.

---

## Layer 3 — `object-query.ts` (picker facade)

The whole call-site-visible surface lives here. One file, four exports, no options bags.

### Types + helpers

```ts
export type Radius = { readonly px: number } | { readonly world: number };
export type Region =
  | { readonly kind: 'point'; readonly p: Point; readonly r: number }
  | { readonly kind: 'rect';  readonly bbox: BBoxTuple };

export function resolveRadius(r: Radius): number;     // exposed for handle-hit.ts
export const atPoint = (p, radius): Region;
export const inBBox  = (bbox):       Region;
```

`Radius` is a tagged union. `{ px: N }` is screen-space and divides by `cameraStore.scale` at
resolve time. `{ world: N }` passes through unchanged. Call sites choose the tag based on
whether their tolerance should feel constant on screen (eraser radius, hit tolerance) or
constant in world units (connector snap edge radius). **No call site does its own `/scale`.**

`regionEnvelope` (private) converts a region to the bbox we feed rbush. For point regions
that's `[x-r, y-r, x+r, y+r]`. For rect regions it's the bbox as-is.

### Internal scratch

```ts
const BINDABLE_KINDS_SET: ReadonlySet<ObjectKind> = new Set(…);  // built once at import

interface Cand { readonly handle: ObjectHandle; readonly paint: Paint; }

function sortTopFirst(cs: Cand[]): void;                          // ULID-desc, in-place
function shapeArea(h: ObjectHandle): number;                      // f[2]*f[3] inline
function collectHits(entries, p, r, kindFilter): Cand[];
```

`BINDABLE_KINDS_SET` is built once at module import from the `KIND` table's `bindable` flags —
**never** per-call `new Set` allocation.

`collectHits` is the one shared inner loop: iterate rbush envelope entries, optionally skip
non-matching kinds (cheap set check before `getHandle`), resolve handle, dispatch
`cap.hitPoint`, drop misses. Returns a fresh `Cand[]` per call, but only populated by entries
that actually hit.

Z-sort is ULID descending — ULIDs are time-ordered, so later-created objects win ties. Sort is
in-place on the scratch array; call sites never see it.

### Export 1 — `queryHandleIds`

```ts
export function queryHandleIds(region: Region): string[];
```

Region membership. Envelope-prefilter via rbush, then per-kind precise intersect
(`cap.hitRect` for rect regions, `cap.hitCircle` for point regions). Returns `string[]`.

**Shape-type awareness is preserved.** Rect regions hitting an ellipse use
`ellipseIntersectsBBox` (perimeter-aware), diamonds use `diamondIntersectsBBox`. Point regions
(circles) use `circleHitsShape` with fill awareness — eraser treats filled shape interiors as
hits, unfilled shapes only along the edge.

Consumers: marquee select (`SelectTool.updateMarqueeSelection`), eraser sweep (`EraserTool
.updateHitTest`). Both iterate the returned `string[]` directly — no `.map(h => h.id)` shim.

### Export 2 — `pickTopmostPaint`

```ts
export function pickTopmostPaint(at: Point, radius: Radius): ObjectHandle | null;
```

**Frame-aware tournament.** Returns the `ObjectHandle` the user most likely meant to click:

1. **Topmost `'ink'` wins outright** (short-circuits before any area math). Strokes, connectors,
   text, code, images, filled-shape edges, note/bookmark bodies all short-circuit here — the
   overwhelming majority of clicks.
2. **Between a topmost `'fill'` and see-through frames stacked above it**, the smaller area wins.
   Tie → higher Z. This is the "click the small unfilled rect inside the big filled rect" case.
3. **If nothing paints** (entire stack is see-through frames), return the smallest-area frame.
4. **Single candidate** → return it directly (skip sort + walk).

Called only by `SelectTool.hitTestObjects`. Used with `{ px: HIT_RADIUS_PX + HIT_SLACK_PX }` =
`{ px: 8 }` screen-space, giving a forgiving touch target without enlarging the visual click
point.

### Export 3 — `pickTopmostOfKind`

```ts
export function pickTopmostOfKind(at: Point, radius: Radius, kind: ObjectKind): string | null;
```

**Fused visible-kind scan.** Target is always a framed kind (text/note/code), so the picker
shape is "first paint hit is either the target (return id) or a blocker (return null)".

Walk z-sorted top-first. For each candidate:
- `'seethrough'` (unfilled shape above the target) → **continue** — doesn't block.
- `'ink'` (any paint) + kind matches → return id.
- `'ink'` (any paint) + kind mismatches → return null (a filled rect / text / image above the
  code block is occluding it).

**No see-through fallback.** Target is always framed → target always paints `'ink'` → a
see-through match is impossible, so the fallback branch that `pickTopmostBindable` uses would
be dead code here. Intentionally omitted.

Called by `TextTool.begin` (targets `'text'` or `'note'`) and `CodeTool.begin` (targets
`'code'`) with `{ px: 8 }` tolerance. Both use the returned id to decide "open existing
editor?" vs "create new object?". **This replaces the old two-call `queryHits() +
pickTopmostByKind()` pattern** — no intermediate `HitCandidate[]` allocation.

### Export 4 — `pickTopmostBindable`

```ts
export function pickTopmostBindable<T>(
  at: Point,
  radius: Radius,
  accept: (h: BindableHandle) => T | null,
): T | null;
```

**Snap-style accept callback with see-through memo.** Connector snapping is the user:
the caller passes a closure that maps a candidate shape to a `SnapTarget | null`; the picker
walks the bindable stack top-first and returns what the caller wants.

Uses `BINDABLE_KINDS_SET` as kind prefilter inside `collectHits` — non-bindable entries (stroke,
connector) are skipped before `getHandle`.

Walk z-sorted top-first. For each bindable candidate:
- `'seethrough'` (unfilled bindable shape) — call `accept(h)`. If it returns non-null, remember
  it as the smallest-area fallback (inline shape area, `f[2]*f[3]`). Continue scanning —
  something above this might be a better match.
- `'ink'` / `'fill'` (paint blocker) — call `accept(h)`. If non-null, return immediately. If
  null, return the memoized see-through fallback (the blocker occludes anything below, so we
  can't go deeper).

The memo handles the "three nested unfilled rects on top of a rect with a fill" case: the
snapper prefers the innermost unfilled shape, but falls back to the filled one beneath if the
inner shapes don't accept (e.g. because the cursor is outside their edge-snap radius).

Called only by `findBestSnapTarget` in `core/connectors/snap.ts`:

```ts
return pickTopmostBindable([cx, cy], { world: edgeRadius }, (h) => {
  const frame = frameOf(h);
  if (!frame) return null;
  return computeSnapForShape(h.id, frame, getHandleShapeType(h), ctx);
});
```

The generic `T` flows through — the callback returns `SnapTarget | null`, so the picker returns
`SnapTarget | null`. No intermediate array, no options bag. `{ world: edgeRadius }` uses the
world-space radius from connector constants (stable in world units regardless of zoom).

---

## Layer 4 — `handle-hit.ts` (non-spatial sibling)

Resize handles and connector endpoint dots are tiny, transient, derived from selection state —
they don't live in the spatial index. But the mental model ("find the nearest probe within a
screen-space radius") matches the spatial vocabulary, so the scale-conversion atom (`Radius`,
`resolveRadius`) is shared.

```ts
interface HandleProbe<T> { readonly center: Point; readonly value: T; }

function hitNearest<T>(opts: { at; radius: Radius; probes: Iterable<HandleProbe<T>> }): T | null;
function hitResizeHandle(at: Point, bbox: BBoxTuple): HandleId | null;
function hitEndpointDot(at: Point, selectedIds: readonly string[]): EndpointHit | null;
```

`hitNearest` — squared-distance comparison across probes; no `Math.hypot` per probe. Returns
the closest probe's `value` within tolerance.

`hitResizeHandle` — bespoke (not built on `hitNearest`). Corner handles are point probes; side
handles (N/S/E/W) are edge strips along the bbox edges between corner radii, because a pure
midpoint-only probe would be frustrating to grab on long edges.

`hitEndpointDot` — generator feeding `hitNearest`. Iterates selected connectors and yields two
probes per connector (start + end endpoint world positions via
`getEndpointEdgePosition(handle, 'start' | 'end')`). Returns `{ connectorId, endpoint }`.

Both use `{ px: 10 }` screen-space — `HANDLE_HIT_PX` / `ENDPOINT_DOT_HIT_PX`.

No spatial index. No handle resolution. No paint classification. This file is intentionally
simple — if the mental model ever diverges (e.g. per-kind endpoint probes), split it.

---

## Consumer Playbook

### `SelectTool.ts` (click + marquee)

```ts
private hitAtDown: ObjectHandle | null = null;

private hitTestObjects(worldX, worldY): ObjectHandle | null {
  return pickTopmostPaint([worldX, worldY], { px: HIT_RADIUS_PX + HIT_SLACK_PX });
}

// Marquee (updateMarqueeSelection):
const marqueeBBox = pointsToBBox(marquee.anchor, marquee.current);
const overlappingIds = queryHandleIds(inBBox(marqueeBBox));
if (!sameSet(overlappingIds, currentSet)) store.setSelection(overlappingIds);

// Resize handles (begin):
const handleHit = hitResizeHandle([worldX, worldY], selectionBounds);

// Endpoint dots (begin, connector mode):
const endpointHit = hitEndpointDot([worldX, worldY], selectedIds);
```

Handle id/kind read directly (`hit.id`, `hit.kind`). The marquee `string[]` is handed to
`setSelection` unchanged. Never allocates a `HitCandidate[]`, never `.map`s ids, never builds a
kind set.

### `EraserTool.ts`

```ts
private updateHitTest(worldX, worldY): void {
  this.state.hitNow.clear();
  const ids = queryHandleIds(atPoint([worldX, worldY], { px: ERASER_RADIUS_PX + ERASER_SLACK_PX }));
  for (const id of ids) this.state.hitNow.add(id);
  if (this.state.isErasing) for (const id of this.state.hitNow) this.state.hitAccum.add(id);
}
```

`queryHandleIds` with a point region → precise `cap.hitCircle` per kind. Fill-aware: filled
shape interior hits count, unfilled shapes only along the edge (users expect to click through
empty rects to delete strokes behind them). Strokes/connectors hit as polylines, framed kinds
as rect/circle intersect.

### `TextTool.ts`

```ts
begin(pointerId, worldX, worldY): void {
  this.gestureActive = true;
  this.pointerId = pointerId;
  this.downWorld = [worldX, worldY];
  const tool = useDeviceUIStore.getState().activeTool;
  this.hitTextId = pickTopmostOfKind([worldX, worldY], { px: 8 }, tool === 'note' ? 'note' : 'text');
}
```

One call returns the id of the topmost text/note occluded by paint blockers. `end()` branches
on `hitTextId`: hit → open editor; miss → create new object. The old two-call
`queryHits()` + `pickTopmostByKind()` pattern is gone — no intermediate array allocated for the
sake of discarding it.

### `CodeTool.ts`

```ts
this.hitCodeId = pickTopmostOfKind([worldX, worldY], { px: 8 }, 'code');
```

Same pattern as TextTool, kind = `'code'`. Hit → open editing; miss → create new code block.

### `snap.ts` (`findBestSnapTarget`)

```ts
return pickTopmostBindable([cx, cy], { world: edgeRadius }, (h) => {
  const frame = frameOf(h);
  if (!frame) return null;
  return computeSnapForShape(h.id, frame, getHandleShapeType(h), ctx);
});
```

The accept callback does the per-shape snap computation (edge/midpoint/center/interior logic,
hysteresis, sub-mode selection) — see `core/connectors/CLAUDE.md`. `pickTopmostBindable` owns:
- bindable prefilter (kind set)
- z-sorted top-first walk
- see-through memoization (inner unfilled shapes beat outer filled shapes)
- occluder-vs-fallback return logic

The Ctrl-to-suppress-snap behavior lives **above** this call in `ConnectorTool` / `SelectTool`,
which skip the call entirely if `isCtrlHeld()`. The picker itself has no opinion about input
state.

### Non-facade consumers (raw `queryBBox`)

Three files bypass the facade because they don't want hit logic, don't want handles, and
already handle their own kind filtering / scratch bboxes:

**`renderer/layers/objects.ts`** — viewport cull for rendering.
```ts
const spatialIndex = getSpatialIndex();
for (const entry of spatialIndex.queryBBox(getVisibleBoundsTuple())) {
  seen.add(entry.id); candidateIds.push(entry.id);
}
```
`getVisibleBoundsTuple()` is a shared module-scoped tuple (no per-frame alloc). Transforming
selection injects additional ids regardless of spatial index result to survive edge-scroll.

**`core/image/image-manager.ts`** — viewport decode/evict.
```ts
const padded = padViewport(getVisibleBoundsTuple());  // 5.5× padded
const visible = spatialIndex.queryBBox(padded);
for (const entry of visible) {
  if (entry.kind !== 'image' && entry.kind !== 'bookmark') continue;
  // … compute ppsp, registerAssetInfo, etc.
}
```
Kind-filters inline (two target kinds only), reads asset ids from handles, doesn't need
hit-testing. Padded viewport is aggressive to pre-decode images about to scroll in.

**`core/clipboard/clipboard-actions.ts`** — smart-duplicate collision probe.
```ts
const results = spatialIndex.queryBBox([qb.minX, qb.minY, qb.maxX, qb.maxY]);
const hasCollision = results.some((r) => !excludeIds.has(r.id));
```
Tries four offset directions (right/below/above/left). Envelope-only check is exactly right —
anything overlapping counts as a collision regardless of precise geometry.

**Don't wrap these behind a facade function just for uniformity.** They want `IndexEntry[]`,
not handles.

---

## Design Decisions Worth Remembering

### Why `Paint = 'ink' | 'fill' | 'seethrough'` with `null` = miss

Previous iterations packed hit/miss + see-through state into a single nullable value, which
forced pickers to re-derive whether a `null` meant "no hit" or "hit but transparent". The current
split keeps miss detection in `hitPoint`'s return-type (`null`) and uses a dedicated literal
(`'seethrough'`) for the transparent-interior case. The three pickers then branch cleanly on
the `Paint` enum without ambiguity.

### Why `area` isn't on `KindCapability`

Area is only relevant for the frame-aware tournament, and the tournament only ever runs shape
area (strokes/connectors short-circuit at `'ink'`; framed kinds also short-circuit at `'ink'`;
only shapes produce `'fill'` / `'seethrough'`). A generic `area` field on every cap would be
dead code for 7 of 8 kinds. Inlining `f[2]*f[3]` at the two places it's needed is shorter,
faster, and removes the `computePolylineArea` import chain that was used by the old
stroke/connector `area` implementations.

### Why `frame` isn't on `KindCapability`

Frame resolution for bindable kinds is per-subsystem: text/note via `getTextFrame`, code via
`getCodeFrame`, bookmark via `getBookmarkFrame`, image/shape via stored `getFrame`. The
`framedCap` factory closes over the right getter at `KIND` table construction. Code that
actually needs "the frame of any bindable handle" uses `frameOf` from
`core/geometry/frame-of.ts`, which is consumed by connector topology, rendering atoms,
keyboard-manager, eraser overlay dimming — not by spatial hit testing.

### Why the picker logic is inline, not combinator-based

The three pickers share the *shape* "z-sort + walk + branch on Paint" but each has a different
terminal condition (tournament vs kind-match vs accept+memo). Previous iterations tried to
express this via picker combinators (`firstCandidate`, `pickBestBy`, `scanTopmostWithMemo`,
`pickFrameAware`, `pickTopmostByKind`), each with one call site, each adding a layer of
indirection for no factoring win. The current code inlines all three walks in `object-query.ts`
— ~60 LOC of straightforward control flow that a reader can follow end-to-end without jumping
modules. If a fifth picker semantic arises, revisit; for four pickers (including
`queryHandleIds`), inlining is clearer.

### Why `BINDABLE_KINDS_SET` is built once at module import

Building a new `Set<ObjectKind>` per snap call would be an allocation per mouse move during
connector drag. The set is immutable at runtime (derived from a const table), so it's computed
once via `new Set((Object.keys(KIND) as ObjectKind[]).filter(k => KIND[k].bindable))` at
import and reused forever.

### Why `Radius` is a tagged union, not two separate functions

Screen-space vs world-space tolerance is a property of the **caller's intent**, not a property
of the picker. The eraser wants its radius to feel constant on screen — 10 px regardless of
zoom. The connector snapper wants its radius to cover a fixed world distance — the same few
shape-widths at any zoom. Encoding the choice in the argument (`{ px }` vs `{ world }`) means
the picker signature is the same for both call sites, and scale conversion happens in exactly
one place (`resolveRadius`).

### Why the three non-facade consumers exist

`objects.ts` needs ids + kinds for 500+ objects per frame to dispatch rendering — it doesn't
want hit testing, doesn't want handles (dispatch reads from `getObjectsById()` separately),
and already owns its own dedup `Set`. `image-manager.ts` is the same story for a padded
viewport with two-kind filtering. `clipboard-actions.ts` just wants "is anything here" — a
boolean over an envelope query, no hit-testing needed. Wrapping these in a facade function
would add a `.map` or a wrapping array without buying anything.

---

## When modifying this system

- **Adding a new `ObjectKind`**: add a `KindCapability<K>` entry to `KIND`. The `bindable` flag
  is read once at import for `BINDABLE_KINDS_SET`; `hitPoint` participates in the pickers,
  `hitRect` in marquee membership, `hitCircle` in eraser membership. If the kind is a framed
  rect, use the `framedCap` factory with the subsystem's frame getter.
- **New consumer with hit-testing needs**: pick the closest existing picker by return shape
  — handle, id, typed accept result, or ids[]. Don't add a new picker export unless the
  semantics genuinely differ (e.g. different occlusion model).
- **New consumer without hit-testing needs**: call `getSpatialIndex().queryBBox(…)` directly.
  Don't route raw-entry consumers through `object-query.ts`.
- **Changing scale conversion**: `resolveRadius` is the single source of truth. `handle-hit.ts`
  imports it from `object-query.ts` — keep that edge; don't fork scale logic.
- **Changing paint semantics**: update the `Paint` union in `kind-capability.ts` AND the
  branch logic in all three pickers in `object-query.ts` at the same time — they're two sides
  of one contract.
- **Changing z-order**: `sortTopFirst` compares ULIDs lexically desc. If creation timestamp
  ever diverges from the insertion id, revisit.

---

## Integration Points

| System                        | Touches Spatial Via                                          |
| ----------------------------- | ------------------------------------------------------------ |
| `RoomDocManager`              | Owns `ObjectSpatialIndex`, calls `insert`/`update`/`remove`/`bulkLoad`/`clear` |
| `runtime/room-runtime`        | Exposes `getSpatialIndex()` + `getHandle()` that pickers read |
| `stores/camera-store`         | `resolveRadius` reads `.scale` for `{ px }` → world conversion |
| `core/text/text-system`       | `getTextFrame(id)` — text + note hit predicates              |
| `core/code/code-system`       | `getCodeFrame(id)` — code hit predicates                     |
| `core/bookmark/bookmark-render` | `getBookmarkFrame(id)` — bookmark hit predicates           |
| `core/accessors`              | `getFrame`, `getPoints`, `getShapeType`, `getWidth`, `getFillColor` — all hit predicate inputs |
| `core/geometry/hit-primitives` | `strokeHitTest`, `shapeHitTest`, `rectFrameHit`, `circleRectIntersect`, `circleHitsShape`, `bboxesIntersect`, `polylineIntersectsBBox`, `ellipseIntersectsBBox`, `diamondIntersectsBBox`, `getDiamondVertices` — the pure math beneath the caps |
| `core/geometry/frame-of`      | NOT a spatial consumer — but `frameOf` is used **inside** snap's accept callback |
| `stores/selection-store`      | `computeHandles(bbox)` for resize handle corners (handle-hit.ts) |
| `core/connectors/connector-utils` | `getEndpointEdgePosition(handle, endpoint)` (handle-hit.ts)  |
