# Eraser Tool Critical Fixes - Investigation & Instructions

## Executive Summary

Three critical issues were identified in the eraser tool after the Y.Map migration:

1. **Diamond/Ellipse hit-testing is completely off** - accurate on corners but wildly inaccurate on sides
2. **Missing radius slack** - requires cursor to be fully on top of object to erase
3. **Fill behavior not handled** - unfilled shapes erase from center when they shouldn't

---

## Issue 1: Diamond/Ellipse Hit-Testing is Way Off

### Root Cause

**File:** `client/src/lib/tools/EraserTool.ts`, lines 151-159

The `updateHitTest()` method uses `circleRectIntersect()` for ALL shapes:

```typescript
case 'shape': {
  const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
  if (!frame) break;

  const [x, y, w, h] = frame;
  if (this.circleRectIntersect(worldX, worldY, radiusWorld, x, y, w, h)) {
    this.state.hitNow.add(handle.id);
  }
  break;
}
```

**The Problem:** `circleRectIntersect()` tests against the shape's **bounding box (frame)**, NOT the actual geometric shape.

### Visual Explanation for Diamond

For a diamond with `frame = [0, 0, 100, 100]`:

```
Bounding Box (what circleRectIntersect tests):
┌──────────────────────────────────────────┐
│                    ▲ (50, 0)             │
│                   ╱ ╲                    │
│                  ╱   ╲                   │
│                 ╱     ╲                  │
│ (0, 50) ◄─────◆       ◆─────► (100, 50)  │
│                 ╲     ╱                  │
│                  ╲   ╱                   │
│                   ╲ ╱                    │
│                    ▼ (50, 100)           │
└──────────────────────────────────────────┘

Diamond vertices: Top(50,0), Right(100,50), Bottom(50,100), Left(0,50)
```

**When eraser is at position (80, 20):**
- `circleRectIntersect()` returns **TRUE** (point is inside bounding box)
- But the actual diamond edge at that position is at approximately x=60
- **Result:** Erases when 20 pixels OUTSIDE the diamond!

**When eraser is at corner position (100, 50):**
- `circleRectIntersect()` returns **TRUE**
- The diamond's Right vertex IS at (100, 50)
- **Result:** Correctly erases

**This explains why "corners are accurate but sides are not."**

### The Same Problem Exists for Ellipses

An ellipse inscribed in `frame = [0, 0, 100, 100]` doesn't fill the corners of that box.

---

## Issue 2: Missing Radius Slack

### Root Cause

**File:** `client/src/lib/tools/EraserTool.ts`, line 116

```typescript
const radiusWorld = ERASER_RADIUS_PX / viewTransform.scale;
```

No slack is added. The original PROMPT.MD specified:

```typescript
const ERASER_SLACK_PX = 2.0; // forgiving feel
const radiusWorld = (ERASER_RADIUS_PX + ERASER_SLACK_PX) / viewTransform.scale;
```

**Impact:** User must precisely position cursor directly on object to erase, rather than just "mildly touching" it.

---

## Issue 3: Fill Behavior Not Handled

### Root Cause

**File:** `client/src/lib/tools/EraserTool.ts`, lines 151-159

The current hit-testing doesn't check for `fillColor`. This matters because:

**Filled Shape Behavior:**
- Eraser should hit if cursor is ANYWHERE inside the shape (fill area OR near edge)
- This is correct semantically - the fill makes the interior "solid"

**Unfilled Shape Behavior:**
- Eraser should ONLY hit if cursor is near the STROKE/EDGE
- Interior is "empty" - eraser passing through center should NOT erase
- This matches user expectations for outlined shapes

### Example

For an unfilled ellipse centered at (50, 50):
- If eraser is at (50, 50) - the CENTER
- Current code: **ERASES** (because it's inside the bounding box)
- Expected: **SHOULD NOT ERASE** (center is empty, only stroke exists)

For a filled ellipse:
- If eraser is at (50, 50) - the CENTER
- Current code: **ERASES**
- Expected: **SHOULD ERASE** (center is filled)

---

## Step-by-Step Fix Instructions

### Step 1: Add Radius Slack Constant

**File:** `client/src/lib/tools/EraserTool.ts`

**Location:** Near line 5 (after ERASER_RADIUS_PX)

**Add:**
```typescript
const ERASER_SLACK_PX = 2.0; // Forgiving feel - don't require precise alignment
```

**Modify line 116 from:**
```typescript
const radiusWorld = ERASER_RADIUS_PX / viewTransform.scale;
```

**To:**
```typescript
const radiusWorld = (ERASER_RADIUS_PX + ERASER_SLACK_PX) / viewTransform.scale;
```

---

### Step 2: Add Shape-Specific Hit Test Methods

**File:** `client/src/lib/tools/EraserTool.ts`

**Location:** After the existing `circleRectIntersect` method (around line 240)

**Add these new methods:**

```typescript
/**
 * Test if eraser circle intersects a diamond shape.
 * Diamond vertices are at midpoints of frame edges.
 */
private diamondHitTest(
  cx: number, cy: number, r: number,
  frame: [number, number, number, number],
  strokeWidth: number,
  isFilled: boolean
): boolean {
  const [x, y, w, h] = frame;
  const halfStroke = strokeWidth / 2;

  // Diamond vertices (midpoints of frame edges)
  const top: [number, number] = [x + w / 2, y];
  const right: [number, number] = [x + w, y + h / 2];
  const bottom: [number, number] = [x + w / 2, y + h];
  const left: [number, number] = [x, y + h / 2];

  // For filled diamonds: check if point is inside OR near edges
  if (isFilled) {
    if (this.pointInDiamond(cx, cy, top, right, bottom, left)) {
      return true;
    }
  }

  // Check distance to each edge (4 line segments)
  const edges: [[number, number], [number, number]][] = [
    [top, right],
    [right, bottom],
    [bottom, left],
    [left, top]
  ];

  for (const [p1, p2] of edges) {
    const dist = this.pointToSegmentDistance(cx, cy, p1[0], p1[1], p2[0], p2[1]);
    if (dist <= r + halfStroke) {
      return true;
    }
  }

  return false;
}

/**
 * Check if point is inside a diamond (convex polygon test)
 */
private pointInDiamond(
  px: number, py: number,
  top: [number, number],
  right: [number, number],
  bottom: [number, number],
  left: [number, number]
): boolean {
  // Use cross product sign consistency for convex polygon
  const vertices = [top, right, bottom, left];
  let sign: number | null = null;

  for (let i = 0; i < 4; i++) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % 4];

    // Cross product of edge vector and point-to-vertex vector
    const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);

    if (sign === null) {
      sign = cross >= 0 ? 1 : -1;
    } else if ((cross >= 0 ? 1 : -1) !== sign) {
      return false; // Point is outside
    }
  }

  return true;
}

/**
 * Test if eraser circle intersects an ellipse shape.
 */
private ellipseHitTest(
  cx: number, cy: number, r: number,
  frame: [number, number, number, number],
  strokeWidth: number,
  isFilled: boolean
): boolean {
  const [x, y, w, h] = frame;
  const halfStroke = strokeWidth / 2;

  // Ellipse center and radii
  const ecx = x + w / 2;
  const ecy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  // Normalize point to unit circle space
  const dx = (cx - ecx) / rx;
  const dy = (cy - ecy) / ry;
  const normalizedDist = Math.sqrt(dx * dx + dy * dy);

  if (isFilled) {
    // For filled: hit if inside ellipse OR within stroke width of edge
    // Inside: normalizedDist < 1
    // Near edge with eraser radius: need to account for r in world space
    // Convert eraser radius to normalized space (approximate)
    const avgRadius = (rx + ry) / 2;
    const normalizedR = r / avgRadius;
    const normalizedStroke = halfStroke / avgRadius;

    return normalizedDist <= 1 + normalizedR + normalizedStroke;
  } else {
    // For unfilled: only hit if near the stroke
    // Distance from ellipse edge in normalized space is |normalizedDist - 1|
    const distFromEdge = Math.abs(normalizedDist - 1);

    // Convert thresholds to normalized space
    const avgRadius = (rx + ry) / 2;
    const normalizedR = r / avgRadius;
    const normalizedStroke = halfStroke / avgRadius;

    return distFromEdge <= normalizedR + normalizedStroke;
  }
}

/**
 * Test if eraser circle intersects a rectangle shape (stroke only for unfilled).
 */
private rectHitTest(
  cx: number, cy: number, r: number,
  frame: [number, number, number, number],
  strokeWidth: number,
  isFilled: boolean
): boolean {
  const [x, y, w, h] = frame;
  const halfStroke = strokeWidth / 2;

  if (isFilled) {
    // For filled: use existing circle-rect intersection (anywhere inside counts)
    // Expand rect by stroke width for edge hits
    return this.circleRectIntersect(cx, cy, r + halfStroke, x, y, w, h);
  }

  // For unfilled: check distance to each edge segment
  const edges: [[number, number], [number, number]][] = [
    [[x, y], [x + w, y]],         // Top edge
    [[x + w, y], [x + w, y + h]], // Right edge
    [[x + w, y + h], [x, y + h]], // Bottom edge
    [[x, y + h], [x, y]]          // Left edge
  ];

  for (const [p1, p2] of edges) {
    const dist = this.pointToSegmentDistance(cx, cy, p1[0], p1[1], p2[0], p2[1]);
    if (dist <= r + halfStroke) {
      return true;
    }
  }

  return false;
}
```

---

### Step 3: Update the Shape Hit-Test Logic in updateHitTest()

**File:** `client/src/lib/tools/EraserTool.ts`

**Replace the current shape case (lines ~151-159) with:**

```typescript
case 'shape': {
  const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
  if (!frame) break;

  const shapeType = handle.y.get('shapeType') as string | undefined;
  const strokeWidth = (handle.y.get('width') as number) ?? 1;
  const fillColor = handle.y.get('fillColor') as string | undefined;
  const isFilled = !!fillColor;

  let hit = false;

  switch (shapeType) {
    case 'diamond':
      hit = this.diamondHitTest(worldX, worldY, radiusWorld, frame, strokeWidth, isFilled);
      break;
    case 'ellipse':
      hit = this.ellipseHitTest(worldX, worldY, radiusWorld, frame, strokeWidth, isFilled);
      break;
    case 'rect':
    case 'roundedRect':
    default:
      // Rectangles can use the simpler rect test
      hit = this.rectHitTest(worldX, worldY, radiusWorld, frame, strokeWidth, isFilled);
      break;
  }

  if (hit) {
    this.state.hitNow.add(handle.id);
  }
  break;
}
```

---

### Step 4: Update Text Hit-Test for Consistency

**File:** `client/src/lib/tools/EraserTool.ts`

The text hit-test is fine as-is since text boxes are always "filled" with content. No changes needed.

---

### Step 5: Update eraser-dim.ts to Handle Fill (Optional Enhancement)

**File:** `client/src/renderer/layers/eraser-dim.ts`

Currently the dimming only strokes shapes. For filled shapes, you may want to also dim the fill. This is optional but would improve visual consistency.

**In the shape dimming section, consider:**

```typescript
if (kind === 'shape') {
  const width = handle.y.get('width') as number | undefined;
  const fillColor = handle.y.get('fillColor') as string | undefined;

  // Dim fill if shape is filled
  if (fillColor) {
    ctx.fill(path);
  }

  // Dim stroke
  if (width && width > 0) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.stroke(path);
  }
}
```

---

### Step 6: Remove Debug Console.log

**File:** `client/src/renderer/object-cache.ts`, line 62

**Remove this line:**
```typescript
console.log(shapeType, frame);
```

---

## Code Quality Notes from Investigation

### OverlayRenderLoop.ts

The overlay render loop implementation looks correct. Key observations:

1. **Line 83-85:** Correctly skips `holdPreviewForOneFrame` for eraser (eraser doesn't need preview hold because it doesn't flicker like strokes)

2. **Line 195-201:** Preview caching correctly excludes eraser previews - this is intentional since eraser preview has different lifecycle

3. **Line 304:** Self-scheduling for trail animation (`if (this.hasEraserTrail()) this.invalidateAll();`) is correct

4. **Trail constants are reasonable:**
   - `TRAIL_LIFETIME_MS = 200` - short trail
   - `TRAIL_MIN_DIST_PX = 0` - captures all movement
   - `TRAIL_MAX_POINTS = 10` - bounded memory

### EraserTool.ts

1. **State machine is clean** - clear separation between erasing/not-erasing states

2. **getPreview() correctly returns null when not erasing** - matches the design requirement of no hover dimming

3. **Commit batches deletions correctly** - single transaction for all accumulated hits

---

## Testing Checklist

After implementing the fixes, verify:

1. [ ] **Diamond shapes:**
   - [ ] Eraser near diamond EDGE triggers hit
   - [ ] Eraser FAR from edge (inside bbox but outside diamond) does NOT trigger hit
   - [ ] Corner hits still work correctly
   - [ ] Filled diamonds erase when cursor is inside fill area
   - [ ] Unfilled diamonds do NOT erase when cursor is in center

2. [ ] **Ellipse shapes:**
   - [ ] Eraser near ellipse EDGE triggers hit
   - [ ] Eraser in corner of bounding box (outside ellipse) does NOT trigger hit
   - [ ] Filled ellipses erase when cursor is inside fill area
   - [ ] Unfilled ellipses do NOT erase when cursor is in center

3. [ ] **Rectangle shapes:**
   - [ ] Filled rectangles erase from anywhere inside
   - [ ] Unfilled rectangles only erase near edges

4. [ ] **Radius slack:**
   - [ ] Eraser feels "forgiving" - don't need precise alignment
   - [ ] Objects erase when just touching them, not requiring full overlap

5. [ ] **Strokes and connectors:**
   - [ ] Still work correctly (regression test)

6. [ ] **Visual feedback:**
   - [ ] Trail animation still works smoothly
   - [ ] Dimming shows on accumulated hits
   - [ ] No dimming on hover (only during active erasing)

---

## File Summary

| File | Changes |
|------|---------|
| `client/src/lib/tools/EraserTool.ts` | Add slack constant, add 4 new hit-test methods, update shape case in updateHitTest() |
| `client/src/renderer/layers/eraser-dim.ts` | (Optional) Add fill dimming for filled shapes |
| `client/src/renderer/object-cache.ts` | Remove debug console.log |

---

## Confidence Assessment

| Issue | Root Cause Confidence | Solution Confidence |
|-------|----------------------|---------------------|
| Diamond/Ellipse hit-testing | **HIGH** - Traced exact code path, geometry clearly shows bbox vs shape mismatch | **HIGH** - Shape-specific tests are standard geometry algorithms |
| Missing slack | **HIGH** - Direct code comparison with PROMPT.MD spec | **HIGH** - Simple constant addition |
| Fill behavior | **HIGH** - Code doesn't check fillColor at all | **HIGH** - Standard filled/unfilled shape semantics |
