# Selection System

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail level when updating — don't inflate coverage of one change at the expense of the big picture.

SelectTool + transform system + selection store + hit testing + transform rendering. The most complex tool in the codebase: handles translate, scale (per-kind-aware), connector endpoint drag, marquee, multi-select, text/code editing entry, and Z-order-aware hit testing.

## Architecture

```
SelectTool.ts (PointerTool singleton via tool-registry)
├── State machine: idle → pendingClick → marquee | translate | scale | endpointDrag
├── Hit testing via core/spatial/ (see core/spatial/CLAUDE.md — owns all hit logic)
├── Delegates to TransformController for scale/translate lifecycle
├── Commits endpoint drags directly via transact()
└── Preview data → overlay + base canvas rendering

transform.ts (entry-based transform engine)
├── TransformController class — encapsulates all mutable transform state
├── Structural trait types (HasOrigin, HasFrame, etc.) for function reuse
├── GeoOf<K> / OutOf<K> mapped types — per-kind frozen/output geometry
├── Entry<K> + EntryStore — generics survive through indexed access
├── Behavior table: defaults + 9 overrides (replaces prior 42-entry flat table)
├── 4 mapped dispatch tables: APPLY_SCALE, COMMIT_SCALE, TRANSLATE_APPLY, TRANSLATE_COMMIT
├── Apply functions (13): trait-typed for reuse, kind-specific where needed
├── Commit functions (8): write OutOf<K> fields to Y.Map
├── Freeze/factory functions: snapshot Y.Map → frozen geometry, pre-allocate output
├── Topology integration: reroutes connectors per-frame
└── Module singleton + renderer getters (getScaleEntry, getScaleBehavior, etc.)

selection-store.ts (Zustand + subscribeWithSelector)
├── selectedIds, mode, selectionKind, kindCounts
├── transform: { kind: 'none' } | TranslateTransform | ScaleTransform | EndpointDragTransform
├── marquee, textEditingId, codeEditingId
├── selectedStyles, inlineStyles, boundsVersion (context menu support)
└── Orchestrates TransformController: begin/update/end/cancelTransform route through getController()

tools/selection/types.ts (shared type home)
├── SelectionKind = ObjectKind | 'none' | 'mixed'  — matches object taxonomy 1:1
├── KindCounts = Record<ObjectKind, number> & { total }  — singular keys
├── TransformState discriminant (ScaleTransform carries handleId/selBounds/origin)
├── ScaleCtx (gesture bundle for scale-system.ts atoms)
└── SelectedStyles, InlineStyles, MarqueeState

tools/selection/connector-topology.ts
├── ConnectorTopology + ConnectorEntry (static | translate | reroute discriminated union)
├── newTopologyBuilder(mode, selectedIdSet) — controller drives inline with its freeze loop
├── runTopologyScale / runTopologyTranslate — per-frame apply (pure dispatch, zero allocation)
└── commitTopology / cancelTopology

selection-utils.ts (pure functions — zero-arg where possible)
├── computeSelectionComposition(ids) → kind, mode, counts (buckets via counts[kind]++)
├── computeStyles(ids, kind) → SelectedStyles
└── computeUniformInlineStyles(ids) → InlineStyles

(computeSelectionBounds lives in selection-store.ts — reads store state directly, no circular import)

selection-actions.ts (mutation functions — documented in context-menu/CLAUDE.md)

core/geometry/scale-system.ts (pure math atoms — NO STATE)
├── scaleAround(), round3(), roundProp() — number primitives
├── rawScaleFactors() — cursor→factors from initialDelta
├── uniformFactor(sx, sy, handleId) — handle-aware collapse to 1 signed magnitude
├── preservePosition() / preservePositionMut() — relative 0-1 position in scaled/flipped box (mut writes `out` for zero-alloc hot paths)
├── edgePinPosition1D() — 1D edge-pin position. Spans-full-axis fast-path translates via scaleAround on center; otherwise straddle-aware (origin objects pin near, others pin far)
└── computeReflowWidth() — edge-scaling + min-width clamping for text/code

core/geometry/bounds.ts (bbox/frame helpers)
├── frameToBbox, frameToBboxMut, copyBbox, bboxCenter, bboxSize
├── scaleBBoxAround, translateBBox, expandBBoxEnvelope
└── offsetPoint, offsetBBox, offsetFrame, offsetPoints, setBBoxXYWH — mutating transform primitives

core/types/handles.ts (handle taxonomy)
├── HandleId = CornerHandle | SideHandle
├── isCorner(), isHorzSide(), isVertSide() — type guards
├── scaleOrigin() — opposite handle position
└── handleCursor() — CSS cursor string

core/spatial/ (see core/spatial/CLAUDE.md — owns all hit logic)
├── pickTopmostPaint()    → ObjectHandle  (click: frame-aware tournament)
├── queryHandleIds()      → string[]      (marquee/eraser: precise per-kind intersect)
├── hitResizeHandle()     → HandleId      (resize handles; gates on shouldShowHandles)
├── hitEndpointDot()      → EndpointHit   (connector mode)
└── shouldShowHandles()   → bool          (single visibility/hit/cursor gate; Math.max ≥ 12px)

renderer/layers/objects.ts (base canvas — consumer of transform getters)
├── drawObjects() — main dispatch, reads selectionStore for transform preview
├── renderScaleEntry() — per-kind scale dispatch using getScaleEntry/getScaleBehavior
└── renderTranslatedEntry() — edge-pin fallback via bbox delta

renderer/layers/selection-overlay.ts (overlay canvas — selection chrome)
├── drawSelectionOverlay() — discriminates by mode: connector → endpoint dots only;
│                            single non-connector → bounds rect IS the highlight + handles;
│                            multi → per-object highlights + selection rect + handles
├── currentBoundsForHandle() / currentFrameForShape() — gated by transformHasChange()
│                            so begin→first-update gap falls back to idle geometry
└── selectionRectForOverlay() — uniform-aware (uniformFactor when isOverlayUniform());
                                frozen-at-begin during translate (getTranslateSelBounds())
```

---

## State Machine (SelectTool.ts)

### Phases

```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';
```

### Target Classification

At `begin()`, click target is classified into one of:

```typescript
type DownTarget =
  | 'none'
  | 'handle'                  // Resize handle (standard mode, no text/code editing)
  | 'connectorEndpoint'       // Endpoint dot (connector mode)
  | 'objectInSelection'       // Object already selected
  | 'objectOutsideSelection'  // Object not selected
  | 'selectionGap'            // Empty space inside selection bounds (standard mode)
  | 'background';             // Empty space outside selection bounds
```

### Constants

```typescript
HIT_RADIUS_PX = 6       // Screen-space hit radius for object selection
HIT_SLACK_PX = 2.0      // Additional tolerance (total = 8px screen)
MOVE_THRESHOLD_PX = 4   // Screen-space pixels before drag detected
CLICK_WINDOW_MS = 180   // Time threshold for gap click disambiguation
```

### begin() Flow

```
1. Always: contextMenuController.hide()
2. Convert world → screen for threshold checking
3. Priority hit testing (mode-specific):
   Standard mode (has selection, not editing text/code):
     → hitResizeHandle() → downTarget = 'handle'
   Connector mode:
     → hitEndpointDot() → downTarget = 'connectorEndpoint'
4. Common object hit test:
   → hitTestObjects() → 'objectInSelection' or 'objectOutsideSelection'
5. No object hit:
   Standard mode → check pointInBBox(selectionBounds) → 'selectionGap'
   Otherwise → 'background' (clearSelection if had selection)
6. phase = 'pendingClick' for all targets
```

**Single text/code re-click exception:** When clicking a single-selected text/code/note object, `cancelHide()` is called immediately after `hide()` to prevent context menu flash.

### pendingClick → Phase Transition (in move())

Each target type requires `passMove` (dist > MOVE_THRESHOLD_PX) before transitioning. `selectionGap` and `background` also accept `passTime` (elapsed >= CLICK_WINDOW_MS).

| DownTarget | Transition | Notes |
|------------|------------|-------|
| `handle` | → `scale` | `store.beginScale(handleId, downWorld)` — store owns the whole gesture (bounds, origin, initialDelta, clickOffset, controller) |
| `connectorEndpoint` | → `endpointDrag` | Drill to single connector if multi-selected |
| `objectOutsideSelection` | → `translate` | First selects object. Anchored connectors → `marquee` instead |
| `objectInSelection` | → `translate` | Anchored connectors in connector mode → `marquee` instead |
| `selectionGap` | → `translate` | Gap drag = translate entire selection |
| `background` | → `marquee` | Empty area drag = marquee select |

### Scale Phase (begin + move)

SelectTool hands the store raw cursor coords and nothing else. Gesture math lives entirely in the store.

**Begin** — `store.beginScale(handleId, downWorld)`:
1. `computeSelectionBounds()` → selBounds
2. `scaleOrigin(handleId, selBounds)` → origin; `handlePosition(handleId, selBounds)` → handlePos
3. `initialDelta = handlePos - origin` (handle-to-origin vector)
4. `clickOffset = downWorld - handlePos` (cursor-to-handle gap, stays constant throughout drag so the grabbed pixel tracks the cursor)
5. `ctrl.beginScale(selectedIdSet, handleId, origin, selBounds)`
6. Set `transform = { kind: 'scale', initialDelta, clickOffset }`

The controller owns `handleId`/`origin`/`selBounds` (needed per-apply via `scaleCtx`). The store owns `initialDelta`/`clickOffset` (gesture math for `rawScaleFactors`). No duplication.

**Move** — `store.updateScale(worldX, worldY)`:
1. Narrow `transform` to `kind === 'scale'`, read `scaleCtx` from controller for `handleId`/`origin`
2. `rawScaleFactors(worldX - clickOffset[0], worldY - clickOffset[1], origin, initialDelta, handleId)` → [sx, sy]
3. `ctrl.updateScale(sx, sy)` — applies to all entries + topology

### Translate Phase (move)

```
store.updateTranslate(worldX - downWorld[0], worldY - downWorld[1])
```

### end() — Click Finalization (pendingClick)

| DownTarget | Click Behavior |
|------------|----------------|
| `handle` | No-op (didn't drag) |
| `connectorEndpoint` | Drill to single connector |
| `objectOutsideSelection` | Shift/Ctrl: additive select. Else: replace selection |
| `objectInSelection` | Shift/Ctrl: subtractive remove. Multi: drill to single. Single text/note/shape: enter text editing. Single code: enter code editing |
| `selectionGap` | Quick tap (< 180ms, < 4px): deselect. Longer: keep |
| `background` | Deselect |

### end() — Transform Commit (translate/scale)

```
store.endTransform()  // commits-or-clears the controller internally, resets discriminant
```

`store.cancelTransform()` does the same for Esc mid-drag. SelectTool never touches `getController()` for these lifecycle events — the store owns the sequence.

### Modifier Keys

- **Shift or Ctrl/Cmd** (`hasAddModifier()`): additive/subtractive multi-select on click
- **Ctrl** during endpoint drag: suppresses connector snapping

---

## Transform System (transform.ts)

The entry-based transform engine. SelectTool delegates lifecycle, renderer reads via module getters. All transform state lives in `TransformController`.

### Type System

#### Structural Traits

```typescript
type HasOrigin = { origin: Point };
type HasBBox = { bbox: BBoxTuple };
type HasFrame = { frame: FrameTuple };
type HasScale = { scale: number };
type HasFontSize = { fontSize: number };
type HasWidth = { width: number };
type HasPoints = { points: Point[] };
```

Functions typed with traits accept any kind whose Geo/Out extends the trait via structural subtyping. Example: `edgePinOffset(f: HasBBox, ctx, o: HasBBox)` accepts every scalable kind because every `GeoOf<K>`/`OutOf<K>` has `bbox`; the field-presence runtime check in `applyOffset` (`'frame' in o`, `'origin' in o`) handles the kind-specific writes.

#### GeoOf<K> / OutOf<K> (Mapped Types)

`GeoOf<K>` = frozen geometry snapshot from Y.Map at transform begin.
`OutOf<K>` = mutable output written per-frame by apply functions, read by renderer.

```
GeoMap / OutMap composed from traits. Optional fields are behavior-specific
(freeze writes only what the chosen behavior will actually read).

  shape:    GeoOf = HasFrame & HasBBox               OutOf = HasFrame & HasBBox
  image:    GeoOf = HasFrame & HasBBox               OutOf = HasFrame & HasBBox
  stroke:   GeoOf = HasPoints & HasBBox & { width? } OutOf = HasBBox & { factor, fcx, fcy }
  text:     GeoOf = HasOrigin & HasBBox & { fontSize?, width?, align?, measured?, minW? }
            OutOf = HasOrigin & HasFontSize & HasWidth & HasBBox & { layout }
  code:     GeoOf = HasOrigin & HasBBox & { fontSize?, width?, sourceLines?, lineNumbers?, ... }
            OutOf = HasOrigin & HasFontSize & HasWidth & HasBBox & { layout }
  note:     GeoOf = HasOrigin & HasBBox & { scale? }  OutOf = HasOrigin & HasScale & HasBBox
  bookmark: GeoOf = HasOrigin & HasBBox & { scale? }  OutOf = HasOrigin & HasScale & HasBBox
  connector: never (handled by topology)
```

**Per-behavior freeze:** `freezeScaleEntry(kind, behavior, ...)` captures only fields the chosen
behavior will read. `edgePin` delegates to `freezeTranslateEntry` (needs nothing kind-specific —
just frame/origin/bbox). `uniform` adds `fontSize`/`width`/`scale` depending on kind. `reflow`
additionally captures `align`/`measured`/`minW` (text) or `sourceLines`/`lineNumbers`/`headerVisible`/`outputVisible`/`output`/`minW` (code). Apply functions assert their required fields with `!`
— the behavior table already proves which apply function sees which frozen shape.

**Stroke OutMap** drops `points`/`width` entirely. Gestures only mutate `o.bbox`; renderer reads
`factor`/`fcx`/`fcy` for `ctx.scale` rendering; commit reads `frozen.points` directly. No per-frame
point array allocation regardless of stroke length.

#### Entry<K> + EntryStore

```typescript
interface Entry<K extends ObjectKind = ObjectKind> {
  readonly id: string;
  readonly y: Y.Map<unknown>;
  readonly frozen: Readonly<GeoOf<K>>;  // Immutable snapshot
  out: OutOf<K>;                         // Mutated per-frame
  prevBbox: BBoxTuple;                   // Dirty rect tracking
}

type EntryStore = { [K in ObjectKind]?: Map<string, Entry<K>> };
```

Generics survive through indexed access: `EntryStore[K]` → `Map<string, Entry<K>> | undefined`.

#### ScalableKind

```typescript
type ScalableKind = Exclude<ObjectKind, 'connector'>;
```

Connectors are handled by topology, never enter the entry system.

### Behavior Resolution

Scale behavior depends on three factors: **object kind**, **handle category** (corner/hSide/vSide), and **selection size** (single = 1 obj / multi = 2+ objs).

```typescript
type ScaleBehavior = 'uniform' | 'nonUniform' | 'edgePin' | 'reflow';
```

**Default behavior** (applies to most kinds):

| Handle | single (1 obj) | multi (2+ objs) |
|--------|----------------|-----------------|
| corner | uniform | uniform |
| hSide | uniform | edgePin |
| vSide | uniform | edgePin |

**9 overrides** (only the exceptions):

| Key | Behavior | Why |
|-----|----------|-----|
| `shape_corner_single` | nonUniform | Lone shape scales independently per-axis (multi-shape corners fall through to default `uniform` so groups scale together) |
| `shape_hSide_single/multi` | nonUniform | Shapes always non-uniform on sides |
| `shape_vSide_single/multi` | nonUniform | Shapes always non-uniform on sides |
| `text_hSide_single/multi` | reflow | E/W handles re-layout text at new width |
| `code_hSide_single/multi` | reflow | E/W handles re-layout code at new width |

`resolveBehavior(kind, handleId, single)` → returns `ScaleBehavior` (never undefined — defaults always provide a value).

### Dispatch Tables

Four mapped-type tables enforce kind→function compatibility at compile time:

```typescript
type ScaleApplyTable = { [K in ScalableKind]: Partial<Record<ScaleBehavior, (f: GeoOf<K>, ctx: ScaleCtx, o: OutOf<K>) => void>> };
type ScaleCommitTable = { [K in ScalableKind]: Partial<Record<ScaleBehavior, (y: Y.Map<unknown>, o: OutOf<K>, f: Readonly<GeoOf<K>>) => void>> };
type TranslateApplyTable = { [K in ScalableKind]: (f: GeoOf<K>, dx: number, dy: number, o: OutOf<K>) => void };
type TranslateCommitTable = { [K in ScalableKind]: (y: Y.Map<unknown>, o: OutOf<K>) => void };
```

ScaleCommitTable includes frozen geometry as third param (used by stroke to defer point computation to commit time). Functions with fewer params are assignable via TS arity rule.

Trait-typed functions satisfy mapped slots via contravariance: `(f: HasFrame) => void` is assignable to `(f: GeoOf<'shape'>) => void` because `GeoOf<'shape'>` extends `HasFrame`.

**APPLY_SCALE table:**

| Kind | uniform | nonUniform | edgePin | reflow |
|------|---------|------------|---------|--------|
| shape | scaleFrameUniform | scaleFrameNonUniform | — | — |
| image | scaleFrameUniform | — | edgePinOffset | — |
| stroke | scaleStrokeBBox | — | edgePinOffset | — |
| text | scaleOriginFontSize | — | edgePinOffset | reflowText |
| code | scaleOriginFontSize | — | edgePinOffset | reflowCode |
| note | scaleOriginScale | — | edgePinOffset | — |
| bookmark | scaleOriginScale | — | edgePinOffset | — |

**COMMIT_SCALE** follows the same table shape with per-kind commit functions. Translate uses no dispatch table: `updateTranslate` calls `applyOffset` directly for every kind, and `TRANSLATE_COMMIT` is one record of commit functions keyed by kind.

### Apply Functions — atoms compose atoms

All apply functions compose primitives from `core/geometry/scale-system.ts`
(`scaleBBoxUniform`, `scaleBBoxEdges`, `edgePinDelta`, `derivePaddedFrame`, `scaleAround`,
`roundProp`, `computeReflowWidth`) + offset primitives from `core/geometry/bounds.ts`.

**Shape/image (`scaleFrameUniform`, `scaleFrameNonUniform`):** two-liners — scale bbox via
`scaleBBoxUniform`/`scaleBBoxEdges`, then `derivePaddedFrame` rebuilds the frame with **constant**
stroke padding. Output bbox = frame + constant padding (stroke width doesn't scale with the
transform).

**Stroke uniform (`scaleStrokeBBox`):** bbox-only update. Stores frozen bbox center + absolute
factor on output (`factor`/`fcx`/`fcy`) for `ctx.translate/scale/translate` preview rendering.
**No per-frame point mutation** — frozen points are only read at commit.

**Text/code uniform (`scaleOriginFontSize`):** shared function. Calls `scaleBBoxOriginProp` (bbox
scale + `roundProp` + origin-from-relative-offset), then writes `fontSize` and `width`. Width uses
a `typeof f.width === 'number'` guard — text's `'auto'` width produces `NaN` (skipped at commit),
code's width always falls through. Same math works for both because origin encodes the in-frame
anchor offset naturally (`new_origin = new_bbox_min + (frozen_origin - frozen_bbox_min) * ef`).

**Note/bookmark uniform (`scaleOriginScale`):** same `scaleBBoxOriginProp` pattern with `scale`
as the tracked prop.

**Unified offset pipeline (`applyOffset` + `edgePinOffset`):** the core collapse. Field-presence
runtime check (`'frame' in o`, `'origin' in o`) picks which offset primitives to call:
```ts
function applyOffset(f, dx, dy, o) {
  if ('frame' in o) offsetFrameMut(o.frame, f.frame, dx, dy);
  if ('origin' in o) offsetPoint(o.origin, f.origin, dx, dy);
  offsetBBox(o.bbox, f.bbox, dx, dy);
}
function edgePinOffset(f, ctx, o) {
  const [dx, dy] = edgePinDelta(f.bbox, ctx);
  applyOffset(f, dx, dy, o);
}
```
One function replaces six (`edgePinFrame`/`edgePinOriginBbox`/`edgePinPoints`/`edgePinText`/
`edgePinCode` + all three `applyTranslate*`). Stroke no longer mutates points during edgePin or
translate — only `bbox` updates per frame; commit reads frozen points + bbox delta.

**Reflow (`reflowText`, `reflowCode`):** `computeReflowWidth` + re-layout at new width.
`reflowText` calls `layoutMeasuredContent(frozen.measured, targetWidth, fontSize)` and uses
`anchorFactor(align)` for origin offset. `reflowCode` calls `computeCodeLayout(frozen.sourceLines,
fontSize, targetWidth, lineNumbers)`. Both use `frozen.minW` (captured at `beginScale` via
`getMinCharWidth`/`getCodeMinWidth`). These are the only behaviors that need kind-specific frozen
data beyond origin/bbox.

### Commit Functions

| Function | Writes | Used by |
|----------|--------|---------|
| `commitFrame` | frame | shape, image (all behaviors) |
| `commitOrigin` | origin | text/code edgePin + translate, note/bookmark edgePin + translate |
| `commitOriginScale` | origin, scale | note/bookmark uniform |
| `commitTextScale` | origin, fontSize, width | text uniform (skips width when frozen was `'auto'` → `NaN`) |
| `commitCodeScale` | origin, fontSize, width | code uniform |
| `commitReflow` | origin, width | text/code reflow |
| `commitStrokeUniform` | points, width | stroke uniform (reads frozen.points/width, applies `o.factor` around `bboxCenter(o.bbox)`) |
| `commitStrokeOffset` | points | stroke edgePin + translate (reads `frozen.points` + `o.bbox - f.bbox` delta — no frozen width needed) |

`TRANSLATE_COMMIT` reuses `commitFrame`/`commitOrigin`/`commitStrokeOffset` — no dedicated translate commit functions. `TRANSLATE_COMMIT`/`COMMIT_SCALE` share the `(y, o, f) => void` signature so translate commit can access frozen geometry (needed by `commitStrokeOffset`).

### TransformController

Encapsulates all mutable transform state. Module singleton via `getController()`.

**State:**
```
store: EntryStore              — per-kind maps of Entry<K>
activeKinds: ScalableKind[]    — kinds present in current transform
behaviors: Partial<Record<ScalableKind, ScaleBehavior>>
scaleCtx: ScaleCtx | null      — { sx, sy, origin, selBounds, handleId }
dx, dy: number                 — translate delta
mode: 'none' | 'scale' | 'translate'
topology: ConnectorTopology | null
```

**Lifecycle:**

```
beginScale(selectedIds, handleId, origin, selBounds):
  1. clear() — reset all state; single = (selectedIds.size === 1)
  2. builder = newTopologyBuilder('scale', selectedIds)
  3. For each selected id (one getHandle per id):
     - connector → builder.onSelectedConnector(id, handle); continue
     - non-connector:
       a. resolveBehavior(kind, handleId, single) → ScaleBehavior
       b. freezeScaleEntry(kind, behavior, id, y, bbox) → frozen geometry snapshot
       c. createOutFor(kind, frozen) → pre-allocated output
       d. Store as Entry in store[kind]
       e. if bindable → builder.onSelectedBindable(id, kind, entry, handle)
  4. this.topology = builder.finalize()

updateScale(sx, sy):
  1. Update scaleCtx.sx, scaleCtx.sy
  2. For each activeKind: lookup apply function from APPLY_SCALE[kind][behavior]
  3. Apply to all entries, invalidate dirty rects
  4. if topology → runTopologyScale(topology, scaleCtx)

beginTranslate(selectedIds, selBounds):
  1. clear(), capture selBounds for overlay rect (parallels scaleCtx.selBounds)
  2. Freeze translate entries (simpler: no behavior resolution)
  3. Build topology via newTopologyBuilder('translate', selectedIds) inline

updateTranslate(dx, dy):
  1. Store dx, dy
  2. For each activeKind: TRANSLATE_APPLY[kind] on all entries
  3. if topology → runTopologyTranslate(topology, dx, dy)

commit():
  1. Capture store/behaviors/topology refs
  2. clear() — prevents double-transform glitch
  3. transact(() => {
       dispatch COMMIT_SCALE or TRANSLATE_COMMIT per kind
       if (topology) commitTopology(topology, mode, dx, dy)
     })

cancel(): invalidate all dirty rects, cancelTopology(topology), clear()
clear(): reset store, activeKinds, behaviors, scaleCtx, dx/dy, mode, topology
```

**Correlated union casts:** When iterating `activeKinds`, TS can't prove `APPLY_SCALE[kind]` and `store[kind]` share the same K. ONE cast per loop with inline comment explaining safety — the mapped table type already proved correctness at definition.

**Public accessors:**
- `getMap<K>(kind)` — returns `Map<string, Entry<K>> | undefined` (generic preserved)
- `getBehavior(kind)` — returns `ScaleBehavior | undefined`
- `getScaleCtx()`, `getTopology()`, `getMode()`, `hasChange()`
- `isOverlayUniform()`, `getTranslateSelBounds()` — overlay-only (see `selection-overlay.ts`)

### Module Getters (for renderer)

```typescript
getScaleEntry<K>(kind, id): Entry<K> | undefined  // Generic flows through
getScaleBehavior(kind): ScaleBehavior | undefined
getTransformMode(): 'none' | 'scale' | 'translate'
getTranslateDelta(): [number, number] | null
getTransformTopology(): ConnectorTopology | null
getTransformScaleCtx(): ScaleCtx | null
transformHasChange(): boolean                     // overlay-only — gates begin→first-update reads
isOverlayUniform(): boolean                       // overlay-only — rect uniform-vs-per-axis
getTranslateSelBounds(): BBoxTuple | null         // overlay-only — translate union frozen at begin
getController(): TransformController              // Lazy singleton
```

### Overlay-only accessors

Three module getters exist purely for `selection-overlay.ts`: `transformHasChange()` (live-vs-idle gate), `isOverlayUniform()` (uniform vs. per-axis rect), `getTranslateSelBounds()` (translate union frozen at begin, parallels `scaleCtx.selBounds`). Each WHY lives at the call site in the overlay; only the controller-side method docs spell out the field invariants.

### Scale Math (scale-system.ts)

Pure math atoms. No types, no factories, no state. Takes `ScaleCtx` from `tools/selection/types.ts`
as a typed parameter bundle — intentional inward type-only import so the atoms can consume the
gesture context directly without re-declaring its fields.

**Number primitives:**
- `scaleAround(v, origin, factor)` — `origin + (v - origin) * factor`. The universal scale atom.
- `round3(n)`, `roundProp(prop, af)` — rounding helpers.

**Factor computation:**
- `rawScaleFactors(wx, wy, origin, delta, handleId)` — cursor→[sx,sy] using initialDelta (not bounds width). Cursor position should have clickOffset subtracted before passing.
- `uniformFactor(sx, sy, handleId)` — handle-aware collapse of 2 axes to 1 signed magnitude. Uses `isHorzSide`/`isVertSide` type guards (not value equality) to detect side handles, preventing corner-handle flicker when one axis passes through 1.0. Min 0.001.
- `preservePosition(cx, cy, selBounds, origin, factor)` / `preservePositionMut(out, cx, cy, selBounds, origin, factor)` — relative 0-1 position maintained in scaled/flipped box. Mut variant writes `out` in place for zero-allocation callers (consumed by the connector topology free-side resolver on corner handles).

**Edge pin:**
- `edgePinPosition1D(objMin, objMax, originV, scale, selLo, selHi)` — 1D edge-pin position. Spans-full-axis fast-path (`objMin ≤ selLo AND objMax ≥ selHi`) → translate via `scaleAround` on the object center, since pinning to an edge it owns would freeze it (e.g. two side-by-side notes both spanning the full Y range under a vSide drag). Otherwise straddle-aware: objects whose bbox contains origin pin the nearer edge (stay fixed), all others pin the farther edge (track the dragged handle). Produces discrete flip when crossing origin.
- `edgePinDelta(src, ctx)` — composes two 1D calls into a `[dx, dy]` delta. Consumed by `edgePinOffset` in transform.ts.

**BBox-aware atoms (compose the primitives above, consumed by transform.ts):**
- `scaleBBoxUniform(out, src, ctx)` — uniform scale a bbox around `ctx.origin`. Writes out, returns absolute factor (for prop rounding).
- `scaleBBoxEdges(out, src, ctx)` — non-uniform: scale each edge independently around `ctx.origin`, normalize for flip.
- `derivePaddedFrame(outFrame, outBbox, srcFrame, srcBbox)` — derive shape/image frame from a scaled bbox with **constant** stroke-width padding, then overwrite outBbox = outFrame + constant pad (encodes the shape/image padding invariant).

**Reflow:**
- `computeReflowWidth(fx, fw, originX, sx, minW)` — edge-scaling + min-width clamping for text/code reflow.

### BBox-Based Scale Origins

Scale origins and bounds are derived from `handle.bbox` (includes stroke width padding), not raw frame geometry. This ensures the visual selection overlay (handles drawn at bbox corners) matches the scale anchor point.

**`computeSelectionBounds()`** (selection-store.ts, zero-arg) serves both roles: selection overlay bounds and scale gesture bounds. Union of `handle.bbox` for all selected objects. Exception: text uses `getTextFrame() → frameToBbox()` (italic overhangs make bbox differ from visual frame). Called by `store.beginScale`. The editing fallback (reads `textEditingId`/`codeEditingId` when `selectedIds` is empty) is unreachable during scale because handle hit-test gates on not-editing.

**Shape/image scaling — constant padding invariant:** Shapes have stroke-width padding between frame and bbox (`padding = strokeWidth/2 + 1`). During scale, the **bbox** is scaled for position computation, then the **frame** is derived by subtracting constant padding. The output bbox = frame + constant padding (not the scaled bbox), because stroke width doesn't scale with the transform. This prevents dirty rect artifacts at small scales where scaled padding would be smaller than the actual stroke extent.

**Stroke scaling — ctx.scale rendering:** Strokes use cached Path2D with `ctx.translate/ctx.scale/ctx.translate` during scale preview instead of per-frame point mutation. Output stores `factor`/`fcx`/`fcy` (absolute scale factor and frozen bbox center). Points are only computed at commit time from frozen geometry. Stroke edgePin + translate are also bbox-only during gestures: `applyOffset` updates `o.bbox` via `offsetBBox`, commit (`commitStrokeOffset`) derives final points from `frozen.points + (o.bbox - f.bbox)`. `OutMap['stroke']` allocates no points array regardless of stroke length.

---

## Connector Topology

Connectors never enter the per-kind entry store — `TransformController` routes them through a companion module (`tools/selection/connector-topology.ts`) via a builder it drives inline with its single begin-phase freeze loop. One `getHandle` per selected id, one per non-selected attached connector; no redundant passes.

### Endpoint states × connector modes

Two orthogonal classifications, decided at begin:

**Endpoint state** (per endpoint, via `classifyEndpoint`):
| State | When | Override passed to `rerouteConnector` |
|---|---|---|
| `canonical` | Anchored to a non-selected bindable, OR free and connector not selected | none — reroute falls back to Y.Map |
| `frame-bound` | Anchored to a selected bindable | `{ frame: <live> }` filled from `entry.out.*` |
| `free-moving` | Not anchored AND connector is selected | `Point` (translated or scaled per frame) |

**Connector mode** (per connector, discriminant of `ConnectorEntry`):
| Mode | Condition | Per-frame work |
|---|---|---|
| `static` | Both endpoints canonical (only selected connectors enter) | None — renderer draws at stored position |
| `translate` | Both endpoints non-canonical AND gesture is `translate` | Rigid bbox shift; commit translates points once |
| `reroute` | Anything else (incl. any scale gesture with non-canonical endpoints) | `rerouteConnector(id, { start?, end? })` |

### Shape

```typescript
type ConnectorEntry = StaticEntry | TranslateEntry | RerouteEntry;  // discriminated by `mode`

type ConnectorTopology = {
  byId:       ReadonlyMap<string, ConnectorEntry>;   // renderer lookup
  translates: readonly TranslateEntry[];             // monomorphic apply loops
  reroutes:   readonly RerouteEntry[];
  injectIds:  readonly string[];                     // selectedIds ∪ attached-non-selected connectors
};

type Side = BindSide | FreeSide;
type BindSide = { kind: 'bind'; bindKind; entry; frozenFrame: FrameTuple | null };  // non-null for note/bookmark
type FreeSide = { kind: 'free'; originalPos: Readonly<Point>; scratch: Point };     // per-instance scratch
```

`RerouteEntry.start` / `.end` is `Side | null` — `null` encodes canonical (no override key set on the shared `OVERRIDES` object that frame reuses).

### Bind-side frame derivation (`fillFrameFromBind`)

Per-frame, for each bind side, fill a module-level `FrameTuple` scratch from whatever apply just wrote:
- **shape / image** — `copyFrame(scratch, out.frame)`.
- **text / code** — `bboxToFrameMut(out.bbox, scratch)` (bbox coincides with visual frame today; flagged with a TODO for italic-overhang widening).
- **note / bookmark** — `[out.origin.x, out.origin.y, frozenFrame.w × (out.scale/frozen.scale), frozenFrame.h × ratio]`. The ratio matches the renderer's `ctx.scale` factor exactly, keeping the connector anchor in pixel-lockstep with the rendered edge.

Mode-agnostic: the same function serves translate and scale because `applyOffset` propagates `f.scale → o.scale` for note/bookmark (ratio = 1 under translate). Each frame scratch is wrapped once in a permanently-linked `{ frame }` object; safe to share across entries because `rerouteConnector` allocates fresh position tuples from anchor × frame — the scratch is only read.

### Free-side isolation (per-instance scratch)

Each `FreeSide` owns a private `scratch: Point`, allocated once at build. Per-side (not shared module-level) because `rerouteConnector`'s routing pipeline holds `FREE_ENDPOINT(position)` by reference and pushes it into the returned `points` array — sharing one scratch across entries within a frame would leak the last-processed entry's values into every prior entry's `currPoints`. `makeSide` also clones `storedPos` into `originalPos` so a prior gesture's entry preserved by Y.Map (by reference) can't corrupt this gesture's baseline.

Free-apply math lives in two helpers — `resolveFreeScale(s, ctx)` and `resolveFreeTranslate(s, dx, dy)` — so the four slot resolvers (`resolveStart/End{Scale,Translate}`) stay pure dispatch, selecting which module `FRAME_SCRATCH_*` / `FRAME_WRAP_*` pair to feed on the bind branch. `resolveFreeScale` branches on `isCorner(ctx.handleId)`: corners use `uniformFactor` + `preservePositionMut`, so free endpoints track the selection's uniform corner scale (matching `scaleBBoxUniform` for shapes/images) instead of stretching diagonally with independent `sx`/`sy`. Side handles fall through to axis-aligned `scaleAround` — the inactive axis is hardcoded `1` by `rawScaleFactors`, so the corresponding coordinate passes through unchanged.

### Commit

`commitReroute` writes `points` as-is (A*/simplify yields fresh interior tuples), then clones the first/last into `start`/`end` so Y.Map never holds a live topology reference. `commitTranslate` allocates one translated `Point[]` from `originalPoints + (dx, dy)` — no per-frame polyline buffer.

### Public API

| Function | Called by |
|---|---|
| `newTopologyBuilder(mode, selectedIdSet)` → `TopologyBuilder` | `TransformController.beginScale` / `beginTranslate` |
| `builder.onSelectedConnector(id, handle)` / `.onSelectedBindable(id, kind, entry, handle)` | Per-id dispatch inside the controller's freeze loop |
| `builder.finalize(): ConnectorTopology \| null` | End of controller's begin |
| `runTopologyScale(topology, ctx)` / `runTopologyTranslate(topology, dx, dy)` | `updateScale` / `updateTranslate` (after non-connector apply) |
| `commitTopology(topology, mode, dx, dy)` | Inside `commit()`'s transact block |
| `cancelTopology(topology)` | `TransformController.cancel()` |

### Invariants

1. **Zero per-frame allocation in the topology layer.** Frame scratches + per-free-side scratch are allocated once at build.
2. **Apply paths of bindable kinds are untouched.** `fillFrameFromBind` reads `entry.out.*` / `entry.frozen.*` — the only apply-adjacent concession is `applyOffset` propagating `f.scale → o.scale` when both sides carry the field.
3. **Frame overrides are read-only.** `rerouteConnector` reads `override.frame` via `anchorFramePoint` / `elbowAnchorPoint`, both of which allocate fresh position tuples.
4. **Free-endpoint scratches must be per-side.** Shared module scratches break multi-entry scale/translate because free-endpoint positions flow through to `currPoints`.
5. **Y.Map never stores a live topology reference.** Commit clones endpoints; `makeSide` clones the stored baseline. Future reroute paths can be added without re-opening either aliasing vector.

---

## Hit Testing

All hit logic lives in `core/spatial/` (see its CLAUDE.md for internals — pipeline, paint classification, per-kind caps, frame-aware tournament). SelectTool is a pure consumer: pick the right entry point per phase, read the single value each returns.

| Phase | Call | Returns | Behavior |
|-------|------|---------|----------|
| Click target (`hitTestObjects`) | `pickTopmostPaint([x, y], { px: HIT_RADIUS_PX + HIT_SLACK_PX })` | `ObjectHandle \| null` | **Best candidate, not just topmost.** Topmost paint-blocker wins outright (strokes, connectors, text/code/image frames, filled-shape edges). For a small unfilled shape stacked above a larger filled shape, the smaller wins — frame-aware area tournament. |
| Marquee (`updateMarqueeSelection`) | `queryHandleIds(inBBox(marqueeBBox))` | `string[]` | **Precise per-kind intersection, not bbox.** Shape-type aware (ellipse perimeter, diamond edges), polylines tested segment-wise, framed kinds (text/code/note/image/bookmark) tested against their derived frame. |
| Resize handle (standard mode) | `hitResizeHandle([x, y], selectionBounds)` | `HandleId \| null` | Screen-space probe (~10px). Internally gates on `shouldShowHandles(bbox)` — `Math.max(w, h) * scale ≥ HANDLE_MIN_BBOX_PX (12)` so the gate flips exactly when corner stamps would physically meet (one tiny axis stays grabbable). Same gate drives overlay visibility + cursor — render/hit/cursor always agree. Only consulted with selection active and no text/code editor mounted. |
| Endpoint dot (connector mode) | `hitEndpointDot([x, y], selectedIds)` | `EndpointHit \| null` | Screen-space nearest-probe over selected connectors' start/end world positions. |

Click tolerance: `HIT_RADIUS_PX (6) + HIT_SLACK_PX (2) = 8px` screen-space — forgiving touch target without enlarging the visual anchor. Marquee uses no tolerance (exact region intersect).

---

## Rendering During Transforms (objects.ts)

### drawObjects() Dispatch

Reads `useSelectionStore` for transform state. For each object in ULID order:

**Not transforming or not selected:** `drawObject(ctx, handle)` (per-kind switch).

**Translate:** `ctx.translate(dx, dy)` + `drawObject()`. Connectors use topology: translateOnly → ctx.translate, rerouted → `drawConnectorFromPoints()`.

**Scale:** `renderScaleEntry(ctx, handle, snapshot)` — per-kind dispatch using entry system.

**Endpoint drag:** Connector with matching id + routedPoints → `drawConnectorFromPoints()`.

**Culling guard:** During transforms, all selected + topology connector IDs are injected into candidate list regardless of spatial index viewport query. Prevents disappearing during edge-scroll panning.

### renderScaleEntry()

Reads `getScaleEntry(kind, id)` and `getScaleBehavior(kind)` from transform module. Per-kind rendering:

| Kind | uniform | reflow | edgePin (fallback) |
|------|---------|--------|--------------------|
| shape | Build fresh Path2D from `entry.out.frame`, guard on bbox (not frame) size | — | — |
| image | Draw bitmap at `entry.out.frame` | — | — |
| stroke | `ctx.scale(factor)` on cached Path2D — no per-frame point mutation | — | `renderTranslatedEntry()` |
| text | Cached layout + `ctx.scale(ratio)` around out.origin | Render `entry.out.layout` at out.origin | `renderTranslatedEntry()` |
| code | Cached layout + `ctx.scale(ratio)` around out.bbox corner | Render `entry.out.layout` at out.origin | `renderTranslatedEntry()` |
| note/bookmark | `ctx.scale(ratio)` around out.origin, then `drawObject()` | — | `renderTranslatedEntry()` |

### renderTranslatedEntry()

Generic edge-pin fallback. Typed as `Entry<KindWithBBoxGeo>`, where `KindWithBBoxGeo` is exported from `transform.ts` (next to `GeoMap`/`OutMap`) and shared by `selection-overlay.ts`:
```typescript
export type KindWithBBoxGeo = { [K in ObjectKind]: GeoOf<K> extends { bbox: BBoxTuple } ? K : never }[ObjectKind];
// Resolves to: Exclude<ObjectKind, 'connector'> — every non-connector kind has bbox in GeoMap.
```

Computes delta from `entry.out.bbox - entry.frozen.bbox`, applies `ctx.translate(dx, dy)`.

---

## Selection Store (selection-store.ts)

### State

```typescript
interface SelectionState {
  selectedIds: string[];
  mode: SelectionMode;              // 'none' | 'standard' | 'connector'
  selectionKind: SelectionKind;     // Derived from kind counts
  selectedIdSet: ReadonlySet<string>; // O(1) lookup
  kindCounts: KindCounts;           // Per-kind counts for mixed filter
  menuOpen: boolean;                // Context menu visibility gate
  selectedStyles: SelectedStyles;   // Style snapshot (equality-gated)
  inlineStyles: InlineStyles;       // Bold/italic/highlight (equality-gated)
  boundsVersion: number;            // Bumped on bbox changes → controller repositions
  transform: TransformState;        // { kind: 'none' | 'translate' | 'scale' | 'endpointDrag' }
  marquee: MarqueeState;
  textEditingId: string | null;
  textEditingIsNew: boolean;
  codeEditingId: string | null;
}
```

`TranslateTransform` is a thin `{ kind: 'translate' }` marker. `ScaleTransform` carries the gesture math: `{ kind: 'scale', initialDelta, clickOffset }`. The split is deliberate:
- **Controller** (`scaleCtx`) owns `handleId`/`origin`/`selBounds` — needed per-apply, updated with `sx`/`sy` each frame.
- **Store** (`ScaleTransform`) owns `initialDelta`/`clickOffset` — gesture-frame constants feeding `rawScaleFactors` on each move. No duplication between the two.

Per-frame `sx`/`sy` stay on `TransformController` — mutating the Zustand discriminant every pointermove would fire subscribers wastefully.

All entry state (frozen geometry, output, topology, dx/dy, sx/sy) lives in `TransformController`. The store orchestrates the whole scale gesture end-to-end: SelectTool calls `store.beginScale(handleId, downWorld)` once and `store.updateScale(worldX, worldY)` on each move — it never reads scale state back or touches `rawScaleFactors`. `beginScale`/`beginTranslate`/`updateScale`/`updateTranslate`/`endTransform`/`cancelTransform` all call `getController()` internally; SelectTool imports `getController` only for `getPreview()` scale reads.

Exception: `EndpointDragTransform` still carries full state in the store (connectorId, endpoint, routedPoints, currentSnap, prevBbox) — it's not entry-based and doesn't go through the controller.

### Key Actions

| Action | Effect |
|--------|--------|
| `setSelection(ids)` | Compute composition, reset transform/marquee, bump boundsVersion, refreshStyles |
| `clearSelection()` | Reset everything to defaults |
| `beginTranslate()` | `computeSelectionBounds()` (mirrors `beginScale`) → `ctrl.beginTranslate(selectedIdSet, selBounds)` + set `{ kind: 'translate' }`. Bails early if union is null. |
| `updateTranslate(dx, dy)` | `ctrl.updateTranslate(dx, dy)` |
| `beginScale(handleId, downWorld)` | `computeSelectionBounds()` → `scaleOrigin`/`handlePosition` → gesture math → `ctrl.beginScale(...)` + set `{ kind: 'scale', initialDelta, clickOffset }` |
| `updateScale(worldX, worldY)` | Narrow `transform` + read `scaleCtx` → `rawScaleFactors(...)` → `ctrl.updateScale(sx, sy)` |
| `endTransform()` | `ctrl.hasChange() ? ctrl.commit() : ctrl.clear()` + set `{ kind: 'none' }` |
| `cancelTransform()` | `ctrl.cancel()` + set `{ kind: 'none' }` |
| `beginEndpointDrag(connId, endpoint, bbox)` | Set endpointDrag transform |
| `beginTextEditing(id, isNew)` | Set textEditingId, menuOpen=true, refreshStyles |
| `endTextEditing()` | Clear textEditingId, menuOpen=conditional, refreshStyles |
| `beginCodeEditing(id)` | Set codeEditingId, menuOpen=true, refreshStyles |
| `endCodeEditing()` | Clear codeEditingId, menuOpen=conditional |
| `refreshStyles()` | Recompute selectedStyles + inlineStyles from current state |

---

## Selection Utils (selection-utils.ts)

### computeSelectionComposition(ids)

Single-pass bucket count: `counts[handle.kind]++` into a `Record<ObjectKind, number>`, then derive `selectionKind` by counting non-zero buckets (0 → `'none'`, 1 → that kind, 2+ → `'mixed'`). Returns `{ selectionKind, kindCounts, selectedIdSet, mode }`. `KindCounts = Record<ObjectKind, number> & { total }` — keys match `ObjectKind` singular exactly, so `kindCounts[kind]` is valid anywhere `kind: ObjectKind`.

### computeSelectionBounds()

Zero-arg: reads `selectedIds` → `textEditingId` → `codeEditingId` fallback chain. Serves triple duty — idle selection overlay bounds, scale gesture bounds (`store.beginScale`), and translate-frozen union (`store.beginTranslate`).
- Text: `frameToBbox(getTextFrame(id))` (italic overhangs differ from bbox)
- All others (including code): `handle.bbox` (code's `computeCodeBBox` already writes the derived layout frame into `handle.bbox` — no stroke padding to account for)

Returns `null` on empty selection (causes both `beginScale` and `beginTranslate` to bail early). The overlay also calls it directly when idle or before the first update fires (see `selection-overlay.ts`).

### computeStyles(ids, kind)

Returns `EMPTY_STYLES` immediately for `none`, `mixed`, `image`, `bookmark`.

### computeUniformInlineStyles(ids)

Aggregates bold/italic/highlight across text/shape(labeled)/note objects.

---

## Endpoint Drag

Only in connector mode (single connector selected). Dragging start or end endpoint. Managed by SelectTool directly (not TransformController).

```
1. Find snap target (findBestSnapTarget) — Ctrl suppresses
2. Build endpoint override (SnapTarget or [worldX, worldY])
3. Reroute connector (rerouteConnector with override)
4. Update store with position, snap, routedPoints, routedBbox
5. Invalidate prev + current dirty rects
```

**Commit:** Sets `points`, `start`, `end` on Y.Map. Updates or deletes anchor key based on snap state.

---

## Context Menu Integration

SelectTool controls context menu visibility:
- `begin()` → `contextMenuController.hide()` (always)
- `end()` / `cancel()` → `contextMenuController.show()` (if selection or editing active)
- Single text re-click → `cancelHide()` to prevent flash

Store fields consumed by context menu are documented in `components/context-menu/CLAUDE.md`.

---

## File Map

| File | Responsibility |
|------|----------------|
| `tools/selection/SelectTool.ts` | State machine, hit testing dispatch, routes transform lifecycle through store, endpoint drag commit |
| `tools/selection/transform.ts` | TransformController, structural traits, mapped types (incl. exported `KindWithBBoxGeo`), dispatch tables, apply/commit/freeze functions, module getters (incl. `transformHasChange`/`isOverlayUniform`/`getTranslateSelBounds` for the overlay) |
| `tools/selection/types.ts` | Shared types: `SelectionKind`, `KindCounts`, `TransformState` (incl. `ScaleTransform` = `{ kind, initialDelta, clickOffset }`), `ScaleCtx` (gesture bundle for `scale-system.ts` atoms), `SelectedStyles`, `InlineStyles`, empty constants |
| `tools/selection/connector-topology.ts` | `ConnectorEntry` discriminated union (`static` \| `translate` \| `reroute`), `newTopologyBuilder` (driven inline by `TransformController`'s freeze loop), `runTopologyScale`/`runTopologyTranslate`/`commitTopology`/`cancelTopology`, `fillFrameFromBind` bind-side frame derivation |
| `tools/selection/selection-utils.ts` | `computeSelectionComposition`, `computeStyles`, `computeUniformInlineStyles` |
| `tools/selection/selection-actions.ts` | 21 mutation functions for context menu buttons (documented in context-menu CLAUDE.md) |
| `stores/selection-store.ts` | Zustand store, orchestrates `TransformController` (begin/update/end/cancel), `computeSelectionBounds()`, `filterSelectionByKind(kind: ObjectKind)`, handle helpers. Re-exports shared types for backward compat. |
| `core/geometry/scale-system.ts` | Pure math atoms: `scaleAround`, `uniformFactor` (handle-aware), `preservePosition`, `edgePinPosition1D`, `computeReflowWidth` + bbox-aware atoms consumed by transform.ts (`scaleBBoxUniform`, `scaleBBoxEdges`, `edgePinDelta`, `derivePaddedFrame`). Imports `ScaleCtx` from `tools/selection/types.ts`. |
| `core/geometry/bounds.ts` | Bbox/frame tuple helpers (`frameToBbox`, `bboxToFrame`, `bboxCenter`, `copyBbox`, etc.), WorldBounds operations, mutating offset primitives (`offsetBBox`, `offsetFrame`, `offsetPoint`, `offsetPoints`, `setBBoxXYWH`) |
| `core/types/handles.ts` | HandleId taxonomy, type guards, scaleOrigin, handleCursor |
| `core/spatial/` | Hit testing + region queries — consumed only via `pickTopmostPaint` (click), `queryHandleIds(inBBox)` (marquee), `hitResizeHandle`, `hitEndpointDot`. `core/spatial/handle-hit.ts` also owns `shouldShowHandles` (the single render/hit/cursor visibility gate, `Math.max ≥ HANDLE_MIN_BBOX_PX`). Internals documented in `core/spatial/CLAUDE.md`. |
| `renderer/layers/objects.ts` | `drawObjects` dispatch, `renderScaleEntry` (entry-based), `renderTranslatedEntry` (edge-pin fallback) |
| `renderer/layers/selection-overlay.ts` | `drawSelectionOverlay`: marquee, single-select bounds rect (doubles as highlight), multi-select per-object highlights + union rect, connector mode endpoint dots only (no bbox/handles — connectors aren't scaled in practice; dots already signal selection). Mid-transform geometry reads gated by `transformHasChange()` to bridge the begin→first-update gap; per-axis vs. uniform overlay rect via `isOverlayUniform()`; translate union frozen at begin via `getTranslateSelBounds()`. |
