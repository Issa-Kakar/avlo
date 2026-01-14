# Connector Routing Redesign: Comprehensive Analysis

## Executive Summary

This analysis examines the current connector routing architecture, identifies fundamental structural issues, studies Excalidraw's Dynamic AABB approach, and proposes a unified solution. The core insight: **our current system computes information in the wrong order and lacks a unified spatial context and also dynamic offset ability**, while Excalidraw's dongle-based approach elegantly sidesteps many of our problems.
**Core Problem:** See below

**Solution:** Build "Dynamic AABBs" where the **facing edge IS the centerline** (computed from actual edges), and other edges have normal padding. Grid lines come directly from AABB boundaries - no separate centerline computation, no cell blocking needed, no special treatment if a facing side also contains an endpoint.

**Key Insight from Excalidraw:** Their AABBs extend to touch at centerlines. The A* path between start/end naturally goes through the centerline because that's where the AABB boundaries meet. No blocking required: the start and end dongles are attached to these AABBs specifically, which means even when a facing side is a start anchor, it does not push the start x/y and the midline both; It uses the midline as the AABB edge and uses it for start as well, and appends the from.position/to.position after routing dongle-dongle.
---

## Part 1: Current System Architecture Analysis

### 1.1 Data Flow (Current)

```
Terminal (from, to)
    ↓
computeApproachPoint() → fromApproach, toApproach [OFFSET APPLIED HERE]
    ↓
computeGoalPosition() → goalPos [OFFSET APPLIED AGAIN]
    ↓
buildNonUniformGrid()
    ├── computeFacingSides() / computeFacingSidesFromPoint() / computeFacingSidesToPoint()
    │   └── Uses approachOffset throughout [OFFSET APPLIED MANY TIMES]
    ├── Add endpoint lines [+ approachOffset scattered]
    ├── Add obstacle boundary lines [+ approachOffset scattered]
    └── createCellGrid()
        └── blockFacingSideCells() [Complex blocking logic]
    ↓
astar(grid, startCell, goalCell, hints, obstacles)
    ↓
Assemble path: [from.position, ...gridPath, to.position]
```

### 1.2 Fundamental Problems Identified

#### Problem 1: Offset Calculations Scattered Everywhere

The `approachOffset` (currently ~38 world units for strokeWidth=2) is applied in:

| Location | Count | What's Happening |
|----------|-------|------------------|
| `computeApproachPoint()` | 2× | Start/end approach points |
| `computeGoalPosition()` | 4× | Each direction case |
| `buildNonUniformGrid()` | 12× | Endpoint lines, obstacle boundaries |
| `computeFacingSides()` | 8× | Facing side calculations |
| `computeFacingSidesFromPoint()` | 4× | Free→Anchored centerlines |
| `computeFacingSidesToPoint()` | 4× | Anchored→Free centerlines |
| `blockFacingSideCells()` | 0 | (uses pre-computed values) |
| **Total** | ~30+ | Spread across 5 functions |

**Impact:** Changing offset behavior for one scenario requires hunting through multiple functions, and the interdependencies are non-obvious.

#### Problem 2: Centerline Existence Uses Padded Bounds

```typescript
// Current: computeFacingSides()
if (result.endFacingX > result.startFacingX) {  // PADDED values!
  result.centerlineX = (actualStartEdge + actualEndEdge) / 2;
  result.hasXCenterline = true;
}
```

**The Bug:** When shapes are close (within 2× padding), the padded facing sides overlap, so `hasXCenterline` becomes `false`, even though there's actual space between the shapes.

**Example:**
- Shape A right edge: 100
- Shape B left edge: 150
- Padding: 38
- Shape A facing: 100 + 38 = 138
- Shape B facing: 150 - 38 = 112
- Check: 112 > 138? **FALSE** → No centerline computed
- Reality: Gap of 50px exists → Centerline at 125 would be valid!

#### Problem 3: "Beyond Facing" Uses Padded Bounds

```typescript
// computeFacingSidesToPoint()
const shapeFacingX = startDir === 'E' ? x + w + approachOffset : x - approachOffset;
const pointBeyondFacing = startDir === 'E' ? px > shapeFacingX : px < shapeFacingX;

if (pointBeyondFacing && zRouteValid) {
  // Create centerline...
}
```

**The Bug:** When the free endpoint is close to the shape (within padding), `pointBeyondFacing` is false even though we should route directly.

**Example (Anchored→Free, anchor E):**
- Shape right edge: 100
- Padding: 38
- `shapeFacingX`: 138
- Free point at X=120 (between shape and padded line)
- Check: 120 > 138? **FALSE** → No centerline, falls to U-route logic
- Reality: Should go directly right (Z-route) since point is to the right of shape!

#### The Interconnection Problem
These values need each other in circular ways:
- **Centerline** needs spatial relationship AND actual edges
- **AABB boundaries** need centerline to know where facing edge goes
- **Grid lines** need AABB boundaries
- **Blocking** needs centerline existence AND grid lines AND start/goal positions

- **Start/goal positions** need AABB boundaries (which need centerline)
Current code computes them in scattered order, causing:
- `approachOffset` used in 40+ places with subtle variations
- Information computed multiple times with different assumptions
- Changes require coordinated edits across 6+ functions

**Whenever start is initially from Anchor, anchored-free starts routing from the fixed offset from the shape. The issue: In real usage, when starting the initial drag from the shape, the first movements are ALWAYS INSIDE THE OFFSET PADDING START POSITION, SO THE ENDPOINT IS "BEHIND" THE START**:
- Users expect when starting an initial connector from a shape for the arrow to point outwards from anchor. But when we have routing start BEYOND the endpoint, EVEN IF WE FIX THE CENTERLINE EXISTENCE: THIS WON'T CHANGE IF WE DO NOT UPDATE THE START POSITION TO ROUTE FROM THE SHAPE BOUNDARY.
- AND EVEN IF WE CHANGE THE START POSITION, WE MUST ENSURE WE DON'T ADD A GRID LINE AT THAT ANCHOR SIDE PADDED, OR ELSE WEIRD ROUTES OCCUR, THE SHAPE SIDE X OR Y, WITHOUT AN OFFSET, IS THE START POSITION NOT THE PADDED BOUNDARY. AKA: THE FROM.POSITION X AND Y. 

- SO NOT ONLY DO WE HAVE TO DETECT Z ROUTES/CENTERLINES, BUT WE ALSO NEED TO DYNAMICALLY CHANGE THE OFFSET IN "FromApproach" AND WE NEED TO NOT ADD THE SHAPE SIDE PADDED BOUNDARY AT ALL, PLUS WE HAVE TO BLOCK SIDE FACING CELLS ON "FromApproach" to enforce centerline path, PLUS we have to be aware in other anchored-free scenarios in U routes to make sure we DO APPLY THE OFFSET in normal cases, IT CANNOT ALWAYS BE OFFSET = 0.
- In conclusion: this problem is difficult to solve due to the fragmented logic and ordering we have currently, we need stronger centralization.

#### Problem 4: Grid Construction is Too Complex, not allowing chances to make things dynamic

`buildNonUniformGrid()` tries to be clever about:
1. Which axis lines to add for anchored vs free endpoints
2. When to merge facing sides into centerlines
3. When to add exterior-only sides
4. Complex line placement logic spread across ~150 lines

This makes it nearly impossible to reason about what lines exist for a given scenario.

#### Problem 5: Cell Blocking is Compensating for Bad Structure

`blockFacingSideCells()` exists because:
1. We add facing side lines to the grid
2. But we don't want A* to travel along them (stub effect)
3. So we block all cells on those lines except start/goal
4. Except for anchored→free we need different blocking rules
5. And we must never block start/goal positions

This is a ~120-line function compensating for the fact that our grid can't support a unified grid construction with different case handling and start/end offset changes.

#### Problem 6: Three Separate Facing-Side Functions

```typescript
computeFacingSides()         // Anchored→Anchored
computeFacingSidesFromPoint() // Free→Anchored
computeFacingSidesToPoint()   // Anchored→Free
```

Each implements similar logic with subtle differences, making this much more complex then it needs to be and all changes made are annoying to apply uniformly.

#### Problem 7: Information Dependency Order is Wrong

Current order:
1. Compute approach points (needs offset)
2. Build grid (needs facing sides, which need offset)
3. Find cells (needs grid)
4. Compute direction hints (needs shape positions, should inform grid!)
5. Run A*

**The problem:** We add the facing sides of Shapes even if a centerline exists, thus creating the need to even "blockSideFacingCells" in the first place. Direction hints and spatial relationships should inform grid construction, not be computed afterward. We're computing `preferredFirstDir` after building the grid, but that information should help us decide what lines to even put in the grid.

#### Problem 8: Fixed Offset Regardless of Space

```typescript
// routing-astar.ts
const fromApproach = computeApproachPoint(from, strokeWidth);  // Always full offset
const toApproach = computeApproachPoint(to, strokeWidth);      // Always full offset
```

Even when shapes are 20 world units apart (less than 2× offset), we use full 38-unit offsets on both sides.

**The Problem:** When there is less space than the offset but there exists space well before overlap, offset is not changed, and due to the architecture being fragmented there exists multiple simulataneous variables that must also change in the routing algorithm in regards to Endpoints, grid construction, padding, blocking certain cells, etc. making the handling of these cases difficult to implement.
- To make this dynamic: If the AABB's were constructed beforehand, the approach point would be placed right in the middle between the 20 unit space of the shapes, as the midline would exist and the "offset" naturally becomes the midline instead, no matter how far away or how close.
---

## Part 2: Excalidraw's Dynamic AABB Approach

### 2.1 Key Insight: "Dongles"

Excalidraw uses **dongle positions** - points where the first/last segment meets the routing grid. Instead of blocking cells, they **extend** the start/end to the centerline. Facing Edges become the centerline itself.

```
AVLO (current):              EXCALIDRAW:
Start ──→ (blocked cells)    Start ──→ StartDongle ═══════╗
              ↓                          (ON centerline)  ║
         centerline                                       ║
              ↓                                           ║
(blocked cells) ←── End      EndDongle ←═════════════════╝
                                  ←── End
```

**The genius:** The first segment (Start→StartDongle) is ALWAYS straight and perpendicular to the shape. The dongle sits ON the dynamic AABB boundary, which is either:
- The centerline (when facing sides exist)
- The padded boundary (when no centerline)

### 2.2 Dynamic AABB Generation

```typescript
const generateDynamicAABBs = (
  a: Bounds,           // Start element bounds
  b: Bounds,           // End element bounds
  startDifference,     // Per-side offsets for start
  endDifference,       // Per-side offsets for end
  // ...
): Bounds[] => {
  // Creates two AABBs that:
  // 1. Start at element bounds
  // 2. Expand toward each other
  // 3. MEET AT CENTERLINE when facing
  // 4. Handle corner cases with cross product tricks
}
```
**Core computation (simplified):**
```typescript
// When start is LEFT of end (horizontal facing)
if (a[2] < b[0]) {  // a.maxX < b.minX (shapes don't overlap on X)
  // Start AABB's right edge extends to centerline
  first[2] = (actualStartRight + actualEndLeft) / 2;
  // End AABB's left edge extends to centerline
  second[0] = (actualEndLeft + actualStartRight) / 2;
  // They meet exactly at centerline!
}
```


### 2.3 Grid Calculation (Much Simpler!)

```typescript
const calculateGrid = (aabbs, start, startHeading, end, endHeading, common) => {
  const horizontal = new Set<number>();
  const vertical = new Set<number>();

  // Add START/END positions (just the coordinates, not padded)
  if (startHeading === LEFT || startHeading === RIGHT) {
    vertical.add(start[1]);  // Y line for horizontal heading
  } else {
    horizontal.add(start[0]); // X line for vertical heading
  }
  // Same for end...

  // Add AABB boundaries
  aabbs.forEach(aabb => {
    horizontal.add(aabb[0]); horizontal.add(aabb[2]);
    vertical.add(aabb[1]); vertical.add(aabb[3]);
  });
  

  // Create nodes at intersections - THAT'S IT!
};
```

**Notice what's missing:**
- No per-side offset calculations
- No "facing side" concept at grid level
- No special centerline handling
- No cell blocking logic

The Dynamic AABBs already encode all of this information!

### 2.4 Dongle Position Calculation

```typescript
const getDonglePosition = (bounds, heading, p) => {
  switch (heading) {
    case UP:    return [p[0], bounds[1]];  // Same X, top of bounds
    case RIGHT: return [bounds[2], p[1]];  // Right of bounds, same Y
    case DOWN:  return [p[0], bounds[3]];  // Same X, bottom of bounds
    case LEFT:  return [bounds[0], p[1]];  // Left of bounds, same Y
  }
};
```

**Key insight:** The dongle is always ON the dynamic AABB boundary, at the same axis position as the actual start/end point.

### 2.5 A* Path Assembly

```typescript
// After A* finds path from startDongle → endDongle:
const points = path.map(node => node.pos);
startDongle && points.unshift(startGlobalPoint);  // Prepend actual start
endDongle && points.push(endGlobalPoint);          // Append actual end
```

**Result for head-on HVH:**
```
A* finds: startDongle → centerline node → endDongle
          (just vertical movement!)

Final path: actualStart → startDongle → (vertical) → endDongle → actualEnd
            [horizontal]  [vertical]  [horizontal]
```

The middle segment can literally be a single vertical line! All the "HVH" structure comes from the prepend/append of actual positions.

---

## Part 3: Comparative Analysis

### 3.1 Where Each System Encodes "Centerline Knowledge"

| Aspect | AVLO (Current) | Excalidraw |
|--------|----------------|------------|
| Centerline existence | `hasXCenterline` flag in FacingSides | Encoded in AABB boundary position |
| Centerline position | Explicit `centerlineX/Y` value | Is the AABB boundary itself |
| Stub segments | Cell blocking prevents parallel travel | First/last segments always perpendicular |
| Facing side lines | Added to grid, then blocked | Never added - AABB boundary IS the line |
| Start position in grid | `fromApproach` (offset from actual) | `startDongle` (on AABB boundary) |

---
## Focus: What We're Actually Building

### The Core Insight: Centerline AS The Facing Side

The fundamental shift different from the Excalidraw specific approach, is not about "non-overlapping AABBs" but about **how facing sides are represented**:

```
CURRENT SYSTEM:
- Facing sides are padded boundaries (shape + offset)
- Centerline is a SEPARATE line added between them
- We then BLOCK the facing side cells to force centerline usage

NEW SYSTEM:
- Facing sides ARE the centerline (when one exists)
- The AABB boundary on a facing side IS the centerline
- No separate centerline line, no blocking needed
- When no centerline exists, facing side is normal padded boundary
```

### Differences: AABBs Can Overlap - We Don't Care

Unlike Excalidraw, we're NOT creating non-overlapping AABBs:

| Excalidraw | Our Approach |
|------------|--------------|
| Non-overlapping AABBs | AABBs may overlap |
| Uses AABBs for segment obstacle check | Uses SHAPE BOUNDS for segment obstacle check |
| Complex vector cross product for corners | Simple: facing side = centerline or padding |
| No cell blocking (AABBs define routable space) | No cell blocking with grid, A* checks obstacles |

**Why this works:** Our segment intersection check uses the actual shape bounds, not the AABBs. The AABBs only define grid line positions. Overlapping AABBs just mean some grid lines might be shared or close together - harmless.

### 1.3 The "Dongle" Concept Adapted

Excalidraw's dongle = point on AABB boundary where A* starts/ends.

Our adaptation:
- **Dongle position** = intersection of anchor's fixed axis and AABB side
- **For facing side with centerline:** dongle is ON the centerline
- **For facing side without centerline:** dongle is ON the padded boundary
- **The "offset" becomes the distance from anchor to dongle** - inherently dynamic!

1. **Compute centerline from ACTUAL edges** (always exists if shapes don't overlap)
2. **Build Dynamic AABBs** where facing edge = centerline, for BOTH
3. **Grid lines = AABB boundaries** (no separate centerline computation)
4. **A* start/goal = dongle positions** (on AABB boundary in outward direction)
5. **Assemble path** = [actual position] + [A* path] + [actual position]
```
Anchored→Anchored with centerline:

Shape A                          Shape B
   │                                 │
   anchor ──→ dongle ═══════ dongle ←── anchor
              (centerX)     (centerX)

   Dongles are BOTH at centerX. A* path between them is vertical.
   First/last segments (anchor→dongle) are prepended/appended.
```

---

## Part 4: Proposed Solution

### 4.1 Core Architecture Change: "Routing Context First"

**New data flow:**

```
Terminal (from, to)
    ↓
createRoutingContext()  ← ALL spatial analysis happens here
    ├── Compute spatial relationships to prepare for checking centerline existence (no padding)
    ├── Compute Dynamic AABBs (handles centerline internally)
    ├── Compute Stub(dongle) positions
    └── Return unified context object
    ↓
buildRoutingGrid(context)  ← MUCH dumber, just AABB boundaries + 1 line for each endpoint direction
    ↓
astar(grid, startStub, endStub)  ← Route between dongles
    ↓
assemblePath(astarPath, from, to)  ← Prepend/append actual positions
```

**Critical difference from current system:**
- We're not checking `paddedFacingX > paddedFacingY` to decide centerline existence
- We're computing centerline between ACTUAL edges, then AABBs expand to MEET there(SHARED)
- The AABB boundary IS the routing line

### 4.4 Simplified Grid Construction

- No `approachOffset` scattered throughout
- No facing side calculations inside of grid building(already given AABBs)
- No centerline special blocking
- No facing side line merging logic

The AABB boundaries already encode all of this!

### 4.5 Stubs(dongles)-Based Path Assembly

```typescript
  //  A* between Stubs
  const routePath = astar(grid, startCell, endCell, ctx);

  // 5. Assemble: actual_start → dongles → actual_end
  const fullPath: [number, number][] = [from.position];
  for (const cell of donglePath) {
    fullPath.push([cell.x, cell.y]);
  }
  fullPath.push(to.position);

```

### Offset Emerges From Geometry

```typescript
// Dongle position for anchor heading E:
const dongleX = aabb.right;  // This IS the dynamic offset!

// If centerline exists (shapes have gap):
//   aabb.right = centerX = (shapeA.right + shapeB.left) / 2
//   Offset = centerX - anchor.x (varies with gap size!)

// If no centerline (shapes overlap on X):
//   aabb.right = shapeA.right + baseOffset
//   Offset = baseOffset (standard padding)
```

**The "offset" is now the distance from anchor to dongle.** When shapes are close, centerline is close, dongle is close, offset is small. When shapes are far, centerline is far, dongle is far, offset is large. No conditional logic needed.

### Why This Fixes Anchored→Free "Behind Start" Bug

The original problem:
> When starting anchored→free, the endpoint is initially "behind" the start position (inside padding zone). The padded facing line is beyond the endpoint, so `pointBeyondFacing` is false, causing U-routes instead of Z-routes.

The fix:
```typescript
// Centerline existence check uses ACTUAL shape edge, not padded:
const centerX = (shape.right + endpoint.x) / 2;
const centerlineExists = endpoint.x > shape.right;  // Not: endpoint.x > shape.right + offset

if (centerlineExists) {
  aabb.right = centerX;  // Dongle will be at centerX
} else {
  aabb.right = shape.right + offset;  // Normal padding
}
```

When endpoint is "behind" (between shape and where centerline would be):
- `endpoint.x > shape.right` is still TRUE (endpoint is right of shape)
- Centerline exists, dongle is at centerline
- Route goes: anchor → dongle (at centerX) → endpoint
- This IS the Z-route, working correctly!

When endpoint is INSIDE shape bounds:
- `endpoint.x > shape.right` is FALSE
- No centerline, dongle at padded boundary
- Falls back to L/U-route logic
- Also correct!


## Grid Line Count in Shape-Shape Examples

### Head-on Horizontal (E→W)

Shape A ──→ centerX ←── Shape B

X lines: A.left-pad, centerX, B.right+pad = 3
Y lines: A.top-pad, A.bottom+pad, anchor.y (×2 if different) = 3-4
Total: 6-7 lines

### Diagonal (A top-left, B bottom-right)

X lines: A.left-pad, centerX, B.right+pad = 3
Y lines: A.top-pad, centerY, B.bottom+pad, A.anchor.y, B.anchor.y = 5
Total: 8 lines

---


### AABB Boundary Calculation Example

For a shape with right side facing (anchor E, end shape to the right):

```typescript
// WRONG interpretation of an example:
right = centerX + baseOffset  // NO! Don't add offset to centerline

// CORRECT:
left = shape.x - baseOffset           // Non-facing: padded outward
right = centerX                        // Facing: IS the centerline, no offset
top = shape.y - baseOffset            // Non-facing: padded
bottom = shape.y + shape.h + baseOffset // Non-facing: padded
```

**Rule:** Facing side boundary = centerline (exact). Non-facing side boundary = shape edge + offset.

## Appendix A:

### A 1.1 No Vector Cross Product Needed

Excalidraw uses vector cross products for corner cases to prevent AABB overlap. We don't need this because:

1. Our AABBs CAN overlap - we don't use them for obstacle checking
2. When both X and Y centerlines exist (diagonal case), AABBs naturally TOUCH at (centerX, centerY)
3. No complex splitting logic required

Diagonal case (A top-left, B bottom-right):

startAABB:                    endAABB:
  right = centerX               left = centerX
  bottom = centerY              top = centerY

They touch at corner (centerX, centerY) - no overlap, no cross product needed.

### A.2 Grid is Just AABB Boundaries

```typescript
aabbs.forEach((aabb) => {
  horizontal.add(aabb[0]);  // left
  horizontal.add(aabb[2]);  // right
  vertical.add(aabb[1]);    // top
  vertical.add(aabb[3]);    // bottom
});
```

That's it. No offset calculations, no facing side logic, no centerline special cases. The AABBs already encode all of that.

## Appendix B: Visual Examples

### B.1 Head-On HVH (Current vs Proposed)

**Current System:**
```
Shape A                                Shape B
   │                                       │
   └──→ approach (offset)                  │
              │                            │
              ├── facing line (blocked) ───┤
              │        centerline          │
              ├── facing line (blocked) ───┤
              │                            │
              ↓                   approach ←──
                                       │
```
Grid has: approach lines, facing lines, centerline
Blocking required on facing lines except endpoints

**Proposed System:**
```
Shape A                                Shape B
   │                                       │
   └──→ dongle ═════════════════════ dongle ←──
                  (centerline IS the
                   AABB boundary)
```
Grid has: AABB boundaries only
No blocking needed - dongles are already on the right lines

### B.2 Close Shapes (The Bug Case)

**Current (Bug):**
```
Shapes within 2×padding:
Shape A │ │ Shape B     Gap: 50px, Padding: 38px
        ├─┤
        38 38           paddedA > paddedB → NO CENTERLINE!
                        Route goes through boundary → Wrong!
```

**Proposed (Fixed):**
```
Shape A │ │ Shape B     Gap: 50px
        │↔│             centerline at 25px
AABB A ─┘ └─ AABB B     AABBs TOUCH at centerline
                        Route naturally uses centerline
```

---

## CONCLUSION: CRITICAL COHESIVE SUMMARY PLAN TO TIE EVERYTHING TOGETHER: View @PROMPT.MD
