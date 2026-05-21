# Selection System

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail level when updating.

SelectTool + transform engine + selection store + hit testing + transform rendering. Handles translate, scale (per-kind-aware), connector endpoint drag, marquee, multi-select, text/code editing entry, and Z-order-aware hit testing.

---

## File Map

| File | Responsibility |
|------|----------------|
| `tools/selection/SelectTool.ts` | State machine, hit dispatch, routes transform lifecycle through the store. Endpoint drag begun via `getController().beginEndpointDrag(...)`; rest of lifecycle flows through `endTransform`/`cancelTransform`. |
| `tools/selection/transform.ts` | `TransformController` — owns scale + translate + **endpoint drag** modes, structural traits, mapped types (incl. `KindWithBBoxGeo`), dispatch tables, apply/commit/freeze, `getEndpointDragEntry()` accessor, controller-owned `injectIds` buffer, module getters |
| `tools/selection/types.ts` | Shared types: `SelectionKind`, `KindCounts`, `TransformState`, `ScaleCtx`, `SelectedStyles`, `InlineStyles`. `EndpointDragTransform` carries renderer/UI fields only. |
| `tools/selection/connector-topology.ts` | `ConnectorEntry` discriminated union (static / translate / reroute / endpoint-drag synthetic), per-pipeline Side types, `newTopologyBuilder`, `runTopologyScale/Translate`, `commitTopology`, `cancelTopology`, `fillFrameFromBind` |
| `tools/selection/selection-utils.ts` | `computeSelectionComposition`, `computeStyles` (declarative `foldField` composition), `computeUniformInlineStyles` |
| `tools/selection/selection-actions.ts` | 22 mutation wrappers for context menu — each a 1-3 line `applyField`/`toggleField`/`adjustByPresets` call (see `components/context-menu/CLAUDE.md`) |
| `tools/selection/selection-field-table.ts` | `FieldDescriptor<V>` type + `Aggregate<V>` + `foldField`/`applyField`/`toggleField`/`adjustByPresets`/`withEditorOr` primitives + ~17 typed descriptors (one per property). Single source of truth for read/write/persist/accept per kind |
| `stores/selection-store.ts` | Zustand store, orchestrates `TransformController`, `computeSelectionBounds()` |
| `core/geometry/scale-system.ts` | Pure math atoms: `scaleAround`, `uniformFactor`, `preservePosition[Mut]`, `edgePinPosition1D`, `computeReflowWidth`, `scaleBBoxUniform/Edges`, `derivePaddedFrame` |
| `core/geometry/bounds.ts` | Bbox/frame helpers + mutating offset primitives (`offsetBBox`, `offsetFrame`, `offsetPoint`, `setBBoxXYWH`) |
| `core/types/handles.ts` | HandleId taxonomy, type guards, `scaleOrigin`, `handleCursor` |
| `core/spatial/` | Hit testing — see `core/spatial/CLAUDE.md` |
| `renderer/layers/objects.ts` | `drawObjects` dispatch, `renderScaleEntry` (entry-based), `renderTranslatedEntry` (edge-pin fallback) |
| `renderer/layers/selection-overlay.ts` | Marquee, single-select bounds rect (doubles as highlight), multi-select per-object highlights + union rect, connector mode endpoint dots only. `shouldHideHandlesForEditing` keeps handles VISIBLE for shape/note label editing (label DOM lives strictly inside the padded bbox) and hides them only when the editor occupies the full bbox (`text` standalone, `code`). |

---

## SelectTool State Machine

```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';

/** Discriminated pointer-down classification — payload-per-variant, no `!.` peeks. */
type DownHit =
  | { kind: 'background' }
  | { kind: 'selectionGap' }
  | { kind: 'object';     handle: ObjectHandle; isSelected: boolean }
  | { kind: 'handle';     handleId: HandleId }
  | { kind: 'endpoint';   connectorId: string; slot: Slot }
  | { kind: 'openButton'; handle: ObjectHandle };           // bookmark Open chip

const HIT_RADIUS_PX = 6;       // tolerance = HIT_RADIUS_PX + HIT_SLACK_PX = 8px screen
const HIT_SLACK_PX = 2;
const MOVE_THRESHOLD_PX = 4;
const CLICK_WINDOW_MS = 180;
```

### `begin()` flow

1. `contextMenuController.hide()`, then `clearBookmarkOpenHoverIfAny()`. The hover gets re-set below only on the openButton branch.
2. Mode-specific priority: standard mode (selection + not editing) → `hitResizeHandle()` → `'handle'`. Connector mode → `hitEndpointDot()` → `'endpoint'`.
3. Common: `hitTestObjects()` → object hit. Bookmark hit + no shift/ctrl + `hitTestOpenButton()` → `'openButton'` (sets `hoveredOpenBookmarkId`). Otherwise → `'object'` (carries `isSelected`).
4. No object hit: standard mode + inside selection bbox → `'selectionGap'`; else `'background'` (clears selection).
5. `phase = 'pendingClick'` for all targets.

**Single editable re-click exception:** clicking a single-selected text/code/note/shape calls `cancelHide()` immediately after `hide()` to prevent context menu flash. Shape is included because label-less shapes create the label on first click — same edit-entry path.

### `pendingClick → Phase` (in `move()`)

Transition gated by `passMove` (`dist > MOVE_THRESHOLD_PX`). Gap/background also accept `passTime` (≥ `CLICK_WINDOW_MS`).

| DownHit kind | Transition | Notes |
|---|---|---|
| `handle`     | `scale`        | `store.beginScale(handleId, downWorld)` |
| `endpoint`   | `endpointDrag` | Drill to single connector if multi-selected. Controller owns the gesture (RouteContext + buffer + bbox snapshots). |
| `object` (unselected) | `translate` | Selects first. Anchored connectors → `marquee` instead. |
| `object` (selected)   | `translate` | Anchored connectors in connector mode → `marquee` instead. |
| `openButton` | `translate`    | Drift on a pressed Open button = translate intent (user moving the bookmark). Hover stays painted; `ctx.translate(tdx, tdy)` in `objects.ts` carries the hovered chip with the card. |
| `selectionGap`        | `translate` | Drag = translate entire selection. |
| `background`          | `marquee`   | Empty area drag = marquee select. |

### Scale phase

SelectTool hands the store raw cursor coords; **all gesture math lives in the store**.

`store.beginScale(handleId, downWorld)`:
1. `computeSelectionBounds()` → selBounds.
2. `scaleOrigin(handleId, selBounds)` → origin; `handlePosition` → handlePos.
3. `initialDelta = handlePos - origin`; `clickOffset = downWorld - handlePos`.
4. `ctrl.beginScale(selectedIdSet, handleId, origin, selBounds)`.
5. `transform = { kind: 'scale', initialDelta, clickOffset }`.

`store.updateScale(worldX, worldY)`: read `scaleCtx` from controller, `rawScaleFactors(worldX - clickOffset[0], worldY - clickOffset[1], origin, initialDelta, handleId) → [sx, sy]`, then `ctrl.updateScale(sx, sy)`.

The split: controller owns `handleId`/`origin`/`selBounds` (per-apply); store owns `initialDelta`/`clickOffset` (gesture math feeding `rawScaleFactors`). Per-frame `sx`/`sy` stay on the controller — mutating the Zustand discriminant on every pointermove would fire subscribers wastefully.

### Translate phase

```ts
store.updateTranslate(worldX - downWorld[0], worldY - downWorld[1])
```

### `end()` finalization

Click (no drag): handle → no-op; endpoint → drill to single; openButton → re-verify against fresh handle and re-test rect, then `openBookmarkUrl(id)` (the bookmark may have been deleted mid-press; drift >MOVE_THRESHOLD_PX would have promoted to translate already); outside → shift/ctrl additive xor replace; in-selection → shift/ctrl subtractive xor (multi: drill, single text/note/shape: enter text edit, single code: enter code edit); gap → quick tap deselects; background → deselect.

Drag commit: `store.endTransform()` calls `ctrl.commit()` xor `ctrl.clear()` and resets the discriminant. `store.cancelTransform()` does the same for Esc.

After every `end()` / `cancel()`: `rehoverFromLastCursor()` re-runs `handleHoverCursor` against `getLastCursorWorld()` so a just-committed bookmark scale immediately reflects in the hover indicator without requiring a cursor wiggle.

**Modifiers:** Shift/Ctrl = additive/subtractive multi-select. Ctrl during endpoint drag suppresses snapping.

### Hover & Cursor

When idle, `move()` calls `handleHoverCursor(worldX, worldY)`. Priority (first match wins, all others fall through to default cursor):

1. **Pan ownership guard.** `panTool.isActive()` → bail (panTool owns 'grabbing' during MMB/spacebar pan; camera subscription routes those through `onViewChange` → here, so don't clobber).
2. Standard mode + selection + not editing → `hitResizeHandle` → `handleCursor(handle)`.
3. Connector mode → `hitEndpointDot` → 'grab'.
4. **Bookmark Open chip** (occlusion-aware via `pickTopmostPaint` — framed kinds paint `'ink'` on hit, so a bookmark winning the picker means the cursor is on visible bookmark pixels). On enter/leave, `invalidateWorldBBox(getOpenButtonWorldBBox(id))` so the base canvas repaints the chip's hover-fill. Cursor → 'pointer'.

SelectTool exposes `getHoveredOpenBookmarkId(): string | null` — `objects.ts` hoists this once per frame into `_hoveredOpenBookmarkId` and `drawObject`'s bookmark branch passes `_hoveredOpenBookmarkId === handle.id` to `drawBookmark`. `clearBookmarkOpenHoverIfAny()` runs at the start of every `begin()` (re-set by the openButton branch), on `cancel()`, on `onPointerLeave()`, and whenever a higher-priority cursor wins.

---

## Transform System (`transform.ts`)

The entry-based engine. SelectTool delegates lifecycle; renderer reads via module getters. All transform state lives in `TransformController`.

### Type system

```typescript
// Structural traits — functions typed by trait accept any kind whose Geo/Out has the field
type HasOrigin = { origin: Point };
type HasBBox = { bbox: BBoxTuple };
type HasFrame = { frame: FrameTuple };
type HasScale = { scale: number };
type HasFontSize = { fontSize: number };
type HasWidth = { width: number };
type HasPoints = { points: Point[] };

interface Entry<K extends ObjectKind = ObjectKind> {
  readonly id: string;
  readonly y: Y.Map<unknown>;
  readonly frozen: Readonly<GeoOf<K>>;  // immutable snapshot at begin
  out: OutOf<K>;                         // mutated per-frame, read by renderer
  prevBbox: BBoxTuple;                   // dirty-rect tracking
}
type EntryStore = { [K in ObjectKind]?: Map<string, Entry<K>> };

type ScalableKind = Exclude<ObjectKind, 'connector'>;  // connectors → topology
```

`GeoOf<K>` = frozen geometry per kind. `OutOf<K>` = mutable output. Trait composition (kept tight; behavior-specific fields are optional and only populated by behaviors that read them):

```
shape:    HasFrame & HasBBox
image:    HasFrame & HasBBox
stroke:   GeoOf = HasPoints & HasBBox & {width?}        OutOf = HasBBox & {factor, fcx, fcy}
text:     HasOrigin & HasBBox & {fontSize, width?, align?, measured?, minW?}
                                                         OutOf = +HasFontSize & HasWidth & {layout}
code:     HasOrigin & HasBBox & {fontSize?, width?, source?, lineNumbers?, …}
                                                         OutOf = +HasFontSize & HasWidth & {layout}
note:     HasOrigin & HasBBox & {scale?}                 OutOf = +HasScale
bookmark: HasOrigin & HasBBox & {scale?}                 OutOf = +HasScale
```

`text.fontSize` is **required** (no `?`) — every text behavior captures it, including translate/edgePin. Reason: `applyOffset` propagates `f.fontSize → o.fontSize` unconditionally so `fillDirty`'s italic-overhang pad math can read `out.fontSize` without branching on behavior.

`KindWithBBoxGeo = Exclude<ObjectKind, 'connector'>` — every non-connector has `bbox`. Exported and shared with `selection-overlay.ts`.

**Per-behavior freeze.** `freezeScaleEntry(kind, behavior, ...)` captures only fields the chosen behavior will read. `edgePin` delegates to `freezeTranslateEntry`; `uniform` adds the tracked scalar; `reflow` adds the layout inputs.

| Behavior | Per-kind freeze (beyond origin/frame/bbox) |
|---|---|
| translate / edgePin (text)     | `fontSize` — propagated by `applyOffset` so `fillDirty`'s italic-pad reads `out.fontSize` unconditionally |
| translate / edgePin (note, bookmark) | `scale` — propagated by `applyOffset` so `fillFrameFromBind`'s `ratio = out.scale / frozen.scale` works under translate (ratio = 1) |
| translate / edgePin (others)   | nothing extra |
| uniform (text/code)            | `fontSize`, `width` |
| uniform (note/bookmark)        | `scale` |
| uniform (stroke)               | `points`, `width` (only uniform commit reads them) |
| reflow (text)                  | `align`, `measured`, `minW` |
| reflow (code)                  | `source`, `lineNumbers`, `headerVisible`, `outputVisible`, `output`, `minW` |

**Stroke OutMap** drops `points`/`width` entirely. Apply mutates only `o.bbox` and stores `factor`/`fcx`/`fcy` for `ctx.scale` preview rendering. Commit reads `frozen.points` directly. **No per-frame point allocation regardless of stroke length.**

### Behavior resolution

```typescript
type ScaleBehavior = 'uniform' | 'nonUniform' | 'edgePin' | 'reflow';
```

**Default** (most kinds): single → `uniform`; multi → corner: `uniform`, sides: `edgePin`.

**Overrides** (only the exceptions):

| Key | Behavior |
|---|---|
| `shape_corner_single` | `nonUniform` (multi-shape corners → default `uniform` so groups scale together) |
| `shape_hSide_*`, `shape_vSide_*` | `nonUniform` (shapes always non-uniform on sides) |
| `text_hSide_*`, `code_hSide_*` | `reflow` (E/W handles re-layout at new width) |

`resolveBehavior(kind, handleId, single)` always returns a value (defaults provide fallback).

### Dispatch tables (3 + the unified `applyOffset`)

```typescript
type ScaleApplyTable     = { [K in ScalableKind]: Partial<Record<ScaleBehavior, ApplyFn<K>>> };
type ScaleCommitTable    = { [K in ScalableKind]: Partial<Record<ScaleBehavior, CommitFn<K>>> };
type TranslateCommitTable = { [K in ScalableKind]: CommitFn<K> };
```

Translate has **no apply table** — `updateTranslate` calls `applyOffset` directly for every kind.

`COMMIT_SCALE` includes frozen geometry as third param so stroke can defer point computation to commit. `TRANSLATE_COMMIT` reuses `commitFrame` / `commitOrigin` / `commitStrokeOffset` and shares the `(y, o, f) => void` signature.

**APPLY_SCALE:**

| Kind | uniform | nonUniform | edgePin | reflow |
|---|---|---|---|---|
| shape | `scaleFrameUniform` | `scaleFrameNonUniform` | — | — |
| image | `scaleFrameUniform` | — | `edgePinOffset` | — |
| stroke | `scaleStrokeBBox` | — | `edgePinOffset` | — |
| text | `scaleOriginFontSize` | — | `edgePinOffset` | `reflowText` |
| code | `scaleOriginFontSize` | — | `edgePinOffset` | `reflowCode` |
| note | `scaleOriginScale` | — | `edgePinOffset` | — |
| bookmark | `scaleOriginScale` | — | `edgePinOffset` | — |

**Commit fns:** `commitFrame` (shape/image), `commitOrigin` (text/code/note/bookmark edgePin + translate), `commitOriginScale` (note/bookmark uniform), `commitTextScale` (text uniform — skips width when frozen was `'auto'` → `NaN`), `commitCodeScale`, `commitReflow` (text/code reflow), `commitStrokeUniform` (reads `frozen.points/width`, applies `o.factor` around `bboxCenter(o.bbox)`), `commitStrokeOffset` (stroke edgePin + translate — reads `frozen.points + (o.bbox - f.bbox)`).

**Correlated-union casts:** `activeKinds` iteration can't prove `APPLY_SCALE[kind]` and `store[kind]` share K. ONE cast per loop with biome-ignore comment — the mapped table type already proves correctness at definition.

### Apply atoms compose primitives from `core/geometry/`

Two-liner shape/image: `scaleBBoxUniform`/`scaleBBoxEdges` then `derivePaddedFrame` rebuilds frame with **constant** stroke padding (output bbox = frame + constant pad — stroke doesn't scale). Shape `nonUniform` passes `MIN_SHAPE_FRAME_DIM + 2*pad` per axis into `scaleBBoxEdges` so `derivePaddedFrame` leaves the frame ≥ `MIN_SHAPE_FRAME_DIM` — connectors anchored to a shape collapsing through origin stay well-defined. Clamp reuses `computeReflowWidth`'s edge-pin (text/code reflow uses the same atom).

Stroke `scaleStrokeBBox` is bbox-only; stores `factor`/`fcx`/`fcy` for `ctx.translate/scale/translate` preview.

Text/code `scaleOriginFontSize` (shared): `scaleBBoxOriginProp` (bbox scale + `roundProp` + origin-from-relative-offset), then writes `fontSize` and `width`. Same math works for both because origin encodes the in-frame anchor offset naturally. Width uses `typeof f.width === 'number'` guard — text's `'auto'` produces `NaN` (skipped at commit).

Note/bookmark `scaleOriginScale`: same `scaleBBoxOriginProp` pattern with `scale` as tracked prop.

**Unified offset pipeline:**
```ts
function applyOffset(f, dx, dy, o) {
  if ('frame' in o)  offsetFrameMut(o.frame, f.frame, dx, dy);
  if ('origin' in o) offsetPoint(o.origin, f.origin, dx, dy);
  offsetBBox(o.bbox, f.bbox, dx, dy);
}
function edgePinOffset(f, ctx, o) {
  const [dx, dy] = edgePinDelta(f.bbox, ctx);
  applyOffset(f, dx, dy, o);
}
```
One function replaces six. Stroke also goes through this — only `bbox` updates per frame, commit (`commitStrokeOffset`) derives final points from `frozen.points + bbox delta`.

**Reflow:** `computeReflowWidth` + re-layout at new width. `reflowText` → `layoutMeasuredContent(frozen.measured, w, fontSize, o.layout)` (reuses the pre-allocated `TextLayout` buffer from `createOutFor`) + `anchorFactor(align)`. `reflowCode` → `layoutCodeSourceInto(frozen.source, fontSize, w, lineNumbers, o.layout)` (reuses the pre-allocated `CodeLayout` buffer). Both use `frozen.minW` (from `getMinCharWidth`/`getCodeMinWidth` at begin). The reflow buffer is allocated once at freeze; per-pointermove allocation is zero.

### TransformController

State: `store: EntryStore`, `activeKinds: ScalableKind[]`, `behaviors`, `scaleCtx: ScaleCtx | null`, `dx, dy`, `mode`, `topology`.

```
beginScale(selectedIds, handleId, origin, selBounds):
  clear() → newTopologyBuilder → loop selected ids (one getHandle each):
    connector  → builder.onSelectedConnector
    bindable   → freezeScaleEntry → createOutFor → store as Entry → builder.onSelectedBindable
  topology = builder.finalize()

updateScale(sx, sy):
  scaleCtx.sx/sy = ...; for each activeKind: APPLY_SCALE[kind][behavior] on all entries
  invalidate dirty rects; runTopologyScale(topology, scaleCtx)

beginTranslate / updateTranslate / commit / cancel: parallel structure
```

**`fillDirty`** inflates text rects by italic-overhang pad (read from `out.fontSize`, family-agnostic). Dirty rects invalidated before apply (old) and after (new) — `prevBbox` tuple reuse is load-bearing.

### Module getters (for renderer + overlay)

```typescript
getScaleEntry<K>(kind, id): Entry<K> | undefined  // generic flows through
getScaleBehavior(kind):     ScaleBehavior | undefined
getTransformMode():         'none' | 'scale' | 'translate' | 'endpointDrag'
getTranslateDelta():        [number, number] | null
getTransformTopology():     ConnectorTopology | null      // null in idle / endpointDrag
getEndpointDragEntry():     EndpointDragEntry | null      // null unless dragging
getTransformInjectIds():    readonly string[] | null      // controller-owned reused buffer
getTransformScaleCtx():     ScaleCtx | null
transformHasChange():       boolean              // overlay-only — gates begin→first-update reads
isOverlayUniform():         boolean              // overlay-only — uniform vs per-axis rect
getTranslateSelBounds():    BBoxTuple | null     // overlay-only — translate union frozen at begin
getController():            TransformController  // lazy singleton
```

### Scale-bounds invariants

- **`computeSelectionBounds()`** (zero-arg, in selection-store): union of `handle.bbox`. Exception: text uses `frameToBbox(getTextFrame())` — `handle.bbox` carries italic-overhang pad; overlay handles must sit on the visual frame.
- **Shape/image padding invariant.** `padding = strokeWidth/2 + 1`. During scale: bbox is scaled for position; frame derived by subtracting **constant** padding; output bbox = frame + constant pad. Prevents dirty-rect artifacts at small scales where scaled padding < actual stroke extent.
- **Stroke `ctx.scale` rendering.** Output stores `factor`/`fcx`/`fcy`; preview uses cached Path2D with `ctx.translate/ctx.scale/ctx.translate`. No per-frame point mutation.

---

## Connector Topology (`connector-topology.ts`)

Connectors never enter the per-kind entry store. The controller drives a builder inline with its single begin-phase freeze loop. **One `getHandle` per selected id, one per non-selected attached connector.**

### Endpoint state × connector mode

Two orthogonal classifications, decided at begin.

**Endpoint state** (per side, via `classifyEndpoint`):

| State | When | Side variant |
|---|---|---|
| `canonical` | anchored to non-selected bindable, OR free + connector unselected | `'static'` — endpoint baked once via `bakeCanonicalEndpoint` |
| `frame-bound` | anchored to a selected bindable | `'bind'` — `Pipeline.newAnchored`; per-frame `fillFrameFromBind` + `Pipeline.configAnchored` |
| `free-moving` | not anchored AND connector is selected | `'free'` — `Pipeline.newFree(scratch)`, `endpoint.pos === scratch` (alias) |

**Connector mode** (per connector, discriminant of `ConnectorEntry`):

| Mode | Condition | Per-frame |
|---|---|---|
| `static` | both endpoints canonical (only selected connectors enter) | none — renderer draws stored route |
| `translate` | both non-canonical AND gesture is `translate` | rigid bbox shift; renderer reads cached route + `ctx.translate(dx, dy)` |
| `reroute` | anything else | rebake non-static sides; `Pipeline.routeInto(start.endpoint, end.endpoint, ...)` |

### Shape

```typescript
type ConnectorEntry =
  | StaticEntry
  | TranslateEntry             // frozenStart/frozenEnd: Point | null  (cloned at begin; null = bound)
  | ElbowRerouteEntry          // RerouteEntryBase<ElbowSide>
  | StraightRerouteEntry;      // RerouteEntryBase<StraightSide>

type ConnectorTopology = {
  byId:                 ReadonlyMap<string, ConnectorEntry>;   // renderer lookup (all reroute variants share mode/currBbox/pointsBuf/validCount)
  translates:           readonly TranslateEntry[];
  elbowReroutes:        readonly ElbowRerouteEntry[];          // partitioned for monomorphic apply
  straightReroutes:     readonly StraightRerouteEntry[];
  attachedConnectorIds: ReadonlySet<string>;                   // non-selected connectors bound to a selected bindable
};

interface RerouteEntryBase<S> extends DirtyEntry {
  readonly mode: 'reroute';
  readonly start: S;             // ElbowSide | StraightSide; never null (canonical = kind:'static')
  readonly end:   S;
  readonly routeCtx: RouteContext;
  readonly pointsBuf: Point[];   // persistent buffer, .length may exceed validCount (HWM)
  validCount: number;            // -1 = routing failed this frame
}
```

The **per-pipeline Side unions** live here. `AnchorSource` fields (anchor / shapeId / interior) are inlined directly onto the `bind` variant so `side` IS structurally an `AnchorSource` — `Pipeline.configAnchored(out, frame, shapeType, side)` passes it as the source with no allocation. ELBOW bind also carries `shapeType` (frozen at begin) and `frame` (aliased to `endpoint.frame`). STRAIGHT bind carries the same minus `shapeType`; `frame` is aliased for `interior` variant, standalone scratch for `edge`.

**See `core/connectors/CLAUDE.md` "Side ownership model" for the full alias contract and frozen-at-begin invariants.** This file owns the topology integration angle; the connector docs own the pipeline contract.

### `fillFrameFromBind` (bind-side frame derivation)

Per-frame, for each bind side, write the live anchor frame into `side.frame`. For ELBOW + STRAIGHT-interior, `side.frame === side.endpoint.frame` (alias) — same write updates both.

| `bindKind` | Write |
|---|---|
| `shape`, `image` | `copyFrame(scratch, e.out.frame)` |
| `text`, `code` | `bboxToFrameMut(e.out.bbox, scratch)` (italic-overhang pad lives on `entry.prevBbox`, never on `out.bbox`) |
| `note`, `bookmark` | `[origin.x, origin.y, frozen.w × ratio, frozen.h × ratio]` where `ratio = out.scale / frozen.scale` |

Mode-agnostic: same function serves translate and scale because `applyOffset` propagates `f.scale → o.scale` (ratio = 1 under translate). After `fillFrameFromBind`, the apply loop calls `Pipeline.configAnchored(side.endpoint, side.frame, side.shapeType, side)`. ELBOW re-derives `endpoint.dir` via `projectAnchorToEdge` and writes `endpoint.pos` via `fillElbowAnchorPointInto`; STRAIGHT writes `endpoint.pos` via `fillAnchorPoint`. Frame slots written by `configAnchored` are self-writes when aliased.

### Free-side aliasing

Each free side owns a private `scratch: Point` allocated once at build. `Pipeline.newFree(scratch)` preserves the reference, so `endpoint.pos === scratch`. Per-frame apply mutates scratch slots; the endpoint sees updates automatically.

Per-side (not module-shared): the routing pipeline holds free `Point`s by reference and writes them into the returned route — sharing one scratch across two sides would corrupt one read. `originalPos` is also cloned at begin so a prior gesture's preserved Y.Map reference can't corrupt this gesture's baseline.

Free-apply math (`runTopologyScale` / `runTopologyTranslate`):
- Translate: `offsetPoint(s.scratch, s.originalPos, dx, dy)`.
- Scale: branch on `corner` (hoisted across both pipelines since it's gesture-stable). Corner → `preservePositionMut(s.scratch, …, uf)` so free endpoints track the selection's uniform corner scale. Side handles → axis-aligned `scaleAround` (inactive axis hardcoded `1` by `rawScaleFactors`).

### Monomorphic apply loops

Reroute entries are partitioned at finalize into `elbowReroutes` / `straightReroutes`. Each pipeline gets its own `apply*ReroutesScale/Translate` loop calling ELBOW or STRAIGHT directly — no `Pipeline<unknown>` cast in the hot path.

### Commit rule

> **Free endpoints commit a Point. Bound (and static) endpoints commit nothing. `points` is never committed.**

The bound shape's frame write in the same `transact()` triggers the observer reroute on tx end → `ConnectorRouter.rerouteCanonical` populates the local route cache → off-gesture consumers read the fresh cache.

- `commitTranslate(e, dx, dy)` reads `e.frozenStart`/`frozenEnd` (cloned at begin). Free → `y.set(side, [frozen + dx, frozen + dy])`. Bound → `null` frozen → no write. **No Y.Map read at commit.**
- `commitReroute(e)` reads each side. `'free'` → write a clone of `s.scratch`. `'static'` / `'bind'` → no-op. The clone is load-bearing: Y.Map preserves references, scratch must stay private.

### Public API

| Function | Called by |
|---|---|
| `newTopologyBuilder(mode, selectedIdSet) → TopologyBuilder` | `TransformController.beginScale/beginTranslate` |
| `builder.onSelectedConnector(id, handle)` / `.onSelectedBindable(id, kind, entry, handle)` | Per-id dispatch in the controller's freeze loop |
| `builder.finalize() → ConnectorTopology \| null` | End of controller's begin |
| `runTopologyScale(topology, ctx)` / `runTopologyTranslate(topology, dx, dy)` | After non-connector apply each frame |
| `commitTopology(topology, mode, dx, dy)` | Inside `commit()`'s transact block |
| `cancelTopology(topology)` | `TransformController.cancel()` |

### Topology-specific invariants

(In addition to the shared pool/alias contract in `core/connectors/CLAUDE.md`.)

1. **Zero per-frame allocation.** Per-side scratches built once at gesture begin; `pointsBuf` mutated find-or-push and grows only past its high-water mark. No `BindCtx` record — `AnchorSource` fields inlined.
2. **Zero per-frame Y.Map reads.** `RouteContext` (start/end/cap/width/cachedRoute/pipeline) built ONCE at `processConnector`; per-frame apply reads only side state + `entry.out.*`.
3. **No null Side slots.** Canonical sides are `kind: 'static'` — apply loop never branches on null.
4. **Apply paths of bindable kinds are untouched.** `fillFrameFromBind` reads `entry.out.*` / `entry.frozen.*`. The only apply-adjacent concession: `applyOffset` propagates `f.scale → o.scale` when both sides carry the field.

---

## Hit Testing

All hit logic in `core/spatial/` (see its CLAUDE.md). SelectTool is a pure consumer.

| Phase | Call | Returns | Behavior |
|---|---|---|---|
| Click target | `pickTopmostPaint([x, y], { px: 8 })` | `ObjectHandle \| null` | **Best candidate, not just topmost.** Frame-aware area tournament — small unfilled shape stacked above larger filled shape: smaller wins. |
| Marquee | `queryHandleIds(inBBox(marqueeBBox))` | `string[]` | **Precise per-kind intersection.** Shape-type aware (ellipse perimeter, diamond edges); polylines segment-wise; framed kinds against derived frame. |
| Resize handle | `hitResizeHandle([x, y], selectionBounds)` | `HandleId \| null` | Screen-space ~10px probe. Internally gates on `shouldShowHandles(bbox)` — `Math.max(w, h) * scale ≥ HANDLE_MIN_BBOX_PX (12)`. Same gate drives overlay visibility + cursor — render/hit/cursor always agree. |
| Endpoint dot | `hitEndpointDot([x, y], selectedIds)` | `EndpointHit \| null` | Screen-space nearest probe over selected connectors' endpoints. `EndpointHit.slot: Slot` (`0 \| 1`). |

Marquee uses no tolerance (exact region intersect).

---

## Rendering During Transforms (`renderer/layers/objects.ts`)

`drawObjects()` reads `useSelectionStore` for transform state and **resolves dispatch tokens once per frame** before iterating objects. No per-iteration optional chaining, no per-iteration `useSelectionStore.getState()`, no per-iteration kind switches the caller already knows.

Frame-top hoists:

```ts
_textEditingId / _codeEditingId             // module-state snapshot — leaf draw fns read these
_hoveredOpenBookmarkId                       // from selectTool.getHoveredOpenBookmarkId(); drawObject's
                                             // bookmark branch passes `_hoveredOpenBookmarkId === handle.id`
const topology = getTransformTopology()
const connEntries = topology?.byId           // null in idle / endpointDrag
const attachedSet = topology?.attachedConnectorIds  // ReadonlySet | null
const epDragEntry = getEndpointDragEntry()   // EndpointDragEntry | null
const epDragId    = epDragEntry?.id ?? null
const tdx / tdy   = isTranslating ? ctrl.dx/dy : 0  // hoisted scalars
```

Per object in ULID order:

- **Connector:** ONE Map.get (topology) OR ONE string equality (endpoint drag) + ONE dispatch (`drawConnectorEntry`):
  - `connEntries` non-null → `connEntries.get(handle.id)` (topology gestures).
  - else `epDragId !== null && handle.id === epDragId` → `epDragEntry` (endpoint drag).
  - Resolved `ce` → switch on `ce.mode`:
    - `'static'` → `drawConnector(ctx, handle)`.
    - `'translate'` → `ctx.translate(tdx, tdy)` + `drawConnector`.
    - `'reroute'` (topology scale-driven OR endpoint-drag synthetic) → `drawConnectorFromPoints(ctx, handle, ce.pointsBuf, ce.validCount)`.
  - No entry → `drawConnector(ctx, handle)` (off-gesture or partially-built).
- **Non-connector, not transforming or unselected:** `drawObject(ctx, handle)`.
- **Non-connector, translate:** `ctx.translate(tdx, tdy)` + `drawObject()`.
- **Non-connector, scale:** `renderScaleEntry(ctx, handle)` per-kind dispatch (closure-free `ctx.save/translate/scale/[body]/restore` inline at every site).

**Spatial-loop skip** during transforms: `selectedSet.has(id)` OR (`attachedSet !== null && attachedSet.has(id)`). The endpoint-drag id is already in `selectedSet` by drill invariant — no third branch needed. Tighter than checking `connEntries.has(id)` (which spans selected ∪ attached redundantly).

**Culling guard.** During transforms, inject IDs (selected ∪ attached-connectors via topology, OR the dragged connector for endpoint drag) are pushed using their preview bbox regardless of spatial-index query. The cull is **pre-dispatched** — outer switch on `transform.kind` resolves once per frame, inner loop is monomorphic. EndpointDrag's cull reads `epDragEntry` directly (no `for` loop ceremony for one ID).

**Endpoint drag's render path is structurally indistinguishable from a single-connector reroute** — the controller exposes a synthetic `EndpointDragEntry` (`mode: 'reroute'`, `pointsBuf`, `validCount`, `currBbox`) that flows through the same `drawConnectorEntry` dispatch as topology reroute entries. The renderer's only branch on endpoint drag is the frame-top accessor split (`connEntries` vs `epDragId`), not the hot per-iteration loop.

### `renderScaleEntry()` per kind

| Kind | uniform | reflow | edgePin (fallback) |
|---|---|---|---|
| shape | Build fresh Path2D from `entry.out.frame`, guard on bbox size | — | — |
| image | Bitmap at `entry.out.bbox` | — | — |
| stroke | `ctx.scale(factor)` on cached Path2D | — | `renderTranslatedEntry` |
| text | Cached layout + `ctx.scale(ratio)` around `out.origin` | Render `entry.out.layout` at `out.origin` | `renderTranslatedEntry` |
| code | Cached layout + `ctx.scale(ratio)` around `out.bbox` corner | Render `entry.out.layout` at `out.origin` | `renderTranslatedEntry` |
| note/bookmark | `ctx.scale(ratio)` around `out.origin`, then `drawObject()` | — | `renderTranslatedEntry` |

`renderTranslatedEntry()` (typed `Entry<KindWithBBoxGeo>`): delta = `out.bbox - frozen.bbox` → `ctx.translate(dx, dy)`.

---

## Selection Store (`stores/selection-store.ts`)

```typescript
interface SelectionState {
  selectedIds, mode, selectionKind, selectedIdSet, kindCounts,
  menuOpen, selectedStyles, inlineStyles, boundsVersion,
  transform: TransformState,    // {kind:'none'} | TranslateTransform | ScaleTransform | EndpointDragTransform
  marquee, textEditingId, codeEditingId,
}
```

`TranslateTransform` is a thin marker. `ScaleTransform` carries `{kind, initialDelta, clickOffset}` (gesture-frame constants for `rawScaleFactors`). `EndpointDragTransform` carries `{kind, connectorId, slot: Slot, currentPosition, currentSnap}` — renderer/UI only; the route buffer + bbox snapshots + `RouteContext` live on the controller. All entry state (frozen, output, topology, dx/dy, sx/sy, endpoint drag) lives in `TransformController`. The store orchestrates the whole gesture; SelectTool never touches the controller directly except for `getController().beginEndpointDrag(...)` at gesture start (controller needs the live handle to build `RouteContext`).

| Action | Effect |
|---|---|
| `setSelection(ids)` | Compose, reset transform/marquee, bump boundsVersion, refreshStyles |
| `clearSelection()` | Reset to defaults |
| `beginTranslate()` | `computeSelectionBounds()` → `ctrl.beginTranslate(selectedIdSet, selBounds)` + `{kind:'translate'}`. Bails early on null union. |
| `updateTranslate(dx, dy)` | `ctrl.updateTranslate` |
| `beginScale(handleId, downWorld)` | bounds → origin/handlePos → gesture math → `ctrl.beginScale` + `{kind:'scale', ...}` |
| `updateScale(worldX, worldY)` | `rawScaleFactors` → `ctrl.updateScale` |
| `endTransform()` | Routes by `transform.kind`: endpointDrag → `ctrl.commitEndpointDrag(currentSnap)`; translate/scale → `ctrl.hasChange() ? commit() : clear()`. Then `{kind:'none'}`. |
| `cancelTransform()` | `ctrl.cancel()` (handles all gesture modes) + `{kind:'none'}` |
| `beginEndpointDrag(connectorId, slot)` | Set endpointDrag transform discriminant. Controller is begun separately via `getController().beginEndpointDrag(connectorId, slot, handle)`. |
| `updateEndpointDrag(currentPosition, currentSnap)` | Patch the discriminant — overlay reads it for snap feedback + dragged dot. Controller is updated separately via `getController().updateEndpointDrag(worldX, worldY, snap)`. |
| `begin/endTextEditing`, `begin/endCodeEditing`, `refreshStyles` | Editing state + style snapshot upkeep |

`computeSelectionBounds()` (zero-arg) serves triple duty: idle overlay bounds, scale gesture bounds, translate-frozen union. Reads `selectedIds → textEditingId → codeEditingId` fallback chain. Returns `null` on empty selection (causes both begin-fns to bail). Text uses `frameToBbox(getTextFrame())`; all others use `handle.bbox`.

---

## Endpoint Drag

Only in connector mode (single connector selected). **Owned by `TransformController`** as a third gesture mode alongside scale and translate. SelectTool delegates lifecycle; the controller's synthetic `EndpointDragEntry` (`mode: 'reroute'`, `pointsBuf`, `validCount`, `currBbox`) flows through `drawConnectorEntry` — same dispatch the topology reroute entries use. The renderer cannot tell endpoint drag from a single-connector reroute and shouldn't have to.

**Controller state** (`TransformController.endpointDrag`, logical only):
- `entry: EndpointDragEntry` — alias to `epDragEntryScratch` (controller-owned scratch allocated once at construction). Renderer reads directly via `getEndpointDragEntry()`.
- `routeCtx: RouteContext` — `buildRouteContext(connectorId, handle.y)` once at begin; gesture-stable.
- `slot: Slot` — which endpoint moves (0 = start, 1 = end).
- `prevBbox: BBoxTuple` — alias to `epDragPrevBbox` (controller-owned scratch).

**Controller scratches** (allocated once at construction, mutated per gesture):
- `epDragEntryScratch: EndpointDragEntry` — `id` reset per begin; `currBbox` slots and `pointsBuf` mutated per frame; `validCount` reset per begin and updated per frame.
- `epDragPrevBbox: BBoxTuple` — slots mutated per frame.
- `injectIds: string[]` — shared with scale/translate; reset to length 0 then pushed `connectorId` (single element) per `beginEndpointDrag`.

**No wrapper collections.** No `Map<string, ConnectorEntry>` and no `injectIds: readonly string[]` allocations per gesture — the renderer dispatches off the controller's accessor (`getEndpointDragEntry()`) directly.

**Lifecycle (controller methods):**
1. `beginEndpointDrag(connectorId, slot, handle): boolean` — clears state, builds RouteContext (returns `false` on a partially-built connector), mutates the scratches (`id`, `currBbox`, `pointsBuf.length=0`, `validCount=0`, `prevBbox`), pushes the id into `injectIds`, sets `mode = 'endpointDrag'`. Per-gesture allocation: zero.
2. `updateEndpointDrag(worldX, worldY, snap)` — snapshots `entry.currBbox → prevBbox` BEFORE the reroute, invalidates OLD, calls `rerouteEndpointDragInto(routeCtx, slot, snap ?? [x, y], entry.currBbox, entry.pointsBuf)`, invalidates NEW. The snapshot order is load-bearing.
3. `commitEndpointDrag(snap): boolean` — invalidates dirty rects, writes `anchorRecordFromSnap(snap)` xor a free `Point` cloned from `pointsBuf[slotPointIndex(slot, validCount)]` to Y.Map (inside `transact()`), tears down state. Returns `false` on `validCount < 2` (no commit). Scratches are left as-is for the next gesture.
4. `cancel()` — when `endpointDrag` is non-null, invalidates the precise dirty rects and clears (no full repaint).

**SelectTool** at gesture begin: `getController().beginEndpointDrag(connectorId, slot, handle)`; `useSelectionStore.getState().beginEndpointDrag(connectorId, slot)` for the store discriminant. Per move: read `connectorType` from the live handle, compute snap via `findBestSnapTarget`, call `getController().updateEndpointDrag(...)` + `useSelectionStore.getState().updateEndpointDrag(currentPosition, snap)`. End/cancel route through `endTransform()` / `cancelTransform()` like other gestures.

**Commit rule.** Free Point xor `StoredAnchor`. The deep observer reroutes canonically post-tx, populating the local route cache.

**Slot naming.** `Slot = 0 | 1` (`SLOT_START`/`SLOT_END`) lives in `core/connectors/reroute-connector.ts`. Helpers there: `slotKey(s)` (Y.Map field name at the storage boundary), `slotOther(s)` (1 - s), `slotPointIndex(s, count)` (branchless: `s * (count - 1)`).

---

## Selection Utils + Field Table

Two collaborating files:

- **`selection-utils.ts`** — composition + style aggregation:
  - `computeSelectionComposition(ids)` — single-pass `counts[handle.kind]++` → `KindCounts = Record<ObjectKind, number> & { total }`. Derive `selectionKind` by counting non-zero buckets.
  - `computeStyles(ids, kind)` — declarative `foldField` composition over the field table. Returns `EMPTY_STYLES` for `none`/`mixed`/`image`/`bookmark`. Code-only fields gate on `kind === 'code'` so non-code selections don't surface stale values.
  - `computeUniformInlineStyles(ids)` — bold/italic/highlight across text/labeled-shape/note. Stays standalone (its bool-AND-fold doesn't fit `Aggregate<V>`'s "first-or-mixed" shape).

- **`selection-field-table.ts`** — single source of truth for "what fields exist, how they're read/written/persisted per kind". Adding a property = appending one `FieldDescriptor` entry.

```ts
interface FieldDescriptor<V> {
  read:    { [K in ObjectKind]?: (h: ObjectHandle) => V | undefined };
  write:   { [K in ObjectKind]?: (h: ObjectHandle, v: V) => void };
  accepts?: { [K in ObjectKind]?: (h: ObjectHandle) => boolean };
  persist?: { [K in SelectionKind]?: (v: V) => void };
  equals?:  (a: V, b: V) => boolean;
}
interface Aggregate<V> { value: V | null; mixed: boolean; second: V | null }
```

**Primitives:**
- `foldField(handles, f) → Aggregate<V>` — first-or-mixed read aggregation.
- `applyField(ids, f, value)` — opens one `transact()`, dispatches per-kind writes, persists by `SelectionKind` (skipped on `mixed`/`none`), refreshes styles. Multi-key writes (e.g. `TEXT_ALIGN`'s origin recompute, `CODE_FONT_SIZE`'s proportional width) live inside the writer closure — atomic inside the open transact.
- `toggleField(ids, f, fallback)` — first-applicable read → `applyField(!current)`. Replaces the 3 byte-identical code-toggle clones (line-numbers / header / output) and bold/italic.
- `adjustByPresets(ids, f, presets, dir, current, min, max)` — clamp or step through preset list. Replaces both inc/dec preset pairs (text + code).
- `withEditorOr(whenEditor, otherwise)` — Tiptap fast-path for bold/italic/highlight. The field layer never depends on Tiptap.

**Descriptors** (~17): `COLOR`, `WIDTH`, `FILL_COLOR`, `SHAPE_TYPE`, `TEXT_COLOR`, `FONT_SIZE`, `FONT_FAMILY`, `TEXT_ALIGN`, `TEXT_ALIGN_V`, `BOLD`, `ITALIC`, `HIGHLIGHT`, `CODE_LANGUAGE`, `CODE_FONT_SIZE`, `LINE_NUMBERS`, `HEADER_VISIBLE`, `OUTPUT_VISIBLE`. All reuse existing accessors and persist sinks.

**Source-of-ids selection** (`getSelectedIds()` / `getTextSelectionIds()` / `getCodeIds()`) lives at the action layer in `selection-actions.ts`. It's "who's calling," not "what the field is." Trying to model it on the descriptor adds the wrong axis.

**Correlated-union cast** at the dispatch boundary (`(f as AnyDescriptor).write[h.kind]`) — one cast per loop with `// biome-ignore`, mirroring the `APPLY_SCALE[kind][behavior]` cast in `transform.ts`. The mapped table proves correctness at definition. (Spatial hit dispatch moved away from this pattern in `core/spatial/hit-dispatch.ts` — see its switch-based dispatchers.)

**Adding a property** is four mechanical edits, no control-flow change:
1. Append one `FieldDescriptor` entry to `selection-field-table.ts`.
2. Add one line to `selection-actions.ts`: `export const setSelectedX = (v) => applyField(getSelectedIds(), X, v);`.
3. Add one `foldField` call + one record field to `computeStyles` in `selection-utils.ts`.
4. Add the field to `SelectedStyles` + `EMPTY_STYLES` + `stylesEqual` in `types.ts`.

`deleteSelected` stays imperative — it's a structural op with a connector-detach prelude, not a property write. Uniformity for its own sake is anti-leverage.

---

## Context Menu

SelectTool controls visibility:
- `begin()` → `contextMenuController.hide()` (always)
- `end()` / `cancel()` → `contextMenuController.show()` (if selection or editing active)
- Single text re-click → `cancelHide()` to prevent flash

Store fields consumed by context menu are documented in `components/context-menu/CLAUDE.md`.
