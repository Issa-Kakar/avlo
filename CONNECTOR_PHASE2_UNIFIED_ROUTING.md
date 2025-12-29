# Connector Routing Phase 2: Unified Grid Intelligence

**Date:** 2024-12-29
**Status:** Analysis Complete - Proposal for Implementation
**Dependencies:** CONNECTOR_PHASE1_GRID_ARCHITECTURE.md (partially implemented)

---

## Table of Contents

1. [Issues Summary](#1-issues-summary)
2. [Deep Analysis of Each Issue](#2-deep-analysis-of-each-issue)
3. [Core Conceptual Problems](#3-core-conceptual-problems)
4. [Proposed Architecture](#4-proposed-architecture)
5. [Implementation Strategy](#5-implementation-strategy)
6. [Edge Cases & Dynamic Fallbacks](#6-edge-cases--dynamic-fallbacks)
7. [File Changes Summary](#7-file-changes-summary)

---

## 1. Issues Summary

### 1.1 Active Issues to Fix

| ID | Issue | Severity | Root Cause |
|----|-------|----------|------------|
| **Z1** | Z-route segment imbalance for unsnapped endpoints | Medium | Free `to` has no offset, but `from` may have offset → asymmetric midpoint |
| **G1** | X/Y line confusion for snapped endpoints | Low | Coordinate semantics mismatch in comments vs. code |
| **J1** | Jetty concept is confusing and misapplied | High | Jetty conflates offset + direction + grid position into one abstraction |
| **S1** | Same-side approach takes wrong initial direction | High | A* doesn't account for final segment bend; 4-turn beats 3-turn incorrectly |
| **O1** | Opposite-side routing takes longer E/W route | High | Grid midpoint is symmetric but doesn't consider obstacle side |
| **T1** | Tight/close endpoint handling | Medium | No dynamic fallback when endpoints overlap padding zone |
| **D1** | Direction seeding may need resurrection | Medium | Anchored starts need fixed initial segment for visual consistency |

### 1.2 Working Well (Keep)

- Adjacent side routing (L-routes)
- Basic A* pathfinding with bend penalty
- Padding boundary blocking
- Cap-aware offset calculation

---

## 2. Deep Analysis of Each Issue

### 2.1 Z-Route Segment Imbalance (Z1)

**Current Behavior:**
```typescript
// routing-zroute.ts
const fromJetty = computeJettyPoint(from, strokeWidth, fromHasCap);  // Has offset if anchored
const toJetty = computeJettyPoint(to, strokeWidth, toHasCap);       // NO offset (unsnapped)

const midX = (fromJetty[0] + toJetty[0]) / 2;  // Asymmetric!
```

**Problem Visualization:**
```
FROM (anchored)                  TO (free)
    ●────┐                         ●
    ↑    │ offset=38               ↑
    │    │                         │ offset=0
    │    └─────────────────────────┤
         ↑                         ↑
         fromJetty                 toJetty = to.position

Midpoint is calculated between fromJetty and toJetty:
  midX = (fromJetty.x + toJetty.x) / 2

This is NOT halfway between the actual endpoints!
The segment lengths become: [38] [long] [short] [0]
```

**Root Cause:** When `to` is unsnapped, `toJetty === to.position` (offset=0). But `fromJetty` still has offset if `from` is anchored. The midpoint calculation uses jetty positions, creating asymmetric segments.

**Solution Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Always compute midpoint from actual positions | Symmetric segments | May conflict with obstacle avoidance |
| B | Give unsnapped `to` a small offset (corner radius) | Creates a "stub" for visual balance | Adds complexity to free endpoints |
| C | Compute midpoint from positions, then offset jetties outward | Best of both worlds | More calculations |

**Recommended: Option C** - Compute the midpoint of actual positions (`from.position` ↔ `to.position`), then let jetties extend naturally. The Z-route becomes symmetric by construction.

---

### 2.2 X/Y Line Confusion (G1)

**Current Code (`routing-grid.ts:182-198`):**
```typescript
if (from.outwardDir === 'N' || from.outwardDir === 'S') {
  // Vertical exit → y-line at jetty
  yLines.push(fromJetty[1]);
  xLines.push(from.position[0]); // Keep x for path assembly
} else {
  // Horizontal exit → x-line at jetty
  xLines.push(fromJetty[0]);
  yLines.push(from.position[1]); // Keep y for path assembly
}
```

**Your Observation:** When snapped to N/S anchor, you expected to add the y-line but found x-line was needed.

**Explanation:** The confusion stems from thinking about axes vs. thinking about movement:

```
For N-side anchor:
  - Position: (x, y) = (100, 50) where y=50 is shape top
  - Jetty extends NORTH to: (100, 50 - offset) = (100, 12)
  - Movement is VERTICAL (along Y axis)
  - The CONSTANT value is X (x=100 doesn't change during vertical movement)
  - Therefore: add x-line at x=100 (the fixed value)
  - Add y-line at the jetty's Y position for the turn point
```

**The Pattern:**
| Snap Side | Outward Dir | Movement Axis | Fixed Axis | Grid Line for Position | Grid Line for Jetty |
|-----------|-------------|---------------|------------|------------------------|---------------------|
| N | N (up) | Y | X | x-line at pos.x | y-line at jetty.y |
| S | S (down) | Y | X | x-line at pos.x | y-line at jetty.y |
| E | E (right) | X | Y | y-line at pos.y | x-line at jetty.x |
| W | W (left) | X | Y | y-line at pos.y | x-line at jetty.x |

**Current code is correct but comments are misleading.** The "single-axis" concept is that the JETTY position only contributes one axis line (the perpendicular one), while the ANCHOR position contributes the parallel one.

---

### 2.3 Jetty Concept Confusion (J1)

**Current Jetty Responsibilities (Too Many):**
1. Grid position for A* start/goal cell
2. Offset distance calculation
3. Path segment endpoint
4. Direction indicator
5. Obstacle clearance guarantee

**Why It's Confusing:**

```
Current Mental Model:
  from.position → fromJetty → [A* path] → toJetty → to.position
                    ↑                         ↑
              "First waypoint"          "Last waypoint"

But this breaks when:
- Unsnapped endpoints have offset=0 (jetty = position)
- Same-side scenarios where jetty is inside blocking zone
- We want different behaviors for A* grid vs. final path assembly
```

**The Deeper Issue:** "Jetty" conflates three distinct concepts:

| Concept | What It Represents | Who Needs It |
|---------|-------------------|--------------|
| **Approach Offset** | Distance from shape for arc+arrow clearance | Grid blocking, path rendering |
| **Grid Entry Point** | Where A* starts/ends searching | Grid cell lookup |
| **Path Waypoint** | Point in final path for smooth rendering | Path assembly |

**Solution: Dissolve "Jetty" into Explicit Concepts**

```typescript
// Instead of computeJettyPoint, have:
computeGridEntryPoint(terminal)     // For A* start/goal cell
computeApproachWaypoint(terminal)   // For path assembly
getObstacleClearance(terminal)      // For blocking zones
```

---

### 2.4 Same-Side Approach Wrong Direction (S1)

**Scenario:**
```
Start ● (inside N-side padding)
       │
       ↓ A* computes: E/W first, then N, then E/W
       │
     ╔═════════════════════════════════╗
     ║ padding zone                    ║
     ║   ┌─────────────────────┐       ║
     ║   │                     │       ║
     ║   │       Shape         │●──────║── Snap to N side
     ║   │                     │       ║
     ║   └─────────────────────┘       ║
     ╚═════════════════════════════════╝
```

**What A* Does (Current):**
```
Path: Start → E → N (to padding boundary) → E (along boundary) → S (to anchor)
Bends: 4 (E→N, N→E, E→S, S into shape... wait, S doesn't count!)

Actually A* finds:
Start → E/W → N → E/W → stop at toJetty
The FINAL segment (toJetty → to.position = South) is NOT part of A*!
```

**Why 4-Turn Beats 3-Turn:**

A* path ends at `toJetty`, not `to.position`. The final segment (jetty → anchor) is added AFTER A*:

```typescript
// routing-astar.ts:390-398
const fullPath: [number, number][] = [fromJetty];
for (const cell of path) {
  fullPath.push([cell.x, cell.y]);
}
fullPath.push(to.position);  // ← Final segment added here, NOT counted in A*
```

So A* sees:
- **4-turn path:** `Start → E → N → E` = 3 bends (E→N, N→E, ends at E)
- **3-turn path:** `Start → N → E → S` = 3 bends... wait, S would be going to the goal?

**The Real Problem:** A* goal is at `toJetty` (padding boundary), NOT `to.position` (anchor). So A* never considers the direction INTO the anchor.

**Solution: Inject Final Segment Into Cost**

When computing move cost to the GOAL cell, add penalty if the arrival direction doesn't match `oppositeDir(to.outwardDir)`:

```typescript
// In A* neighbor loop:
if (neighbor === goalCell) {
  const finalDir = oppositeDir(to.outwardDir);  // Direction INTO shape
  if (moveDir !== finalDir) {
    cost += COST_CONFIG.APPROACH_MISMATCH_PENALTY;  // e.g., 500
  }
}
```

---

### 2.5 Opposite-Side Routing Wrong E/W Direction (O1)

**Scenario:**
```
Start ● (inside N-side padding, x = 120)
       │
       │         midX = 100 (symmetric)
       ↓
     ╔═════════════════════════════════╗
     ║ x=50     Shape      x=150       ║
     ║   ┌─────────────────────┐       ║
     ║   │                     │       ║
     ║   │                     │       ║
     ║   │                     │       ║
     ║   └─────────────────────┘       ║
     ║                         ●───────║── Snap to S side at x=100
     ╚═════════════════════════════════╝

Start x=120, Goal x=100
MidX = (120 + 100) / 2 = 110

A* finds path going EAST to x=150 boundary, then South, then West to x=100
Instead of going WEST to x=50 boundary, then South, then East to x=100
```

**Why Wrong Direction?**

The grid has these x-lines:
- `x = 50 - offset` (W padding boundary)
- `x = 150 + offset` (E padding boundary)
- `x = 110` (midpoint)
- `x = 120` (start position)
- `x = 100` (goal position)

A* uses Manhattan distance + bend penalty. From start at x=120:
- Going West to x=50 boundary: distance = 70, then South, then East to x=100: +50 = **120 total horizontal**
- Going East to x=150 boundary: distance = 30, then South, then West to x=100: +50 = **80 total horizontal**

**The East path IS shorter in pure distance!** But visually it's wrong because it goes the "long way around" the obstacle.

**Root Cause:** The grid midpoint (x=110) is based on endpoint positions, not obstacle awareness. A* optimizes for distance, not "visual directness."

**Solution: Obstacle-Aware Grid Lines**

Add grid lines at the obstacle CENTER, not just midpoints of endpoints:

```typescript
if (to.shapeBounds) {
  const { x, y, w, h } = to.shapeBounds;

  // Padding boundaries (existing)
  xLines.push(x - approachOffset, x + w + approachOffset);
  yLines.push(y - approachOffset, y + h + approachOffset);

  // NEW: Obstacle center lines
  xLines.push(x + w / 2);  // Center X
  yLines.push(y + h / 2);  // Center Y
}
```

This creates a grid point at the obstacle center, giving A* a "corridor" option through the middle.

**Better Solution: Compute Correct Side First**

Before A*, determine which side of the obstacle the start is on relative to the goal:

```typescript
function computePreferredEscapeDir(
  startPos: [number, number],
  goalPos: [number, number],
  obstacle: AABB,
  goalSide: Dir
): Dir {
  const centerX = obstacle.x + obstacle.w / 2;
  const centerY = obstacle.y + obstacle.h / 2;

  // For opposite-side routing (start N, goal S or start E, goal W):
  if (goalSide === 'S' && startPos[1] < obstacle.y) {
    // Start is North, goal is South
    // Go TOWARD the goal's X position
    return startPos[0] < goalPos[0] ? 'E' : 'W';
  }
  // ... similar for other opposite-side cases
}
```

Then pass this to A* as a "preferred first direction" (soft hint, not hard constraint).

---

### 2.6 Tight/Close Endpoint Handling (T1)

**Scenario:**
```
● Start at x=105, y=48
│ (very close to anchor)
│
┌─────────────────────┐
│       Shape         │●── Anchor at x=100, y=50 (N side)
└─────────────────────┘

Distance: ~7 units
Approach offset: ~40 units

The start is INSIDE the padding zone, and the goal is on the SAME SIDE.
There's no room for:
  - Full corner radius (22 units)
  - Straight segment (6 units)
  - Arrow (10+ units)
```

**Current Behavior:** A* successfully routes, but applies same-side approach logic incorrectly - it goes E/W first instead of escaping North. The routing works, it's just using the wrong initial direction.

**Key Insight:** As long as we escape OUTWARD first (North in this example), the U-turn works. The issue is only when endpoints are so close that the arc physically can't fit.

**Required: Forced U-Turn with Dynamic Shrinking**

```
┌─────────────────────────────────────────────────────────────┐
│                    PROXIMITY DETECTION                       │
│                                                              │
│  For same-side scenarios where start is in the anchor's      │
│  padding zone:                                               │
│                                                              │
│  1. ALWAYS go outward first (escape the padding)             │
│  2. Check if endpoints are too close for normal arc          │
│                                                              │
│  arcSpace = distance between start.x and goal.x (for N/S)    │
│  minArcSpace = cornerRadius * 2 + arrowWidth                 │
│                                                              │
│  if arcSpace < minArcSpace:                                  │
│    → TIGHT MODE: shrink geometry                             │
│  else:                                                       │
│    → NORMAL U-TURN                                           │
└─────────────────────────────────────────────────────────────┘

TIGHT MODE strategy (NEVER straight line):
┌─────────────────────────────────────────────────────────────┐
│ ALWAYS force the U-turn shape, but shrink components:       │
│                                                              │
│ 1. Reduce corner radius progressively                        │
│    - Normal: 22 units                                        │
│    - Tight:  max(8, available_space / 3)                     │
│    - Minimum: 4 units (still visually curved)                │
│                                                              │
│ 2. Reduce min straight segment                               │
│    - Normal: 6 units                                         │
│    - Tight:  max(2, available_space / 6)                     │
│    - Can go to 0 if desperate                                │
│                                                              │
│ 3. Reduce arrow approach distance                            │
│    - Arrow head size stays same (visual consistency)         │
│    - But straight run before arrow can shrink                │
│                                                              │
│ 4. If STILL not enough room:                                 │
│    - Force U-turn with overlapping geometry                  │
│    - The arc may clip into the arrow slightly                │
│    - This is acceptable - better than straight line          │
└─────────────────────────────────────────────────────────────┘
```

**Implementation: Compute tight-mode constraints**

```typescript
interface TightModeConstraints {
  cornerRadius: number;      // Reduced from 22
  minStraightSegment: number; // Reduced from 6
  forceUturn: boolean;       // Always true for same-side in padding
}

function computeTightModeConstraints(
  startPos: [number, number],
  goalPos: [number, number],
  goalSide: Dir,
  strokeWidth: number
): TightModeConstraints | null {
  // Only applies to same-side scenarios
  const isNorthSouth = goalSide === 'N' || goalSide === 'S';
  const lateralDistance = isNorthSouth
    ? Math.abs(startPos[0] - goalPos[0])  // X distance for N/S
    : Math.abs(startPos[1] - goalPos[1]); // Y distance for E/W

  const normalCornerRadius = ROUTING_CONFIG.CORNER_RADIUS_W;  // 22
  const normalMinStraight = ROUTING_CONFIG.MIN_STRAIGHT_SEGMENT_W;  // 6
  const arrowWidth = computeArrowLength(strokeWidth) * 0.75;  // Arrow intrusion

  const minNeededForNormal = normalCornerRadius * 2 + arrowWidth;

  if (lateralDistance >= minNeededForNormal) {
    return null;  // Normal mode, no constraints needed
  }

  // TIGHT MODE: Shrink everything proportionally
  const availableSpace = lateralDistance - arrowWidth;
  const shrinkFactor = Math.max(0.2, availableSpace / (normalCornerRadius * 2));

  return {
    cornerRadius: Math.max(4, normalCornerRadius * shrinkFactor),
    minStraightSegment: Math.max(0, normalMinStraight * shrinkFactor),
    forceUturn: true,  // ALWAYS U-turn, never straight
  };
}
```

**Key Principle:** A cramped U-turn with tight corners is ALWAYS better than a straight line. The visual hierarchy is:
1. Best: Normal U-turn with full geometry
2. Acceptable: Tight U-turn with reduced radii
3. Last resort: Overlapping/clipped U-turn
4. **NEVER:** Straight line through the shape

---

### 2.7 Direction Seeding Resurrection (D1)

**Original Problem with Seeding:** Created traps when seeded direction pointed at blocked cells.

**Your Insight:** For ANCHORED starts, you WANT a fixed initial segment direction for visual consistency.

**Key Distinction:**
- **Seeding as CONSTRAINT:** "You MUST go this direction" → Creates traps
- **Seeding as PREFERENCE:** "Prefer this direction, but escape if blocked" → Useful

**Solution: Optional First-Segment Preference**

```typescript
interface AStarOptions {
  // Soft preference for first move direction (not a hard constraint)
  preferredFirstDir?: Dir;

  // If true, first segment is FORCED to this direction
  // Only use for anchored starts where we're outside all obstacles
  forceFirstDir?: boolean;
}

function astar(grid, start, goal, options?: AStarOptions): GridCell[] {
  const startNode: AStarNode = {
    cell: start,
    g: 0,
    h: manhattan(start, goal),
    f: manhattan(start, goal),
    parent: null,
    arrivalDir: options?.forceFirstDir ? options.preferredFirstDir : null,
  };

  // In neighbor loop:
  if (current === startNode && options?.preferredFirstDir) {
    // Apply bonus for preferred direction
    if (moveDir === options.preferredFirstDir) {
      cost -= COST_CONFIG.PREFERRED_DIR_BONUS;  // e.g., -200
    }
  }
}
```

**When to Use Force:**
- From is anchored AND outside all obstacle padding zones
- The forced direction is the anchor's outward direction

**When to Use Preference:**
- From is anchored but inside a padding zone
- Want visual consistency but need escape route

---

## 3. Core Conceptual Problems

### 3.1 The "Jetty" Abstraction Is Wrong

**Current:** One function (`computeJettyPoint`) tries to serve:
- Grid construction
- Path assembly
- Offset calculation
- Start/goal position

**Reality:** These need different values in different scenarios.

### 3.2 A* Doesn't Know About Final Segment

**Current:** A* routes to `toJetty`, then final segment is appended.
**Problem:** Bend penalty doesn't consider the turn into the anchor.

### 3.3 Grid Lines Are Endpoint-Centric, Not Obstacle-Centric

**Current:** Grid lines at endpoint positions + padding boundaries.
**Problem:** Symmetric midpoint doesn't know about obstacle location.

### 3.4 `computeFromOutwardDirOnSnap` Is Fighting A*

**Current:** ConnectorTool computes initial direction, A* may ignore it.
**Problem:** Two systems trying to control the same behavior.

---

## 4. Proposed Architecture

### 4.1 New Routing Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. ANALYSIS PHASE                                            │
│    - Compute proximity mode (normal/close/overlapping)       │
│    - Detect scenario (same-side/adjacent/opposite/outside)   │
│    - Determine escape direction for padding zone starts      │
│    - Compute preferred first direction                       │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│ 2. GRID CONSTRUCTION                                         │
│    - Add obstacle-aware lines (center + boundaries)          │
│    - Add routing corridor lines based on scenario            │
│    - Blocking based on actual obstacle bounds                │
│    - Start/goal at ACTUAL positions (not jetties)            │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│ 3. A* WITH TERMINAL AWARENESS                                │
│    - Optional first-direction preference (not constraint)    │
│    - Final segment direction factored into goal cell cost    │
│    - Obstacle-side awareness for E/W preference              │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│ 4. PATH ASSEMBLY                                             │
│    - Add approach waypoints based on caps                    │
│    - Apply corner radius constraints                         │
│    - Handle close-mode simplifications                       │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 New Type: `RoutingContext`

```typescript
interface RoutingContext {
  // Endpoints (actual positions, not jetties)
  from: {
    position: [number, number];
    outwardDir: Dir;
    isAnchored: boolean;
    hasCap: boolean;
    shapeBounds?: AABB;
  };
  to: {
    position: [number, number];
    outwardDir: Dir;
    isAnchored: boolean;
    hasCap: boolean;
    shapeBounds?: AABB;
  };

  // Computed analysis
  proximityMode: 'normal' | 'close' | 'overlapping';
  scenario: 'same-side' | 'adjacent' | 'opposite' | 'outside';
  fromInPadding: boolean;
  preferredFirstDir: Dir | null;
  preferredApproachDir: Dir;  // Direction to enter goal

  // Offsets (computed from caps + stroke)
  fromOffset: number;
  toOffset: number;
  strokeWidth: number;
}
```

### 4.3 Remove `computeJettyPoint`, Replace With:

```typescript
// For path assembly (where waypoints go)
function computeApproachWaypoint(
  position: [number, number],
  outwardDir: Dir,
  offset: number
): [number, number];

// For grid construction (where A* starts/ends)
function computeGridEntryCell(
  ctx: RoutingContext,
  which: 'from' | 'to'
): [number, number];

// For obstacle clearance (what to block)
function getBlockedZone(
  shapeBounds: AABB,
  strokeWidth: number
): AABB;
```

### 4.4 A* Modifications

**Current:**
```typescript
const startNode: AStarNode = {
  arrivalDir: null,  // No seeding
};

// Neighbor loop doesn't consider goal approach direction
```

**New:**
```typescript
const startNode: AStarNode = {
  arrivalDir: ctx.forceFirstDir ? ctx.preferredFirstDir : null,
};

// In neighbor loop, when evaluating goal cell:
if (isGoalCell(neighbor)) {
  const desiredApproach = oppositeDir(ctx.to.outwardDir);
  if (moveDir !== desiredApproach) {
    cost += COST_CONFIG.APPROACH_MISMATCH_PENALTY;
  }
}

// First move gets preference bonus (not forced)
if (current === startNode && ctx.preferredFirstDir) {
  if (moveDir === ctx.preferredFirstDir) {
    cost -= COST_CONFIG.FIRST_DIR_BONUS;
  }
}
```

### 4.5 Grid Line Strategy

**Current (simplified):**
```
xLines: [from.x, fromJetty.x, toJetty.x, to.x, padding bounds, midpoint]
yLines: [from.y, fromJetty.y, toJetty.y, to.y, padding bounds, midpoint]
```

**New (obstacle-aware):**
```typescript
function buildGrid(ctx: RoutingContext): Grid {
  // 1. Actual endpoint positions (always)
  xLines.push(ctx.from.position[0], ctx.to.position[0]);
  yLines.push(ctx.from.position[1], ctx.to.position[1]);

  // 2. Obstacle boundaries (always)
  if (ctx.to.shapeBounds) {
    const { x, y, w, h } = ctx.to.shapeBounds;
    const offset = ctx.toOffset;

    // Padding boundaries
    xLines.push(x - offset, x + w + offset);
    yLines.push(y - offset, y + h + offset);

    // Obstacle center (for routing "through the middle")
    xLines.push(x + w / 2);
    yLines.push(y + h / 2);
  }

  // 3. Escape corridors for padding zone starts
  if (ctx.fromInPadding && ctx.to.shapeBounds) {
    addEscapeCorridorLines(xLines, yLines, ctx);
  }

  // 4. Approach corridors (based on scenario)
  addApproachCorridorLines(xLines, yLines, ctx);

  // 5. Midpoints for Z-flexibility (but obstacle-aware)
  const midpoint = computeObstacleAwareMidpoint(ctx);
  xLines.push(midpoint[0]);
  yLines.push(midpoint[1]);
}
```

---

## 5. Implementation Strategy

### Phase 2A: Fix Critical Routing Bugs (S1, O1)

**Goal:** Correct routes without major architecture changes.

1. **Add goal-approach penalty to A***
   - Modify `computeMoveCost` to penalize approaches to goal that don't match `oppositeDir(to.outwardDir)`
   - ~20 lines change in `routing-astar.ts`

2. **Add obstacle center lines to grid**
   - Add `x + w/2` and `y + h/2` lines for obstacle
   - ~5 lines change in `routing-grid.ts`

3. **Fix `computeFromOutwardDirOnSnap` for same-side**
   - When start is in same-side padding, return outward direction (not perpendicular)
   - Currently returns `'N'` for N-side, which is correct for same-side
   - Verify and test edge cases

### Phase 2B: Unify Offset Handling (Z1, J1)

**Goal:** Eliminate jetty confusion, balance Z-routes.

1. **Create `RoutingContext` builder**
   - Single function that computes all context up front
   - Replaces scattered jetty calculations

2. **Fix Z-route midpoint calculation**
   - Use actual positions for midpoint, not jetty positions
   - Add offset waypoints after midpoint calculation

3. **Document coordinate semantics (G1)**
   - Clear comments explaining X/Y line strategy

### Phase 2C: Dynamic Close-Mode Handling (T1)

**Goal:** Graceful degradation for tight scenarios.

1. **Add proximity detection**
   - Compute mode before routing
   - Pass to router as context

2. **Implement close-mode simplifications**
   - Reduced corner radius
   - Direct paths when no room for turns

3. **Implement overlapping-mode fallback**
   - Straight line with arrow clipping
   - Or hide connector entirely

### Phase 2D: Optional Direction Hints (D1)

**Goal:** Visual consistency for anchored starts without creating traps.

1. **Add `preferredFirstDir` to A* options**
   - Soft bonus, not hard constraint
   - Only applied to first move from start

2. **Determine when to use hints**
   - Anchored starts outside padding → stronger hint
   - Anchored starts inside padding → weaker hint or none

---

## 6. Edge Cases & Dynamic Fallbacks

### 6.1 Proximity Cases

| Distance | Mode | Strategy |
|----------|------|----------|
| `> offset * 2` | Normal | Full routing with all offsets |
| `offset * 0.5 - offset * 2` | Close | Reduced corner radius, simplified turns |
| `< offset * 0.5` | Overlapping | Direct line, clipped arrow |

### 6.2 Same-Side Cases

| Start Position | Goal Side | Route Shape | Notes |
|----------------|-----------|-------------|-------|
| Above N-side padding | N | `→ ↓ → ↑` (4 seg) | Standard U-turn |
| Inside N-side padding | N | `↑ → ↓` (3 seg) | Escape first |
| Very close to N anchor | N | `→ ↓` (2 seg) | Reduced radius |
| Overlapping N anchor | N | `→` (direct) | Clipped |

### 6.3 Opposite-Side Cases

| Start Position | Goal Side | Route Shape | Notes |
|----------------|-----------|-------------|-------|
| Above N-side padding | S | `→ ↓ ←` or `← ↓ →` | Choose shorter horizontal |
| Inside N-side padding | S | Escape to side, then around | Obstacle-aware |

### 6.4 Adjacent-Side Cases

| Start Position | Goal Side | Route Shape | Notes |
|----------------|-----------|-------------|-------|
| Above shape | E | `→ ↓ →` (L-turn) | Usually works |
| Inside N-side padding | E | May need escape first | Depends on exact position |

---

## 7. File Changes Summary

### 7.1 Phase 2A (Critical Fixes)

| File | Changes |
|------|---------|
| `routing-astar.ts` | Add goal-approach penalty (~20 lines) |
| `routing-grid.ts` | Add obstacle center lines (~5 lines) |
| `ConnectorTool.ts` | Verify same-side direction logic |

### 7.2 Phase 2B (Unify Offsets)

| File | Changes |
|------|---------|
| `constants.ts` | Add `RoutingContext` type and builder |
| `routing-zroute.ts` | Use actual positions for midpoint |
| `routing-grid.ts` | Extensive refactor for new context |
| `routing-astar.ts` | Use context instead of terminals |

### 7.3 Phase 2C (Close Mode)

| File | Changes |
|------|---------|
| `constants.ts` | Add proximity mode types and helpers |
| `routing.ts` | Add proximity mode branching |
| `routing-astar.ts` | Handle close-mode constraints |

### 7.4 Phase 2D (Direction Hints)

| File | Changes |
|------|---------|
| `routing-astar.ts` | Add AStarOptions, first-dir bonus |
| `routing.ts` | Compute and pass hints to A* |

---

## Appendix A: Visual Summary of Fixes

### Before (Current Issues)

```
Issue S1: Same-side takes wrong route
  ● Start (in N padding)
    │
    └─→─┬───────────────┐          4 turns: → ↓ → (goal)
        ↓               │          A* doesn't count final ↑
        └───────────────┘●

Issue O1: Opposite-side takes long route
  ● Start (in N padding, x=120)
    │
    └──→─┬───────────────────┐     Goes EAST (farther)
         ↓                   │     instead of WEST (closer)
         └───────────────────┴●
```

### After (Proposed Fixes)

```
Fix S1: Final segment in cost calculation
  ● Start (in N padding)
    ↑
    └─────┬───────────────┐        3 turns: ↑ → ↓
          ↓               │        A* includes approach penalty
          └───────────────┘●

Fix O1: Obstacle-aware grid lines
  ● Start (x=120)
    │
    └←───┬───────────────┐         Goes WEST (toward goal.x)
         ↓               │         Center line provides path
         └───────────────┴●
```

---

*End of Phase 2 Proposal*
