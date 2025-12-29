# Connector Routing: Padding Zone Architecture Redesign

**Date:** 2024-12-27
**Status:** Analysis Complete - Ready for Implementation Planning
**Related:** CONNECTOR_ROUTING_REDESIGN.md, CONNECTOR_OFFSET_REDESIGN.md

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Original Problem](#2-the-original-problem)
3. [Root Cause: Architectural Mismatch](#3-root-cause-architectural-mismatch)
4. [Key Insights](#4-key-insights)
5. [The Simplified Architecture](#5-the-simplified-architecture)
6. [Edge Cases & Remaining Complexity](#6-edge-cases--remaining-complexity)
7. [Open Questions for Implementation](#7-open-questions-for-implementation)

---

## 1. Executive Summary

### What Changed
The offset redesign introduced a **padding zone** around shapes (~38-52 world units) that routes cannot pass through:
```
approachOffset = CORNER_RADIUS_W + MIN_STRAIGHT_SEGMENT_W + arrowLength
               = 22 + 6 + max(10, strokeWidth × 4)
```

### The Original Symptoms
1. **Frequent straight-line fallbacks** - A* fails to find path
2. **Visual glitches ("spider" rendering)** - Invalid path geometry
3. **Wrong routes on same-side approach** - Suboptimal paths
4. **Trapped in padding zone** - Direction seeding + U-turn prevention creates dead ends

### The Deeper Problem
The symptoms revealed fundamental architectural issues:
- **Direction seeding was never necessary** - A heuristic that created more problems than it solved
- **Jetty concept is redundant** - The padding boundary already serves this purpose
- **Grid structure should BE the constraint** - Not blocking + direction rules
- **Current architecture doesn't scale** - Future features (shape dragging, bidirectional arrows) will break it further

### The Solution Direction
Let the grid structure itself enforce valid routing. Remove artificial constraints (direction seeding, U-turn prevention). Simplify the jetty concept to cap-aware offsets only.

---

## 2. The Original Problem

### 2.1 Padding Zone Trapping

When starting INSIDE the padding zone (but outside the shape), the computed direction may point INTO blocked cells:

```
Start in padding zone, seed direction 'W':

     ╔════════════════════════╗
     ║ ✗ ✗ ✗ ✗ ✗ ✗ ✗ ✗ ✗ ✗  ║
     ║ ✗ ┌──────────────┐ ✗  ║
     ║ ✗ │              │ ●→ ║  Seeded direction 'W'
     ║ ✗ │    Shape     │    ║  Can't go W (blocked)
     ║ ✗ └──────────────┘ ✗  ║  Can't go E (U-turn blocked)
     ║ ✗ ✗ ✗ ✗↑✗ ✗ ✗ ✗ ✗ ✗  ║  N/S also blocked
     ║       goal            ║  → FALLBACK to straight line
     ╚════════════════════════╝
```

### 2.2 Axis-Aligned Trapping

Even when starting OUTSIDE the direct padding zone, if aligned on one axis with the padding, the same problem occurs:

```
Start (X-aligned with E side padding, way above shape)
     │
     │  ← computeFromOutwardDirOnSnap says "go down"
     │     but that direction passes through padding zone!
     │
     ╔═══════════════════════╗
     ║  ┌────────────────┐   ║
     ║  │                │   ║
     ║  │     Shape      │●──║── Snap to E side
     ║  │                │   ║
     ║  └────────────────┘   ║
     ╚═══════════════════════╝
```

The heuristic in `computeFromOutwardDirOnSnap` doesn't know about the padding zone, so it computes directions that lead to blocked paths.

---

## 3. Root Cause: Architectural Mismatch

### 3.1 Direction Seeding Was a Hack

The direction seeding in A* was meant to make routes "prefer" continuing in the jetty direction:

```typescript
const startNode = {
  arrivalDir: fromOutwardDir,  // SEED - pretend we arrived from this direction
};
```

But this creates two problems:
1. **The seeded direction may point at blocked cells** - No escape route
2. **U-turn prevention blocks the escape** - Can't go opposite of seeded direction

**The deeper issue:** We're trying to control A*'s behavior with artificial constraints, rather than letting the search space naturally guide it.

### 3.2 The Jetty Concept is Over-Applied

Currently, BOTH endpoints use full approach offset for jetty computation:
```typescript
const offset = computeApproachOffset(strokeWidth);  // Always 38-52 units
const jetty = position + outwardVector * offset;
```

**But this doesn't make sense for all cases:**

| Endpoint | Has Arrow? | Snapped? | Why Offset? |
|----------|------------|----------|-------------|
| from | No (startCap=none) | No | ❌ No reason |
| from | No | Yes | Maybe corner radius for clean exit |
| from | Yes (startCap=arrow) | Yes | ✓ Arc + straight + arrow |
| to | Yes (endCap=arrow) | Yes | ✓ Arc + straight + arrow |
| to | No | Yes | Maybe corner radius |

The full offset exists for arc + straight + arrow spacing. Without an arrow, why apply it?

### 3.3 Grid Lines Inside Blocking Zone

The current grid adds lines at:
```typescript
// Inner boundaries (shape edge)
xLines.push(x, x + w);
yLines.push(y, y + h);

// Outer boundaries (padded)
xLines.push(x - approachOffset, x + w + approachOffset);
```

This creates grid cells INSIDE the padding zone, which we then block. But **why create cells we're going to block?**

### 3.4 The Final Segment Isn't Part of A*

The path A* finds is: `fromJetty → [cells] → toJetty`

The segments `from.position → fromJetty` and `toJetty → to.position` are prepended/appended afterward. A* doesn't count turns at the jetties.

Direction seeding was trying to compensate: "pretend there's a turn at fromJetty so A* accounts for it." But this is indirect and fragile.

---

## 4. Key Insights

### 4.1 The Grid Structure Should BE the Constraint

**Current approach:** Add grid lines everywhere, then block invalid positions, then seed directions, then prevent U-turns.

**Better approach:** Only add grid lines where routes can actually go. Then:
- No cells to block (they don't exist)
- No direction seeding needed (only valid directions have neighbors)
- No U-turn prevention needed (grid structure prevents invalid paths)

### 4.2 Snapped Endpoints Only Need One Axis

For a **West side snap**:
- The exit direction is FORCED to be West
- We only need an **x-line** at that snap position
- The y-position is determined by the snap's `t` parameter
- No y-line needed - movement from that position is horizontal only

```
West snap at y=100:
- Add x-line at x = shape.x (the snap point)
- The path MUST go West from there
- No ambiguity, no seeding needed
```

This generalizes:
| Snap Side | Required Axis | Exit Direction |
|-----------|---------------|----------------|
| N | y-line at shape.y | North (up) |
| S | y-line at shape.y + h | South (down) |
| E | x-line at shape.x + w | East (right) |
| W | x-line at shape.x | West (left) |

### 4.3 Non-Snapped Endpoints Need Both Axes

For a **free endpoint** (not snapped to shape):
- Can approach from any direction
- Need BOTH x-line and y-line at that position
- If the position is within a padding zone, blocking prevents pass-through

### 4.4 Padding Boundary Lines ARE the "Jetty"

The current jetty is: `position + outwardVector * approachOffset`

But that's essentially the same as the padding boundary line! For a West snap:
- Snap position: `shape.x`
- Jetty position: `shape.x - approachOffset`
- Padding boundary: `shape.x - approachOffset`

The jetty concept dissolves into the grid structure. The padding boundary IS the first waypoint outside the shape.

### 4.5 Blocking is Still Needed (But Minimal)

Without blocking, a path could "cut through" the padding zone:

```
Start ● (x in padding zone, y above)
       │
       ↓ ← Without blocking, could go straight down
       │
     ╔═│════════════════════╗
     ║ │ ┌──────────────┐   ║
     ║ ↓ │              │   ║  ← This path violates padding!
     ║   │    Shape     │●──║
     ║   └──────────────┘   ║
     ╚══════════════════════╝
```

**Solution:** Block cells inside the padding zone, BUT:
- Special-case endpoint positions (never block start/goal)
- This forces paths to escape to padding boundary before continuing

### 4.6 Direction Seeding Has No Benefit

**Q: Is there ANY gain from direction seeding?**

**A: No.** The original intent was to prefer paths continuing in the jetty direction. But:
1. We don't count the from → fromJetty segment as a turn anyway
2. The Manhattan heuristic + bend penalty already prefer direct paths
3. The seeding creates traps when the seeded direction is blocked
4. With proper grid structure, valid directions are self-evident

### 4.7 This Architecture Supports Future Features

**Shape dragging with attached connectors:**
- The TO endpoint will move as the shape moves
- Current architecture assumes TO direction is stable
- New architecture: direction emerges from grid structure, updates naturally

**Bidirectional arrows (startCap = 'arrow'):**
- FROM endpoint needs the same offset treatment as TO
- Current: only TO gets proper offset consideration
- New: cap-aware offsets apply to both endpoints

---

## 5. The Simplified Architecture

### 5.1 Grid Line Philosophy

**Core principle:** Grid lines exist only at positions where routing is valid.

For the **target shape** (to.shapeBounds):
```
Padding boundary lines only:
- x = shape.x - approachOffset
- x = shape.x + w + approachOffset
- y = shape.y - approachOffset
- y = shape.y + h + approachOffset
```

For the **snap position** (to.position):
- Add ONLY the axis perpendicular to snap side
- E/W snap → add x-line at snap position
- N/S snap → add y-line at snap position

For **non-snapped endpoints** (from.position when from.kind = 'world'):
- Add both x-line and y-line
- These may be inside padding zone (handled by blocking)

For **routing flexibility**:
- Midpoints between endpoints
- Maybe quarter-points for complex scenarios

### 5.2 Anchored vs Non-Anchored Endpoints

The grid structure depends on whether an endpoint is **anchored** (snapped to a shape), NOT on whether it has an arrow cap:

**Anchored endpoint (snapped to shape):**
- Single axis line only (perpendicular to snap side)
- Padding offset automatically applied (it's the shape's padding boundary)
- Exit direction is deterministic (outward from shape)

**Non-anchored endpoint (free in world):**
- Both x-line AND y-line needed
- Can approach from any direction
- No padding offset (unless within another shape's padding zone)

The key insight: **the padding boundary around the shape IS the "jetty"**. When anchored, the first waypoint is naturally the padding boundary. No separate jetty calculation needed - they're unified.

| Endpoint | Anchored? | Grid Lines | First Segment |
|----------|-----------|------------|---------------|
| from (snapped) | Yes | Single axis (⊥ to side) | Forced outward |
| from (free) | No | Both x and y | Any direction |
| to (snapped) | Yes | Single axis (⊥ to side) | Forced inward |
| to (free) | No | Both x and y | Any direction |

Arrow caps affect the SIZE of the offset (arrowLength in the formula), but the grid STRUCTURE is determined by anchoring.

### 5.3 Blocking Strategy

**Block:** Cells strictly inside the padded shape bounds
**Never block:** Endpoint positions (start and goal cells)
**Don't create:** Cells at shape edge (no inner boundary lines)

### 5.4 A* Simplifications

**Remove:**
- Direction seeding (arrivalDir starts as null)
- U-turn prevention (no infinite cost for opposite direction)
- Jetty-based start position (start from actual endpoint)
- Short segment penalty (not needed - grid structure prevents stair-stepping)
- Continuation bonus (didn't solve the actual problem - see below)

**Keep:**
- Bend penalty (discourages unnecessary turns)
- Manhattan heuristic (guides toward goal)

**The "Even Z-Route" Problem (Future):**
The continuation bonus was attempting to solve a different problem: preferring "balanced" Z-routes where turns happen at midpoints rather than close to the shape. The real solutions are:
- A) Calculate euclidean distance of each segment, prefer longer ones
- B) Add explicit midpoint bonus (prefer turns at the halfway point)
- C) Use inferDragDirection to determine if Z-route matches approach direction

This is a separate optimization from the core routing fix.

### 5.5 Path Assembly

**Current:** `[from.pos, fromJetty, ...A*path..., toJetty, to.pos]`

**New:** `[from.pos, ...A*path..., to.pos]`

The A* path goes from actual start to actual goal. The padding boundaries are waypoints that A* discovers naturally.

---

## 6. Edge Cases & Remaining Complexity

### 6.1 Start Position Within Padding Zone

If from.position is inside the padding zone of the target shape:
- The from.position cell is NOT blocked (special case)
- Adjacent cells in the padding zone ARE blocked
- A* must "escape" to the padding boundary first
- This happens naturally - the boundary is the only valid neighbor 

### 6.2 Start Position Axis-Aligned with Padding Zone

If from.position.x is within the E-side padding zone but from.position.y is above the shape:

```
Start ● (x in E-padding, y above)
       │
       │ ← y-line at from.y creates cells in padding zone
       │
     ╔═│════════════════════╗
     ║ │ ┌──────────────┐   ║
     ║ ? │              │   ║  ← Cell at (from.x, shape.y) is blocked
     ║   │    Shape     │●──║
     ║   └──────────────┘   ║
     ╚══════════════════════╝
```

**Resolution:** Blocking handles this. The cell at the intersection is blocked, so A* can't path straight down. It must go to the padding boundary first.

### 6.3 Self-Connection (from.shapeBounds = to.shapeBounds)

When connecting a shape to itself:
- Both endpoints have the same padding zone
- Grid must account for this
- Special handling likely needed

### 6.4 Multiple Obstacles

Currently only to.shapeBounds is considered. For full connector routing:
- All shapes in the path should be obstacles
- Grid lines at all padding boundaries
- Blocking for all padding zones

This is a future enhancement, not required for the current fix.

### 6.5 L-Route vs Z-Route Selection

Currently, with high bend penalty, L-routes (1 bend) almost always win over Z-routes (2 bends).

**When Z-routes might be preferred:**
- When the start's approach direction matches the Z-route's first segment direction
- Use `inferDragDirection` during freehand drag to detect this
- If dominant axis of drag matches what a Z-route would naturally do, allow Z-route

**Example:**
```
Start ● approaching from the right
       ↓ (drag direction inferred as 'W')

       ┌──────────────┐
       │              │
       │    Shape     │●── Snap to E side
       └──────────────┘
```

If Z-route would be HVH (horizontal first), and we're "coming from" horizontally (drag dir = W), the Z-route's first segment aligns with our approach. Prefer Z-route.

If Z-route would be VHV (vertical first), but we're anchored to TOP (which wants vertical exit anyway), L-route is natural. Prefer L-route.

**Implementation approach:**
- Check if inferred drag direction matches the axis of a potential Z-route first segment
- If match: reduce or remove bend penalty for that Z-route
- If mismatch: keep full bend penalty, L-route wins

### 6.6 Adjacent Side Connections (Reduced Padding)

When connecting from within the padded bounds to an **adjacent** side (not same side, not opposite side):

```
Start ● (within N-side padding)
       │
       ↓
       ┌──────────────┐
       │              │
       │    Shape     │●── Snap to E side (adjacent to N)
       └──────────────┘
```

Currently: We pad ALL sides, blocking the path through the N-side padding.

**Optimization insight:** If we're routing to an ADJACENT side:
- We only need padding on the TARGET side (for arc + arrow)
- We DON'T necessarily need full corner padding
- As long as the route clears the arc + arrow zone on the target side

**Same side = U-turn:** Full padding needed around the corner.

**Adjacent side = L-turn:** May not need ALL corners padded. If we can go straight to the target side's offset, and clear the arrow (which may hang off the shape slightly), we can allow the route.

**Opposite side = Straight-ish:** Route around one side, may need that side's padding but not all.

This is an optimization for padding violation scenarios - when the start is INSIDE the padding zone but the route doesn't actually USE all the padded corners.

**Implementation approach (future):**
- Detect which side we're snapped to
- Detect which side/corner the start position is near
- If adjacent sides: only block the target side's padding corridor
- If same side: full corner blocking needed
- If opposite side: block the side we're routing around

---

## 7. Open Questions for Implementation

### 7.1 Exact Grid Line Strategy

Should we:
- A) Keep shape edge lines but don't block them (only block interior)?
- B) Remove shape edge lines entirely (only padding boundaries)?
- C) Something else?

Impacts: Cell count, blocking complexity, path smoothness.

### 7.2 Handling the "Pass-Through" Problem

When from.position is  near axis-aligned with padding:
- A) Block cells along that axis inside padding zone ✓
- B) Don't add from.position line if it's inside padding zone
- C) Clip from.position line to exclude padding zone

Current thinking: Option A is simplest - blocking handles it.

### 7.3 Cap-Aware Offset Implementation

Where should cap-awareness live?
- A) In `computeApproachOffset(strokeWidth, hasCap)`
- B) Separate functions for arrow vs non-arrow
- C) In the grid construction logic

### 7.4 Preserving Backward Compatibility

Existing connectors have waypoints computed with old logic:
- Should we re-route them on load?
- Or keep waypoints as-is and only affect new connectors?

### 7.5 Testing Strategy

Key scenarios to verify:
1. Start outside padding → clean L or Z route
2. Start inside padding → escapes correctly
3. Start axis-aligned with padding → doesn't pass through
4. Head-on approach → straight line (no unnecessary bends)
5. Perpendicular approach → clean arc at corner
6. Shape-to-shape connection → works bidirectionally

---

## Appendix A: Visual Summary

### Before (Complex, Fragile)

```
┌─────────────────────────────────────────────────┐
│ computeFromOutwardDirOnSnap() - Heuristic guess │
│              ↓                                  │
│ Direction Seeding - Force initial direction    │
│              ↓                                  │
│ U-Turn Prevention - Block opposite direction   │
│              ↓                                  │
│ Blocking - Mark cells inside padding           │
│              ↓                                  │
│ A* Search - Often fails, falls back            │
│              ↓                                  │
│ Straight line fallback - Visual bug            │
└─────────────────────────────────────────────────┘
```

### After (Simple, Robust)

```
┌─────────────────────────────────────────────────┐
│ Grid Construction                               │
│  - Lines at endpoints + padding boundaries      │
│  - Block only padding zone interior             │
│  - Cap-aware offsets                            │
│              ↓                                  │
│ A* Search                                       │
│  - No seeding, no U-turn prevention             │
│  - Start from actual position                   │
│  - Bend penalty guides clean routes             │
│              ↓                                  │
│ Valid path (grid structure guarantees it)       │
└─────────────────────────────────────────────────┘
```

---

## Appendix B: The Jetty Dissolution

**Old mental model:**
```
from.pos ──jetty──┐
                  │
                  ├── A* path ──┐
                                │
                   to.pos ──jetty
```

The jetty was a "stub" extending from the endpoint. A* routed between jetties.

**New mental model:**
```
from.pos ──┬── A* finds path to padding boundary
           │
           ├── A* routes along/around padding
           │
to.pos ────┴── A* approached via padding boundary
```

The "jetty" is just the padding boundary. A* discovers it naturally as the first/last waypoint outside the blocked zone.

---

*End of Analysis Document*
