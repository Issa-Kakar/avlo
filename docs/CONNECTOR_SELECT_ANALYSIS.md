# Connector SelectTool Integration - Architecture Analysis

## 1. Current `mode` Field: Confirmed Vestigial

**Finding:** The `mode` field (`'none' | 'single' | 'multi'`) is set in `setSelection()` and `clearSelection()` but **never read anywhere in the codebase**. Zero usages outside the store's own setter logic.

Current code in `selection-store.ts:92-97`:
```typescript
setSelection: (ids) => set({
  selectedIds: ids,
  mode: ids.length === 0 ? 'none' : ids.length === 1 ? 'single' : 'multi',
  // ...
})
```

No consumer ever reads `store.mode`. This makes it the perfect candidate for repurposing.

---

## 2. Recommendation: Repurpose `mode` as Interaction Paradigm

**Change `mode` to:**
```typescript
mode: 'none' | 'standard' | 'connector'
```

**Derivation:**
```typescript
const selectionKind = computeSelectionKind(ids, snapshot);
const mode = selectionKind === 'connectorsOnly' ? 'connector' : (ids.length > 0 ? 'standard' : 'none');
```

**Why this is better than just using `selectionKind`:**

`mode` becomes the **primary branching point** for all interaction logic. It answers "HOW do we interact?" while `selectionKind` answers "WHAT is selected?" (needed for transform dispatch in standard mode).

The two concerns diverge:
- `mode === 'connector'` always means: no bounds, no handles, endpoint dots, no gap clicks
- `selectionKind === 'mixed'` affects how strokes/shapes scale differently within standard mode

---

## 3. SelectionKind Expansion

**Current:**
```typescript
type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'mixed';
```

**Add `'connectorsOnly'`:**
```typescript
type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'connectorsOnly' | 'mixed';
```

**Classification change in `computeSelectionKind()`:**
```typescript
// Current: connectors grouped with strokes
if (handle.kind === 'stroke' || handle.kind === 'connector') hasStrokes = true;

// Proposed: separate tracking
if (handle.kind === 'stroke') hasStrokes = true;
else if (handle.kind === 'connector') hasConnectors = true;
else hasShapes = true;

// Pure cases
if (hasConnectors && !hasStrokes && !hasShapes) return 'connectorsOnly';
if (hasStrokes && !hasConnectors && !hasShapes) return 'strokesOnly';
if (hasShapes && !hasStrokes && !hasConnectors) return 'shapesOnly';
return 'mixed';
```

**Impact on existing transform logic:** When `selectionKind` is `'mixed'` and includes connectors, and their endpoints are either free with themselves being selected, or anchored

---

## 4. State Machine Trace: What Changes per Mode

### 4.1 `begin()` - Pointer Down

**Current flow:**
1. Check handles (requires selection bounds)
2. Hit test objects
3. Check selection gap (requires selection bounds)
4. Background

**With mode branching:**

```
begin()
  ├── mode === 'standard'
  │   ├── 1. Hit test handles (from selection bounds)
  │   ├── 2. Hit test objects → objectInSelection / objectOutsideSelection
  │   ├── 3. Inside bounds? → selectionGap
  │   └── 4. Background
  │
  └── mode === 'connector'
      ├── 1. Hit test endpoint dots (iterate selected connectors)
      ├── 2. Hit test objects → objectInSelection / objectOutsideSelection
      └── 3. Background (NO gap - no bounds exist)
```

**Key differences:**
- Connector mode has NO selection bounds, so `selectionGap` is impossible
- Endpoint dots replace handles as the first-priority hit target
- `'handle'` downTarget is impossible in connector mode
- `'connectorEndpoint'` downTarget is impossible in standard mode

### 4.2 `pendingClick` → Drag Transition

| downTarget | Standard Mode | Connector Mode |
|------------|--------------|----------------|
| `handle` | → `scale` phase | N/A (impossible) |
| `connectorEndpoint` | N/A (impossible) | → `endpointDrag` phase |
| `objectOutsideSelection` | Select + translate | Connector hit → always **marquee** |
| `objectInSelection` | → translate | Only if ALL free (no anchors) → translate, else → nothing/marquee |
| `selectionGap` | → translate | N/A (impossible) |
| `background` | → marquee | → marquee |

**Critical connector-specific behavior:**
- Clicking a connector (`objectOutsideSelection`) and dragging does NOT translate it. It always goes to marquee. This prevents accidentally moving anchored connectors.
- `objectInSelection` translate only works if `canTranslateConnectors(selectedIds)` returns true (all endpoints are free - no anchors).

### 4.3 Hover Cursor

| Context | Standard Mode | Connector Mode |
|---------|--------------|----------------|
| Over handle | Directional resize cursor | N/A |
| Over endpoint dot | N/A | `grab` cursor |
| During drag | Same resize cursor | `grabbing` cursor |
| Otherwise | Default | Default |

### 4.4 `end()` - Pointer Up

New case for `endpointDrag` phase:
1. Get final snap state from transform
2. Clear transform BEFORE mutate
3. Commit: set `points`, `start`, `end`, and conditionally `startAnchor`/`endAnchor`

### 4.5 Phase & DownTarget Types

```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';

type DownTarget =
  | 'none'
  | 'handle'              // Standard mode only
  | 'connectorEndpoint'   // Connector mode only
  | 'objectInSelection'
  | 'objectOutsideSelection'
  | 'selectionGap'        // Standard mode only
  | 'background';
```

### 4.6 Cursor Integration

The handle system (`activeHandle`, `getHandleCursor()`, `hitTestHandle()`) is completely bypassed in connector mode — not changed, just unreachable. Endpoint dots are the connector-mode equivalent with a different cursor vocabulary.

| Concern | Standard Mode | Connector Mode |
|---------|--------------|----------------|
| Hover target | `hitTestHandle(bounds, scale)` | `hitTestEndpointDots(selectedIds, snapshot, scale)` |
| Hover cursor | `getHandleCursor(handleId)` → `'nwse-resize'` etc | `'grab'` |
| Down cursor | Same directional resize as hover | `'grabbing'` |
| Active gesture cursor | Stays at directional resize | Stays at `'grabbing'` |
| Instance field at down | `this.activeHandle = handleId` | `this.endpointHitAtDown = { connectorId, endpoint }` |
| Leads to phase | `'scale'` | `'endpointDrag'` |
| End/cancel | `setCursorOverride(null)` (existing) | Same — no changes needed |

---

## 5. Endpoint Dot Hit Testing

### Position Derivation

Endpoint edge position is computed from normalized anchor + current shape frame:

```typescript
function getEndpointEdgePosition(yMap, endpoint, snapshot): [number, number] {
  const anchor = endpoint === 'start' ? getStartAnchor(yMap) : getEndAnchor(yMap);

  if (!anchor) {
    // Free endpoint: stored position IS the edge position
    return endpoint === 'start' ? getStart(yMap) : getEnd(yMap);
  }

  // Anchored: compute from normalized anchor + current frame
  const shapeHandle = snapshot.objectsById.get(anchor.id);
  if (!shapeHandle) return endpoint === 'start' ? getStart(yMap) : getEnd(yMap);

  const frame = getFrame(shapeHandle.y);
  const [nx, ny] = anchor.anchor;
  const [x, y, w, h] = frame;
  return [x + nx * w, y + ny * h];
}
```

**Why edge position (not stored `start`/`end`)?**
- Stored positions include `EDGE_CLEARANCE_W` offset (11 units outward from shape edge)
- The anchor dot should be drawn ON the shape edge, not 11 units out
- Edge position = where the anchor visually lives

### Hit Test Implementation

O(n) iteration through selected connectors (n is typically small):

```typescript
function hitTestEndpointDots(
  worldX, worldY, selectedIds, snapshot, scale
): { connectorId: string; endpoint: 'start' | 'end' } | null {
  const radius = ENDPOINT_DOT_HIT_PX / scale; // ~10px screen space

  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle || handle.kind !== 'connector') continue;

    const startPos = getEndpointEdgePosition(handle.y, 'start', snapshot);
    const endPos = getEndpointEdgePosition(handle.y, 'end', snapshot);

    if (distSq(worldX, worldY, startPos) <= radius * radius) {
      return { connectorId: id, endpoint: 'start' };
    }
    if (distSq(worldX, worldY, endPos) <= radius * radius) {
      return { connectorId: id, endpoint: 'end' };
    }
  }
  return null;
}
```

---

## 6. Transform State: EndpointDragTransform

```typescript
interface EndpointDragTransform {
  kind: 'endpointDrag';
  connectorId: string;
  endpoint: 'start' | 'end';

  // Live manipulation state
  currentPosition: [number, number];    // Current world pos (snap or cursor)
  currentSnap: SnapTarget | null;       // Current snap target (for commit)

  // Rerouted path (updated on each move via rerouteConnector, drawn on base canvas)
  routedPoints: [number, number][] | null;
  routedBbox: WorldBounds | null;

  // For invalidation (prev ∪ current pattern)
  prevBbox: WorldBounds;                // Where connector was last frame (originBbox set here on first move)
}
```

This is fundamentally different from translate/scale because:
1. Operates on ONE connector, ONE endpoint
2. Calls `findBestSnapTarget()` on every move
3. Calls `rerouteConnector()` with endpoint overrides
4. Commit updates anchor data (not just positions)

---

## 7. Overlay Rendering Changes

### Connector Mode (no transform active)

- NO selection box
- NO handles
- Object highlights: No bbox for connectors. Only when selection is normal (not connectors only, becomes mixed)
- Draw endpoint dots at edge positions for each selected connector

### During endpointDrag

- Draw the dragged endpoint dot at `transform.currentPosition`
- If snapped: draw snap feedback (midpoint dots on shape, edge dot)
- The non-dragged endpoint dot stays at its derived edge position
- The rerouted connector is drawn on the **base canvas** from `transform.routedPoints` (not the overlay — this is object rendering, not a tool preview)

### Standard Mode + Connectors in Mixed Selection

- Connectors show bbox like strokes (current behavior unchanged)
- NO endpoint dots (only in pure connector mode)

---

## 8. `rerouteConnector()` Return Value Analysis

### Current Return

```typescript
export function rerouteConnector(...): [number, number][] | null
```

Returns just points or null.

### Proposed Enhancement: `RerouteResult`

```typescript
export interface RerouteResult {
  points: [number, number][];
  bbox: WorldBounds;  // Computed from points - saves caller from recomputing
}
```

**What about returning start/end positions for commit?**

The user's insight is correct: **start/end are always `points[0]` and `points[points.length - 1]`** since the routing points array is pre-trim (before arrow shortening). So we don't need explicit start/end in the result.

**What about anchor data for commit?**

Anchor data only changes during `endpointDrag`. In that case, the SelectTool already has the final `SnapTarget` in `transform.currentSnap`. The commit logic for endpoint drag:

```typescript
// Commit endpoint drag
const { endpoint, currentSnap, routedPoints } = transform;
if (!routedPoints) return;

yMap.set('points', routedPoints);
yMap.set('start', routedPoints[0]);
yMap.set('end', routedPoints[routedPoints.length - 1]);

if (endpoint === 'start') {
  if (currentSnap) {
    yMap.set('startAnchor', {
      id: currentSnap.shapeId,
      side: currentSnap.side,
      anchor: currentSnap.normalizedAnchor,
    });
  } else {
    yMap.delete('startAnchor');
  }
} else {
  // Same for end...
}
```

No need for rerouteConnector to know about anchors. The SelectTool holds the snap state.

**What about non-endpoint-drag reroutes (shape transform)?**

During shape transform, anchors don't change. The commit just needs:
```typescript
yMap.set('points', entry.currentPoints);
yMap.set('start', entry.currentPoints[0]);
yMap.set('end', entry.currentPoints[entry.currentPoints.length - 1]);
// Anchors unchanged - leave as-is
```

### Should `rerouteConnector` do the loop?

The user asked: "shouldn't we make reroute-connector.ts more smart? what if we pass the connectorIDs set and let it loop through?"

**Recommendation: Keep it single-connector.**

Reasons:
1. The SelectTool already needs per-connector tracking (for invalidation bboxes, current points)
2. Different connectors may need different endpoint overrides (some selected, some not)
3. The loop in SelectTool is simple and gives full control over per-entry metadata
4. Batching inside rerouteConnector would require passing the entire `ConnectorTransformContext` - coupling increase

The pattern should be:
```typescript
for (const [id, entry] of connectorContext.entries) {
  const result = rerouteConnector(id, frameOverrides);
  if (result) {
    entry.currentPoints = result.points;
    entry.currentBbox = result.bbox;
  }
}
```

Simple, explicit, debuggable.

### Frame Type Alignment

Current `rerouteConnector` uses `Frame` (`{x, y, w, h}`) for overrides. The `applyAnchorToFrame` helper uses `FrameTuple` (`[x, y, w, h]`). Internally it converts:
```typescript
const frameTuple: FrameTuple = [overrideFrame.x, overrideFrame.y, overrideFrame.w, overrideFrame.h];
```

**Recommendation:** Change the `frameOverrides` parameter to accept `FrameTuple` directly, since that's what shapes store and what the SelectTool computes. Eliminates unnecessary object construction.

```typescript
export function rerouteConnector(
  connectorId: string,
  frameOverrides?: Map<string, FrameTuple>,  // FrameTuple not Frame
  endpointOverrides?: { ... }
): RerouteResult | null
```

---

## 9. ConnectorTransformContext Design

When a shape transform begins (translate/scale), we need to identify and track all connectors that need rerouting.

```typescript
interface ConnectorTransformContext {
  entries: Map<string, ConnectorUpdateEntry>;
}

interface ConnectorUpdateEntry {
  connectorId: string;
  isSelected: boolean;  // Is this connector in selectedIds?
  prevBbox: WorldBounds;                   // Last frame's bbox (init to originalBbox)
  currentPoints: [number, number][] | null;
  currentBbox: WorldBounds | null;
}
```

**Built at transform begin:**
1. Identify all shapes in selectedIds
2. For each shape, query `getConnectorsForShape(shapeId)`
3. Also include any selected connectors that are anchored to transforming shapes
4. Cache original bbox and set `prevBbox = originalBbox`

**Updated on each move:**
1. Compute `frameOverrides` from current transform state
2. For each entry: call `rerouteConnector(id, frameOverrides)`
3. Store returned points and bbox
4. Dirty `prevBbox` and `currentBbox` separately, then set `prevBbox = currentBbox`

**Phase 1 simplification (per user request):**
- Skip free endpoint translation for now if connector is selected and mixed selection, just treat as if it were anchored: always exclude from resize/translation, unless: the connector is already selected, and it can translate only if both ends are unanchored
- Only reroute connectors that have at least one anchor to a transforming shape

---

## 10. Objects.ts Rendering Integration

During active transforms, `objects.ts` needs to render connectors with their rerouted points.

**Two cases:**

### Case A: Connector in `connectorContext.entries` (being rerouted)
- Read `entry.currentPoints` from selection store
- If available: build fresh `ConnectorPaths` from those points + Y.map styles
- If null: draw normally (reroute failed/not needed)

### Case B: Selected connector being translated (all-free endpoints)
- Use existing `ctx.translate(dx, dy)` + cached Path2D (like strokes)

**Implementation in objects.ts:**
```typescript
if (needsTransform && handle.kind === 'connector') {
  const entry = connectorContext?.entries.get(handle.id);
  if (entry?.currentPoints) {
    // Draw from rerouted points
    drawConnectorFromPoints(ctx, handle, entry.currentPoints);
  } else if (transform.kind === 'translate') {
    // All-free: translate cached path
    ctx.save();
    ctx.translate(transform.dx, transform.dy);
    drawConnector(ctx, handle);
    ctx.restore();
  } else {
    drawConnector(ctx, handle);
  }
}
```

---

## 11. Invalidation Strategy

**Two independent dirty regions during shape transforms:**

1. **Selection envelope** (existing, never-shrink) - covers selected shapes/strokes being transformed
2. **Connector dirty rects** - `prevBbox ∪ currentBbox` per connector per frame

**Why connectors DON'T use the never-shrink envelope:**

The selection envelope exists because scale transforms oscillate (drag out then back in). Connectors don't oscillate — they're freshly routed each frame. A route can also jump discontinuously (going around the opposite side of a shape), so an envelope would accumulate a huge region covering both routes.

Instead, use the same pattern as `RoomDocManager.applyObjectChanges()` (`room-doc-manager.ts:1035-1036`): dirty the old position AND the new position. Each frame clears where the connector WAS and paints where it IS.

```typescript
// Per-connector invalidation (on each move):
for (const entry of connectorContext.entries.values()) {
  const result = rerouteConnector(id, frameOverrides);
  if (result) {
    entry.currentPoints = result.points;
    entry.currentBbox = result.bbox;

    // Two separate dirty rects (not unioned — avoids dirtying the gap between them)
    invalidateWorld(entry.prevBbox);
    invalidateWorld(entry.currentBbox);
    entry.prevBbox = entry.currentBbox;
  }
}
```

Two targeted dirty regions, not one oversized union. Matches `RoomDocManager`'s pattern of pushing `oldBBox` and `newBBox` as separate rects.

---

## 12. Store Schema Summary

```typescript
export interface SelectionState {
  selectedIds: string[];
  mode: 'none' | 'standard' | 'connector';   // Interaction paradigm
  selectionKind: SelectionKind;                // Selection composition
  transform: TransformState;
  marquee: MarqueeState;
}

export type TransformState =
  | { kind: 'none' }
  | TranslateTransform
  | ScaleTransform
  | EndpointDragTransform;

export interface TranslateTransform {
  kind: 'translate';
  dx: number;
  dy: number;
  originBounds: WorldBounds;
  connectorContext: ConnectorTransformContext | null;
}

export interface ScaleTransform {
  kind: 'scale';
  origin: [number, number];
  scaleX: number;
  scaleY: number;
  originBounds: WorldBounds;
  bboxBounds: WorldBounds;
  handleId: HandleId;
  selectionKind: SelectionKind;
  handleKind: HandleKind;
  initialDelta: [number, number];
  connectorContext: ConnectorTransformContext | null;
}

export interface EndpointDragTransform {
  kind: 'endpointDrag';
  connectorId: string;
  endpoint: 'start' | 'end';
  currentPosition: [number, number];
  currentSnap: SnapTarget | null;
  routedPoints: [number, number][] | null;
  routedBbox: WorldBounds | null;     // prevBbox is seeded on start from original bbox
  prevBbox: WorldBounds;       // Where connector was last frame (for dirty rect) prevBbox is seeded on start from original bbox
}
```

---

## 13. Implementation Order (Proposed)

### Phase 1: Store & Type Foundation
1. Add `'connectorsOnly'` to `SelectionKind`
2. Change `mode` from `'none' | 'single' | 'multi'` to `'none' | 'standard' | 'connector'`
3. Add `selectionKind` to store state (cached on `setSelection`)
4. Update `computeSelectionKind()` to separate connectors from strokes
5. Add `EndpointDragTransform` to `TransformState`
6. Add store actions: `beginEndpointDrag`, `updateEndpointDrag`

### Phase 2: Endpoint Dots & Hit Testing
7. Implement `getEndpointEdgePosition()` utility
8. Implement `hitTestEndpointDots()`
9. Add endpoint dot rendering to selection-overlay.ts (connector mode only)
10. Update `handleHoverCursor()` to check endpoint dots in connector mode
11. Update `begin()` to check endpoint dots before objects in connector mode

### Phase 3: Endpoint Drag Phase
12. Add `'endpointDrag'` phase handling in `move()`
13. Integrate `findBestSnapTarget()` during endpoint drag
14. Call `rerouteConnector()` with endpoint overrides
15. Render snap feedback in overlay
16. Render rerouted connector in objects.ts from `routedPoints`
17. Commit endpoint drag (points + anchor data)

### Phase 4: Shape Transform → Connector Rerouting
18. Enhance `rerouteConnector()` return value (add bbox)
19. Implement `ConnectorTransformContext` building
20. At transform begin: identify connectors to update via lookup map
21. On transform move: compute frame overrides, reroute, store results
22. Render rerouted connectors in objects.ts
23. Invalidate per-connector `prevBbox` + `currentBbox` (separate rects)
24. Commit rerouted connector points on transform end

### Phase 5: State Machine Refinement
25. Connector mode: `objectOutsideSelection` + drag → marquee (not translate)
26. Connector mode: `objectInSelection` + drag → only if all-free
27. Remove `selectionGap` possibility in connector mode
28. Multi-select drill-down for connector endpoint drag

---

## 14. Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mode vs Kind | Both - mode for interaction, kind for transforms | Clean separation of concerns |
| Endpoint positions | Derived on-demand from anchor+frame | No staleness, trivial math |
| rerouteConnector return | `{points, bbox}` | Minimal useful addition |
| rerouteConnector scope | Single connector | SelectTool needs per-entry control |
| Frame override type | `FrameTuple` not `Frame` | Matches storage format, no conversion |
| Free endpoint translate | Skip for Phase 1 | Complexity deferred |
| ConnectorTransformContext | On translate/scale transforms | Built at begin, updated on move |
| Connector in mixed selection | Treated DIFFERENTLY then strokes | Need to reroute |
| Connector invalidation | Two separate dirty rects per frame | Routes jump discontinuously; union/envelope over-dirties the gap |
| Cursor in connector mode | `grab` / `grabbing` | Distinct from resize cursors; signals "move this point" |
| Endpoint drag snap vis | Midpoint dots + edge dot (blue) | Matches ConnectorTool patterns |

---

## 15. Things NOT Changing

- `computeHandles()` - unchanged, only used in standard mode
- `hitTestHandle()` - unchanged, only called in standard mode
- `getScaleOrigin()` / `getHandleCursor()` - unchanged
- Hit testing (`testObjectHit`) - connectors still hit-testable as stroke polylines
- Marquee intersection (`objectIntersectsRect`) - connectors still use `polylineIntersectsRect` for now
- Object highlights rendering - connectors in mixed selection still show bbox rect
- Existing translate/scale commit logic for strokes - unchanged
- ConnectorTool - completely unaffected
