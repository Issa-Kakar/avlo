# Selection System

SelectTool + transform system + selection store + hit testing + transform rendering. The most complex tool in the codebase: handles translate, scale (per-kind-aware), connector endpoint drag, marquee, multi-select, text/code editing entry, and Z-order-aware hit testing.

## Architecture

```
SelectTool.ts (PointerTool singleton via tool-registry)
├── State machine: idle → pendingClick → marquee | translate | scale | endpointDrag
├── Hit testing via core/geometry/hit-testing.ts
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
└── computeConnectorTopology() — pure function, builds ConnectorTopology

selection-utils.ts (pure functions)
├── computeSelectionComposition(ids) → kind, mode, counts
├── computeSelectionBounds() → BBoxTuple (zero-arg, reads store)
├── computeStyles(ids, kind, objectsById) → SelectedStyles
└── computeUniformInlineStyles(ids, objectsById) → InlineStyles

selection-actions.ts (mutation functions — documented in context-menu/CLAUDE.md)

core/geometry/scale-system.ts (pure math atoms — NO STATE)
├── scaleAround(), round3(), roundProp() — number primitives
├── rawScaleFactors() — cursor→factors from initialDelta
├── uniformFactor(sx, sy, handleId) — handle-aware collapse to 1 signed magnitude
├── preservePosition() — relative 0-1 position maintained in scaled/flipped box
├── edgePinPosition1D() — straddle-aware 1D edge-pin position (origin objects pin near, others pin far)
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

core/geometry/hit-testing.ts (shared with EraserTool)
├── testObjectHit() → HitCandidate (per-kind dispatch)
├── hitTestHandle() → HandleId (resize handles)
├── hitTestEndpointDots() → EndpointHit (connector mode)
└── objectIntersectsRect() (marquee geometry)

renderer/layers/objects.ts (base canvas — consumer of transform getters)
├── drawObjects() — main dispatch, reads selectionStore for transform preview
├── renderScaleEntry() — per-kind scale dispatch using getScaleEntry/getScaleBehavior
└── renderTranslatedEntry() — edge-pin fallback via bbox delta
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
     → hitTestHandle() → downTarget = 'handle'
   Connector mode:
     → hitTestEndpointDots() → downTarget = 'connectorEndpoint'
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
| `handle` | → `scale` | `computeTransformBoundsForScale()` → `scaleOrigin()` → `getController().beginScale()` |
| `connectorEndpoint` | → `endpointDrag` | Drill to single connector if multi-selected |
| `objectOutsideSelection` | → `translate` | First selects object. Anchored connectors → `marquee` instead |
| `objectInSelection` | → `translate` | Anchored connectors in connector mode → `marquee` instead |
| `selectionGap` | → `translate` | Gap drag = translate entire selection |
| `background` | → `marquee` | Empty area drag = marquee select |

### Scale Phase (begin + move)

At begin: `initialDelta = handlePosition - origin` (handle-to-origin vector), `clickOffset = downWorld - handlePosition` (cursor-to-handle gap, stays constant throughout drag).

```
1. ctrl = getController(), scaleCtx = ctrl.getScaleCtx()
2. rawScaleFactors(worldX - clickOffset[0], worldY - clickOffset[1], scaleCtx.origin, initialDelta, handleId) → [sx, sy]
3. ctrl.updateScale(sx, sy) — applies to all entries + topology
```

### Translate Phase (move)

```
getController().updateTranslate(worldX - downWorld[0], worldY - downWorld[1])
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
if ctrl.hasChange() → ctrl.commit()
else → ctrl.clear()
store.endTransform()
```

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

Functions typed with traits accept any kind whose Geo/Out extends the trait via structural subtyping. Example: `edgePinOriginBbox(f: HasOrigin & HasBBox, ...)` accepts `GeoOf<'note'>`, `GeoOf<'text'>`, `GeoOf<'bookmark'>` — anything with those fields.

#### GeoOf<K> / OutOf<K> (Mapped Types)

`GeoOf<K>` = frozen geometry snapshot from Y.Map at transform begin.
`OutOf<K>` = mutable output written per-frame by apply functions, read by renderer.

```
GeoMap / OutMap composed from traits:
  shape:    GeoOf = HasFrame & HasBBox               OutOf = HasFrame & HasBBox
  image:    GeoOf = HasFrame & HasBBox               OutOf = HasFrame & HasBBox
  stroke:   GeoOf = HasPoints & HasWidth & HasBBox   OutOf = same + { factor, fcx, fcy }
  text:     GeoOf = HasFrame & HasOrigin & HasFontSize & HasBBox + kind-specific
            OutOf = HasOrigin & HasFontSize & HasWidth & HasBBox & { layout }
  code:     GeoOf/OutOf similar to text with code-specific fields
  note:     GeoOf = HasOrigin & HasScale & HasBBox   OutOf = same
  bookmark: GeoOf = HasOrigin & HasScale & HasBBox   OutOf = same
  connector: never (handled by topology)
```

Shape/image frozen geometry includes bbox (for stroke-width-aware scaling).
Stroke output includes `factor` (absolute uniform scale), `fcx`/`fcy` (frozen bbox center) for ctx.scale rendering and deferred point commit.

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

Scale behavior depends on three factors: **object kind**, **handle category** (corner/hSide/vSide), and **composition** (only/mixed).

```typescript
type ScaleBehavior = 'uniform' | 'nonUniform' | 'edgePin' | 'reflow';
```

**Default behavior** (applies to most kinds):

| Handle | kind-only | mixed |
|--------|-----------|-------|
| corner | uniform | uniform |
| hSide | uniform | edgePin |
| vSide | uniform | edgePin |

**9 overrides** (only the exceptions):

| Key | Behavior | Why |
|-----|----------|-----|
| `shape_corner_only` | nonUniform | Shapes scale independently per-axis |
| `shape_hSide_only/mixed` | nonUniform | Shapes always non-uniform |
| `shape_vSide_only/mixed` | nonUniform | Shapes always non-uniform |
| `text_hSide_only/mixed` | reflow | E/W handles re-layout text at new width |
| `code_hSide_only/mixed` | reflow | E/W handles re-layout code at new width |

`resolveBehavior(kind, handleId, mixed)` → returns `ScaleBehavior` (never undefined — defaults always provide a value).

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
| image | scaleFrameUniform | — | edgePinFrame | — |
| stroke | scaleStrokeBBox | — | edgePinPoints | — |
| text | scaleTextUniform | — | edgePinText | reflowText |
| code | scaleCodeUniform | — | edgePinCode | reflowCode |
| note | scaleOriginScale | — | edgePinOriginBbox | — |
| bookmark | scaleOriginScale | — | edgePinOriginBbox | — |

**COMMIT_SCALE, TRANSLATE_APPLY, TRANSLATE_COMMIT** follow same pattern with commit/translate functions.

### Apply Functions

**BBox-based (shape/image — scale bbox, derive frame with constant padding):**
- `scaleFrameUniform(f: HasFrame & HasBBox, ctx, o)` — scales bbox by uniform factor, derives frame by subtracting constant stroke padding (padding = 0 for images). Output bbox = frame + constant padding (stroke width doesn't scale with the transform).
- `scaleFrameNonUniform(f: HasFrame & HasBBox, ctx, o)` — scales bbox edges around origin via `scaleAround()`, normalizes for flip, derives frame. Shape only.
- `edgePinFrame(f: HasFrame & HasBBox, ctx, o)` — offsets both frame and bbox by edge-pin delta. Image only.

**Stroke (bbox-based, no per-frame point mutation):**
- `scaleStrokeBBox(f: GeoOf<'stroke'>, ctx, o)` — computes bbox center + uniform factor, stores `factor`/`fcx`/`fcy` on output for ctx.scale rendering. No point loop.
- `edgePinPoints(f: HasPoints & HasWidth & HasBBox, ctx, o)` — offsets all points by edge-pin delta.

**Other trait-typed:**
- `scaleOriginScale(f: HasOrigin & HasScale & HasBBox, ctx, o)` — note, bookmark
- `edgePinOriginBbox(f: HasOrigin & HasBBox, ctx, o)` — note, bookmark (directly), text/code (composed)
- `applyTranslateFrame`, `applyTranslateOrigin`, `applyTranslatePoints` — translate variants (compose bounds.ts offset helpers). `applyTranslateFrame` offsets both frame and bbox from frozen (preserves stroke padding).

**Kind-specific (read many kind-specific fields):**
- `scaleTextUniform`, `scaleCodeUniform` — fontSize rounding, origin from frame center
- `edgePinText`, `edgePinCode` — compose `edgePinOriginBbox` + copy fontSize/width
- `reflowText`, `reflowCode` — `computeReflowWidth` + re-layout at new width (see below)

**Reflow layout integration:** `reflowText` calls `layoutMeasuredContent(frozen.measured, targetWidth, fontSize)` from `text-system.ts` — re-wraps pre-measured content at the new width. `reflowCode` calls `computeCodeLayout(frozen.sourceLines, fontSize, targetWidth, lineNumbers)` from `code-system.ts`. Both use `frozen.minW` (captured at `beginScale` via `getMinCharWidth`/`getCodeMinWidth`) as the minimum width passed to `computeReflowWidth`. `anchorFactor(align)` converts text alignment to origin offset (0/0.5/1 for left/center/right).

### Commit Functions

| Function | Writes | Used by |
|----------|--------|---------|
| `commitFrame` | frame | shape, image |
| `commitOrigin` | origin | text/code edgePin, note/bookmark edgePin |
| `commitOriginScale` | origin, scale | note/bookmark uniform |
| `commitTextScale` | origin, fontSize, width | text uniform |
| `commitCodeScale` | origin, fontSize, width | code uniform |
| `commitReflow` | origin, width | text/code reflow |
| `commitStrokeUniform` | points, width | stroke uniform (reads frozen.points/width, applies factor at commit) |
| `commitPoints` | points | stroke edgePin |

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
beginScale(selectedIds, kindCounts, handleId, origin, selBounds):
  1. clear() — reset all state
  2. For each selected non-connector:
     a. resolveBehavior(kind, handleId, mixed) → ScaleBehavior
     b. freezeScaleEntry(kind, behavior, id, y, bbox) → frozen geometry snapshot
     c. createOutFor(kind, frozen) → pre-allocated output
     d. Store as Entry in store[kind]
  3. computeConnectorTopology('scale', selectedIds) → topology

updateScale(sx, sy):
  1. Update scaleCtx.sx, scaleCtx.sy
  2. For each activeKind: lookup apply function from APPLY_SCALE[kind][behavior]
  3. Apply to all entries, invalidate dirty rects
  4. updateTopologyReroutes()

beginTranslate(selectedIds):
  1. clear(), freeze translate entries (simpler: no behavior resolution)
  2. computeConnectorTopology('translate', selectedIds)

updateTranslate(dx, dy):
  1. Store dx, dy
  2. For each activeKind: TRANSLATE_APPLY[kind] on all entries
  3. updateTopologyReroutes()

commit():
  1. Capture store/behaviors/topology refs
  2. clear() — prevents double-transform glitch
  3. transact(() => { dispatch COMMIT_SCALE or TRANSLATE_COMMIT per kind })
  4. commitTopologyEntries()

cancel(): invalidate all dirty rects, clear()
clear(): reset store, activeKinds, behaviors, scaleCtx, dx/dy, mode, topology
```

**Correlated union casts:** When iterating `activeKinds`, TS can't prove `APPLY_SCALE[kind]` and `store[kind]` share the same K. ONE cast per loop with inline comment explaining safety — the mapped table type already proved correctness at definition.

**Public accessors:**
- `getMap<K>(kind)` — returns `Map<string, Entry<K>> | undefined` (generic preserved)
- `getBehavior(kind)` — returns `ScaleBehavior | undefined`
- `getScaleCtx()`, `getTopology()`, `getMode()`, `hasChange()`
- `getEntryFrame(id)` — searches all kinds for entry's output frame (topology use)

### Module Getters (for renderer)

```typescript
getScaleEntry<K>(kind, id): Entry<K> | undefined  // Generic flows through
getScaleBehavior(kind): ScaleBehavior | undefined
getTransformMode(): 'none' | 'scale' | 'translate'
getTranslateDelta(): [number, number] | null
getTransformTopology(): ConnectorTopology | null
getTransformScaleCtx(): ScaleCtx | null
getController(): TransformController              // Lazy singleton
```

### Scale Math (scale-system.ts)

Pure math atoms. No types, no factories, no state.

- `rawScaleFactors(wx, wy, origin, delta, handleId)` — cursor→[sx,sy] using initialDelta (not bounds width). Cursor position should have clickOffset subtracted before passing.
- `uniformFactor(sx, sy, handleId)` — handle-aware collapse of 2 axes to 1 signed magnitude. Uses `isHorzSide`/`isVertSide` type guards (not value equality) to detect side handles, preventing corner-handle flicker when one axis passes through 1.0. Min 0.001.
- `preservePosition(cx, cy, selBounds, origin, factor)` — relative 0-1 position maintained in scaled/flipped box.
- `edgePinPosition1D(objMin, objMax, originV, scale)` — 1D edge-pin position. Straddle-aware: objects whose bbox contains origin pin the nearer edge (stay fixed), all others pin the farther edge (track the dragged handle). Produces discrete flip when crossing origin. `edgePinCtx` in transform.ts composes two 1D calls into a `[dx, dy]` delta.
- `computeReflowWidth(fx, fw, originX, sx, minW)` — edge-scaling + min-width clamping for text/code reflow.

### BBox-Based Scale Origins

Scale origins and bounds are derived from `handle.bbox` (includes stroke width padding), not raw frame geometry. This ensures the visual selection overlay (handles drawn at bbox corners) matches the scale anchor point.

**`computeTransformBoundsForScale()`** (SelectTool): union of `handle.bbox` for all selected objects. Exception: text uses `getTextFrame() → frameToBbox()` (italic overhangs make bbox differ from visual frame).

**Shape/image scaling — constant padding invariant:** Shapes have stroke-width padding between frame and bbox (`padding = strokeWidth/2 + 1`). During scale, the **bbox** is scaled for position computation, then the **frame** is derived by subtracting constant padding. The output bbox = frame + constant padding (not the scaled bbox), because stroke width doesn't scale with the transform. This prevents dirty rect artifacts at small scales where scaled padding would be smaller than the actual stroke extent.

**Stroke scaling — ctx.scale rendering:** Strokes use cached Path2D with `ctx.translate/ctx.scale/ctx.translate` during scale preview instead of per-frame point mutation. Output stores `factor`/`fcx`/`fcy` (absolute scale factor and frozen bbox center). Points are only computed at commit time from frozen geometry.

---

## Connector Topology

Computed once at transform `begin()` via `computeConnectorTopology(transformKind, selectedIds)` in selection-store.ts. Determines how each connector behaves during the transform.

### Strategy Determination

Two passes:
1. **Selected connectors:** Check if both endpoints move (free endpoints always move if connector is selected; anchored endpoints move if anchored shape is selected).
2. **Non-selected connectors:** Anchored to selected shapes. Only the anchored endpoint moves.

```
Translate + both endpoints move → strategy: 'translate'
Otherwise → strategy: 'reroute' (A* each frame via rerouteConnector)
Scale → always 'reroute'
```

### EndpointSpec (for reroute)

```typescript
type EndpointSpec = string | true | null;
// string = shapeId — frame override (transform shape's frame, use as anchor)
// true   = free position override (apply transform to original endpoint position)
// null   = canonical (no override — endpoint stays at stored value)
```

### Per-Frame Rerouting (TransformController.updateTopologyReroutes)

For translate entries: offset `translatedPoints` by `(dx, dy)`.
For reroute entries:
1. `resolveTopologySpec()` builds endpoint overrides:
   - `string` spec → `{ frame: getEntryFrame(shapeId) }` (reads transformed frame from entry store)
   - `true` spec → translate or scale the original position
2. `rerouteConnector(id, overrides)` → new points
3. Store in `topology.reroutes` map (mutable per-frame cache)
4. Track bbox in `topology.prevBboxes` for dirty rect accumulation

---

## Hit Testing

### Object Hit Testing (`testObjectHit`)

Per-kind dispatch with `HitCandidate` classification:

```typescript
interface HitCandidate {
  id: string;              // ULID = Z-order
  kind: ObjectKind;
  distance: number;        // 0 if inside/on stroke
  insideInterior: boolean; // Inside shape/text bounds (not edge)
  area: number;            // Bounding area for nested priority
  isFilled: boolean;       // Shapes: has fillColor. Others: true
}
```

| Kind | Hit Test Method |
|------|----------------|
| `stroke` / `connector` | Polyline segment distance test (tolerance = radius + strokeWidth/2) |
| `shape` | Interior test (rect/ellipse/diamond) + edge distance test. `isFilled = !!fillColor` |
| `text` | `getTextFrame()` → rect hit test. `isFilled = !!fillColor` |
| `code` | `getCodeFrame()` → rect hit test. Always filled (dark bg) |
| `note` | `getTextFrame()` → rect hit test. Always filled |
| `image` / `bookmark` | `getFrame()` → simple rect containment. Always filled |

**Spatial index pre-filter:** Query R-tree with `[worldX +- radiusWorld, worldY +- radiusWorld]`, then test each candidate.

### Z-Order Selection (`pickBestCandidate`)

Scans from topmost (highest ULID) to bottommost with occlusion model:

1. **Unfilled shape interiors** = transparent. Remembered (smallest area tracked), scanning continues.
2. **Everything else that paints** (stroke, connector, filled shape, text edge, code) = opaque. Stops scan.
3. Resolution: ink always beats frames. Between fill and frame: smaller area wins. Tie: higher Z wins.

### Handle Hit Testing (`hitTestHandle`)

Screen-space radius: `HANDLE_HIT_PX = 10` / scale. Tests corners first, then side edges. Side edges only hit if cursor is between corners.

### Marquee Intersection (`objectIntersectsRect`)

Per-kind geometry intersection (not just bbox):
- Strokes/connectors: `polylineIntersectsRect()` on points
- Shapes: shape-type-aware (ellipse perimeter sampling, diamond edge/vertex, rect bounds)
- Text/code/note: derived frame → rect intersection
- Image/bookmark: stored frame → rect intersection

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

Generic edge-pin fallback. Typed as `Entry<KindWithBBoxGeo>` where:
```typescript
type KindWithBBoxGeo = { [K in ObjectKind]: GeoOf<K> extends { bbox: BBoxTuple } ? K : never }[ObjectKind];
// Resolves to: 'stroke' | 'text' | 'code' | 'note' | 'bookmark'
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

Transform state in the store is now a **thin discriminant** (`{ kind: 'translate' }`, `{ kind: 'scale' }`). All transform data (entries, scale factors, delta, topology) lives in `TransformController`. The store only signals which transform mode is active for UI/renderer branching.

Exception: `EndpointDragTransform` still carries full state in the store (connectorId, endpoint, routedPoints, currentSnap, prevBbox) — it's not entry-based.

### Key Actions

| Action | Effect |
|--------|--------|
| `setSelection(ids)` | Compute composition, reset transform/marquee, bump boundsVersion, refreshStyles |
| `clearSelection()` | Reset everything to defaults |
| `beginTranslate()` | Set `{ kind: 'translate' }` |
| `beginScale()` | Set `{ kind: 'scale' }` |
| `endTransform()` / `cancelTransform()` | Set `{ kind: 'none' }` |
| `beginEndpointDrag(connId, endpoint, bbox)` | Set endpointDrag transform |
| `beginTextEditing(id, isNew)` | Set textEditingId, menuOpen=true, refreshStyles |
| `endTextEditing()` | Clear textEditingId, menuOpen=conditional, refreshStyles |
| `beginCodeEditing(id)` | Set codeEditingId, menuOpen=true, refreshStyles |
| `endCodeEditing()` | Clear codeEditingId, menuOpen=conditional |
| `refreshStyles()` | Recompute selectedStyles + inlineStyles from current state |

---

## Selection Utils (selection-utils.ts)

### computeSelectionComposition(ids)

Single-pass bucket count. Returns `{ selectionKind, kindCounts, selectedIdSet, mode }`.

### computeSelectionBounds()

Zero-arg: reads `selectedIds` → `textEditingId` → `codeEditingId` fallback chain.
- Text/code: `getTextFrame(id)` / `getCodeFrame(id)` (layout-derived, WYSIWYG-accurate)
- All others: `handle.bbox`

### computeStyles(ids, kind, objectsById)

Returns `EMPTY_STYLES` immediately for `none`, `mixed`, `imagesOnly`, `bookmarksOnly`.

### computeUniformInlineStyles(ids, objectsById)

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
| `tools/selection/SelectTool.ts` | State machine, hit testing dispatch, delegates to TransformController, endpoint drag commit |
| `tools/selection/transform.ts` | TransformController, structural traits, mapped types, dispatch tables, apply/commit/freeze functions, module getters |
| `tools/selection/selection-utils.ts` | `computeSelectionComposition`, `computeSelectionBounds`, `computeStyles`, `computeUniformInlineStyles` |
| `tools/selection/selection-actions.ts` | 21 mutation functions for context menu buttons (documented in context-menu CLAUDE.md) |
| `stores/selection-store.ts` | Zustand store, transform types (thin discriminants), connector topology builder, handle helpers |
| `core/geometry/scale-system.ts` | Pure math atoms: scaleAround, uniformFactor (handle-aware), preservePosition, edgePinDelta, computeReflowWidth |
| `core/geometry/bounds.ts` | Bbox/frame tuple helpers, WorldBounds operations, mutating offset primitives |
| `core/types/handles.ts` | HandleId taxonomy, type guards, scaleOrigin, handleCursor |
| `core/geometry/hit-testing.ts` | `testObjectHit`, `hitTestHandle`, `hitTestEndpointDots`, `objectIntersectsRect` |
| `renderer/layers/objects.ts` | `drawObjects` dispatch, `renderScaleEntry` (entry-based), `renderTranslatedEntry` (edge-pin fallback) |
| `renderer/layers/selection-overlay.ts` | `drawSelectionOverlay`: highlights, marquee, box+handles, endpoint dots |
