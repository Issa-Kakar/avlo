# Selection System

SelectTool + selection store + hit testing + transform rendering. The most complex tool in the codebase: handles translate, scale (per-kind-aware), connector endpoint drag, marquee, multi-select, text/code editing entry, and Z-order-aware hit testing.

## Architecture

```
SelectTool.ts (PointerTool singleton via tool-registry)
├── State machine: idle → pendingClick → marquee | translate | scale | endpointDrag
├── Hit testing via core/geometry/hit-testing.ts
├── Transform commits via room-runtime.transact()
└── Preview data → overlay + base canvas rendering

selection-store.ts (Zustand + subscribeWithSelector)
├── selectedIds, mode, selectionKind, kindCounts
├── transform: TranslateTransform | ScaleTransform | EndpointDragTransform
├── marquee, connectorTopology, textReflow, codeReflow
├── textEditingId, codeEditingId
└── selectedStyles, inlineStyles, boundsVersion (context menu support)

selection-utils.ts (pure functions)
├── computeSelectionComposition(ids) → kind, mode, counts
├── computeSelectionBounds() → WorldBounds (zero-arg, reads store)
├── computeStyles(ids, kind, objectsById) → SelectedStyles
└── computeUniformInlineStyles(ids, objectsById) → InlineStyles

selection-actions.ts (mutation functions — documented in context-menu/CLAUDE.md)

core/geometry/hit-testing.ts (shared with EraserTool)
├── testObjectHit() → HitCandidate (per-kind dispatch)
├── hitTestHandle() → HandleId (resize handles)
├── hitTestEndpointDots() → EndpointHit (connector mode)
├── objectIntersectsRect() (marquee geometry)
└── hitTestVisibleText/Note/Code() (tool click-to-edit)

core/geometry/transform.ts (pure math)
├── computeScaleFactors() → {scaleX, scaleY}
├── computeUniformScaleNoThreshold() → uniform scale with flip
├── computePreservedPosition() → [x, y] (position preservation in flipped box)
├── computeEdgePinTranslation() → {dx, dy} (mixed+side pinning)
├── applyUniformScaleToPoints/Frame() (stroke/shape uniform scale)
├── transformFrameForTopology() (connector topology dispatch)
└── applyTransformToFrame/Bounds() (generic transforms)

renderer/layers/objects.ts (base canvas)
├── drawObjects() — main dispatch, reads selectionStore for transform preview
├── renderSelectedObjectWithScaleTransform() — per-kind scale dispatch
└── Per-kind preview: drawScaledStrokePreview, drawScaledTextPreview,
    drawReflowedTextPreview, drawScaledCodePreview, drawReflowedCodePreview,
    drawScaledNotePreview, drawShapeWithTransform, drawShapeWithUniformScale

renderer/layers/selection-overlay.ts (overlay canvas)
├── drawSelectionOverlay() — main entry
├── Phase 1: Object highlights (blue outlines, per-kind rendering)
├── Phase 2: Marquee rectangle
├── Phase 3: Selection box + circular handles (standard mode only)
└── Phase 4: Connector endpoint dots + snap midpoint dots (connector mode)
```

---

## State Machine

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
   Standard mode → check pointInWorldRect(selectionBounds) → 'selectionGap'
   Otherwise → 'background' (clearSelection if had selection)
6. phase = 'pendingClick' for all except background-with-no-selection
```

**Single text/code re-click exception:** When clicking a single-selected text/code/note object, `cancelHide()` is called immediately after `hide()` to prevent context menu flash. The synchronous class add+remove in the same frame means no paint. If user drags instead, `move()` calls `hide()` when drag threshold passes.

### pendingClick → Phase Transition (in move())

Each target type requires `passMove` (dist > MOVE_THRESHOLD_PX) before transitioning. `selectionGap` and `background` also accept `passTime` (elapsed >= CLICK_WINDOW_MS).

| DownTarget | Transition | Notes |
|------------|------------|-------|
| `handle` | → `scale` | Compute geometry bounds for origin, then `beginScale()` |
| `connectorEndpoint` | → `endpointDrag` | Drill to single connector if multi-selected, then `beginEndpointDrag()` |
| `objectOutsideSelection` | → `translate` | First selects the object, then begins translate. Anchored connectors → `marquee` instead |
| `objectInSelection` | → `translate` | In connector mode, anchored connectors → `marquee` instead |
| `selectionGap` | → `translate` | Gap drag = translate entire selection |
| `background` | → `marquee` | Empty area drag = marquee select |

### end() — Click Finalization (pendingClick)

| DownTarget | Click Behavior |
|------------|----------------|
| `handle` | No-op (didn't drag) |
| `connectorEndpoint` | Drill to single connector |
| `objectOutsideSelection` | Shift/Ctrl: additive select. Else: replace selection |
| `objectInSelection` | Shift/Ctrl: subtractive remove. Multi-selected: drill to single. Single text/note/shape: enter text editing. Single code: enter code editing |
| `selectionGap` | Quick tap (< 180ms, < 4px): deselect. Longer: keep selection |
| `background` | Deselect |

**Text/Code editing entry guards:**
- Text/note/shape: only if `!textTool.isEditorMounted()`. `justClosedLabelId` prevents immediate re-open after closing.
- Code: only if `!codeTool.isEditorMounted()`. `justClosedCodeId` same guard.

### Modifier Keys

- **Shift or Ctrl/Cmd held** (`hasAddModifier()`): additive/subtractive multi-select on click
- **Ctrl held** during endpoint drag: suppresses connector snapping
- Modifier check: `isShiftHeld() || isCtrlOrMetaHeld()` from InputManager

---

## Selection Modes

```typescript
type SelectionMode = 'none' | 'standard' | 'connector';
```

- **`none`**: No objects selected
- **`standard`**: 1+ objects selected (any mix). Shows selection box + resize handles. Handles → scale, objects → translate
- **`connector`**: Exactly 1 connector selected. Shows endpoint dots instead of handles. Dots → endpoint drag

Mode is derived in `computeSelectionComposition()`:
- `connector` when `selectedIdSet.size === 1 && selectionKind === 'connectorsOnly'`
- `standard` when `selectedIdSet.size > 0`
- `none` otherwise

### SelectionKind

```typescript
type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'textOnly' | 'codeOnly'
  | 'notesOnly' | 'connectorsOnly' | 'imagesOnly' | 'bookmarksOnly' | 'mixed';
```

Computed by counting non-zero kind buckets. If exactly 1 bucket > 0 → that kind. If > 1 → `'mixed'`. Determines transform behavior, handle visibility, and context menu bar.

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

**Spatial index pre-filter:** Query R-tree with `[worldX ± radiusWorld, worldY ± radiusWorld]`, then test each candidate.

### Z-Order Selection (`pickBestCandidate`)

Scans from topmost (highest ULID) to bottommost with occlusion model:

1. **Unfilled shape interiors** = transparent. Remembered (smallest area tracked), but scanning continues.
2. **Everything else that paints** (stroke, connector, filled shape, text edge, code) = opaque. Stops scan.
3. Resolution: ink always beats frames. Between fill and frame: smaller area wins. Tie: higher Z wins.

### Handle Hit Testing (`hitTestHandle`)

Screen-space radius: `HANDLE_HIT_PX = 10` / scale. Tests corners first (nw/ne/se/sw), then side edges (n/s/e/w). Side edges only hit if cursor is between corners (excludes corner zones).

**Special case:** `bookmarksOnly` with single selection → no handles at all (fixed size, no scaling).

### Endpoint Dot Hit Testing (`hitTestEndpointDots`)

Screen-space radius: `ENDPOINT_DOT_HIT_PX = 10` / scale. Iterates selected connectors, tests both start/end positions derived from `getEndpointEdgePosition()`.

### Marquee Intersection (`objectIntersectsRect`)

Per-kind geometry intersection (not just bbox):
- Strokes/connectors: `polylineIntersectsRect()` on points
- Shapes: shape-type-aware (ellipse perimeter sampling, diamond edge/vertex, rect bounds)
- Text/code/note: derived frame → rect intersection
- Image/bookmark: stored frame → rect intersection

---

## Transform System

### Transform Types

```typescript
type TransformState =
  | { kind: 'none' }
  | TranslateTransform    // { kind: 'translate', dx, dy, originBounds }
  | ScaleTransform         // { kind: 'scale', origin, scaleX, scaleY, originBounds, bboxBounds, handleId, selectionKind, handleKind, initialDelta }
  | EndpointDragTransform; // { kind: 'endpointDrag', connectorId, endpoint, currentPosition, currentSnap, routedPoints, routedBbox, prevBbox }
```

### Translate

Simple: all objects move by `(dx, dy)`. Connectors with both endpoints moving use `ctx.translate()` on cached Path2D. Connectors with one endpoint anchored to non-selected shape use A* reroute.

**Commit:** Strokes → offset points. Text/code/note → offset origin. Shape/image/bookmark → offset frame. Connectors handled by topology.

### Scale — The Complex One

Scale behavior depends on three factors: **selectionKind**, **handleKind** (corner vs side), and **object kind**.

#### Scale Factor Computation

```typescript
computeScaleFactors(worldX, worldY, transform):
  // Vector from origin to cursor / vector from origin to initial click
  Corner: scaleX = dx/initDx, scaleY = dy/initDy  (free both axes)
  Side H (e/w): scaleX = dx/initDx, scaleY = 1
  Side V (n/s): scaleY = dy/initDy, scaleX = 1
```

Uses `initialDelta` (distance from scale origin to initial click), NOT selection bounds width. This ensures `scale=1.0` exactly when cursor returns to start position. Negative scales pass through raw (no dead zone).

#### Geometry Bounds vs BBox Bounds

`beginScale()` uses two bounds:
- **`originBounds`** (geometry-based): Raw frames/points without stroke padding. Used for scale origin computation. Prevents anchor sliding.
- **`bboxBounds`** (padded): Used for dirty rect invalidation (visual coverage).

`computeTransformBoundsForScale()` calls `computeRawGeometryBounds()` which uses frame rects for shapes/text/code/image/bookmark, points min/max for strokes, and bbox for notes/connectors.

#### Transform Behavior Matrix

**Corner Handles (nw/ne/se/sw):**

| Object Kind | Behavior | Details |
|------------|----------|---------|
| **Stroke** | Uniform scale | `applyUniformScaleToPoints()`: center-based, width scales with geometry. "Copy-paste" flip: position preserved in box, geometry uses `abs(scale)` |
| **Shape** (shapesOnly) | Non-uniform scale | `applyTransformToFrame()`: frame corners scale around origin independently. Stroke width NOT scaled |
| **Shape** (mixed) | Uniform scale | `applyUniformScaleToFrame()`: same as strokes — center-based, position preserved |
| **Text** | Uniform scale | fontSize rounded to 3dp, width scaled proportionally, origin recomputed from new frame center |
| **Code** | Uniform scale | Same pattern as text: fontSize rounded, width scaled, origin from center |
| **Note** | Uniform scale | `scale` property (not fontSize) rounded to 3dp. Position preserved via bbox center |
| **Image** | Uniform scale | `applyUniformScaleToFrame()`: aspect ratio preserved always |
| **Bookmark** | Position-only | Fixed size. `computeBookmarkCornerTranslation()`: center translates using preserved-position logic |
| **Connector** | Reroute | Always A* reroute during scale (never translate strategy) |

**Side Handles (n/s/e/w):**

| Object Kind | E/W Handle | N/S Handle (kind-only) | N/S Handle (mixed) |
|------------|------------|----------------------|-------------------|
| **Stroke** (strokesOnly) | Uniform scale (active axis only) | Uniform scale (active axis only) | Edge-pin translate |
| **Stroke** (mixed) | Edge-pin translate | — | Edge-pin translate |
| **Shape** | Non-uniform scale | Non-uniform scale | Non-uniform scale |
| **Text** (textOnly) | **Reflow** (width change, re-layout) | Uniform scale | — |
| **Text** (mixed) | Edge-pin translate | — | Edge-pin translate |
| **Code** (codeOnly) | **Reflow** (width change, re-layout) | Uniform scale | — |
| **Code** (mixed) | Edge-pin translate | — | Edge-pin translate |
| **Note** | Uniform scale | Uniform scale | Edge-pin translate (uses bbox) |
| **Image** | Uniform scale | Uniform scale | Edge-pin translate |
| **Bookmark** | Edge-pin translate | Edge-pin translate | Edge-pin translate |
| **Connector** | Reroute | Reroute | Reroute |

#### Uniform Scale Math

```typescript
computeUniformScaleNoThreshold(scaleX, scaleY):
  // No dead zone — immediate flip when dominant < 0
  Both negative → -(max(|scaleX|, |scaleY|))
  Side handle → use ONLY the active axis magnitude
  Corner → max(|scaleX|, |scaleY|), sign from dominant axis
  Minimum: 0.001

computePreservedPosition(cx, cy, originBounds, origin, uniformScale):
  // When flipping, objects maintain relative position (0-1) in box
  // instead of inverting (close-to-origin → far-from-origin)
  tx = (cx - minX) / boxWidth  // relative position 0-1
  newMinX = min(origin + (minX - ox) * scale, origin + (maxX - ox) * scale)
  result = newMinX + tx * newBoxWidth
```

#### Edge-Pin Translation

Used when objects can't scale but need to stay pinned to the selection edge:

```typescript
computeEdgePinTranslation(minX, maxX, minY, maxY, originBounds, scaleX, scaleY, origin, handleId):
  // Horizontal handles: pin object to anchor edge (opposite edge of dragged handle)
  // Vertical handles: pin object to anchor edge
  // Objects touching the anchor edge stay pinned
  // Objects not touching: center follows scale, with flip compensation
```

**Note bbox for edge-pin:** Notes use bbox bounds (body + shadow padding) for edge-pin, because `computeRawGeometryBounds()` uses bbox for notes and the handles are positioned at bbox. Shadow pad ratio = `frame[2] * 0.15`.

#### Text/Code Reflow (E/W handles)

When `selectionKind === 'textOnly'` or `'codeOnly'` and handle is `e` or `w`:

```
1. Scale both frame edges around origin
2. Normalize (left = min, right = max)
3. Clamp to minimum width (minCharWidth for text, minCodeWidth for code)
4. If clamped: pin edge closest to scale origin
5. Re-layout content at new width
6. Store layout + new origin in TextReflowState / CodeReflowState
```

Text: `layoutMeasuredContent(measured, targetWidth, fontSize)` with new origin computed from anchor factor.
Code: `computeCodeLayout(sourceLines, fontSize, targetWidth, lineNumbers)`.

These pre-computed layouts are used by both the render preview (`drawReflowedTextPreview`/`drawReflowedCodePreview`) and the dirty rect computation, then committed as `width` + `origin` to Y.Map.

### Endpoint Drag

Only in connector mode (single connector selected). Dragging start or end endpoint:

```
1. Find snap target (findBestSnapTarget) — Ctrl suppresses
2. Build endpoint override (SnapTarget or [worldX, worldY])
3. Reroute connector (rerouteConnector with override)
4. Update store with position, snap, routedPoints, routedBbox
5. Invalidate prev + current dirty rects
```

**Commit:** Sets `points`, `start`, `end` on Y.Map. Updates or deletes anchor key based on snap state.

---

## Connector Topology

Computed once at transform `begin()` via `computeConnectorTopology(transformKind, selectedIds)`. Determines how each connector behaves during the transform.

### Strategy Determination

Two passes:
1. **Selected connectors:** For each, check if both endpoints move (free endpoints always move if connector is selected; anchored endpoints move if anchored shape is selected).
2. **Non-selected connectors:** Anchored to selected shapes. Only the anchored endpoint moves.

```
Translate + both endpoints move → strategy: 'translate' (ctx.translate on cached Path2D)
Otherwise → strategy: 'reroute' (A* each frame via rerouteConnector)
Scale → always 'reroute' (never translate)
```

### EndpointSpec (for reroute)

Per-endpoint override specification:

```typescript
type EndpointSpec = string | true | null;
// string = shapeId — frame override (transform shape's frame, use as anchor)
// true   = free position override (apply transform to original endpoint position)
// null   = canonical (no override — endpoint stays at stored value)
```

### Per-Frame Rerouting (`invalidateTransformPreview`)

For each reroute entry:
1. Build endpoint overrides from specs:
   - `string` spec → `{ frame: transformFrameForTopology(originalFrame, transform, kind) }`
   - `true` spec → `transformPositionForTopology(originalPoint, transform)`
2. Call `rerouteConnector(id, overrides)` → new points
3. Store in `topology.reroutes` map (mutable, zero allocation)
4. Track bbox in `topology.prevBboxes` for dirty rect accumulation

### Topology Frame Transform (`transformFrameForTopology`)

Dispatches frame transform based on object kind:
- Images: uniform scale, except mixed+side = edge-pin translate
- Notes: uniform scale, except mixed+side = edge-pin translate (uses bbox with shadow pad)
- Bookmarks: fixed size — side = edge-pin, corner = preserved-position
- Text/code (mixed/textOnly/codeOnly + corner): uniform scale
- Shapes: non-uniform scale via `applyTransformToFrame`

---

## Rendering During Transforms

### Base Canvas (`objects.ts`)

`drawObjects()` reads selection store. For selected objects during active transforms:

**Translate:** `ctx.save() → ctx.translate(dx, dy) → drawObject() → ctx.restore()`. Connectors use topology: translateOnly → ctx.translate, rerouted → `drawConnectorFromPoints()`.

**Scale:** `renderSelectedObjectWithScaleTransform()` dispatches per-kind:

| Kind | Renderer | Method |
|------|----------|--------|
| Stroke (mixed+side) | `drawObject()` with `ctx.translate(dx, dy)` | Cached Path2D + edge-pin |
| Stroke (else) | `drawScaledStrokePreview()` | Fresh PerfectFreehand outline per frame |
| Shape (mixed+corner) | `drawShapeWithUniformScale()` | Fresh Path2D from uniform-scaled frame |
| Shape (else) | `drawShapeWithTransform()` | Fresh Path2D from `applyTransformToFrame` |
| Text (corner / textOnly-N/S) | `drawScaledTextPreview()` | Cached layout + `ctx.scale(effectiveAbsScale)` |
| Text (E/W reflow) | `drawReflowedTextPreview()` | Pre-computed layout from `textReflow` |
| Text (mixed N/S) | `drawText()` with `ctx.translate(dx, dy)` | Cached + edge-pin |
| Code (corner / codeOnly-N/S) | `drawScaledCodePreview()` | Cached layout + `ctx.scale(effectiveAbsScale)` |
| Code (E/W reflow) | `drawReflowedCodePreview()` | Pre-computed layout from `codeReflow` |
| Code (mixed N/S) | `drawCode()` with `ctx.translate(dx, dy)` | Cached + edge-pin |
| Note (mixed+side) | `drawStickyNote()` with `ctx.translate(dx, dy)` | Cached + edge-pin (bbox) |
| Note (else) | `drawScaledNotePreview()` | Nested ctx.scale around note's origin |
| Image (mixed+side) | `drawImage()` with `ctx.translate(dx, dy)` | Cached + edge-pin |
| Image (else) | `drawImage()` with uniform-scaled frame | `applyUniformScaleToFrame` |
| Bookmark (side) | `drawBookmark()` with `ctx.translate(dx, dy)` | Edge-pin translate |
| Bookmark (corner) | `drawBookmark()` with `ctx.translate(dx, dy)` | Preserved-position translate |
| Connector | `drawConnectorFromPoints()` or `drawObject()` | Via topology reroutes |

**Endpoint drag:** Connector with matching id + routedPoints → `drawConnectorFromPoints()`. Others → normal `drawObject()`.

**Culling guard:** During transforms, all selected IDs + topology connector IDs are injected into the candidate list regardless of spatial index viewport query results. This prevents objects from disappearing during edge-scroll panning.

### Overlay Canvas (`selection-overlay.ts`)

Four phases, all in world-transform scope:

1. **Object highlights** (when not transforming, selected count > 0): Blue outlines per kind. Shapes use cached Path2D scaled to visual outer edge. Text/code/image use frame rect. Stroke/connector use bbox rect. Notes/bookmarks use bbox rect. Connector bbox suppressed in connector mode.

2. **Marquee** (when active): Blue-filled rect with solid stroke.

3. **Selection box + handles** (standard mode, not transforming, not in connector mode): Solid blue box at selection bounds. Four circular handles (off-white fill, dark outline, drop shadow). During scale, `originBounds` is used instead of live bbox bounds so handles align with transform.

4. **Connector endpoint dots** (connector mode, single connector): Start/end dots at edge positions. During drag: dragged endpoint shows snap state (blue glow when snapped), plus midpoint indicator dots on target shape.

**Handle suppression:** Handles hidden when: transforming, bookmarksOnly with single selection, text editing (non-label), or code editing.

---

## Dirty Rect Optimization

`invalidateTransformPreview()` accumulates a single expanding envelope:

1. **Connector topology:** reroute bboxes + translateOnly translated bboxes
2. **Object bounds:** Per-kind dispatch matching the scale behavior matrix
3. **Single `invalidateWorld()` call** with the full envelope

The envelope (`transformEnvelope`) is a class field that persists across frames — it only expands, never shrinks. This ensures all previous positions are covered when the object moves.

---

## Selection Store

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
  transform: TransformState;
  marquee: MarqueeState;
  connectorTopology: ConnectorTopology | null;
  textReflow: TextReflowState | null;
  codeReflow: CodeReflowState | null;
  textEditingId: string | null;
  textEditingIsNew: boolean;
  codeEditingId: string | null;
}
```

### Key Actions

| Action | Effect |
|--------|--------|
| `setSelection(ids)` | Compute composition, reset transform/marquee/topology/reflow, bump boundsVersion, refreshStyles |
| `clearSelection()` | Reset everything to defaults, menuOpen=false |
| `beginTranslate(originBounds)` | Compute connector topology ('translate'), set transform |
| `beginScale(bbox, transform, origin, handle, delta)` | Compute connector topology ('scale'), init textReflow/codeReflow if E/W + text/code, set transform |
| `beginEndpointDrag(connId, endpoint, bbox)` | Set endpointDrag transform |
| `endTransform()` / `cancelTransform()` | Clear transform, topology, reflow |
| `beginTextEditing(id, isNew)` | Set textEditingId, menuOpen=true, refreshStyles |
| `endTextEditing()` | Clear textEditingId, menuOpen=conditional on selectedIds, refreshStyles |
| `beginCodeEditing(id)` | Set codeEditingId, menuOpen=true, refreshStyles |
| `endCodeEditing()` | Clear codeEditingId, menuOpen=conditional |
| `refreshStyles()` | Recompute selectedStyles + inlineStyles from current state |

### refreshStyles Resolution

When `selectedIds` is empty but editing:
- `textEditingId` set → `ids = [textEditingId]`, kind resolved from handle (note → `'notesOnly'`, else `'textOnly'`)
- `codeEditingId` set → `ids = [codeEditingId]`, kind = `'codeOnly'`

Inline styles computed when editor is NOT mounted AND kind is `'textOnly'`, `'shapesOnly'`, or `'notesOnly'`.

### Selectors

```typescript
selectTextEditingId, selectIsTextEditing, selectTextEditingIsNew
selectInlineBold, selectInlineItalic, selectInlineHighlightColor
```

### Free Functions

- `filterSelectionByKind(kind)` — Filter selectedIds to single kind, call setSelection. Used by FilterObjectsDropdown.
- `computeHandles(bounds)` — Four corner positions from WorldBounds.
- `getScaleOrigin(handleId, bounds)` — Opposite corner/edge midpoint.
- `getHandleCursor(handleId)` — CSS cursor string.
- `isCornerHandle(handleId)` — Boolean.

---

## Selection Utils

### computeSelectionComposition(ids)

Single-pass bucket count. Returns `{ selectionKind, kindCounts, selectedIdSet, mode }`.

### computeSelectionBounds()

Zero-arg: reads `selectedIds` → `textEditingId` → `codeEditingId` fallback chain.
- Text/note: `getTextFrame(id)` (layout-derived, WYSIWYG-accurate)
- Code: `getCodeFrame(id)` (layout-derived)
- All others: `handle.bbox`

### computeStyles(ids, kind, objectsById)

Returns `EMPTY_STYLES` immediately for `none`, `mixed`, `imagesOnly`, `bookmarksOnly`.

Per-kind field tracking:

| Kind | Fields Tracked |
|------|---------------|
| `strokesOnly` | color, colorMixed, width |
| `shapesOnly` | color, colorMixed, width, fillColor, fillColorMixed, shapeType, fontSize, fontFamily, labelColor, textAlign, textAlignV |
| `connectorsOnly` | color, colorMixed, width |
| `textOnly` | color, fontSize, textAlign, fontFamily, labelColor, fillColor, fillColorMixed, shapeType='text' |
| `notesOnly` | fillColor, fontFamily, textAlign (mismatch→null), textAlignV (mismatch→null) |
| `codeOnly` | fontSize, codeLanguage, codeHeaderVisible, codeOutputVisible |

Text field resolution: first object with text data wins. Text objects use `getColor()` as labelColor. Shapes use `getLabelColor()` (only if `hasLabel()`).

### computeUniformInlineStyles(ids, objectsById)

Aggregates bold/italic/highlight across text/shape(labeled)/note objects. All must be bold for `bold:true`. Highlight must be identical non-null across all.

---

## Commit Path

### commitTranslate

```
transact(() => {
  stroke → offset points
  text/code/note → offset origin
  shape/image/bookmark → offset frame
  topology translate entries → offset originalPoints, set start/end
  topology reroute entries → write rerouted points, set start/end
})
```

### commitScale

Dispatches per-kind inside `transact()`:

| Kind | Commit Logic |
|------|-------------|
| Stroke (mixed+side) | `computeStrokeTranslation()` → offset points |
| Stroke (else) | `applyUniformScaleToPoints()` → new points + scaled width |
| Text (corner / textOnly-N/S) | fontSize rounded 3dp, new origin from center preservation, width scaled |
| Text (E/W reflow) | Write `layout.boxWidth` + reflowOrigin from textReflow state |
| Text (mixed N/S) | Edge-pin: offset origin Y only |
| Code (corner / codeOnly-N/S) | fontSize rounded 3dp, new origin from center preservation, width scaled |
| Code (E/W reflow) | Write `layout.totalWidth` + reflowOrigin from codeReflow state |
| Code (mixed N/S) | Edge-pin: offset origin Y only |
| Note (mixed+side) | Edge-pin: offset origin using bbox bounds |
| Note (else) | Scale property rounded 3dp, origin from bbox-center preservation |
| Image (mixed+side) | Edge-pin: offset frame |
| Image (else) | `applyUniformScaleToFrame()` |
| Bookmark (side) | Edge-pin: offset frame |
| Bookmark (corner) | `computeBookmarkCornerTranslation()` → offset frame |
| Shape (mixed+corner) | `applyUniformScaleToFrame()` |
| Shape (else) | `applyTransformToFrame()` (non-uniform) |
| Connectors | Via topology reroute entries → write rerouted points |

### commitEndpointDrag

```
transact(() => {
  yMap.set('points', routedPoints)
  yMap.set('start', routedPoints[0])
  yMap.set('end', routedPoints[last])
  if (snap) yMap.set(anchorKey, { id, side, anchor })
  else yMap.delete(anchorKey)
})
```

---

## Context Menu Integration

SelectTool controls context menu visibility:
- `begin()` → `contextMenuController.hide()` (always)
- `end()` / `cancel()` → `contextMenuController.show()` (if selection or editing active)
- Single text re-click → `cancelHide()` to prevent flash

Store fields consumed by context menu are documented in `components/context-menu/CLAUDE.md`.

---

## Overlay Styling Constants

```typescript
SELECTION_STYLE = {
  PRIMARY: 'rgba(29, 78, 216, 1)',       // Blue-700
  PRIMARY_FILL: 'rgba(29, 78, 216, 0.15)', // Marquee fill
  PRIMARY_MUTED: 'rgba(29, 78, 216, 0.7)', // Marquee stroke
  HIGHLIGHT_WIDTH: 2,                      // Object outline (screen px)
  BOX_WIDTH: 2,                            // Selection box (screen px)
  MARQUEE_WIDTH: 1.5,                      // Marquee stroke (screen px)
  HANDLE_RADIUS_PX: 6,                     // Handle circle radius
  HANDLE_FILL: 'rgb(250, 250, 250)',       // Off-white
  HANDLE_STROKE: 'rgba(0, 0, 0, 0.25)',   // Subtle outline
  HANDLE_STROKE_WIDTH_PX: 2.5,
  HANDLE_SHADOW_COLOR: 'rgba(0, 0, 0, 0.25)',
  HANDLE_SHADOW_BLUR_PX: 4,
  HANDLE_SHADOW_OFFSET_Y_PX: 1,
}
```

---

## File Map

| File | Responsibility |
|------|----------------|
| `tools/selection/SelectTool.ts` | State machine, hit testing dispatch, transform lifecycle, commit to Y.Doc |
| `tools/selection/selection-utils.ts` | `computeSelectionComposition`, `computeSelectionBounds`, `computeStyles`, `computeUniformInlineStyles` |
| `tools/selection/selection-actions.ts` | 21 mutation functions for context menu buttons (documented in context-menu CLAUDE.md) |
| `stores/selection-store.ts` | Zustand store, transform types, connector topology builder, handle helpers |
| `core/geometry/hit-testing.ts` | `testObjectHit`, `hitTestHandle`, `hitTestEndpointDots`, `objectIntersectsRect`, shape geometry tests |
| `core/geometry/transform.ts` | `computeScaleFactors`, uniform scale, edge-pin, position preservation, topology frame transforms |
| `renderer/layers/objects.ts` | `drawObjects` dispatch, `renderSelectedObjectWithScaleTransform`, per-kind preview renderers |
| `renderer/layers/selection-overlay.ts` | `drawSelectionOverlay`: highlights, marquee, box+handles, endpoint dots |
