# Connector SelectTool Integration — Changelog

> **Scope:** Types, store, mode-aware branching, connector transform behavior (rerouting vs stroke scaling), endpoint drag cycle (snap + route + commit), base canvas rendering from rerouted points.

---

## Phase 1: Types, Store, Separation, Infrastructure

---

### 1. `client/src/stores/selection-store.ts`

#### Types Added
- `SelectionMode = 'none' | 'standard' | 'connector'` — interaction paradigm (handles vs endpoint dots)
- `SelectionKind` — added `'connectorsOnly'` variant
- `ConnectorUpdateEntry` — per-connector tracking during shape transforms (prevBbox, currentPoints, currentBbox)
- `ConnectorTransformContext` — holds `entries: Map<string, ConnectorUpdateEntry>`
- `EndpointDragTransform` — new transform kind (connectorId, endpoint, currentPosition, currentSnap, routedPoints, routedBbox, prevBbox)

#### State Changes
- `mode`: `'none' | 'single' | 'multi'` → `SelectionMode`
- Added `selectionKind: SelectionKind` (cached on setSelection)
- `TranslateTransform` / `ScaleTransform` gained `connectorContext: ConnectorTransformContext | null`
- `TransformState` union includes `EndpointDragTransform`

#### Action Changes
- `setSelection(ids, selectionKind)` — now requires selectionKind, derives mode from it
- `beginTranslate(originBounds, connectorContext?)` — optional connector context
- `beginScale(..., connectorContext?)` — optional connector context
- Added `beginEndpointDrag(connectorId, endpoint, originBbox)`
- Added `updateEndpointDrag(currentPosition, currentSnap, routedPoints, routedBbox)`

---

### 2. `packages/shared/src/utils/bbox.ts`

#### Added `computeConnectorBBoxFromPoints(points, yMap)`
- Takes externally-provided points (e.g. rerouted, not yet committed)
- Reads width and cap info from Y.Map (never stale for style props)
- Computes bbox with arrow/stroke padding (same logic as existing connector case)

---

### 3. `packages/shared/src/index.ts`

- Added `computeConnectorBBoxFromPoints` to barrel export

---

### 4. `client/src/lib/connectors/reroute-connector.ts`

#### API Changes
- `frameOverrides` type: `Map<string, Frame>` → `Map<string, FrameTuple>` (eliminates object→tuple conversion)
- Return type: `[number, number][] | null` → `RerouteResult | null`
- Added `RerouteResult` interface: `{ points: [number, number][]; bbox: WorldBounds }`

#### Internal
- Computes bbox after routing via `computeConnectorBBoxFromPoints(result.points, yMap)`
- `resolveEndpoint` works with `FrameTuple` directly (no conversion)

---

## Phase 2: Mode Branching, Hit Testing Cleanup, Cursor Management

---

### 5. `client/src/lib/connectors/connector-utils.ts`

#### `getEndpointEdgePosition` — Signature Redesigned
- **Old:** `getEndpointEdgePosition(storedPosition, anchor, shapeFrame)` — caller had to decompose Y.Map data manually
- **New:** `getEndpointEdgePosition(handle: ObjectHandle, endpoint: 'start' | 'end', snapshot: Snapshot)` — uses accessors internally
- Resolves stored position, anchor, and shape frame internally via `getStart/getEnd/getStartAnchor/getEndAnchor/getFrame` accessors
- Falls back to stored position if shape deleted or frame missing
- Returns ON-EDGE position (no EDGE_CLEARANCE_W offset)

#### New Imports
- `ObjectHandle`, `Snapshot` types from `@avlo/shared`
- `getStart`, `getEnd`, `getStartAnchor`, `getEndAnchor`, `getFrame` accessors from `@avlo/shared`

---

### 6. `client/src/lib/geometry/hit-testing.ts`

#### `hitTestEndpointDots` — Simplified
- Removed manual decomposition (no more `getStart/getEnd/getStartAnchor/getEndAnchor` calls in hit-testing)
- Now calls `getEndpointEdgePosition(handle, 'start', snapshot)` / `getEndpointEdgePosition(handle, 'end', snapshot)` directly
- Removed `getShapeFrameFromSnapshot()` private helper (no longer needed)

#### Imports Cleaned
- Removed `getStart`, `getEnd`, `getStartAnchor`, `getEndAnchor` imports (moved to connector-utils)
- Kept `getEndpointEdgePosition` import from connector-utils (updated signature)

---

### 7. `client/src/lib/tools/SelectTool.ts`

#### `begin()` — Mode-Aware Branching
- **Standard mode** (`mode === 'standard'`): checks resize handles first (unchanged behavior)
- **Connector mode** (`mode === 'connector'`): checks endpoint dots first via `hitTestEndpointDots`
  - On endpoint hit: sets `downTarget = 'connectorEndpoint'`, applies `grabbing` cursor immediately
  - No handle check, no selectionGap (connector mode has no selection bounds)
- After mode-specific check: common object hit test for both modes
- selectionGap only possible in standard mode (connector mode goes straight to background)

#### `handleHoverCursor()` — Mode-Aware
- **`mode === 'none'`**: clear cursor
- **`mode === 'standard'`**: hit test handles → directional resize cursors (unchanged)
- **`mode === 'connector'`**: hit test endpoint dots → `grab` cursor on hover

#### `move()` pendingClick — `connectorEndpoint` Case Added
- On drag past move threshold:
  - Drills down to single connector if multi-select (sets selection to just that connector)
  - Transitions to `endpointDrag` phase
  - Calls `beginEndpointDrag()` on store with connector's bbox as originBbox
  - Applies `grabbing` cursor

#### `end()` — New Cases
- **pendingClick + `connectorEndpoint`**: click without drag → drills down to single connector (if multi-select)
- **`endpointDrag` phase**: clears transform (Phase 3 will add commit logic)

#### `cancel()` — Handles `endpointDrag`
- Invalidates `prevBbox` from the endpoint drag transform before clearing

#### `getPreview()` — Mode-Aware
- **Connector mode**: skips selection bounds and handles computation entirely (returns null for both)
- **Standard mode**: unchanged (computes bounds + handles)

#### `resetState()` — Clears `endpointHitAtDown`

---

### 8. `client/src/lib/connectors/index.ts`

- Exports unchanged (still exports `getEndpointEdgePosition` — signature change is transparent to barrel)

---

## Phase 3: Connector Transform Behavior & Endpoint Drag Cycle

---

### 9. `client/src/lib/tools/SelectTool.ts`

#### New Imports
- `FrameTuple` from `@avlo/shared`
- `getStartAnchor`, `getEndAnchor` from `@avlo/shared`
- `getConnectorsForShape` from `@/canvas/room-runtime`
- `rerouteConnector` from `@/lib/connectors/reroute-connector`
- `findBestSnapTarget` from `@/lib/connectors/snap`
- `SnapTarget` from `@/lib/connectors/types`
- `ConnectorTransformContext`, `ConnectorUpdateEntry` from `@/stores/selection-store`

#### `commitTranslate()` — Connectors Separated from Strokes
- **Signature changed:** now accepts `connectorContext: ConnectorTransformContext | null` as fourth parameter
- **Stroke branch:** `handle.kind === 'stroke'` only (was `'stroke' || 'connector'`)
- **New connector branch:**
  - Reads `getStartAnchor(yMap)` / `getEndAnchor(yMap)` to classify
  - **Free connectors** (no anchors): offsets `points`, sets `start` = first point, `end` = last point
  - **Anchored connectors**: skipped in per-object loop (anchors are relative to shape, no data change needed)
- **Post-loop connector context commit:**
  - Iterates `connectorContext.entries`
  - Writes `entry.currentPoints` → `yMap.set('points', ...)`, `yMap.set('start', ...)`, `yMap.set('end', ...)`
  - Anchors unchanged (they're normalized [0-1, 0-1] relative to shape frame — shape moved, anchor still valid)

#### `commitScale()` — Connectors Fully Handled by Context
- **Signature changed:** now accepts `connectorContext: ConnectorTransformContext | null` as ninth parameter
- **Connector skip:** `if (handle.kind === 'connector') continue;` — connectors never get stroke-scaled
- **isStroke:** `handle.kind === 'stroke'` only (removed `|| 'connector'`)
- **Post-loop connector context commit:** same pattern as translate (write currentPoints → points/start/end)

#### `buildConnectorContext()` — New Private Method
- Called at translate/scale `begin` (all three translate sites + the scale site)
- **Step 1:** Collects all selected shape/text IDs
- **Step 2:** For each shape, calls `getConnectorsForShape(shapeId)` → accumulates unique connector IDs
- **Step 3:** Creates `ConnectorUpdateEntry` per connector:
  - `connectorId`: the connector ID
  - `isSelected`: whether connector is in `selectedIds`
  - `prevBbox`: from `bboxTupleToWorldBounds(handle.bbox)` (seeded from original)
  - `currentPoints`: null (populated on first move)
  - `currentBbox`: null
- **Step 4:** Also checks selected connectors whose startAnchor/endAnchor points to a selected shape
  - These are connectors that move WITH the selection (both ends could be anchored to transforming shapes)
- Returns `{ entries }` or null if no affected connectors

#### `rerouteAffectedConnectors()` — New Private Method
- Called AFTER `updateTranslate()`/`updateScale()` in both move phases
- **Reads** current transform (translate or scale) from store
- **Builds `frameOverrides: Map<string, FrameTuple>`:**
  - For translate: `[frame[0] + dx, frame[1] + dy, frame[2], frame[3]]` per selected shape
  - For scale: dispatches to `applyUniformScaleToFrame` (mixed+corner) or `applyTransformToFrame` (shapes-only/mixed+side) — matches commitScale logic exactly
- **Reroutes each connector:**
  - Calls `rerouteConnector(connId, frameOverrides)` (endpoint overrides not used here)
  - On success: `invalidateWorld(entry.prevBbox)` + `invalidateWorld(result.bbox)` (separate rects for minimal repaint)
  - Updates entry: `currentPoints = result.points`, `currentBbox = result.bbox`, `prevBbox = result.bbox`

#### `beginTranslate` / `beginScale` Call Sites Updated
- All three `beginTranslate` call sites (objectOutsideSelection, objectInSelection, selectionGap):
  - `const connCtx = this.buildConnectorContext()` before `beginTranslate(bounds, connCtx)`
- `beginScale` call site:
  - `const connCtx = this.buildConnectorContext()` before `store.beginScale(..., connCtx)`

#### `move()` — Translate/Scale Phases Updated
- **Translate move:** after `updateTranslate(dx, dy)`, calls `this.rerouteAffectedConnectors()`
- **Scale move:** after `updateScale(scaleX, scaleY)`, calls `this.rerouteAffectedConnectors()`

#### `move()` — `endpointDrag` Case Implemented
- New case in move() switch after scale case
- **Snap detection:** `findBestSnapTarget({ cursorWorld: [worldX, worldY], scale, prevAttach: epTransform.currentSnap })`
- **Override construction:** builds `{ [endpoint]: snap ?? [worldX, worldY] }` with proper `SnapTarget | [number, number]` typing
- **Rerouting:** `rerouteConnector(connectorId, undefined, endpointOverride)` — frameOverrides unused (only endpoint moves)
- **Dirty rect:** invalidates `prevBbox` + `result.bbox` (two separate world-space rects)
- **Store update:** `updateEndpointDrag(currentPosition, snap, result.points, result.bbox)`
  - `currentPosition`: snap.position if snapped, else raw cursor
  - Snap persisted for hysteresis on next frame (`prevAttach` in SnapContext)

#### `end()` — Translate/Scale Updated
- Extracts `connectorContext` from transform state BEFORE calling `endTransform()`
- Passes to `commitTranslate(selectedIds, dx, dy, connectorContext)` / `commitScale(..., connectorContext)`
- This ensures rerouted points survive the transform clear

#### `end()` — `endpointDrag` Fully Implemented
- Extracts `connectorId, endpoint, routedPoints, currentSnap, prevBbox, routedBbox`
- Invalidates both `prevBbox` and `routedBbox` (covers full dirty area)
- Calls `endTransform()` to clear store
- If `routedPoints.length >= 2`: calls `this.commitEndpointDrag(...)`

#### `commitEndpointDrag()` — New Private Method
- **Signature:** `(connectorId, endpoint, routedPoints, currentSnap: SnapTarget | null)`
- **Y.Doc mutation:**
  - `yMap.set('points', routedPoints)` — full rerouted path
  - `yMap.set('start', routedPoints[0])` — first point
  - `yMap.set('end', routedPoints[routedPoints.length - 1])` — last point
  - **Anchor update:**
    - If `currentSnap`: `yMap.set(anchorKey, { id: snap.shapeId, side: snap.side, anchor: snap.normalizedAnchor })`
    - If no snap: `yMap.delete(anchorKey)` — clears the anchor (endpoint is now free)
  - Other endpoint's anchor/position: UNCHANGED

#### `invalidateTransformPreview()` — Scale Branch Fixed
- Connectors skipped: `if (handle.kind === 'connector') continue;` (handled by `rerouteAffectedConnectors`)
- `const isStroke = handle.kind === 'stroke'` (removed `|| 'connector'`)

---

### 10. `client/src/renderer/layers/objects.ts`

#### New Imports
- `getStartCap`, `getEndCap`, `getStartAnchor`, `getEndAnchor` from `@avlo/shared`
- `buildConnectorPaths` from `@/lib/connectors/connector-paths`
- `ConnectorTransformContext` type from `@/stores/selection-store`

#### `drawObjects()` — Connector Context Read
- Reads `connectorContext` from transform state (only on translate/scale, null otherwise)
- Stored as local variable for the draw loop

#### `drawObjects()` — Translate Block Rewritten for Connectors
- **Connector case** (`handle.kind === 'connector'`):
  - Checks `connectorContext.entries.get(handle.id)?.currentPoints`
  - If rerouted: `drawConnectorFromPoints(ctx, handle, currentPoints)`
  - Else if free (no startAnchor, no endAnchor): `ctx.translate(dx, dy)` + cached path (simple offset)
  - Else: `drawObject(ctx, handle)` fallback (anchored but no reroute yet — first frame edge case)
- **Non-connector case:** unchanged `ctx.translate(dx, dy)` + cached path

#### `drawObjects()` — EndpointDrag Block Added
- When `transform.kind === 'endpointDrag'`:
  - If `handle.id === transform.connectorId` and `transform.routedPoints`: `drawConnectorFromPoints()`
  - Else: `drawObject()` fallback

#### `drawObjects()` — Non-Selected Connector Override
- After the `needsTransform` block, in the else branch:
  - Checks `connectorContext?.entries.get(entry.id)?.currentPoints` for non-selected connectors
  - These are **external connectors** (anchored to a selected shape but not themselves selected)
  - If rerouted: `drawConnectorFromPoints()` instead of cached path
  - This ensures connectors attached to moving shapes reroute visually even when not in selection

#### `renderSelectedObjectWithScaleTransform()` — Signature & Logic Updated
- **New parameter:** `connectorContext: ConnectorTransformContext | null`
- **Connector case** (before stroke check):
  - Reads `connectorContext.entries.get(handle.id)?.currentPoints`
  - If rerouted: `drawConnectorFromPoints()`
  - Else: `drawObject()` fallback (cached, no transform applied)
  - Returns early — connectors NEVER go through stroke scaling
- **isStroke:** `handle.kind === 'stroke'` only (removed `|| 'connector'`)

#### `drawConnectorFromPoints()` — New Helper Function
- **Purpose:** Render a connector from explicit points (for rerouted connectors during transforms)
- **Reads from `handle.y`:** color, width, opacity, startCap, endCap (via typed accessors)
- **Builds fresh paths:** `buildConnectorPaths({ points, strokeWidth: width, startCap, endCap })`
- **Renders two-pass** (same pattern as `drawConnector()`):
  - Pass 1: `ctx.stroke(paths.polyline)` with round caps/joins
  - Pass 2: arrows with `ARROW_ROUNDING_LINE_WIDTH` fixed lineWidth, fill + stroke for rounded corners

---

## Phase 4: Multi-Connector Scale, Per-Endpoint Transform, Anchor-Aware Drag

---

### 11. `client/src/stores/selection-store.ts`

#### Mode Derivation Fix — Single vs Multi-Connector

- **Old:** `selectionKind === 'connectorsOnly'` → always `mode='connector'`
- **New:** `ids.length === 1 && selectionKind === 'connectorsOnly'` → `mode='connector'`; 2+ connectors → `mode='standard'`
- **Result:**
  - 1 connector → `mode='connector'` (endpoint dots, no selection bounds, endpoint drag UX)
  - 2+ connectors → `mode='standard'` (selection box, resize handles, scale transforms)
  - Any mixed → `mode='standard'`

#### `ConnectorUpdateEntry` — Per-Endpoint State Added

New fields for free endpoint transform computation:
```typescript
startIsAnchored: boolean;   // Whether start is anchored to a shape
endIsAnchored: boolean;     // Whether end is anchored to a shape
originalStart: [number, number];  // Stored start position at build time
originalEnd: [number, number];    // Stored end position at build time
```

These enable `computeFreeEndpointOverrides()` to independently decide which endpoints need transform overrides without re-reading Y.Map data on every move frame.

---

### 12. `client/src/lib/tools/SelectTool.ts`

#### New Imports
- `getStart`, `getEnd` from `@avlo/shared` (for reading endpoint positions at context build time)
- `computeUniformScaleNoThreshold`, `computePreservedPosition` from `@/lib/geometry/transform` (for free endpoint scale math)
- `TranslateTransform`, `ScaleTransform` types from `@/stores/selection-store` (for method signatures)

#### `buildConnectorContext()` — Rewritten as 2-Pass Endpoint Truth Table

**Old approach (3 passes):**
1. Find connectors anchored to selected shapes
2. Find selected connectors with anchors to selected shapes (redundant with pass 1 in most cases)
3. Include remaining selected connectors (fully-free)

**New approach (2 passes):**

**Per-endpoint truth table that determines if a connector enters the context:**
| Endpoint State | Connector Selected? | Behavior |
|---|---|---|
| Free | Yes | Moves via endpointOverride (transform applied) |
| Anchored + shape selected | Either | Moves via frameOverride |
| Anchored + shape NOT selected | Yes | Stays canonical |
| Free | No | Stays canonical |

**Pass 1: Selected connectors**
```typescript
for (const id of selectedIds) {
  if (handle.kind !== 'connector') continue;
  const startMoves = !startAnchor || selectedSet.has(startAnchor.id);
  const endMoves = !endAnchor || selectedSet.has(endAnchor.id);
  if (!startMoves && !endMoves) continue; // Both anchored to non-selected
  entries.set(id, { ...allFields });
}
```
- Covers: both-free, free+anchored-to-selected, free+anchored-to-non-selected, both-anchored-to-selected
- Skips: both-anchored-to-non-selected (nothing moves, connector stays canonical)

**Pass 2: Non-selected (external) connectors anchored to selected shapes**
```typescript
for (const id of selectedIds) {
  if (handle.kind !== 'shape' && handle.kind !== 'text') continue;
  for (const connId of getConnectorsForShape(id)) {
    if (entries.has(connId)) continue; // Already handled by pass 1
    entries.set(connId, { isSelected: false, ...fields });
  }
}
```
- These connectors aren't part of the selection — only their anchored endpoint moves (via frameOverride)
- Free endpoints of non-selected connectors stay canonical (correct: user didn't select them)

**Key cases handled correctly:**
| Case | Pass | Free endpoint | Anchored endpoint |
|------|------|---|---|
| Selected, both free | 1 | endpointOverride | endpointOverride |
| Selected, free + anchored-to-selected | 1 | endpointOverride | frameOverride |
| Selected, free + anchored-to-non-selected | 1 | endpointOverride | stays canonical |
| Selected, both anchored-to-selected | 1 | frameOverride | frameOverride |
| Selected, both anchored-to-non-selected | skipped | — | — |
| Non-selected, anchored to selected | 2 | stays | frameOverride |

#### `transformFreeEndpoint()` — New Private Method

Pure function: applies the current transform to a single free endpoint position, matching the transform strategy for the current `selectionKind` × `handleKind`:

- **Translate:** simple `[x + dx, y + dy]` offset
- **Mixed + corner (scale):** uniform scale with position preservation via `computeUniformScaleNoThreshold` + `computePreservedPosition` (matches stroke/shape behavior for mixed selections)
- **Other scale (connectorsOnly, shapesOnly, mixed+side):** non-uniform `origin + (pos - origin) * scale` (matches shape corner-anchored scaling)

#### `computeFreeEndpointOverrides()` — New Private Method

Per-entry computation of which endpoints need position overrides:
- Only selected connectors (`isSelected = true`) get endpoint overrides
- Only free endpoints (`!startIsAnchored` / `!endIsAnchored`) get overrides
- Returns `{ start?: [number, number]; end?: [number, number] } | null`
- Non-selected connectors (external) never get endpoint overrides — their free ends stay canonical

#### `rerouteAffectedConnectors()` — Endpoint Overrides Added

- Now calls `this.computeFreeEndpointOverrides(entry, transform)` per connector entry
- Passes result to `rerouteConnector(connId, frameOverrides, endpointOverrides)`
- `rerouteConnector`'s `resolveEndpoint` handles the override: array positions become free endpoints with computed direction

#### Anchor-Aware Drag — `objectOutsideSelection`

When dragging an unselected connector:
- Reads `getStartAnchor` / `getEndAnchor` from connector's Y.Map
- **Anchored (any anchor):** starts marquee from `downWorld` (can't translate anchored connector body)
- **Free (no anchors):** falls through to standard select + translate

#### Anchor-Aware Drag — `objectInSelection` (Connector Mode)

When dragging the selected connector in connector mode (`mode === 'connector'`):
- Checks anchor state of the single selected connector
- **Anchored:** starts marquee (visual feedback — positions derive from shapes)
- **Free:** falls through to translate (the connector can move freely)
- In standard mode (2+ items): always translates (free endpoints offset via context, anchored stay)

#### `commitTranslate()` — Connector Context Skip

- Connector branch now checks `if (connectorContext?.entries.has(id)) continue;`
- All selected connectors are in the context (Pass 1 adds them)
- Eliminates the old free-connector offset code path for context connectors
- Fallback for safety: free connectors NOT in context still get simple offset (shouldn't happen)

#### `invalidateTransformPreview()` — Connector Scale Invalidation

- **Old:** `if (handle.kind === 'connector') continue;` — skipped all connectors
- **New:** `if (handle.kind === 'connector' && selectionKind !== 'connectorsOnly') continue;`
- For `connectorsOnly` scale: connectors participate in the dirty rect envelope pattern
- This fixes disappearing connectors during axis flips in connectors-only scale transforms
- **Known issue:** connector disappearance on axis flips still under investigation (no stale pixels, but new position may not be properly cleared — zooming out forces full redraw and connector reappears)

---

### 13. `client/src/renderer/types.ts`

#### Dirty Rect Config Tuning
- `MAX_RECT_COUNT`: 20 → 10 (promotes to full clear earlier — reduces fragmented partial clears during connector transforms)

---

## Known Technical Debt

- **Duplicate `'endpointDrag'` identifier:** exists as both a `Phase` value in SelectTool's local state machine (`type Phase = 'idle' | ... | 'endpointDrag'`) AND as a `TransformState.kind` in the selection store (`EndpointDragTransform`). These are conceptually distinct (tool gesture phase vs. store transform state) but the name collision creates confusion when reading the code.
- **`rerouteAffectedConnectors` rebuilds frameOverrides every frame:** the map of `shapeId → transformedFrame` is reconstructed on each move. Should cache the selectedIds→frame mapping at begin and only apply the current transform delta to those frames. The shape IDs don't change during a gesture — only the transform values change.
- **No translate optimization for fully-selected connectors:** when both endpoints of a connector are selected and the transform is a translate, the connector path is identical (just offset). Currently we still run full A* routing. Should detect this case and either: (a) exclude from context entirely and use `ctx.translate()` like shapes, or (b) short-circuit the reroute to simple point offset.
- **Individual `invalidateWorld()` per connector in reroute loop:** each connector calls `invalidateWorld(prevBbox)` + `invalidateWorld(resultBbox)` separately. Should accumulate all connector dirty bounds first, then issue a single `invalidateWorld(unionOfAll)`. Current approach creates many small dirty rects that get promoted to full clear via `MAX_RECT_COUNT`.
- **Rerouting and invalidation split across phases:** `rerouteAffectedConnectors()` is called from the state machine's translate/scale move handlers. The render invalidation for connectors happens inside that method, while invalidation for shapes/strokes happens in `invalidateTransformPreview()`. These two invalidation paths should be unified — `invalidateTransformPreview()` should handle ALL dirty rect computation (shapes + connectors) in one pass.
- **GC pressure from per-frame object allocation:** `computeFreeEndpointOverrides` allocates `{ start, end }` objects, `transformFreeEndpoint` allocates `[x, y]` tuples, and `rerouteAffectedConnectors` allocates `frameOverrides` Map every frame. For 60fps transforms, this creates significant GC churn. Should reuse pre-allocated buffers.
- **Connector disappearance on axis flip in connectorsOnly scale:** the `invalidateTransformPreview` now includes connectors for `connectorsOnly` kind, but axis flips still cause the connector to visually disappear until a full redraw (zoom out). No stale pixels left behind — suggests the NEW bbox position isn't being properly invalidated/cleared. Needs deeper investigation into the envelope accumulation pattern for connectors during scale flips.
- **`rerouteConnector` vs `rerouteAffectedConnectors` duplication:** both functions build similar routing contexts. `rerouteAffectedConnectors` calls `rerouteConnector` per-connector but constructs frameOverrides externally. Could be merged: `rerouteConnector` could accept a pre-built override context instead of rebuilding endpoint resolution per call. Or: move the frame+endpoint override computation into the reroute module itself so the SelectTool just passes the transform state.

---

## Not Yet Implemented / Next Steps

### Correctness
- **Axis flip investigation (connectorsOnly scale):** connector disappears on flip. Envelope pattern may need adjustment — connector bbox after flip may not be accumulating into the dirty rect. Need to trace whether the ACCUMULATE envelope includes the post-flip connector bbox.
- **Endpoint dot overlay rendering:** draw anchor dots on overlay canvas for selected connectors in connector mode using `ANCHOR_DOT_CONFIG` from `constants.ts` for radius, colors, stroke styling (consistent with ConnectorTool's snap dots)
- **Shape midpoint dots during endpoint drag:** when actively dragging an endpoint and snapped to a shape, draw that shape's midpoint positions as visual guides on overlay
- **Remove bbox rendering in connector mode:** selection highlight (bbox rectangle) should NOT render for connectors when in connector mode — only render when selection becomes mixed (standard mode with connectors + other types)
- **Commit diffing in `commitEndpointDrag`:** skip unnecessary Y.Doc writes if anchor ID is unchanged (only update if snap target changed from previous stored anchor — avoid dirty patches on no-op drags)
- **Endpoint dot hit testing refinement:** when endpoint dots are visually drawn, hit test radius should match rendered dot size

### Performance & Architecture
- **Translate short-circuit for fully-moving connectors:** if both endpoints of a selected connector are free (or both anchored to selected shapes), the path shape doesn't change during translate — just offset all points. Skip A* and use `ctx.translate()` rendering (exclude from context, or add a `translateOnly` flag to the entry).
- **Cache frameOverrides across frames:** build the `selectedShapeId → originalFrame` map once at `beginTranslate`/`beginScale`. On each move, apply the current `transform` to the cached original frames. Avoids re-iterating selectedIds and re-reading Y.Map frames every frame.
- **Unified invalidation in `invalidateTransformPreview`:** move all connector dirty rect accumulation into `invalidateTransformPreview()`. The reroute function should only compute new points/bbox and update entries — NOT call `invalidateWorld()` itself. `invalidateTransformPreview` then reads the entry bboxes and unions them into the envelope.
- **Batch rerouting before invalidation:** route all connectors first, collect all bbox changes, THEN issue `invalidateWorld(envelope)` once. Current per-connector invalidation creates many small rects.
- **Reduce GC:** pre-allocate endpoint override objects, reuse `[x, y]` tuples across frames, consider mutable buffers for frame overrides map (clear + refill instead of new Map).
- **Transform-driven rerouting:** the transform store actions (`updateTranslate`, `updateScale`) should trigger rerouting as a side effect, not the state machine's move handler. This decouples the reroute timing from the pointer event flow and makes the data flow clearer: store update → connector reroute → render invalidation.
