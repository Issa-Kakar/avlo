# Connector Anchor System Redesign

## Context: Recent Changes (Uncommitted)

### Problem: Endpoint Dots Were Incorrect for Preview

The connector preview previously rendered two types of dots:
1. **Shape anchor dots** - 4 midpoint dots on snapped shapes
2. **Endpoint dots** - dots at connector endpoints (offset from shape)

The endpoint dots were incorrectly shown during connector creation preview. They were designed for **selection/editing** of existing connectors, not creation. During creation, they visually appeared at the offset position (away from the shape) which was confusing.

### Solution Applied: Merged into Shape Anchor Dots

The endpoint dots were removed from preview, and the shape anchor dots were redesigned:

**Before:**
- `drawShapeAnchorDots()` - only showed 4 midpoint dots, active one was blue
- `drawEndpointDot()` - showed dots at endpoint positions (with offset)

**After:**
- `drawSnapDots()` - shows 4 midpoint dots + a sliding active dot at the `t` position
- Active dot slides along the shape edge as user drags
- Size variation: small midpoint dots (5px) vs larger active dot (7px)
- When at midpoint (t=0.5): all dots grow to active size
- Active dot has glow effect for polish
- `drawEndpointDot()` removed from preview (kept for future selection tool)

### Files Modified

1. **`constants.ts`**: Added `ANCHOR_DOT_CONFIG` with sizing, colors, glow settings
2. **`types.ts`**: Added `snapSide`, `snapT`, `snapPosition` to `ConnectorPreview`
3. **`ConnectorTool.ts`**: Passes new fields through `getPreview()`
4. **`connector-preview.ts`**: Replaced `drawShapeAnchorDots` + `drawEndpointDot` with `drawSnapDots`

---

## Problem Discovered: Shape-Specific Edge Positions

### The Issue

The new `drawSnapDots()` uses `getEdgePosition(frame, side, t)` to compute the active dot position:

```typescript
function getEdgePosition(frame, side, t): [number, number] {
  switch (side) {
    case 'E': return [x + w, y + h * t];
    // ... simple linear interpolation
  }
}
```

**This is incorrect for ellipse and diamond shapes.** It computes positions on the rectangular frame edge, not the actual shape perimeter.

### Quick Fix Applied

We pass `snap.position` (the pre-offset edge position) through the preview:

```typescript
// In ConnectorTool.getPreview():
snapPosition: this.hoverSnap?.position ?? null,

// In drawSnapDots():
const activePos = snapPosition ?? getEdgePosition(frame, side, t);
```

This works because the snap system already computes the correct shape-edge position for all shape types.

---

## Bigger Picture: Data Model Limitations

### Why `t` Alone is Insufficient

The current `SnapTarget` stores:
- `side: Dir` (N/E/S/W)
- `t: number` (0-1 position along edge)
- `position: [number, number]` (shape-edge position, pre-offset)

**Problem:** To reconstruct the edge position from `side + t`, you need shape-type-aware logic:

```typescript
// For rect: simple
edgePos = [x + w * t, y]  // for North side

// For ellipse: complex!
// t = (py - y) / h, need to solve for px on ellipse curve
// Requires quadratic formula or iterative solving

// For diamond: also complex!
// Need to interpolate along diagonal edge, not frame edge
```

### Why `snap.position` Passthrough is Also Problematic

While the quick fix works, it means:
1. `snap.position` returns the **pre-offset** edge position
2. `ConnectorTool` must call `getConnectorEndpoint()` to add the offset
3. For rendering dots, we pass `snap.position` through
4. For routing, we use the offset position

This creates an awkward duality where `snap.position` serves two purposes.

**More importantly:** When shapes resize/move (during Select tool operations), we need to recompute the edge position. With `side + t`, this requires shape-type-aware reconstruction. We can't just use `snap.position` because we don't have a cursor position - we have a stored anchor.

---

## Proposed Solution: Normalized Anchor

### The Insight

Instead of storing `side + t`, store a **normalized anchor** `[nx, ny]`:

```typescript
const anchor: [number, number] = [
  (edgePosition[0] - frame.x) / frame.w,  // nx: 0-1 in frame width
  (edgePosition[1] - frame.y) / frame.h   // ny: 0-1 in frame height
];
```

### Why This is Better

**Reconstruction is trivial for ALL shape types:**
```typescript
const edgePos = [frame.x + nx * frame.w, frame.y + ny * frame.h];
```

No shape-type awareness needed! The normalized anchor captures the exact position in frame-relative space.

**This works because:** The snap system computes the actual edge position (on ellipse curve, diamond diagonal, etc.), and normalizing that position preserves the relationship under frame scaling.

### For Shape Resize/Move

Given only the new frame and stored anchor:

```typescript
function computeEndpoint(newFrame, anchor, side): [number, number] {
  // Edge position - direct from anchor, NO shape-type needed!
  const edgeX = newFrame.x + anchor[0] * newFrame.w;
  const edgeY = newFrame.y + anchor[1] * newFrame.h;

  // Apply offset
  const [dx, dy] = directionVector(side);
  return [edgeX + dx * EDGE_CLEARANCE_W, edgeY + dy * EDGE_CLEARANCE_W];
}
```

Compare to `side + t`:
```typescript
function computeEndpoint(newFrame, shapeType, side, t): [number, number] {
  // REQUIRES shape-type awareness!
  const edgePos = computeShapeEdgePosition(newFrame, shapeType, side, t);
  // ... where computeShapeEdgePosition needs complex logic for ellipse/diamond
}
```

### Midpoint Detection

Midpoints in normalized space:
```typescript
const MIDPOINTS = {
  N: [0.5, 0],
  E: [1, 0.5],
  S: [0.5, 1],
  W: [0, 0.5],
};
```

Check if anchor is at midpoint: `anchor[0] === 0.5 && anchor[1] === 0` (for N), etc.

### Side Derivation

Side can be derived from anchor (for offset direction):
```typescript
if (anchor[0] === 1) return 'E';
if (anchor[0] === 0) return 'W';
if (anchor[1] === 1) return 'S';
if (anchor[1] === 0) return 'N';
```

---

## What Changes Need to Happen

### 1. Change `snap.position` to Return Offset Position

Currently: `snap.position` = edge position (pre-offset)
Proposed: `snap.position` = endpoint position (with offset applied)

This makes `snap.position` the ready-to-use endpoint for routing.

### 2. Add Normalized Anchor to SnapTarget

```typescript
interface SnapTarget {
  shapeId: string;
  side: Dir;
  anchor: [number, number];  // NEW: replaces t
  position: [number, number]; // NOW: includes offset
  isMidpoint: boolean;
  isInside: boolean;
}
```

### 3. Update Preview Rendering

Use anchor to compute dot position:
```typescript
const dotPos = [frame.x + anchor[0] * frame.w, frame.y + anchor[1] * frame.h];
```

No need to pass `snapPosition` separately - anchor is sufficient.

### 4. Update Committed Connector Schema

For anchored endpoints:
- Store `anchor: [nx, ny]` instead of `t`
- Keep `side` for offset direction (optional, derivable)
- `points[0]` and `points[n-1]` are the endpoint positions (with offset)

---

## Benefits of This Approach

1. **No shape-type-aware reconstruction** - normalized anchor directly maps to position
2. **Deterministic resize/move** - pass new frame + anchor, get new endpoint
3. **Single source of truth** - anchor captures exact position, endpoint includes offset
4. **Simpler preview rendering** - just use anchor, no `snapPosition` passthrough needed
5. **Works for all shapes** - rect, ellipse, diamond, any future shape types

---

## Known Bugs in Current Implementation

### Bug #1: Diamond Midpoint Dots Are Incorrectly Positioned

**Symptom:** For stretched diamonds, some midpoint dots appear offset from the visual edge centers.
- Tall skinny diamond (h >> w): N/S dots offset, W/E dots correct
- Wide short diamond (w >> h): W/E dots offset, N/S dots correct

**Root Cause:** `getShapeMidpoints()` in `snap.ts` ignores the shapeType parameter:

```typescript
export function getShapeMidpoints(
  frame: ShapeFrame,
  _shapeType: string  // ← IGNORED!
): Record<Dir, [number, number]> {
  return getMidpoints(frame);  // Always returns frame edge centers
}
```

This returns frame edge centers: `N: [x + w/2, y]`, `E: [x + w, y + h/2]`, etc.

For diamond, the edges are **diagonal** (defined in `findNearestEdgePoint`):
```typescript
// Diamond edges:
{ side: 'N', p1: left, p2: top }     // NW diagonal: [x, y+h/2] → [x+w/2, y]
{ side: 'E', p1: top, p2: right }    // NE diagonal: [x+w/2, y] → [x+w, y+h/2]
{ side: 'S', p1: right, p2: bottom } // SE diagonal: [x+w, y+h/2] → [x+w/2, y+h]
{ side: 'W', p1: bottom, p2: left }  // SW diagonal: [x+w/2, y+h] → [x, y+h/2]
```

The **true midpoint of the N edge** (t=0.5 along the diagonal) is:
```
lerp([x, y+h/2], [x+w/2, y], 0.5) = [x + w/4, y + h/4]
```

But we draw the dot at `[x + w/2, y]` (the top **vertex**, not the edge midpoint).

**Visualization:**
```
For tall skinny diamond:

    Frame edge center (wrong)
           ↓
           * ← Dot drawn here
          /|\
         / | \
        /  |  \
       /   |   \
      /    * ← Actual N edge midpoint (correct position)
     /    /
    *----*----*
    |         |
    *         *  ← W/E dots at vertices (happen to be correct for this aspect ratio)
    |         |
    *----*----*
         \
          \
           *
```

**Impact:** The midpoint dots in `drawSnapDots()` use `getMidpoints(frame)` which has the same issue. The 4 static midpoint dots are placed at frame edge centers, not at the true edge midpoints for diamond shapes.

---

### Bug #2: Ellipse Edge Sliding Feels "Slippery" and "Stuck"

**Symptom:** When dragging along a wide ellipse (w >> h), the sliding feels non-linear:
- Near top/bottom: dot barely moves despite cursor movement ("stuck")
- Near sides: dot jumps rapidly with small movements ("slippery")
- Near quadrant boundaries: dot may jump unexpectedly

**Root Cause #1: Non-linear angle mapping**

The ellipse projection in `findNearestEdgePoint` uses:
```typescript
const angle = Math.atan2((cy - ecy) / ry, (cx - ecx) / rx);
const px = ecx + rx * Math.cos(angle);
const py = ecy + ry * Math.sin(angle);
```

For a wide ellipse (rx=100, ry=20):
- The `atan2` arguments are scaled by `1/ry` (large) and `1/rx` (small)
- Near the top: `(cy - ecy) / ry` dominates, small Y movement → large angle change
- Near the sides: `(cx - ecx) / rx` is tiny, cursor must move far to change angle
- Result: **non-uniform sensitivity** around the ellipse perimeter

**Root Cause #2: Side boundary discontinuities**

The side is determined by angle quadrants:
```typescript
const normAngle = (angle + Math.PI * 2) % (Math.PI * 2);
if (normAngle < Math.PI / 4 || normAngle >= (Math.PI * 7) / 4) {
  side = 'E';
} else if (normAngle < (Math.PI * 3) / 4) {
  side = 'S';
} // ...
```

At the 45° boundaries, the side flips (e.g., N → E), and the `t` calculation switches basis:
```typescript
if (side === 'N' || side === 'S') {
  t = (px - x) / w;   // X-based
} else {
  t = (py - y) / h;   // Y-based
}
```

This creates **discontinuities** in `t` at quadrant boundaries, making the active dot jump.

**Note:** The sliding position (`snap.position`) is actually correct - it's on the ellipse curve. The issue is the **feel** of the interaction, not the final position. The normalized anchor approach won't fix this UX issue directly, but it's a separate concern from the data model.

---

## Mathematical Proof: Why Normalized Anchor Doesn't Need Shape Awareness

The key insight is that normalization is a **linear transformation** that preserves the exact relationship between a point and its frame.

### For Any Point (px, py) on Any Shape:

**Normalize:**
```typescript
anchor = [(px - frame.x) / frame.w, (py - frame.y) / frame.h]
```

**Reconstruct (no shape type needed):**
```typescript
px = frame.x + anchor[0] * frame.w
py = frame.y + anchor[1] * frame.h
```

### Proof for Ellipse:

Point on ellipse at angle θ:
```
px = cx + rx·cos(θ) = x + w/2 + (w/2)·cos(θ)
py = cy + ry·sin(θ) = y + h/2 + (h/2)·sin(θ)
```

Normalized:
```
nx = (px - x) / w = 0.5 + 0.5·cos(θ)
ny = (py - y) / h = 0.5 + 0.5·sin(θ)
```

Reconstruction:
```
px' = x + nx·w = x + (0.5 + 0.5·cos(θ))·w
    = x + w/2 + (w/2)·cos(θ) = px ✓

py' = y + ny·h = y + (0.5 + 0.5·sin(θ))·h
    = y + h/2 + (h/2)·sin(θ) = py ✓
```

### Proof for Diamond:

Point on N edge (from left vertex to top vertex) at parameter t:
```
left = [x, y + h/2]
top = [x + w/2, y]
px = x + t·(w/2)
py = y + h/2 - t·(h/2) = y + (h/2)·(1 - t)
```

Normalized:
```
nx = (px - x) / w = t/2
ny = (py - y) / h = (1 - t)/2
```

Reconstruction:
```
px' = x + nx·w = x + (t/2)·w = x + t·(w/2) = px ✓
py' = y + ny·h = y + ((1-t)/2)·h = y + (h/2)·(1-t) = py ✓
```

### Why This Works

The shape-aware math is needed **only once** - when computing the initial snap position `(px, py)` from cursor input. After normalization to `(nx, ny)`:

1. **Drawing anchor dot:** `[frame.x + nx * frame.w, frame.y + ny * frame.h]`
2. **After shape resize:** `[newFrame.x + nx * newFrame.w, newFrame.y + ny * newFrame.h]`

No shape type parameter. No reverse projection. Just linear interpolation.

The normalized anchor is a "snapshot" of the exact position in frame-relative [0,1]×[0,1] space. Frame transformations (translate, scale) are linear, and the anchor scales correctly with them.

---

## Summary

| Current | Proposed |
|---------|----------|
| `side + t` | `side + anchor[nx, ny]` |
| `snap.position` = edge pos | `snap.position` = endpoint (with offset) |
| Shape-aware reconstruction | Direct linear interpolation |
| Complex resize handling | Trivial resize handling |
| Pass `snapPosition` for dots | Use `anchor` for dots |

### Bugs to Fix

| Bug | Location | Issue |
|-----|----------|-------|
| Diamond midpoint dots | `getShapeMidpoints()` in snap.ts | Returns frame edge centers instead of diagonal edge midpoints |
| Ellipse slippery feel | `findNearestEdgePoint()` in snap.ts | Non-linear angle mapping + side boundary discontinuities |
| Midpoint dots in preview | `drawSnapDots()` in connector-preview.ts | Uses `getMidpoints(frame)` which has same diamond issue |
