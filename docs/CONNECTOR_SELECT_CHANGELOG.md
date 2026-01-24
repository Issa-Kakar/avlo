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

## Phase 5: Connector Transform Refactoring — Per-Endpoint Overrides, TranslateOnly, Unified Invalidation

---

### Overview

Consolidates fragmented invalidation logic, splits immutable topology from mutable render cache, adds translate optimization for fully-moving connectors, eliminates the per-frame `frameOverrides` Map via per-endpoint override encoding, and unifies dirty-rect computation into a single `invalidateTransformPreview()` call.

**Architectural principle:** Encode the *why* (which endpoint moves, and how) at begin time via typed override fields. At each frame, `resolveOverride()` applies the current transform scalars to these precomputed overrides — no Map rebuilding, no re-iteration of selectedIds.

---

### 14. `client/src/lib/connectors/reroute-connector.ts`

#### API Signature Change

```typescript
// BEFORE (3 params, 2 orthogonal override mechanisms):
rerouteConnector(
  connectorId: string,
  frameOverrides?: Map<string, FrameTuple>,
  endpointOverrides?: { start?: SnapTarget | [number, number]; end?: SnapTarget | [number, number] }
)

// AFTER (2 params, unified per-endpoint overrides):
rerouteConnector(
  connectorId: string,
  endpointOverrides?: { start?: EndpointOverrideValue; end?: EndpointOverrideValue }
)
```

#### New Type Exported

```typescript
export type EndpointOverrideValue = SnapTarget | [number, number] | { frame: FrameTuple };
```

Three discriminated cases:
- `Array.isArray(override)` → free position `[x, y]` (no anchor, dir computed from spatial relationship)
- `'frame' in override` → `{ frame: FrameTuple }` (apply stored anchor to a transformed frame — replaces the old frameOverrides Map lookup)
- Otherwise → `SnapTarget` (has `shapeId` property — existing logic unchanged)

#### `resolveEndpoint()` Rewritten

**Before:** 3-priority resolution:
1. Direct override (SnapTarget or `[x,y]`)
2. `frameOverrides.get(anchor.id)` (Map lookup)
3. Y.Map stored data

**After:** 2-priority resolution:
1. Override (discriminated: `[x,y]` / `{ frame }` / SnapTarget)
2. Y.Map stored data

The `{ frame }` discrimination replaces the old `frameOverrides?.get(anchor.id)` lookup. The override value now carries its own frame rather than requiring a shared Map across all connectors.

#### Module Doc Comment Updated

Reflects the new per-endpoint override design. Removed references to "two orthogonal override mechanisms."

---

### 15. `client/src/stores/selection-store.ts`

#### Types Removed

- `ConnectorUpdateEntry` interface (15 fields — replaced by typed entries in SelectTool)
- `ConnectorTransformContext` interface (single `entries` Map — eliminated)

#### Fields Removed from Transform Types

- `TranslateTransform.connectorContext` → removed
- `ScaleTransform.connectorContext` → removed

These fields coupled per-frame mutable routing state (currentPoints, prevBbox) into an immutable store object, causing confusion about what was reactive vs mutated-in-place.

#### New Type Added

```typescript
export interface ConnectorRerouteState {
  translateIdSet: Set<string>;                       // O(1): is this connector translateOnly?
  reroutes: Map<string, [number, number][] | null>;  // connectorId → rerouted points (mutable cache)
}
```

**Design:** `translateIdSet` is immutable after begin (set once). `reroutes` is mutated in-place each frame by `invalidateTransformPreview()` — the store reference doesn't change, avoiding Zustand re-renders on pointer moves.

#### New State Field

```typescript
interface SelectionState {
  // ...existing...
  connectorReroutes: ConnectorRerouteState | null;  // Active during translate/scale only
}
```

#### New Action

```typescript
setConnectorReroutes: (state: ConnectorRerouteState | null) => void;
```

Called by `buildConnectorTopology()` at transform begin.

#### Lifecycle

- `beginTranslate` / `beginScale`: signature simplified (no `connectorContext` param). `connectorReroutes` set separately by `buildConnectorTopology()`.
- `endTransform` / `cancelTransform` / `setSelection` / `clearSelection`: all clear `connectorReroutes: null`.

---

### 16. `client/src/lib/tools/SelectTool.ts`

#### New Types (Module-Level)

```typescript
// Per-endpoint override encoding:
//   null   = canonical (endpoint stays at Y.Map stored value)
//   string = frame override (value is shapeId whose frame to transform)
//   true   = free position override (apply transform to originalPoints position)
type EndpointOverride = string | true | null;

interface ConnectorRerouteEntry {
  connectorId: string;
  originalPoints: [number, number][];  // [0] = startPos, .at(-1) = endPos
  originalBbox: WorldBounds;
  startOverride: EndpointOverride;
  endOverride: EndpointOverride;
}

interface ConnectorTranslateEntry {
  connectorId: string;
  originalPoints: [number, number][];  // For commit (offset all points)
  originalBbox: WorldBounds;           // For envelope inclusion
}
```

#### New Instance Fields

```typescript
private connectorRerouteEntries: ConnectorRerouteEntry[] | null = null;
private connectorTranslateEntries: ConnectorTranslateEntry[] | null = null;
private connectorOriginalFrames: Map<string, FrameTuple> | null = null;
private connectorPrevBboxes: Map<string, WorldBounds> | null = null;
```

All set at begin, cleared at end/cancel via `resetState()`.

#### `buildConnectorContext()` → `buildConnectorTopology(transformKind)`

**Signature:** `private buildConnectorTopology(transformKind: 'translate' | 'scale'): void`

**Called after** `beginTranslate()` / `beginScale()` (not passed as param — sets up store separately).

**Strategy determination per connector:**

| Transform | Both endpoints move? | Classification |
|-----------|---------------------|----------------|
| Translate | Yes | TranslateOnly (ctx.translate on cached Path2D) |
| Translate | No (one or neither) | Reroute (A* each frame) |
| Scale | Always | Reroute |

**Endpoint "moves" if:**
- Selected connector: `!anchor || selectedSet.has(anchor.id)` (free moves, anchored-to-selected moves)
- Non-selected connector: `!!anchor && selectedSet.has(anchor.id)` (only anchored-to-selected moves)

**Per-endpoint override computation via `computeEndpointOverride()`:**

| Endpoint State | Override Value |
|---|---|
| Anchored + shape selected | `anchor.id` (string → frame override) |
| Free + connector selected | `true` (free position override) |
| Anchored + shape NOT selected | `null` (canonical) |
| Free + connector NOT selected | `null` (canonical) |

**Also caches:** `connectorOriginalFrames` = Map of selected shape/text IDs → their current Y.Map frame. Read once at begin, never re-read from Y.Map during gesture.

#### `resolveOverride()` — New Private Method

```typescript
private resolveOverride(
  override: EndpointOverride,
  originalPos: [number, number],
  transform: TranslateTransform | ScaleTransform
): EndpointOverrideValue | undefined
```

Converts the precomputed `EndpointOverride` to the runtime `EndpointOverrideValue` consumed by `rerouteConnector`:
- `null` → `undefined` (no override, use canonical Y.Map data)
- `true` → `this.transformFreeEndpoint(originalPos, transform)` → `[x, y]`
- `string` (shapeId) → `{ frame: this.computeTransformedFrame(origFrame, transform) }`

**Key insight:** The per-frame cost is just a frame transform (4-element arithmetic) per anchored endpoint, and a position transform (2-element arithmetic) per free endpoint. No Map construction, no selectedIds iteration.

#### `computeTransformedFrame()` — New Private Method

Applies the current transform to a cached original frame, matching commit-time logic:
- Translate: `[x + dx, y + dy, w, h]`
- Scale (mixed + corner): `applyUniformScaleToFrame()`
- Scale (other): `applyTransformToFrame({ kind: 'scale', ... })`

#### `invalidateTransformPreview()` — Unified

**Replaces** both the old `rerouteAffectedConnectors()` AND the old `invalidateTransformPreview()`.

Three steps in one method:

1. **Reroute connectors:** for each `connectorRerouteEntries`, compute overrides via `resolveOverride()`, call `rerouteConnector()`, update `connectorReroutes.reroutes` Map in-place, expand envelope with prev + current bbox.

2. **Compute shape/stroke envelope:** unchanged per-object bounds logic. For translate: also expands with translateOnly connector bboxes. For scale: also includes original bboxes of reroute entries.

3. **Single invalidation:** `invalidateWorld(this.transformEnvelope)` — one call, one dirty rect.

#### Move Handlers Simplified

```typescript
case 'translate':
  updateTranslate(dx, dy);
  this.invalidateTransformPreview();  // Does rerouting + dirty rect in one call
  break;

case 'scale':
  updateScale(scaleX, scaleY);
  this.invalidateTransformPreview();  // Same unified path
  break;
```

No more separate `rerouteAffectedConnectors()` call.

#### `commitTranslate()` — Rewritten

**Signature:** `(selectedIds, dx, dy, rerouteEntries, translateEntries, connectorReroutes)`

- Skips connectors handled by topology entries (checked via `handledConnectorIds` Set)
- **TranslateOnly entries:** offsets `originalPoints` by `(dx, dy)` → writes points/start/end
- **Reroute entries:** reads final `connectorReroutes.reroutes.get(id)` → writes points/start/end
- Safety fallback for untracked free connectors (shouldn't happen)

#### `commitScale()` — Rewritten

**Signature:** `(selectedIds, origin, scaleX, scaleY, handleId, selectionKind, handleKind, originBounds, rerouteEntries, connectorReroutes)`

- Strokes: inline uniform scale computation (no `applyUniformScaleToPoints` dependency — computes center, scale factor, position preservation inline)
- All reroute entries: writes from `connectorReroutes.reroutes` Map

#### `endpointDrag` Move Handler Updated

- `rerouteConnector(connectorId, endpointOverride)` — now 2-arg call
- Override typed as `EndpointOverrideValue` (was `SnapTarget | [number, number]`)

#### Methods Removed

- `buildConnectorContext()` — replaced by `buildConnectorTopology()`
- `rerouteAffectedConnectors()` — logic moved into `invalidateTransformPreview()`
- `computeFreeEndpointOverrides()` — replaced by `EndpointOverride` encoding at begin time

#### Import Changes

- Removed: `applyUniformScaleToPoints` (inlined in commitScale)
- Removed: `ConnectorTransformContext`, `ConnectorUpdateEntry` (types deleted)
- Added: `ConnectorRerouteState` from selection-store
- Added: `EndpointOverrideValue` from reroute-connector
- Added: `WorldBounds` type from `@avlo/shared`

---

### 17. `client/src/renderer/layers/objects.ts`

#### `drawObjects()` — Reads `connectorReroutes` from Store

```typescript
const connReroutes = selectionState.connectorReroutes;
```

Replaces old `connectorContext` read from `transform.connectorContext`.

#### Translate Block — TranslateOnly + Reroute Paths

**Selected connector during translate:**
```typescript
if (connReroutes?.translateIdSet.has(handle.id)) {
  // TranslateOnly: cached Path2D + ctx.translate (same as shapes)
  ctx.translate(transform.dx, transform.dy);
  drawObject(ctx, handle);
} else {
  // Rerouted: draw from fresh points
  const points = connReroutes?.reroutes.get(handle.id);
  if (points) drawConnectorFromPoints(ctx, handle, points);
  else drawObject(ctx, handle); // Fallback
}
```

#### Scale Block — Reroute Only

`renderSelectedObjectWithScaleTransform()` signature updated:
- **Old param:** `connectorContext: ConnectorTransformContext | null`
- **New param:** `connReroutes: ConnectorRerouteState | null`

Connector branch reads `connReroutes?.reroutes.get(handle.id)` instead of `connectorContext?.entries.get(handle.id)?.currentPoints`.

#### Non-Selected Connector Override

```typescript
if (handle.kind === 'connector' && connReroutes) {
  const points = connReroutes.reroutes.get(entry.id);
  if (points) drawConnectorFromPoints(ctx, handle, points);
  else drawObject(ctx, handle);
}
```

External connectors (anchored to selected shapes) render from rerouted points without needing to check `isSelected`.

#### Imports Cleaned

- Removed: `getStartAnchor`, `getEndAnchor` (no longer needed in render logic)
- Removed: `ConnectorTransformContext` type
- Added: `ConnectorRerouteState` type

---

### Debt Resolved by This Phase

| Debt Item (from Phase 4) | Resolution |
|---|---|
| `rerouteAffectedConnectors` rebuilds frameOverrides every frame | `connectorOriginalFrames` cached at begin; `resolveOverride` applies transform to cached frames |
| No translate optimization for fully-selected connectors | `ConnectorTranslateEntry` + `translateIdSet` — ctx.translate on cached Path2D, skip A* entirely |
| Individual `invalidateWorld()` per connector in reroute loop | Unified envelope in `invalidateTransformPreview()` — single `invalidateWorld()` call |
| Rerouting and invalidation split across phases | Both happen in `invalidateTransformPreview()` — reroute first, envelope second, invalidate once |
| GC pressure from per-frame object allocation | No more per-frame frameOverrides Map, no computeFreeEndpointOverrides allocation. `resolveOverride` still allocates `{ frame }` objects — addressable with pooling later |
| `rerouteConnector` vs `rerouteAffectedConnectors` duplication | `rerouteAffectedConnectors` removed. SelectTool calls `rerouteConnector` directly with precomputed `EndpointOverrideValue` |

---

## Known Technical Debt

### Critical — Incorrect Behavior

- **Self-anchored connectors (both endpoints to same shape):** When a connector has both start AND end anchored to the same shape, and that shape is selected+translated, `buildConnectorTopology` correctly classifies this as translateOnly (both endpoints move). However, the commit path writes offset `originalPoints` which is semantically wrong — the connector should be re-routed around the new shape position since both endpoints are ON the shape edge. The translateOnly optimization assumes the path topology is unchanged, but a self-anchored connector's path is shaped BY the shape it wraps around. Should be classified as reroute with both overrides = shape's frame.

- **Selected anchored connector with non-selected shape — visual disconnect:** If a connector is selected but its anchor shape(s) are NOT selected, `buildConnectorTopology` skips it (neither endpoint "moves" from the topology's perspective). During translate, the render code falls through to `drawObject(ctx, handle)` — drawing at the cached original position. The connector visually stays behind while the selection box moves. Old code used `ctx.translate` which was also wrong (showed connector disconnected from shape). Correct behavior: anchored connectors whose anchor shapes are not in the selection should NOT participate in the translate at all. The selection should be adjusted to exclude them, or the translate should skip them and leave them at their canonical position (current behavior is accidental but correct — the visual desync of the selection box is the real problem).

- **Connector disappearance on axis flip in connectorsOnly scale:** `invalidateTransformPreview` includes connector bboxes in the envelope for reroute entries, but axis flips during connectorsOnly scale still cause the connector to visually disappear until a full redraw. The envelope accumulates the original bbox but may not correctly expand to cover the post-flip routed path. Needs investigation into whether reroute actually produces valid points during flipped scale.

### Architecture — Topology/Cache Split

- **Immutable topology lives in SelectTool instance fields, not in store:** `connectorRerouteEntries`, `connectorTranslateEntries`, `connectorOriginalFrames` are all immutable after begin. They should be in the selection store so that `objects.ts` and future consumers can read topology metadata (e.g., which endpoint is overridden, what the original frame was) without coupling to the tool instance. The store should expose the full computed topology; the tool should only own the per-frame mutation of `reroutes` Map entries.

- **`connectorReroutes.reroutes` mutated in-place without store notification:** The reroutes Map is mutated by `invalidateTransformPreview()` without calling `set()`. This is intentional (avoids re-renders) but means Zustand subscriptions never fire for reroute changes. The render loop reads via `getState()` (imperative, not reactive) which works, but if any React component ever needs reroute state, it won't get updates. Consider separating the store field (immutable topology) from a module-level cache (mutable points) accessible via getter.

- **`connectorPrevBboxes` tracked as instance field:** This is mutable per-frame state (updated as reroutes produce new bboxes). It's only used inside `invalidateTransformPreview()` for envelope expansion. Could be a simple local Map within the method if the envelope pattern is correct, or should be part of the reroute cache if it needs to persist across frames (current design).

### Performance

- **`resolveOverride` allocates `{ frame: [...] }` objects per endpoint per frame:** For N connectors with anchored endpoints, allocates N objects per pointer move. Should pool or reuse a pre-allocated override object.

- **`commitScale` inline stroke scaling re-computes center from points array:** Iterates all points to find centroid. Could cache centroid at begin time (original bbox center is a close approximation for most strokes).

- **Duplicate `'endpointDrag'` identifier:** Still exists as both a `Phase` value in SelectTool's local state machine AND as a `TransformState.kind` in the selection store. Conceptually distinct but creates naming confusion.

---

## Not Yet Implemented / Next Steps

### Correctness — Connector Transform Edge Cases

- **Self-anchored connector reclassification:** Both endpoints anchored to the same shape should be reroute (not translateOnly). The path wraps around the shape — translating the shape changes the routing context. `buildConnectorTopology` should detect `startAnchor.id === endAnchor.id` and force reroute classification even when both endpoints "move."

- **Selection filtering for untranslatable connectors:**
- **Endpoint dot overlay rendering:** draw anchor dots on overlay canvas for selected connectors in connector mode.
- **Shape midpoint dots during endpoint drag:** visual guides when snapped to a shape.
- **Remove bbox rendering in connector mode:** selection highlight should NOT render for connectors in connector mode.
- **Commit diffing in `commitEndpointDrag`:** skip Y.Doc writes if anchor unchanged.
- **Endpoint dot hit testing refinement:** radius should match rendered dot size.

### Architecture — Store/Cache Redesign

- **Move immutable topology into store:** The following should be computed at begin time and stored in `SelectionState` (not as SelectTool instance fields):
  - `rerouteEntries: ConnectorRerouteEntry[]` (which connectors reroute, their overrides)
  - `translateEntries: ConnectorTranslateEntry[]` (which connectors just translate)
  - `originalFrames: Map<string, FrameTuple>` (cached shape frames for override computation)

  This lets `objects.ts` and overlay rendering read topology without tool coupling.

- **Separate mutable reroute cache from store:** The `reroutes: Map<string, [number, number][] | null>` should be a module-level cache (like `object-cache.ts` pattern) with a getter `getConnectorReroutePoints(id): [number, number][] | null`. The store field should only hold the immutable topology + `translateIdSet`. Render code checks `store.connectorReroutes` to know IF it should look up the cache, then reads the cache for the actual points.

- **Store-computed topology derivation:** `buildConnectorTopology` logic (which connectors are affected, what their overrides are) is pure computation from selectedIds + snapshot. It should be computed inside the store action (or as a derived value) rather than in the tool. The tool's role is deciding WHEN to build (at begin), not HOW to build.

### Performance

- **Reduce GC in `resolveOverride`:** The returned `[x, y]` tuples and `{ frame }` objects are short-lived. Consider a frame-local buffer that's reused across the reroute loop iteration.

---

## Phase 6: Store-Owned Topology, Bug Fixes, Connector Lookup Fix

---

### Overview

Migrates the connector topology from SelectTool instance fields to the selection store. Fixes two correctness bugs (non-selected translateOnly rendering, selected-but-static connector commit fallback) and a subtle self-loop bug in the connector lookup reverse map.

**Principle:** The topology IS the source of truth. If a connector isn't in it, it doesn't move. Period.

---

### 18. `client/src/stores/selection-store.ts`

#### Types Removed

- `ConnectorRerouteState` interface (replaced by `ConnectorTopology`)

#### Types Added

```typescript
type EndpointSpec = string | true | null;

interface ConnectorTopologyEntry {
  connectorId: string;
  strategy: 'translate' | 'reroute';
  originalPoints: [number, number][];
  originalBbox: WorldBounds;
  startSpec: EndpointSpec;   // only meaningful for 'reroute'
  endSpec: EndpointSpec;     // only meaningful for 'reroute'
}

interface ConnectorTopology {
  entries: ConnectorTopologyEntry[];
  translateIdSet: Set<string>;
  originalFrames: Map<string, FrameTuple>;
  reroutes: Map<string, [number, number][] | null>;   // mutable per-frame cache
  prevBboxes: Map<string, WorldBounds>;                // mutable per-frame cache
}
```

**Design:** Unified entry array (translate + reroute) with strategy discriminant. Immutable structure allocated once at begin. `reroutes` and `prevBboxes` are pre-allocated Maps, `.set()` per frame with no new allocations.

#### State Changes

- `connectorReroutes: ConnectorRerouteState | null` → `connectorTopology: ConnectorTopology | null`

#### Action Changes

- `setConnectorReroutes(state)` → `setConnectorTopology(topology)`

#### Import Added

- `FrameTuple` from `@avlo/shared`

---

### 19. `client/src/renderer/layers/objects.ts`

#### Bug 1 Fix — Non-Selected TranslateOnly Connectors

**Problem:** Non-selected connectors classified as translateOnly (both anchors to selected shapes) were not in the `reroutes` Map — the non-selected branch only checked `reroutes`, so they fell through to `drawObject` at original position. On commit, topology wrote the offset → visual pop.

**Fix:** Non-selected branch now checks `translateIdSet` for translate transforms:

```typescript
} else {
  if (handle.kind === 'connector' && connTopology) {
    if (transform.kind === 'translate' && connTopology.translateIdSet.has(entry.id)) {
      ctx.save();
      ctx.translate(transform.dx, transform.dy);
      drawObject(ctx, handle);
      ctx.restore();
    } else {
      const points = connTopology.reroutes.get(entry.id);
      if (points) drawConnectorFromPoints(ctx, handle, points);
      else drawObject(ctx, handle);
    }
  } else {
    drawObject(ctx, handle);
  }
}
```

#### Import Changes

- `ConnectorRerouteState` → `ConnectorTopology`

#### Variable Renames

- `connReroutes` → `connTopology` (reads from `selectionState.connectorTopology`)

#### `renderSelectedObjectWithScaleTransform` — Param Updated

- `connReroutes: ConnectorRerouteState | null` → `connTopology: ConnectorTopology | null`
- Connector branch reads `connTopology?.reroutes.get(handle.id)`

---

### 20. `client/src/lib/tools/SelectTool.ts`

#### Bug 2 Fix — Selected Anchored Connector Commit Fallback

**Problem:** Connector selected, both anchors to non-selected shapes → `buildConnectorTopology` correctly skips (neither endpoint moves) → not in topology → `commitTranslate` per-object loop hits "safety fallback" → blindly offsets points → connector separates from shape.

**Fix:** No fallback. Per-object loop skips ALL connectors (`if (handle.kind === 'connector') continue`). Connectors are written exclusively from topology entries.

#### Types Removed (Module-Level)

- `EndpointOverride` type
- `ConnectorRerouteEntry` interface
- `ConnectorTranslateEntry` interface

#### Instance Fields Removed

- `connectorRerouteEntries`
- `connectorTranslateEntries`
- `connectorOriginalFrames`
- `connectorPrevBboxes`

All topology data now lives in the store-owned `ConnectorTopology` object.

#### Methods Removed

- `computeEndpointOverride()` — inlined into `processConnector` closure
- `resolveOverride()` — inlined into `invalidateTransformPreview`

#### Methods Renamed

- `computeTransformedFrame()` → `transformFrame()`
- `transformFreeEndpoint()` → `transformPosition()`

#### `buildConnectorTopology()` — Rewritten

Now constructs a `ConnectorTopology` object and writes it to the store via `setConnectorTopology()`:

- Builds unified `entries: ConnectorTopologyEntry[]` array (strategy + specs)
- Pre-allocates `reroutes` and `prevBboxes` Maps for reroute entries
- Collects `originalFrames` for selected shapes
- Inline endpoint spec computation (was `computeEndpointOverride`)
- No instance field writes — store is sole owner

#### `invalidateTransformPreview()` — Reads Topology from Store

Section 1 (connector topology) reads `store.connectorTopology`:
- Iterates `topology.entries` where `strategy === 'reroute'`
- Inlines override resolution: `typeof startSpec === 'string'` → frame override via `this.transformFrame()`, `startSpec === true` → position override via `this.transformPosition()`
- TranslateOnly envelope expansion also iterates `topology.entries` where `strategy === 'translate'`

Section 2 (shapes/strokes) simplified — removed the trailing `this.connectorRerouteEntries` original-bbox loop (now handled by prevBboxes in section 1).

#### `commitTranslate()` — Simplified

**Signature:** `(selectedIds, dx, dy, topology: ConnectorTopology | null)`

- Per-object loop: ALL connectors skipped (`continue`)
- Topology loop: iterates `topology.entries`, dispatches on `entry.strategy`
  - `'translate'`: offsets `entry.originalPoints` by `(dx, dy)`
  - `'reroute'`: writes `topology.reroutes.get(entry.connectorId)`

No `handledConnectorIds` set. No fallback.

#### `commitScale()` — Simplified

**Signature:** last param changed from `(rerouteEntries, connectorReroutes)` → `topology: ConnectorTopology | null`

- Per-object loop: ALL connectors skipped
- Topology loop: iterates entries where `strategy === 'reroute'`, writes from `topology.reroutes`

#### End Handlers — Capture Before Clear

Both translate and scale end handlers:
```typescript
const { selectedIds, connectorTopology } = store;
store.endTransform();  // clears topology
this.commitTranslate(selectedIds, dx, dy, connectorTopology);  // uses captured ref
```

#### Import Changes

- Removed: `ConnectorRerouteState`
- Added: `ConnectorTopology`, `ConnectorTopologyEntry`, `EndpointSpec`

---

### 21. `client/src/lib/connectors/connector-lookup.ts`

#### Self-Loop Bug Fix in `processConnectorUpdated`

**Problem:** When a connector has both anchors pointing to the same shape (self-loop), detaching one endpoint calls `removeConnectorFromShape(shapeId, connId)` — removing the connector from the lookup set entirely, even though the other anchor still references it. Result: `getConnectorsForShape` returns nothing, topology builder never processes this connector, it becomes "free floating."

**Root cause:** Per-field incremental add/remove doesn't account for the other anchor referencing the same shape.

**Fix:** Replaced per-field logic with set-difference on unique shape IDs:

```typescript
const oldShapes = uniqueShapeIds(oldStartId, oldEndId);
const newShapes = uniqueShapeIds(newStartId, newEndId);

for (const shapeId of oldShapes) {
  if (!newShapes.has(shapeId)) removeConnectorFromShape(shapeId, connectorId);
}
for (const shapeId of newShapes) {
  if (!oldShapes.has(shapeId)) addConnectorToShape(shapeId, connectorId);
}
```

#### New Helper

```typescript
function uniqueShapeIds(startId: string | null, endId: string | null): Set<string>
```

Deduplicates anchor IDs — for self-loops, `{"shapeA"}` instead of checking `"shapeA"` twice.

---

### Debt Resolved by This Phase

| Debt Item | Resolution |
|---|---|
| Immutable topology in SelectTool instance fields, not in store | `ConnectorTopology` owned by store; `objects.ts` reads it directly |
| `connectorPrevBboxes` tracked as instance field | Now in `ConnectorTopology.prevBboxes` (store-owned, pre-allocated) |
| Safety fallback in `commitTranslate` blindly offsets connectors | Removed. Connectors = topology-only. Not in topology = static = no write |
| Non-selected translateOnly connectors frozen during gesture | `objects.ts` checks `translateIdSet`, applies `ctx.translate` |
| Store-computed topology derivation (debt note from Phase 5) | `buildConnectorTopology` writes directly to store via `setConnectorTopology` |
| Self-loop connector lookup corruption | `uniqueShapeIds` set-difference prevents double-remove |

---

## Next Steps

- **SelectTool size reduction:** Extract duplicate transform logic into shared helpers, move `transformFrame`/`transformPosition` to `geometry/transform.ts`, consider deriving topology inside a store action (moves ~100 lines out of SelectTool)
- **Deprecation cleanup:** Replace `WorldRect` alias with direct `WorldBounds` usage, enable clean barrel imports from `@/stores/selection-store`
- **Overlay rendering:** Endpoint dot rendering on overlay canvas for connector mode, shape midpoint snap dots during endpoint drag
- **Code quality:** Add inline comments to topology flow, remove unused imports accumulated across phases
