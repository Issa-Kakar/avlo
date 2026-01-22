# Connector Routing Refactor: Primitives-Based API

**Date:** 2026-01-19
**Status:** Complete (Phase 1-6 of SelectTool integration prep)
**Related:** `docs/CONNECTOR_ROUTING_SYSTEM.md`, `docs/CONNECTOR_ROUTING_SYSTEM_CONDENSED.md`

---

## Executive Summary

Refactored the connector routing system from a **Terminal-based API** to a **primitives-based API** (7 parameters). This eliminates boilerplate when building routing calls and sets up clean SelectTool integration for connector manipulation (move, resize, endpoint drag).

### The 7 Primitives

```typescript
computeAStarRoute(
  startPos: [number, number],      // 1. Start endpoint position
  startDir: Dir,                   // 2. Start outward direction
  endPos: [number, number],        // 3. End endpoint position
  endDir: Dir,                     // 4. End outward direction
  startShapeBounds: AABB | null,   // 5. Start shape bounds (null = free)
  endShapeBounds: AABB | null,     // 6. End shape bounds (null = free)
  strokeWidth: number              // 7. Connector stroke width
): RouteResult
```

**Key Insight:** `isAnchored` is now **derived** from `bounds !== null`, eliminating redundant state.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Solution Architecture](#solution-architecture)
3. [Files Changed](#files-changed)
4. [API Changes](#api-changes)
5. [Code Walkthrough](#code-walkthrough)
6. [SelectTool Integration Patterns](#selecttool-integration-patterns)
7. [Future Cleanup Tasks](#future-cleanup-tasks)
8. [Testing Notes](#testing-notes)

---

## Problem Statement

### Before: Terminal Objects Were Verbose

The old routing API required constructing full `Terminal` objects with 6 fields:

```typescript
interface Terminal {
  position: [number, number];
  outwardDir: Dir;
  isAnchored: boolean;       // Redundant - can derive from shapeBounds
  hasCap: boolean;           // Only used for offset calc, not routing
  shapeBounds?: AABB;
  normalizedAnchor?: [number, number];  // Only needed for commit, not routing
}
```

**Pain Points:**

1. **Boilerplate:** ConnectorTool had to construct two full Terminal objects just to call `computeRoute()`
2. **Redundancy:** `isAnchored` duplicates information already present in `shapeBounds !== null`
3. **SelectTool Friction:** To reroute a connector during shape transform, SelectTool would need to:
   - Read connector Y.map data
   - Construct two Terminal objects
   - Handle direction resolution
   - Call routing
   - This is tedious when you often just want to override one endpoint's position

4. **Mixed Concerns:** Terminal mixed routing primitives (`position`, `outwardDir`, `shapeBounds`) with commit-time data (`normalizedAnchor`, `shapeId`, `side`)

### Goal

Create a simplified API where:
- Routing accepts only the 7 primitives it actually needs
- SelectTool can easily reroute connectors with minimal boilerplate
- Direction resolution is handled internally when needed
- The routing layer has no dependency on `Terminal` type

---

## Solution Architecture

### Layer Separation

```
┌─────────────────────────────────────────────────────────────────┐
│                        ConnectorTool.ts                          │
│  (Uses ToolTerminal for internal state + commit)                │
│  Calls computeAStarRoute() directly with primitives             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      route-connector.ts                          │
│  High-level API for SelectTool                                  │
│  - Reads Y.map data                                             │
│  - Applies frame/endpoint overrides                             │
│  - Handles direction resolution                                 │
│  - Returns routed points                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      routing-astar.ts                            │
│  computeAStarRoute(7 primitives) → RouteResult                  │
│  Pure routing logic - no Y.map access, no Terminal dependency   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     routing-context.ts                           │
│  createRoutingContext(7 primitives) → RoutingContext            │
│  Spatial analysis: centerlines, dynamic AABBs, stubs            │
└─────────────────────────────────────────────────────────────────┘
```

### Two Paths to Routing

| Caller | Path | When to Use |
|--------|------|-------------|
| **ConnectorTool** | `computeAStarRoute()` directly | Creating new connectors - has all state in memory |
| **SelectTool** | `routeConnector()` | Rerouting existing connectors - reads from Y.map |

---

## Files Changed

### 1. `client/src/lib/connectors/types.ts`

**Changed:** `RoutingContext` interface

```typescript
// BEFORE
export interface RoutingContext {
  from: Terminal;           // ❌ Terminal dependency
  to: Terminal;             // ❌ Terminal dependency
  startBounds: Bounds;
  endBounds: Bounds;
  startStub: [number, number];
  endStub: [number, number];
  startDir: Dir;
  endDir: Dir;
  obstacles: AABB[];
}

// AFTER
export interface RoutingContext {
  startPos: [number, number];  // ✅ Just the position
  endPos: [number, number];    // ✅ Just the position
  startBounds: Bounds;         // Dynamic routing bounds (with centerline/padding)
  endBounds: Bounds;
  startStub: [number, number];
  endStub: [number, number];
  startDir: Dir;
  endDir: Dir;
  obstacles: AABB[];           // Raw shape bounds for segment checking
}
```

**Why:** The routing context only needs positions for final path assembly. It doesn't need the full Terminal.

---

### 2. `client/src/lib/connectors/routing-context.ts`

**Changed:** `createRoutingContext()` signature

```typescript
// BEFORE
export function createRoutingContext(
  from: Terminal,
  to: Terminal,
  strokeWidth: number
): RoutingContext

// AFTER
export function createRoutingContext(
  startPos: [number, number],
  startDir: Dir,
  endPos: [number, number],
  endDir: Dir,
  startShapeBounds: AABB | null,  // null = free endpoint
  endShapeBounds: AABB | null,    // null = free endpoint
  strokeWidth: number
): RoutingContext
```

**Key Change:** `isAnchored` is now **derived**:

```typescript
// Derive isAnchored from bounds !== null
const startAnchored = startShapeBounds !== null;
const endAnchored = endShapeBounds !== null;
```

**Internal variable rename:** `startBounds`/`endBounds` → `routingStartBounds`/`routingEndBounds` to avoid confusion with the input `startShapeBounds`/`endShapeBounds`.

---

### 3. `client/src/lib/connectors/routing-astar.ts`

**Changed:** `computeAStarRoute()` signature

```typescript
// BEFORE
export function computeAStarRoute(
  from: Terminal,
  to: Terminal,
  strokeWidth: number
): RouteResult

// AFTER
export function computeAStarRoute(
  startPos: [number, number],
  startDir: Dir,
  endPos: [number, number],
  endDir: Dir,
  startShapeBounds: AABB | null,
  endShapeBounds: AABB | null,
  strokeWidth: number
): RouteResult
```

**Removed:** `computeRoute()` wrapper function (was a backwards-compat shim that just forwarded to `computeAStarRoute`)

**Early exit fix:**

```typescript
// BEFORE (buggy - reference equality)
if (from.position === to.position) { ... }

// AFTER (correct - value equality)
if (startPos[0] === endPos[0] && startPos[1] === endPos[1]) { ... }
```

---

### 4. `client/src/lib/connectors/connector-utils.ts`

**Added:** `applyAnchorToFrame()` helper

```typescript
/**
 * Apply normalized anchor to frame, returning endpoint position with edge clearance.
 *
 * Normalized anchor [nx, ny] is in [0-1, 0-1] space relative to frame.
 * The edge position is computed, then offset outward by approach offset.
 */
export function applyAnchorToFrame(
  anchor: [number, number],
  frame: { x: number; y: number; w: number; h: number },
  side: Dir,
  strokeWidth: number
): [number, number] {
  const [nx, ny] = anchor;
  const edgeX = frame.x + nx * frame.w;
  const edgeY = frame.y + ny * frame.h;

  // Apply edge clearance offset in outward direction
  const [dx, dy] = directionVector(side);
  const offset = computeApproachOffset(strokeWidth);
  return [edgeX + dx * offset, edgeY + dy * offset];
}
```

**Why:** SelectTool needs to recompute endpoint positions when shapes transform. The anchor is stored as normalized `[0-1, 0-1]` coordinates, so we need to map it to world coords with the new frame.

**Usage Example:**
```typescript
// Shape moved from [0,0,100,100] to [50,50,100,100]
// Anchor at [0.5, 0] (top edge center)
const newPos = applyAnchorToFrame([0.5, 0], {x:50, y:50, w:100, h:100}, 'N', 2);
// → [100, 50 - offset] (top center of new frame, offset outward)
```

---

### 5. `client/src/lib/connectors/route-connector.ts` (NEW)

High-level API for SelectTool to reroute existing connectors.

```typescript
/**
 * Route a connector with optional overrides.
 *
 * Two orthogonal override mechanisms:
 * 1. shapeFrames: Map of shapeId → new frame (for shapes being transformed)
 * 2. endpointOverrides: Direct endpoint override (SnapTarget or [x,y] position)
 *
 * Resolution per endpoint:
 *   1. endpointOverrides.start/end (if provided) - direct override wins
 *   2. shapeFrames.get(anchor.id) (if anchored) - shape is transforming
 *   3. Y.map data - default
 */
export function routeConnector(
  connectorId: string,
  shapeFrames?: Map<string, Frame>,
  endpointOverrides?: {
    start?: SnapTarget | [number, number];
    end?: SnapTarget | [number, number];
  }
): [number, number][] | null
```

**Design Decisions:**

1. **Natural Discriminated Union:** `SnapTarget | [number, number]`
   - Arrays vs objects self-discriminate: `Array.isArray(override)`
   - No need for wrapper types or tagged unions

2. **Orthogonal Concerns:**
   - `shapeFrames` handles "shape is transforming"
   - `endpointOverrides` handles "endpoint is directly overridden"
   - Can use both together without conflict

3. **Internal Direction Resolution:**
   - Anchored endpoints use their stored `anchor.side`
   - Free endpoints compute direction from spatial relationship
   - Caller doesn't need to worry about direction logic

**Internal Structure:**

```typescript
// 1. Read connector data from Y.map
const storedStart = yMap.get('start');
const startAnchor = yMap.get('startAnchor');
// ...

// 2. Resolve each endpoint (override → frame override → stored)
const startResolved = resolveEndpoint('start', ...);
const endResolved = resolveEndpoint('end', ...);

// 3. Resolve directions
const { startDir, endDir } = resolveDirections(startResolved, endResolved, strokeWidth);

// 4. Call primitives-based routing
const result = computeAStarRoute(
  startResolved.position, startDir,
  endResolved.position, endDir,
  startResolved.shapeBounds, endResolved.shapeBounds,
  strokeWidth
);

return result.points;
```

---

### 6. `client/src/lib/tools/ConnectorTool.ts`

**Changed:** Uses primitives-based API directly

```typescript
// BEFORE: Built Terminal objects, called computeRoute()
const fromTerminal: Terminal = {
  position: this.from.position,
  outwardDir: resolvedFromDir,
  isAnchored: this.from.isAnchored,
  hasCap: this.from.hasCap,
  shapeBounds: fromShapeBounds,
  normalizedAnchor: this.from.normalizedAnchor,
};
const result = computeRoute(fromTerminal, toTerminal, this.prevRouteSignature, this.frozenWidth);

// AFTER: Calls computeAStarRoute() with primitives
const result = computeAStarRoute(
  this.from.position,
  resolvedFromDir,
  this.to.position,
  resolvedToDir,
  fromShapeBounds,
  toShapeBounds,
  this.frozenWidth,
);
```

**ToolTerminal Simplified:**

```typescript
// No longer extends Terminal - standalone interface
interface ToolTerminal {
  position: [number, number];
  outwardDir: Dir;
  isAnchored: boolean;
  hasCap: boolean;
  shapeBounds?: AABB;          // For routing
  shapeId?: string;            // For commit
  side?: Dir;                  // For commit
  normalizedAnchor?: [number, number];  // For commit
}
```

**Removed:** `prevRouteSignature` field (was passed to old `computeRoute()` but never actually used for anything)

---

### 7. `client/src/lib/connectors/index.ts`

**Exports Updated:**

```typescript
// REMOVED
export { computeRoute } from './routing-astar';

// ADDED
export { routeConnector } from './route-connector';
export { applyAnchorToFrame } from './connector-utils';
```

---

## API Changes

### Breaking Changes

| Old API | New API | Migration |
|---------|---------|-----------|
| `computeRoute(from, to, prevSig, width)` | `computeAStarRoute(startPos, startDir, endPos, endDir, startBounds, endBounds, width)` | Extract primitives from Terminal |
| `createRoutingContext(from, to, width)` | `createRoutingContext(startPos, startDir, endPos, endDir, startBounds, endBounds, width)` | Extract primitives from Terminal |
| `RoutingContext.from` / `.to` | `RoutingContext.startPos` / `.endPos` | Use position directly |

### New APIs

| Function | Purpose |
|----------|---------|
| `routeConnector(connectorId, shapeFrames?, endpointOverrides?)` | High-level rerouting for SelectTool |
| `applyAnchorToFrame(anchor, frame, side, strokeWidth)` | Map normalized anchor to world position |

---

## Code Walkthrough

### How `routeConnector()` Works

**Scenario:** User is dragging a shape. Two connectors are attached to it.

```typescript
// In SelectTool.onTransformMove():
const shapeFrames = new Map([
  [selectedShapeId, { x: newX, y: newY, w: shape.w, h: shape.h }]
]);

// Reroute all affected connectors
for (const connectorId of getConnectorsForShape(selectedShapeId)) {
  const points = routeConnector(connectorId, shapeFrames);
  if (points) {
    previewRoutes.set(connectorId, points);
  }
}
```

**Internal Flow:**

1. **Read Y.map:**
   ```typescript
   const storedStart = yMap.get('start');           // [100, 50]
   const startAnchor = yMap.get('startAnchor');     // { id: 'shape1', side: 'E', anchor: [1, 0.5] }
   ```

2. **Resolve Start Endpoint:**
   ```typescript
   // startAnchor exists → check for frame override
   const overrideFrame = shapeFrames.get('shape1');  // { x: 150, y: 50, w: 100, h: 100 }

   // Frame override exists → apply anchor to new frame
   const position = applyAnchorToFrame([1, 0.5], overrideFrame, 'E', strokeWidth);
   // → [150 + 100 + offset, 50 + 50] = [250 + offset, 100]

   return {
     position: [250 + offset, 100],
     dir: 'E',
     shapeBounds: { x: 150, y: 50, w: 100, h: 100 },
     isAnchored: true
   };
   ```

3. **Resolve End Endpoint:** (no override → use stored)

4. **Resolve Directions:**
   ```typescript
   // Start is anchored → use anchor.side ('E')
   // End is anchored → use anchor.side ('W')
   ```

5. **Route:**
   ```typescript
   computeAStarRoute(
     [250 + offset, 100], 'E',
     [endPos], 'W',
     { x: 150, y: 50, w: 100, h: 100 },  // Start obstacle
     { x: 400, y: 50, w: 100, h: 100 },  // End obstacle
     strokeWidth
   );
   ```

---

## SelectTool Integration Patterns

### Pattern 1: Shape Transform (Translate/Resize)

```typescript
// User is transforming one or more shapes
const shapeFrames = new Map(
  selectedShapeIds.map(id => [id, computeNewFrame(id, transform)])
);

// Get all connectors that need rerouting
const affectedConnectors = new Set<string>();
for (const shapeId of shapeFrames.keys()) {
  const connectors = getConnectorsForShape(shapeId);
  if (connectors) {
    for (const cid of connectors) affectedConnectors.add(cid);
  }
}

// Reroute each
const previewRoutes = new Map<string, [number, number][]>();
for (const cid of affectedConnectors) {
  const points = routeConnector(cid, shapeFrames);
  if (points) previewRoutes.set(cid, points);
}
```

### Pattern 2: Endpoint Drag (Reconnection)

```typescript
// User is dragging connector endpoint to reconnect
const snap = findBestSnapTarget(ctx);

const points = routeConnector(connectorId, undefined, {
  end: snap ?? [worldX, worldY]  // SnapTarget or free position
});
```

### Pattern 3: Free Endpoint Translate

```typescript
// Moving a free (unattached) endpoint
const currentEnd = yMap.get('end') as [number, number];
const points = routeConnector(connectorId, undefined, {
  end: [currentEnd[0] + dx, currentEnd[1] + dy]
});
```

### Pattern 4: Both Shapes Moving

```typescript
// Connector spans two selected shapes
const shapeFrames = new Map([
  [startShapeId, newStartFrame],
  [endShapeId, newEndFrame]
]);
const points = routeConnector(connectorId, shapeFrames);
```

### Pattern 5: Mixed (Shape + Free Endpoint)

```typescript
// One end attached to moving shape, other end is free and being dragged
const points = routeConnector(
  connectorId,
  new Map([[shapeId, newFrame]]),
  { end: [freeEndX + dx, freeEndY + dy] }
);
```

---

## Future Cleanup Tasks

The following cleanup is planned before full SelectTool integration:

### 1. Type Consolidation (AABB/Frame/Bounds)

**Current State:** Multiple similar types scattered across files:

```typescript
// types.ts
interface ShapeFrame { x, y, w, h }
interface AABB { x, y, w, h }  // Identical to ShapeFrame!
interface Bounds { left, top, right, bottom }  // NECESSARY: Edge-based representation

// route-connector.ts
interface Frame { x, y, w, h }  // Yet another copy

// Various places use inline { x, y, w, h } objects
```

**Cleanup:**
- Consolidate `AABB`, `ShapeFrame`, `Frame` into single type (probably `AABB`)
- Keep `Bounds` for edge-based representation (used in routing context)
- Update all usages

### 2. Function Cleanup

**Candidates for removal/simplification:**
- `getShapeTypeMidpoints()` - may be duplicating logic
- Check for unused direction helpers

### 3. Naming Improvements

**`route-connector.ts`:**
- Consider rename to `reroute-connector.ts` (more accurate - it's for rerouting existing connectors)
- Function `routeConnector()` → `rerouteConnector()`?
- Not compatible with ConnectorTool anyway (different data flow)

**Parameter names:**
- `shapeFrames` → `frameOverrides` (clearer intent)

**Internal variables:**
- `startResolved` / `endResolved` → clearer names?
- `ResolvedEndpoint` interface - review naming

### 4. SelectTool Preparation

- Clean up SelectTool overlay rendering
- Add connector selection support
- Integrate `routeConnector()` / `rerouteConnector()` calls
- Handle preview vs commit flow

### 5. Consider Edge Cases

- Anchored shape deleted → connector should fall back to stored position (handled)
- Both shapes deleted → connector becomes fully free
- Shape type changes (e.g., rect → diamond) → midpoint positions shift

---

## Appendix: Type Reference

### RoutingContext (After Refactor)

```typescript
interface RoutingContext {
  // Endpoint positions for final path assembly
  startPos: [number, number];
  endPos: [number, number];

  // Dynamic routing bounds (centerline/padding baked in)
  startBounds: Bounds;
  endBounds: Bounds;

  // Stub positions - where A* actually starts/ends
  startStub: [number, number];
  endStub: [number, number];

  // Resolved directions
  startDir: Dir;
  endDir: Dir;

  // Raw shape bounds for segment intersection checking
  obstacles: AABB[];
}
```

### Terminal (Still Exists, Not Used in Routing)

```typescript
// Still exported from types.ts for external use
// But routing layer no longer depends on it
interface Terminal {
  position: [number, number];
  outwardDir: Dir;
  isAnchored: boolean;
  hasCap: boolean;
  shapeBounds?: AABB;
  normalizedAnchor?: [number, number];
}
```

### ToolTerminal (ConnectorTool Internal)

```typescript
// Internal to ConnectorTool - not exported
interface ToolTerminal {
  position: [number, number];
  outwardDir: Dir;
  isAnchored: boolean;
  hasCap: boolean;
  shapeBounds?: AABB;
  // Commit-specific fields
  shapeId?: string;
  side?: Dir;
  normalizedAnchor?: [number, number];
}
```

---

## Conclusion

This refactor establishes a clean primitives-based routing API that:

1. **Reduces boilerplate** - No more constructing full Terminal objects
2. **Eliminates redundancy** - `isAnchored` derived from `bounds !== null`
3. **Enables SelectTool integration** - `routeConnector()` handles the complexity
4. **Maintains separation of concerns** - Routing layer has no Y.map or Terminal dependencies
5. **Is fully typed** - All changes pass typecheck

The foundation is now set for SelectTool connector manipulation (Phase 7 of the connector system implementation).

---

## Update: 2026-01-21 - Cleanup & Tuple Modernization

### Critical Bug Fix
**`applyAnchorToFrame()`** was using `computeApproachOffset()` (CORNER_RADIUS + arrowLength + EDGE_CLEARANCE ≈ 43+ units) instead of just `EDGE_CLEARANCE_W` (11 units). This caused connector endpoints to drift excessively during shape transforms.

### Removed Deprecated Functions
- `getShapeFrame()` → use `getFrame()` from `@avlo/shared`
- `getMidpoints()` → inlined into `getShapeTypeMidpoints()`
- `getEdgePosition()` → dead code
- `getConnectorEndpoint()` → double-applied EDGE_CLEARANCE
- `pointInsideShape()` wrapper → import from `@/lib/geometry/hit-testing`

### Tuple-Oriented API
All internal functions now accept `FrameTuple` instead of `ShapeFrame` objects:
- `getShapeTypeMidpoints(frame: FrameTuple, ...)`
- `computeSnapForShape(shapeId, frame: FrameTuple, ...)`
- `findNearestEdgePoint(cx, cy, frame: FrameTuple, ...)`
- `applyAnchorToFrame(anchor, frame: FrameTuple, side)`

### File Rename
- `route-connector.ts` → `reroute-connector.ts`
- `routeConnector()` → `rerouteConnector()`

### Type Cleanup
- Removed `ShapeFrame` alias (use `Frame` or `FrameTuple` from `@avlo/shared`)
- Added `FrameTuple` to barrel exports
- Kept `AABB` for routing code semantic clarity
