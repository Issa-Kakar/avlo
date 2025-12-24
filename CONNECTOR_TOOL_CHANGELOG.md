# Connector Tool Slice 1 - Implementation Progress

## Status: Parts 1-6 Implemented ⚠️ (Critical Routing Bugs Found)

**Date:** 2024-12-23
**Branch:** `feature/connector-tool`

---

## Critical Issues Identified (2024-12-23) - MUST FIX

After initial implementation, user testing revealed **three critical UX bugs** in the routing algorithm:

### Issue 1: L-Route During Dynamic Drag (WRONG)

**Problem:** When dragging without a snap target, the router sometimes picks L-routes (2 segments: HV or VH). This creates horrible UX because:
- The connector "flips" between HV and VH as you drag
- There's no visual stability during drag
- It doesn't match user mental model of "drawing an arrow"

**Expected Behavior:**
- During free drag (no snap), **ALWAYS use 3-segment routing** (HVH or VHV)
- This provides stable, predictable routing while dragging
- The L-route (2 segments) should **ONLY** be an option when snapping to a shape

**Root Cause:** `pickBestRoute()` in `routing.ts` prefers fewer bends (L-route) over more bends (Z-route), even during dynamic drag.

**Fix Required:** Add a `forceThreeSegments` or `isSnapped` parameter to `computeRoute()`. When NOT snapped, filter out L-route candidates entirely.

### Issue 2: Self-Intersection on Snap (WRONG)

**Problem:** When snapping to a shape edge, the connector can draw THROUGH the target shape. Example:
- Drag from below a rectangle
- Snap to the TOP edge of the rectangle
- Connector draws a straight line through the rectangle body

**Expected Behavior:**
- The connector should NEVER cross through the shape it's snapping to
- If snapping to TOP coming from below, route should go AROUND (e.g., around left or right side)
- This is NOT about avoiding OTHER objects - it's about not intersecting the TARGET shape

**Clarification:** "No object avoidance during creation" means we don't route around unrelated shapes. But we absolutely MUST avoid self-intersection with the shape we're connecting to.

**Root Cause:** Routing algorithm doesn't consider the target shape's bounds when computing the path. It just connects jetty points without checking if the path crosses the target.

**Fix Required:** Add target shape bounds awareness to routing. When computing route, check if any segment would cross the target shape's bounding box, and if so, choose a dogleg route that goes around.

### Issue 3: Arrow Head Direction Mismatch (WRONG)

**Problem:** The arrow head direction doesn't always match the final segment direction. Example:
- End segment is vertical (going down)
- Arrow head points to the right instead of down

**Expected Behavior:**
- Arrow head direction should ALWAYS match the direction of the final segment
- If final segment goes from (100, 50) to (100, 100), arrow points DOWN
- If final segment goes from (50, 100) to (100, 100), arrow points RIGHT

**Root Cause:** Need to investigate - possibly the `drawArrowHead()` function is using wrong points for direction calculation, or the simplified path is losing the final segment direction.

**Fix Required:** Verify that `drawArrowHead()` uses the correct last two points after path simplification. The direction vector should be computed from `points[n-2]` to `points[n-1]`.

---

## Implementation Summary (Parts 5-6)

### Part 5: ConnectorTool Implementation ✅
**File:** `client/src/lib/tools/ConnectorTool.ts`

Replaced placeholder with full implementation:
- State machine: `'idle' | 'creating'`
- `begin()` - Freeze settings, snap start point, initialize route
- `move()` - Update endpoint (snap or free), recompute route
- `end()` - Commit connector to Y.Doc
- `getPreview()` - Build ConnectorPreview with all snap/route state
- Proper lifecycle methods (cancel, onPointerLeave, onViewChange, destroy)

### Part 6: Connector Preview Rendering ✅
**New File:** `client/src/renderer/layers/connector-preview.ts`

- `drawConnectorPreview()` - Main entry point
- `drawRoundedPolyline()` - arcTo corners with ROUTING_CONFIG.CORNER_RADIUS_W
- `drawArrowHead()` - Filled triangle, scales with stroke width
- `drawShapeAnchorDots()` - 4 midpoint dots (blue when active)
- `drawEndpointDot()` - Blue if attached, white if free

### Part 6.2: OverlayRenderLoop Integration ✅
**File:** `client/src/renderer/OverlayRenderLoop.ts`

Added connector preview case after selection preview block.

---

## Coordinate Space Fix (2024-12-23)

**Problem Identified:** The original plan confused screen-space and world-space for routing geometry.

### What Was Wrong
```typescript
// In routing.ts - WRONG:
const jettyW = pxToWorld(ROUTING_CONFIG.JETTY_PX, scale);  // Changed with zoom!
```

This would cause connectors drawn at different zoom levels to have different geometry:
- At scale=0.5 (zoomed out): jetty = 32 world units
- At scale=2.0 (zoomed in): jetty = 8 world units

### What Was Fixed
1. **ROUTING_CONFIG** now uses world-space constants (`JETTY_W`, `DOGLEG_W`, etc.)
2. **routing.ts** uses these directly without `pxToWorld()` conversion
3. Added arrow head constants to match existing `object-cache.ts` (10 world units)

### Correct Usage by Type

| Type | Space | Reason |
|------|-------|--------|
| Snap thresholds | Screen-space (pxToWorld) | Feel consistent at any zoom |
| Jetty/dogleg | World-space (fixed) | Permanent geometry in Y.Doc |
| Arrow heads | World-space (fixed) | Match committed connectors |
| Corner radius | World-space (fixed) | Match shape rendering |
| Anchor/endpoint dots | Screen-space (pxToWorld) | UI affordances like handles |

### Additional Clarifications

**Arrow head sizing:**
- Arrow size should scale with stroke width for visual balance
- `arrowLength = max(MIN_LENGTH, strokeWidth * FACTOR)`
- Added `ARROW_LENGTH_FACTOR`, `ARROW_WIDTH_FACTOR`, `ARROW_MIN_LENGTH_W`, `ARROW_MIN_WIDTH_W`
- Note: `object-cache.ts` uses stroked arrow lines (lineWidth applies automatically), but preview uses filled triangles (needs explicit scaling)

**Why pxToWorld works without pan:**
- `pxToWorld` converts **distances**, not **positions**
- Distances are translation-invariant (pan doesn't matter, only scale)
- Position conversions (screenToWorld, worldToCanvas) are handled by:
  - CanvasRuntime: converts pointer events to world coords before calling tools
  - OverlayRenderLoop: applies full transform via `ctx.setTransform()`
- This matches SelectTool pattern: `handleSize = 8 / view.scale`

---

## What Was Implemented

### Part 1: Data Model (Spec Only)
The Y.Map Connector Schema and Local Tool State are defined in `CONNECTOR_TOOL_SLICE_1.md`. No code changes needed - this is implemented when Part 5 (ConnectorTool) is created.

### Part 2: Enhanced ConnectorPreview Type ✅
**File:** `client/src/lib/tools/types.ts`

Updated the `ConnectorPreview` interface to support:
- Main connector path (world coords)
- Styling (color, width, opacity, caps)
- **Anchor visualization** - `snapShapeId`, `snapShapeFrame`, `snapShapeType`, `activeMidpointSide`
- **Endpoint states** - `fromIsAttached`, `fromPosition`, `toIsAttached`, `toPosition`
- `showCursorDot` flag for cursor dot during creation

Key design decision: Anchor dots ONLY appear when snapping would occur. If `snapShapeId` is set, the user WILL connect to this shape on release.

### Part 3: Snapping System ✅
**New Directory:** `client/src/lib/connectors/`

#### `constants.ts`
- `SNAP_CONFIG` - Screen-space snap thresholds (edge radius, midpoint hysteresis, inside depth)
- `ROUTING_CONFIG` - Orthogonal routing config (jetty, corner radius, dogleg)
- `pxToWorld(px, scale)` - Convert screen pixels to world units

#### `shape-utils.ts`
- `Dir` type - 'N' | 'E' | 'S' | 'W'
- `ShapeFrame` interface - { x, y, w, h }
- `getShapeFrame(handle)` - Extract frame from ObjectHandle
- `getMidpoints(frame)` - Get all 4 midpoints
- `getEdgePosition(frame, side, t)` - Position along edge (0-1)
- `getOutwardVector(side)` - Unit vector pointing outward
- `oppositeDir(dir)` - Get opposite direction
- `isHorizontal(dir)`, `isVertical(dir)` - Direction axis checks

#### `snap.ts`
- `SnapTarget` interface - Snap result with shapeId, side, t, isMidpoint, position, isInside
- `SnapContext` interface - Cursor position, scale, previous attach (for hysteresis)
- `findBestSnapTarget(ctx)` - Main entry point, uses spatial index, sorts by area (nested shapes), returns first valid snap
- `computeSnapForShape(shapeId, frame, shapeType, ctx)` - Shape-type-aware snapping
- `pointInsideShape(cx, cy, frame, shapeType)` - Handles rect/ellipse/diamond
- `getShapeMidpoints(frame, shapeType)` - Get perimeter midpoints
- `findNearestEdgePoint(cx, cy, frame, shapeType)` - Shape-type-aware edge detection

**Key UX Behaviors:**
1. Sort candidates by area ascending (smallest = most nested first)
2. Among equal-area candidates, prefer higher z-order (ULID descending)
3. Deep inside shape → only midpoints available
4. Midpoint hysteresis → sticky midpoints (snap-in at 14px, snap-out at 20px)

### Part 4: Orthogonal Routing Algorithm ✅
**File:** `client/src/lib/connectors/routing.ts`

- `RouteResult` interface - { points, signature }
- `RouteEndpoint` interface - { pos, dir }
- `computeRoute(from, to, prevSignature)` - Main routing function
  - Computes jetty points (stubs before first turn)
  - Generates route candidates (straight, L, Z, dogleg)
  - Picks best route (fewest bends > shortest length > stability)
  - Simplifies collinear points
- `inferDragDirection(from, cursor, prevDir, hysteresisRatio)` - Infer direction for free endpoints with hysteresis

**Route Types:**
- Straight (0 bends) - When endpoints are aligned
- L-route (1 bend) - HV or VH
- Z-route (2 bends) - HVH or VHV
- Dogleg routes - HVH+ or HVH- (when shapes are behind each other)

### Re-exports ✅
**File:** `client/src/lib/connectors/index.ts`

All public APIs are re-exported for convenient importing.

---

## What Remains (For Next Agent) - CRITICAL FIXES

### Priority 1: Fix Routing Algorithm (routing.ts)

1. **Force 3-segment routing during free drag:**
   - Add `allowTwoSegment: boolean` parameter to `computeRoute()`
   - When `allowTwoSegment=false`, filter out HV/VH candidates from `generateRouteCandidates()`
   - ConnectorTool should pass `allowTwoSegment: this.to?.kind === 'shape'`

2. **Add target shape awareness for self-intersection:**
   - Add optional `targetShapeBounds?: [x,y,w,h]` parameter to `computeRoute()`
   - After generating candidates, filter out any that would cross through target bounds
   - For each candidate path, check if any segment intersects the target rect
   - If all candidates intersect, force dogleg route that goes around

### Priority 2: Verify Arrow Head Direction (connector-preview.ts)

- Ensure `drawArrowHead()` computes direction from the FINAL two points
- After `simplifyOrthogonal()`, verify last segment is preserved
- The arrow should point in the direction of `tip - prev`, where tip is the last point

### Priority 3: Update ConnectorTool to pass context

- Pass `allowTwoSegment: boolean` based on whether `this.to?.kind === 'shape'`
- Pass `targetShapeBounds` when snapped to provide self-intersection avoidance

### Part 7-11: Testing & Polish
See `CONNECTOR_TOOL_SLICE_1.md` for detailed checklist.

---

## File Structure Summary

```
client/src/lib/connectors/
├── constants.ts        ✅  SNAP_CONFIG, ROUTING_CONFIG, pxToWorld
├── shape-utils.ts      ✅  getShapeFrame, getMidpoints, getEdgePosition, etc.
├── snap.ts             ✅  findBestSnapTarget, computeSnapForShape
├── routing.ts          ⚠️  computeRoute, inferDragDirection (NEEDS FIX - see issues above)
└── index.ts            ✅  Re-exports

client/src/lib/tools/
├── types.ts            ✅  Updated ConnectorPreview interface
└── ConnectorTool.ts    ✅  Full implementation (Part 5)

client/src/renderer/layers/
└── connector-preview.ts  ✅  Created (Part 6) - arrow head may need fix
```

---

## Dependencies Used

The implementation follows existing patterns from:
- `SelectTool.ts` - Spatial index queries, hit testing
- `hit-test-primitives.ts` - `pointInRect`, `pointInDiamond`
- `camera-store.ts` - `useCameraStore.getState().scale`
- `room-runtime.ts` - `getCurrentSnapshot()`
- `invalidation-helpers.ts` - `invalidateOverlay()`

---

## Typecheck Status

✅ All typechecks pass (`npm run typecheck`)

---

## How to Continue

**CRITICAL: Fix the routing bugs before proceeding with other work!**

1. Read the "Critical Issues Identified" section above carefully
2. Fix routing.ts - add `allowTwoSegment` and `targetShapeBounds` parameters
3. Update ConnectorTool.ts to pass the new parameters
4. Verify arrow head direction in connector-preview.ts
5. Run typecheck: `npm run typecheck`
6. Test manually:
   - Draw connector from free space (should ALWAYS be 3 segments)
   - Snap to shape edge (L-route now allowed, should NOT cross through shape)
   - Verify arrow points in correct direction on final segment

---

## Key Design Decisions Made

1. **Dots ONLY appear when snapped** - No separate hover preview zone
2. **Smallest area first** - Nested shapes prioritized correctly
3. **Shape-type-aware snapping** - Ellipse, diamond handled correctly
4. **Midpoint hysteresis** - Snap-in at 14px, snap-out at 20px
5. **Route stability** - Previous signature used to prevent jitter
6. **No `points` in Y.Map** - Reconstruct from endpoints + waypoints
