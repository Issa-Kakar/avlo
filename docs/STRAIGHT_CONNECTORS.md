# Straight Connectors — Technical Reference

> **Status:** First pass implementation. Core pipeline works end-to-end. Multiple UX/offset/snap issues known and documented — see "Known Issues" at the bottom.

## Overview

Straight connectors are a second routing mode alongside orthogonal (elbow) connectors. Instead of A\* Manhattan routing, they draw a direct line from A to B.

**`ConnectorType = 'elbow' | 'straight'`** — stored per-connector in Y.Map. Device-ui-store holds the default for new connectors.

**Key architectural principle:** All straight connector logic branches on `connectorType` checks. Elbow code paths are completely untouched — no regressions possible from gating.

---

## Anchor Categories

Straight connectors introduce a distinction that doesn't exist for elbow connectors:

### Edge Anchors

`normalizedAnchor` has at least one coordinate at 0 or 1 (within `INTERIOR_EPS = 1e-6`).

- Position computed by `applyAnchorToFrame()` with standard `EDGE_CLEARANCE_W` (11 units) outward offset
- Line goes straight from A to B — **can pass through shapes** (no obstacle avoidance)
- Visually identical to elbow edge anchors in terms of snap dots

### Interior Anchors

`normalizedAnchor` has both coordinates strictly in `(0, 1)` — detected by `isAnchorInterior()`.

- Position is the raw interior point (no edge offset — `applyAnchorToFrame` returns directly)
- The **visible line stops at the shape edge** (ray intersection computed by `computeShapeEdgeIntersection`)
- A **dashed guide line** connects the edge intersection to the interior anchor point (overlay only, not committed)
- `EDGE_CLEARANCE_W` offset applied along the approach direction (from intersection toward the other endpoint)

### Center Snap (`[0.5, 0.5]`)

Special case of interior anchor. Detected by exact `0.5, 0.5` check + `isAnchorInterior()`.

- Dedicated `CENTER_SNAP_RADIUS_PX: 12` with hysteresis (1.3x OUT threshold)
- Renders a center dot on the shape in the snap UI (in addition to 4 midpoint dots)
- Same routing behavior as any other interior anchor

---

## `isAnchorInterior()` — The Gating Function

```typescript
// types.ts
const INTERIOR_EPS = 1e-6;
export function isAnchorInterior(anchor: [number, number]): boolean {
  return (
    anchor[0] > INTERIOR_EPS &&
    anchor[0] < 1 - INTERIOR_EPS &&
    anchor[1] > INTERIOR_EPS &&
    anchor[1] < 1 - INTERIOR_EPS
  );
}
```

This epsilon is intentionally much stricter than the snap clamping range `[0.01, 0.99]`, ensuring snap-produced interior anchors always pass the check. It also guards against floating-point near-edge values from ellipse edge projection.

**Used by:**

- `applyAnchorToFrame()` — skip edge offset for interior anchors
- `computeStraightRoute()` — trigger edge intersection + dashed guide
- `computeSnapForShape()` — center snap hysteresis detection
- `ConnectorTool.getPreview()` — `isCenterSnap` preview field
- `selection-overlay.ts` — dashed guide rendering for selected connectors

---

## Snap System Changes (`snap.ts`)

### `SnapContext` Extension

```typescript
interface SnapContext {
  cursorWorld: [number, number];
  scale: number;
  prevAttach: SnapTarget | null;
  connectorType?: ConnectorType; // NEW — defaults to 'elbow' behavior
}
```

All `findBestSnapTarget()` calls now pass `connectorType` from either:

- The frozen connector type (during creation in ConnectorTool)
- The live store value (during idle hover in ConnectorTool)
- The connector's Y.Map value (during endpoint drag in SelectTool)

### `computeSnapForShape()` — Straight Inside-Shape Logic

The function now has a straight-specific branch (`CASE 1a`) that fires when `isStraight && isInside`:

```
CASE 1a (straight, inside shape):
  Priority cascade:
  1. Center snap: cursor within CENTER_SNAP_RADIUS_PX of shape center
     - Hysteresis: if previously center-snapped, OUT threshold = 1.3x IN threshold
     - Returns: normalizedAnchor=[0.5, 0.5], position=center, edgePosition=center
  2. Midpoint stickiness: same hysteresis as edge case (MIDPOINT_SNAP_IN/OUT_PX)
     - Returns standard midpoint snap (edge anchor, not interior)
  3. Interior anchor: fallback — anchor at cursor position
     - normalizedAnchor = clamped to [0.01, 0.99] range
     - position = cursor world position (no offset)
     - edgePosition = cursor world position
     - side = nearest edge side (for `StoredAnchor.side`)

CASE 1b (elbow, deep inside shape):
  Unchanged — force midpoint only (existing behavior)

CASE 2 (outside or near edge):
  Unchanged for both types — edge sliding + midpoint stickiness
```

**Key behavior difference:** For elbow connectors, going deep inside a shape forces midpoint-only mode (`FORCE_MIDPOINT_DEPTH_PX: 35`). For straight connectors, this gate is skipped (`!isStraight && isInside && ...`), allowing interior placement.

### Known Issue: Edge Sliding When Inside

The current implementation enters the straight interior branch for **all** inside-shape positions, including shallow ones near the edge. This makes edge sliding very difficult for straight connectors — the cursor jumps to interior anchor mode as soon as it crosses the shape boundary. The elbow connector's shallow-inside edge sliding (CASE 2 with `!isInside` check) doesn't apply because the straight branch catches first.

**Desired behavior:** Edge sliding should work identically to elbow when cursor is near the edge. Only transition to interior anchors when significantly inside the shape.

---

## Routing (`reroute-connector.ts`)

### `ResolvedEndpoint` Extension

```typescript
interface ResolvedEndpoint {
  position: [number, number];
  dir: Dir | null;
  shapeBounds: AABB | null;
  isAnchored: boolean;
  // NEW — populated when anchored (for straight connector routing)
  normalizedAnchor?: [number, number];
  shapeType?: string;
  frame?: FrameTuple;
}
```

Both `resolveEndpoint()` (for existing connectors) and `resolveNewEndpoint()` (for new connectors) now populate these fields from shape lookups. The data was already available in the lookup paths — just assigned to the result.

### `computeStraightRoute()` — Core Routing Function

```typescript
function computeStraightRoute(
  start: ResolvedEndpoint,
  end: ResolvedEndpoint,
): {
  points: [number, number][];
  startDashTo: [number, number] | null;
  endDashTo: [number, number] | null;
};
```

**Per-endpoint logic:**

| Endpoint State                                     | Line Position                                          | Dash Guide                                  |
| -------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| Free (`!isAnchored`)                               | `position` as-is                                       | None                                        |
| Edge anchor (`isAnchored && !isAnchorInterior`)    | `position` (has edge offset from `applyAnchorToFrame`) | None                                        |
| Interior anchor (`isAnchored && isAnchorInterior`) | Edge intersection + `EDGE_CLEARANCE_W` along approach  | Dashed line from intersection to `position` |

**Interior anchor processing:**

1. `computeShapeEdgeIntersection(shapeType, frame, interiorPoint, otherEndpoint)`
2. If intersection found:
   - Compute approach direction: `normalize(otherPos - intersection)`
   - `lineEndpoint = intersection + approachDir * EDGE_CLEARANCE_W`
   - `dashTo = interiorPoint` (the raw interior position)
3. If no intersection (fallback): use `interiorPoint` directly

**Always returns exactly 2 points** — straight connectors have no waypoints.

### Branching in `rerouteConnector()`

After resolving both endpoints, before direction resolution:

```typescript
const connectorType = getConnectorType(yMap);
if (connectorType === 'straight') {
  const straight = computeStraightRoute(startResolved, endResolved);
  const bboxTuple = computeConnectorBBoxFromPoints(straight.points, yMap);
  return { points: straight.points, bbox: bboxToBounds(bboxTuple) };
}
// ... existing A* path
```

Straight connectors skip direction resolution, A\* routing, and grid construction entirely.

### `routeNewConnector()` Return Type Change

```typescript
// OLD
function routeNewConnector(...): [number, number][]

// NEW
interface NewRouteResult {
  points: [number, number][];
  startDashTo: [number, number] | null;
  endDashTo: [number, number] | null;
}
function routeNewConnector(..., connectorType: ConnectorType = 'elbow', ...): NewRouteResult
```

For elbow connectors, `startDashTo` and `endDashTo` are always `null`. ConnectorTool stores the dash values for preview rendering.

---

## Edge Intersection (`connector-utils.ts`)

### `computeShapeEdgeIntersection()`

```typescript
export function computeShapeEdgeIntersection(
  shapeType: string,
  frame: FrameTuple,
  interiorPoint: [number, number],
  target: [number, number],
): { point: [number, number]; side: Dir } | null;
```

Casts a ray from `interiorPoint` toward `target` and finds where it exits the shape boundary.

**Per shape type:**

| Shape                  | Method                                                                                                                        | Side Derivation                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `rect` / `roundedRect` | Ray vs 4 axis-aligned edges. Smallest positive `t` with valid cross-axis range.                                               | Which edge was hit             |
| `ellipse`              | Parametric substitution into ellipse equation `((Px-cx)/rx)^2 + ((Py-cy)/ry)^2 = 1`. Solve quadratic, smallest positive root. | Quadrant of intersection angle |
| `diamond`              | Ray vs 4 diagonal line segments (top↔right, right↔bottom, bottom↔left, left↔top). Cramer's rule for ray-segment intersection. | Which segment was hit          |

**Edge cases handled:**

- Degenerate shapes (`w < 0.001` or `h < 0.001`): returns `null`
- Zero-length ray (`target ≈ interiorPoint`): returns `null`
- Ray parallel to edge: skipped (denominator check)
- Target inside same shape: may return `null` if no positive-`t` intersection (ray never exits)

---

## `applyAnchorToFrame()` Modification

```typescript
export function applyAnchorToFrame(anchor, frame, side): [number, number] {
  const posX = frame[0] + anchor[0] * frame[2];
  const posY = frame[1] + anchor[1] * frame[3];

  // Interior anchors: return position directly (no edge offset)
  if (isAnchorInterior(anchor)) return [posX, posY];

  // Edge anchors: apply EDGE_CLEARANCE_W in outward direction
  const [dx, dy] = directionVector(side);
  return [posX + dx * EDGE_CLEARANCE_W, posY + dy * EDGE_CLEARANCE_W];
}
```

**Safety:** Interior anchors cannot exist for elbow connectors (the snap system's `forceMidpointsOnly` prevents it), so this change has zero impact on elbow routing.

---

## Preview Types (`lib/tools/types.ts`)

### `ConnectorPreview` Extension

```typescript
interface ConnectorPreview {
  // ... existing fields ...

  connectorType: 'elbow' | 'straight'; // Routing type for rendering decisions
  startDashTo: [number, number] | null; // Interior anchor position (dashed guide start)
  endDashTo: [number, number] | null; // Interior anchor position (dashed guide end)
  isCenterSnap: boolean; // Center dot should be highlighted
}
```

---

## Preview Rendering (`connector-preview.ts`)

### Dashed Guide Lines

After drawing polyline + arrows, if `connectorType === 'straight'`:

```typescript
if (preview.startDashTo) drawDashedGuide(ctx, points[0], preview.startDashTo, ...);
if (preview.endDashTo) drawDashedGuide(ctx, points[last], preview.endDashTo, ...);
```

**`drawDashedGuide()` style:**

- Dash pattern: 6px dash, 4px gap (screen-space via `pxToWorld`)
- Line width: `max(1/scale, connectorWidth * 0.6)` — thinner than main line
- Opacity: `connectorOpacity * 0.5` — semi-transparent
- Color: same as connector

### Center Dot in `drawSnapDots()`

Two new parameters: `isStraight: boolean`, `isCenterSnap: boolean`.

When `isStraight`:

- A 5th dot drawn at shape center `[x + w/2, y + h/2]`
- If `isCenterSnap`: rendered as active dot (blue fill, glow) at large radius
- Otherwise: rendered as inactive dot (white fill, blue stroke) at small radius
- When `isCenterSnap`, the regular active sliding dot is skipped (early return)

---

## ConnectorTool Integration (`ConnectorTool.ts`)

### New Instance Fields

```typescript
private frozenConnectorType: ConnectorType | null = null;
private startDashTo: [number, number] | null = null;
private endDashTo: [number, number] | null = null;
```

### Lifecycle

| Phase             | Connector Type Source                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| `begin()`         | Frozen from `useDeviceUIStore.getState().connectorType`                 |
| `move()` idle     | Live from `useDeviceUIStore.getState().connectorType` (for hover dots)  |
| `move()` creating | Frozen `this.frozenConnectorType`                                       |
| `getPreview()`    | `this.frozenConnectorType ?? useDeviceUIStore.getState().connectorType` |
| `resetState()`    | Cleared to `null`                                                       |

### `begin()` Changes

Passes `connectorType` to `findBestSnapTarget()`:

```typescript
findBestSnapTarget({
  cursorWorld,
  scale,
  prevAttach: null,
  connectorType: this.frozenConnectorType,
});
```

### `move()` Creating Changes

Routes via `routeNewConnector()` with type, captures dash info:

```typescript
const routeResult = routeNewConnector(
  start,
  end,
  width,
  this.frozenConnectorType ?? 'elbow',
  this.dragDir,
);
this.routedPoints = routeResult.points;
this.startDashTo = routeResult.startDashTo;
this.endDashTo = routeResult.endDashTo;
```

### `getPreview()` Changes

Populates new `ConnectorPreview` fields:

```typescript
connectorType: this.frozenConnectorType ?? useDeviceUIStore.getState().connectorType,
startDashTo: this.startDashTo,
endDashTo: this.endDashTo,
isCenterSnap: !!(this.hoverSnap
  && this.hoverSnap.normalizedAnchor[0] === 0.5
  && this.hoverSnap.normalizedAnchor[1] === 0.5
  && isAnchorInterior(this.hoverSnap.normalizedAnchor)),
```

### `commitConnector()` Changes

Writes `connectorType` to Y.Map (only when not default `'elbow'`):

```typescript
if (this.frozenConnectorType && this.frozenConnectorType !== 'elbow') {
  connectorMap.set('connectorType', this.frozenConnectorType);
}
```

Stores routed points as start/end for consistency:

```typescript
connectorMap.set('start', this.routedPoints[0]);
connectorMap.set('end', this.routedPoints[this.routedPoints.length - 1]);
```

---

## SelectTool Integration (`SelectTool.ts`)

### Endpoint Drag — `move()` endpointDrag Phase

Reads connector type from Y.Map and passes to snap:

```typescript
const connHandle = snapshot.objectsById.get(connectorId);
const connectorType = connHandle ? getConnectorType(connHandle.y) : 'elbow';

findBestSnapTarget({
  cursorWorld: [worldX, worldY],
  scale,
  prevAttach: epTransform.currentSnap,
  connectorType,
});
```

No other SelectTool changes needed — `rerouteConnector()` reads `connectorType` from Y.Map internally and branches to `computeStraightRoute`.

### Shape Transform (translate/scale)

No changes. The connector topology system (`ConnectorTopology`) is type-agnostic. `rerouteConnector()` handles the straight/elbow branching internally. Interior anchors move with their shape naturally during transforms.

---

## Selection Overlay (`selection-overlay.ts`)

### `drawConnectorEndpointDots()` Extension

After drawing endpoint dots, checks if the selected connector is straight:

```typescript
if (getConnectorType(handle.y) === 'straight') {
  drawStraightConnectorGuides(ctx, handle, startPos, endPos, snapshot, scale);
}
```

### `drawStraightConnectorGuides()`

For each endpoint (start, end):

1. Read `StoredAnchor` from Y.Map
2. Check `isAnchorInterior(anchor.anchor)`
3. If interior: look up shape frame, compute interior position via `applyAnchorToFrame()` (returns raw interior pos, no offset)
4. Draw dashed guide from endpoint dot position to interior position

**Style:** Uses `SELECTION_STYLE.PRIMARY` color (blue), 1.5px line width, 50% opacity, 6/4px dash pattern.

---

## Y.Map Schema Addition

```typescript
{
  // ... existing connector fields ...
  connectorType?: 'straight';  // Only stored when not 'elbow' (default)
}
```

Read via `getConnectorType(y)` from `@avlo/shared` (returns `'elbow'` if missing).

---

## Files Modified

| File                                   | What Changed                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `connectors/types.ts`                  | `isAnchorInterior()`, `SnapContext.connectorType`                                                              |
| `connectors/constants.ts`              | `SNAP_CONFIG.CENTER_SNAP_RADIUS_PX: 12`                                                                        |
| `connectors/connector-utils.ts`        | `computeShapeEdgeIntersection()` (3 shape types), `applyAnchorToFrame` interior bypass                         |
| `connectors/snap.ts`                   | CASE 1a: straight inside-shape snapping (center → midpoint → interior)                                         |
| `connectors/reroute-connector.ts`      | `computeStraightRoute()`, `NewRouteResult`, `ResolvedEndpoint` extended fields, branching in both routing APIs |
| `connectors/index.ts`                  | Re-exports: `isAnchorInterior`, `computeShapeEdgeIntersection`, `NewRouteResult`                               |
| `lib/tools/types.ts`                   | `ConnectorPreview`: 4 new fields                                                                               |
| `renderer/layers/connector-preview.ts` | `drawDashedGuide()`, center dot in `drawSnapDots()`                                                            |
| `lib/tools/ConnectorTool.ts`           | Freeze/pass `connectorType`, dash state, commit type                                                           |
| `lib/tools/SelectTool.ts`              | Pass `connectorType` to snap in endpoint drag                                                                  |
| `renderer/layers/selection-overlay.ts` | `drawStraightConnectorGuides()`, `drawDashedGuideLine()`                                                       |
| `stores/device-ui-store.ts`            | Default changed to `'straight'` for testing (revert to `'elbow'` for production)                               |

## Untouched Files

These explicitly do NOT need changes:

| File                    | Why                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `connector-paths.ts`    | 2-point polyline already works. `buildRoundedPolylinePath` handles it. Arrows work.                    |
| `object-cache.ts`       | Same `buildConnectorPaths` for both types.                                                             |
| `objects.ts` (renderer) | Committed rendering uses stored `points` — works for any point count. No dashed guides on base canvas. |
| `routing-context.ts`    | Only used for elbow A\*.                                                                               |
| `routing-astar.ts`      | Only used for elbow A\*.                                                                               |
| `connector-lookup.ts`   | Type-agnostic reverse map.                                                                             |
| `selection-store.ts`    | Topology system is type-agnostic. `rerouteConnector` handles branching.                                |

---

## Data Flow Summary

### Creation (ConnectorTool)

```
ConnectorTool.begin()
  → freeze connectorType from device-ui-store
  → findBestSnapTarget({ connectorType }) → SnapTarget with interior anchor

ConnectorTool.move()
  → findBestSnapTarget({ connectorType }) for end endpoint
  → routeNewConnector(start, end, width, connectorType, dragDir)
    → resolveNewEndpoint() → ResolvedEndpoint with normalizedAnchor/shapeType/frame
    → computeStraightRoute()
      → isAnchorInterior? → computeShapeEdgeIntersection → offset along approach
      → returns { points: [A, B], startDashTo, endDashTo }
  → store routedPoints, startDashTo, endDashTo

ConnectorTool.getPreview()
  → ConnectorPreview { connectorType, startDashTo, endDashTo, isCenterSnap }

OverlayRenderLoop
  → drawConnectorPreview()
    → draw polyline + arrows (same as elbow, just 2 points)
    → if straight: drawDashedGuide() for each non-null dashTo
    → drawSnapDots() with isStraight + isCenterSnap (center dot + 4 midpoints)

ConnectorTool.commitConnector()
  → Y.Map: connectorType='straight', points, start/end, anchors
```

### Rerouting (shape transform or endpoint drag)

```
SelectTool.move() endpointDrag
  → getConnectorType(connHandle.y) → 'straight'
  → findBestSnapTarget({ connectorType }) → SnapTarget
  → rerouteConnector(connectorId, { [endpoint]: snapOrPos })
    → resolveEndpoint() → ResolvedEndpoint with straight fields
    → getConnectorType(yMap) → 'straight'
    → computeStraightRoute() → { points, ... }
    → bbox from points

SelectTool.invalidateTransformPreview() (shape drag)
  → rerouteConnector(connectorId, { start/end: { frame } })
    → resolveEndpoint with frame override → populated straight fields
    → computeStraightRoute() → new 2-point path
```

### Selection overlay (selected connector, idle)

```
drawSelectionOverlay()
  → drawConnectorEndpointDots()
    → draw start/end dots (same as elbow)
    → getConnectorType(handle.y) === 'straight'?
      → drawStraightConnectorGuides()
        → for each anchor: isAnchorInterior?
          → applyAnchorToFrame (returns raw interior pos)
          → drawDashedGuideLine from endpoint to interior pos
```

---

## Known Issues & Areas for Second Pass

### 1. Edge Sliding Broken for Straight Connectors (snap.ts)

**Problem:** The straight inside-shape branch (CASE 1a) fires for ALL inside positions, including cursor positions right near the shape edge. This prevents the edge-sliding behavior that elbow connectors have when cursor is shallowly inside a shape.

**Root cause:** `if (isStraight && isInside)` catches everything. The elbow code has a depth gate (`forceMidpointDepthW`) that allows shallow-inside cursors to fall through to edge sliding (CASE 2). The straight branch doesn't have an equivalent gate.

**Expected fix:** Add a depth threshold for straight connectors before entering the interior branch. When shallow inside, fall through to CASE 2 (edge sliding) like elbow does.

### 2. Offset Issues

**Problem:** The `EDGE_CLEARANCE_W` offset for interior anchors may not look right in all cases. The offset is applied along the approach direction (from edge intersection toward the other endpoint), but for very short connectors or endpoints close to each other, this can look wrong.

**Expected fix:** May need to tune the offset distance or use a different clearance value for straight connectors.

### 3. Device UI Store Default

`connectorType` is currently defaulted to `'straight'` in device-ui-store for testing. **Must revert to `'elbow'` before production.**

### 4. No UI Toggle

No toolbar UI exists to switch between elbow and straight. Currently testing via the store default only. The `setConnectorType` action already exists in the store.

### 5. Dashed Guide Visibility

Dashed guides only appear on the overlay canvas (preview during creation, selection overlay when selected). They are NOT rendered on the base canvas for committed connectors. This is by design, but the guide might need to be visible in more contexts depending on UX feedback.
