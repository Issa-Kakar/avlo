# Straight Connectors — Technical Reference

> **Status:** Production-ready. Edge sliding, offset direction, dashed guides, overlap handling, and snap dot rendering all working correctly.

## Overview

Straight connectors are a second routing mode alongside orthogonal (elbow) connectors. Instead of A\* Manhattan routing, they draw a direct line from A to B.

**`ConnectorType = 'elbow' | 'straight'`** — stored per-connector in Y.Map. Device-ui-store holds the default for new connectors.

**Key architectural principle:** All straight connector logic branches on `connectorType` checks. Elbow code paths are completely untouched — no regressions possible from gating.

---

## Anchor Categories

Straight connectors introduce a distinction that doesn't exist for elbow connectors:

### Edge Anchors

`normalizedAnchor` has at least one coordinate at 0 or 1 (within `INTERIOR_EPS = 1e-6`).

- Raw on-edge position computed from normalized anchor interpolation
- `EDGE_CLEARANCE_W` (11 units) applied as **pull-back toward the other endpoint** (not outward like elbow)
- Visually identical to elbow edge anchors in terms of snap dots

### Interior Anchors

`normalizedAnchor` has both coordinates strictly in `(0, 1)` — detected by `isAnchorInterior()`.

- Position is the raw interior point (no edge offset — `applyAnchorToFrame` returns directly)
- The **visible line stops at the shape edge** (ray intersection computed by `computeShapeEdgeIntersection`)
- `EDGE_CLEARANCE_W` applied as pull-back from intersection toward the other endpoint
- A **dashed guide line** connects the interior anchor point to the line endpoint on the shape edge (overlay only)

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
- `computeStraightRoute()` — trigger edge intersection + dashed guide vs edge pull-back
- `computeSnapForShape()` — center snap hysteresis detection, depth gate for interior mode
- `ConnectorTool.getPreview()` — `isCenterSnap` preview field
- `selection-overlay.ts` — dashed guide rendering + center dot detection during endpoint drag

---

## Snap System (`snap.ts`)

### `SnapContext` Extension

```typescript
interface SnapContext {
  cursorWorld: [number, number];
  scale: number;
  prevAttach: SnapTarget | null;
  connectorType?: ConnectorType; // defaults to 'elbow' behavior
}
```

### `computeSnapForShape()` — Straight Inside-Shape Logic

The function has a straight-specific branch (`CASE 1a`) with a **depth gate** that preserves edge sliding:

```
Depth gate: STRAIGHT_INTERIOR_DEPTH_PX (20px)
  When cursor is shallowly inside (< 20px from nearest edge):
    → Falls through to CASE 2 (edge sliding) — identical to elbow behavior
  When cursor is deeply inside (> 20px):
    → Enters CASE 1a interior mode

CASE 1a (straight, deep inside shape):
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
     - side = nearest edge side (for StoredAnchor.side)

CASE 1b (elbow, deep inside shape):
  Unchanged — force midpoint only (existing behavior, gate: FORCE_MIDPOINT_DEPTH_PX: 35)

CASE 2 (outside or near edge — both types):
  Edge sliding + midpoint stickiness. Straight connectors reach this
  when shallowly inside (< 20px depth) via the depth gate.
```

**Depth gate comparison:**

| Connector Type | Threshold                        | Behavior when shallow inside |
| -------------- | -------------------------------- | ---------------------------- |
| Elbow          | `FORCE_MIDPOINT_DEPTH_PX: 35`    | Edge sliding (CASE 2)        |
| Straight       | `STRAIGHT_INTERIOR_DEPTH_PX: 20` | Edge sliding (CASE 2)        |

The straight threshold is smaller because interior anchors are a valid destination (unlike elbow where deep-inside forces midpoint-only).

---

## Routing (`reroute-connector.ts`)

### `ResolvedEndpoint`

```typescript
interface ResolvedEndpoint {
  position: [number, number];
  dir: Dir | null;
  shapeBounds: AABB | null;
  isAnchored: boolean;
  // Straight connector fields (populated when anchored)
  normalizedAnchor?: [number, number];
  shapeType?: string;
  frame?: FrameTuple;
  shapeId?: string; // Target shape ID — enables same-shape detection
}
```

Both `resolveEndpoint()` and `resolveNewEndpoint()` populate all fields including `shapeId` from shape lookups / snap targets / stored anchors.

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

**Helpers:**

```typescript
// Raw anchor position = frame interpolation with NO offset
function getRawAnchorPosition(ep: ResolvedEndpoint): [number, number] {
  return [frame[0] + anchor[0] * frame[2], frame[1] + anchor[1] * frame[3]];
}

// EDGE_CLEARANCE_W offset along the connector line direction (toward other endpoint)
function applyPullBack(point, toward): [number, number] {
  return point + normalize(toward - point) * EDGE_CLEARANCE_W;
}
```

**Per-endpoint logic:**

| Endpoint State                    | Line Position                                              | Dash Guide                                     |
| --------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Free (`!isAnchored`)              | `position` as-is                                           | None                                           |
| Edge anchor (`!isAnchorInterior`) | `applyPullBack(rawEdge, otherRaw)` — toward other endpoint | None                                           |
| Interior anchor, same shape       | `rawPosition` directly — no edge intersection              | None                                           |
| Interior anchor, different shape  | Edge intersection + `applyPullBack` along approach         | Dashed line from raw interior to line endpoint |

**Key offset difference from elbow:** Elbow connectors apply `EDGE_CLEARANCE_W` **outward** (perpendicular to shape edge via `directionVector(side)`). Straight connectors apply it as **pull-back along the connector line** (toward the other endpoint). This ensures the arrow tip points directly at the edge, not above or beside the shape.

### Same-Shape Detection

When both endpoints are interior anchors on the **same shape** (`start.shapeId === end.shapeId`), the edge intersection is skipped entirely. The visible line goes directly from `startRaw` to `endRaw`. No dashed guides.

This prevents the "spinning clock" effect that occurs when both ray intersections exit the same convex shape — the rays would exit on opposite far sides, producing a wildly incorrect segment.

### Overlap Detection (Flipped/Collapsed Segment Safety)

After computing both `startPt` and `endPt` through normal per-endpoint logic, a final safety check validates the result:

```typescript
const rawDx = endRaw[0] - startRaw[0];
const rawDy = endRaw[1] - startRaw[1];
if (rawDx * rawDx + rawDy * rawDy > 0.001) {
  const visDx = endPt[0] - startPt[0];
  const visDy = endPt[1] - startPt[1];
  if (visDx * rawDx + visDy * rawDy <= 0 || Math.hypot(visDx, visDy) < EDGE_CLEARANCE_W) {
    return { points: [startRaw, endRaw], startDashTo: null, endDashTo: null };
  }
}
```

**What it detects:** When shapes overlap, edge intersections or pull-backs can produce a visible segment that is:

- **Flipped** (dot product ≤ 0) — line points opposite to the raw A→B direction
- **Collapsed** (length < EDGE_CLEARANCE_W) — endpoints pulled past each other

**Geometric cause:** For interior anchors, if endRaw is inside shape A (overlap region), the ray from startRaw exits A on the far side past endRaw. For edge anchors, if the gap between edges is less than `2 × EDGE_CLEARANCE_W` (22 units), both pull-backs overshoot past each other.

**Fallback:** Direct `[startRaw, endRaw]` with no dashes — same visual as same-shape interior. For interior anchors, the line starts/ends at the raw interior positions. For edge anchors, the line touches the shape edges directly (no clearance gap). Both are acceptable degraded visuals for the degenerate overlap case.

**No false positives:**

- Same-shape case: returns early before this check
- Normal non-overlapping: dot product is positive and segment length is reasonable
- Free endpoints: `startPt === startRaw`, so the check is trivially satisfied

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

### `routeNewConnector()` Return Type

```typescript
interface NewRouteResult {
  points: [number, number][];
  startDashTo: [number, number] | null;
  endDashTo: [number, number] | null;
}
function routeNewConnector(..., connectorType: ConnectorType = 'elbow', ...): NewRouteResult
```

For elbow connectors, `startDashTo` and `endDashTo` are always `null`.

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

| Shape                  | Method                                                                                  | Side Derivation                |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| `rect` / `roundedRect` | Ray vs 4 axis-aligned edges. Smallest positive `t` with valid cross-axis range.         | Which edge was hit             |
| `ellipse`              | Parametric substitution into ellipse equation. Solve quadratic, smallest positive root. | Quadrant of intersection angle |
| `diamond`              | Ray vs 4 diagonal line segments. Cramer's rule for ray-segment intersection.            | Which segment was hit          |

### `applyAnchorToFrame()` Modification

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

**Note:** This outward offset is used by **elbow connectors** and by `resolveEndpoint`'s `position` field. For straight connectors, `computeStraightRoute` computes its own offsets from raw positions, ignoring `position` in favor of `getRawAnchorPosition()` + `applyPullBack()`.

---

## Preview Types (`lib/tools/types.ts`)

### `ConnectorPreview` Extension

```typescript
interface ConnectorPreview {
  // ... existing fields ...

  connectorType: 'elbow' | 'straight'; // Routing type for rendering decisions
  startDashTo: [number, number] | null; // Interior anchor position (dashed guide target)
  endDashTo: [number, number] | null; // Interior anchor position (dashed guide target)
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

Direction: from line endpoint (edge intersection) TO interior anchor position.

**`drawDashedGuide()` style:**

- Dash pattern: 6px dash, 4px gap (screen-space via `pxToWorld`)
- Line width: `max(1/scale, connectorWidth * 0.6)` — thinner than main line
- Opacity: `connectorOpacity * 0.5` — semi-transparent
- Color: same as connector

### Center Dot in `drawSnapDots()`

Two parameters: `isStraight: boolean`, `isCenterSnap: boolean`.

When `isStraight`:

- A 5th dot drawn at shape center `[x + w/2, y + h/2]`
- If `isCenterSnap`: rendered as active dot (blue fill, glow) at large radius, then early return (skip normal active dot)
- Otherwise: rendered as inactive dot (white fill, blue stroke) at small radius

### Start Endpoint Dot During Creation

After snap dots, when `fromIsAttached && fromPosition && hasRoute`:

- Draws an inactive-style endpoint dot at `fromPosition`
- Uses `ANCHOR_DOT_CONFIG.LARGE_RADIUS_PX` and `INACTIVE_FILL/STROKE`
- Visible from the moment the connector creation begins from a shape

---

## Selection Overlay (`selection-overlay.ts`)

### `drawConnectorEndpointDots()` — Straight Connector Awareness

After drawing endpoint dots, if the connector is straight:

**During endpoint drag** (`transform.kind === 'endpointDrag'`):

- Reads `transform.routedPoints` for live line endpoint positions
- Dragged endpoint: if `currentSnap` is interior, draws dashed guide from `edgePosition` to `routedPoints[0]` or `routedPoints[last]`
- Non-dragged endpoint: reads stored anchor from Y.Map, if interior, draws dashed guide from canonical position to `routedPoints`
- Snap midpoint dots include center dot: detects `isCenterSnap` from `currentSnap.normalizedAnchor === [0.5, 0.5]` and passes to `drawSnapMidpointDots`

**Idle** (no active transform):

- Calls `drawStraightConnectorGuides()` which reads stored `points` from Y.Map
- For each interior anchor: dashed line from dot position (`getEndpointEdgePosition`) to `points[0]` / `points[last]`

### `drawStraightConnectorGuides()` — Idle Dashed Guides

```typescript
function drawStraightConnectorGuides(ctx, handle, startPos, endPos, snapshot, scale) {
  const points = getPoints(handle.y);
  if (points.length < 2) return;

  if (startAnchor && isAnchorInterior(startAnchor.anchor)) {
    drawDashedGuideLine(ctx, startPos, points[0], scale);
  }
  if (endAnchor && isAnchorInterior(endAnchor.anchor)) {
    drawDashedGuideLine(ctx, endPos, points[points.length - 1], scale);
  }
}
```

**Key design:** Uses stored `points[0]`/`points[last]` as the dashed line target (the edge intersection point on the committed connector). The endpoint dot is at the interior anchor position via `getEndpointEdgePosition()` (which interpolates the normalized anchor within the shape frame). This ensures the dashed line connects the visible dot to the visible line endpoint.

### `drawSnapMidpointDots()` — Center Dot Support

Extended with `isStraight` and `isCenterSnap` parameters:

- When `isStraight`: draws a center dot at shape center
  - `isCenterSnap`: active style (blue fill, glow, large radius), early return
  - Otherwise: inactive style (white fill, blue stroke, small radius)
- Provides visual parity with `connector-preview.ts`'s `drawSnapDots()` center dot behavior

---

## ConnectorTool Integration (`ConnectorTool.ts`)

### Lifecycle

| Phase             | Connector Type Source                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| `begin()`         | Frozen from `useDeviceUIStore.getState().connectorType`                 |
| `move()` idle     | Live from `useDeviceUIStore.getState().connectorType` (for hover dots)  |
| `move()` creating | Frozen `this.frozenConnectorType`                                       |
| `getPreview()`    | `this.frozenConnectorType ?? useDeviceUIStore.getState().connectorType` |
| `resetState()`    | Cleared to `null`                                                       |

### `commitConnector()` Changes

Writes `connectorType` to Y.Map (only when not default `'elbow'`):

```typescript
if (this.frozenConnectorType && this.frozenConnectorType !== 'elbow') {
  connectorMap.set('connectorType', this.frozenConnectorType);
}
```

---

## SelectTool Integration (`SelectTool.ts`)

### Endpoint Drag

Reads connector type from Y.Map and passes to snap:

```typescript
const connHandle = snapshot.objectsById.get(connectorId);
const connectorType = connHandle ? getConnectorType(connHandle.y) : 'elbow';
findBestSnapTarget({ cursorWorld, scale, prevAttach, connectorType });
```

No other SelectTool changes needed — `rerouteConnector()` reads `connectorType` from Y.Map internally and branches to `computeStraightRoute`.

### Shape Transform (translate/scale)

No changes. The connector topology system is type-agnostic. `rerouteConnector()` handles the straight/elbow branching internally.

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

| File                                   | What Changed                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectors/types.ts`                  | `isAnchorInterior()`, `SnapContext.connectorType`                                                                                                                                        |
| `connectors/constants.ts`              | `CENTER_SNAP_RADIUS_PX`, `STRAIGHT_INTERIOR_DEPTH_PX`                                                                                                                                    |
| `connectors/connector-utils.ts`        | `computeShapeEdgeIntersection()` (3 shape types), `applyAnchorToFrame` interior bypass                                                                                                   |
| `connectors/snap.ts`                   | CASE 1a: depth-gated straight inside-shape snapping (center → midpoint → interior)                                                                                                       |
| `connectors/reroute-connector.ts`      | `computeStraightRoute()` with pull-back offsets, same-shape detection, overlap safety; `ResolvedEndpoint.shapeId`; `NewRouteResult`; `getRawAnchorPosition()`, `applyPullBack()` helpers |
| `connectors/index.ts`                  | Re-exports: `isAnchorInterior`, `computeShapeEdgeIntersection`, `NewRouteResult`                                                                                                         |
| `lib/tools/types.ts`                   | `ConnectorPreview`: 4 new fields                                                                                                                                                         |
| `renderer/layers/connector-preview.ts` | `drawDashedGuide()`, center dot in `drawSnapDots()`, start endpoint dot                                                                                                                  |
| `lib/tools/ConnectorTool.ts`           | Freeze/pass `connectorType`, dash state, commit type                                                                                                                                     |
| `lib/tools/SelectTool.ts`              | Pass `connectorType` to snap in endpoint drag                                                                                                                                            |
| `renderer/layers/selection-overlay.ts` | `drawStraightConnectorGuides()` using stored `points`; drag-aware dashed guides via `routedPoints`; center dot in `drawSnapMidpointDots()`                                               |

## Untouched Files

| File                    | Why                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `connector-paths.ts`    | 2-point polyline already works. `buildRoundedPolylinePath` handles it. Arrows work. |
| `object-cache.ts`       | Same `buildConnectorPaths` for both types.                                          |
| `objects.ts` (renderer) | Committed rendering uses stored `points` — works for any point count.               |
| `routing-context.ts`    | Only used for elbow A\*.                                                            |
| `routing-astar.ts`      | Only used for elbow A\*.                                                            |
| `connector-lookup.ts`   | Type-agnostic reverse map.                                                          |
| `selection-store.ts`    | Topology system is type-agnostic. `rerouteConnector` handles branching.             |

---

## Data Flow Summary

### Creation (ConnectorTool)

```
ConnectorTool.begin()
  → freeze connectorType from device-ui-store
  → findBestSnapTarget({ connectorType }) → SnapTarget (edge/interior/center)

ConnectorTool.move()
  → findBestSnapTarget({ connectorType }) for end endpoint
  → routeNewConnector(start, end, width, connectorType, dragDir)
    → resolveNewEndpoint() → ResolvedEndpoint with shapeId/normalizedAnchor/shapeType/frame
    → computeStraightRoute()
      → getRawAnchorPosition() for each anchored endpoint
      → same-shape? → direct raw, no dash
      → interior? → computeShapeEdgeIntersection → applyPullBack toward other
      → edge? → applyPullBack toward other (not outward)
      → overlap safety check (dot product + length)
      → returns { points: [A, B], startDashTo, endDashTo }
  → store routedPoints, startDashTo, endDashTo

ConnectorTool.getPreview()
  → ConnectorPreview { connectorType, startDashTo, endDashTo, isCenterSnap }

OverlayRenderLoop
  → drawConnectorPreview()
    → draw polyline + arrows (same as elbow, just 2 points)
    → if straight: drawDashedGuide() for each non-null dashTo
    → drawSnapDots() with isStraight + isCenterSnap (center dot + 4 midpoints)
    → if fromIsAttached: draw start endpoint dot

ConnectorTool.commitConnector()
  → Y.Map: connectorType='straight', points, start/end, anchors
```

### Rerouting (shape transform or endpoint drag)

```
SelectTool.move() endpointDrag
  → getConnectorType(connHandle.y) → 'straight'
  → findBestSnapTarget({ connectorType }) → SnapTarget
  → rerouteConnector(connectorId, { [endpoint]: snapOrPos })
    → resolveEndpoint() → ResolvedEndpoint with shapeId + straight fields
    → getConnectorType(yMap) → 'straight'
    → computeStraightRoute() → { points, ... }
    → bbox from points

SelectTool.invalidateTransformPreview() (shape drag)
  → rerouteConnector(connectorId, { start/end: { frame } })
    → resolveEndpoint with frame override → populated straight fields
    → computeStraightRoute() → new 2-point path
```

### Selection overlay (selected connector)

```
drawSelectionOverlay()
  → drawConnectorEndpointDots()
    → draw start/end dots (same as elbow)
    → getConnectorType(handle.y) === 'straight'?
      → if endpointDrag:
        → read transform.routedPoints for live line endpoints
        → dragged endpoint: interior snap? → dashed guide to routedPoints edge
        → non-dragged: stored anchor interior? → dashed guide to routedPoints edge
        → snap midpoint dots with center dot support
      → else (idle):
        → drawStraightConnectorGuides()
          → read stored points from Y.Map
          → for each interior anchor: dashed from dot to points[0]/points[last]
```
