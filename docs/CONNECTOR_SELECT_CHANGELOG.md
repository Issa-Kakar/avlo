# Connector SelectTool Integration — Changelog

> **Scope:** Types, store, separation of connectors from strokes, endpoint hit testing, mode-aware branching, cursor management.

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

## Not Yet Implemented

- `move()` — `'endpointDrag'` phase routing (call `rerouteConnector` with endpoint overrides)
- `end()` — endpoint drag commit (update points + anchor data in Y.Doc)
- Overlay rendering (endpoint dots drawn on overlay canvas, snap feedback)
- `ConnectorTransformContext` building at translate/scale begin
- Frame override computation on each move (for shape transforms)
- Connector rerouting during shape transforms
- Connector rendering from `routedPoints` in objects.ts (base canvas)
- Per-connector dirty rect invalidation (prevBbox + currentBbox separate rects)
- Connector-in-mixed-selection transform behavior (reroute vs translate)
