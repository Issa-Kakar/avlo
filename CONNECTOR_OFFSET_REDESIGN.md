# Connector Offset Redesign - Fundamental Fix

**Date:** 2024-12-26
**Status:** ✅ IMPLEMENTED (end caps working, start caps TODO)
**Purpose:** Complete redesign of connector routing offsets to properly account for arc corners AND arrow heads in path geometry.

---

## Executive Summary for Next Agent

### What Was Done
- Made routing offsets **dynamic based on strokeWidth**
- Introduced `MIN_STRAIGHT_SEGMENT_W = 8` to guarantee a straight segment between arc and arrow
- StrokeWidth now flows through the entire routing pipeline
- End arrow caps now render correctly with smooth arc → straight → arrow transition

### What Still Needs Work
- **Start caps**: The `from` terminal needs the same offset treatment for `startCap = 'arrow'`
- The rendering in `connector-preview.ts` currently only trims for `endCap`, not `startCap`
- The jetty for `from` should also use `computeApproachOffset()` when `from` has an arrow cap

### Key Files
- `constants.ts` - `computeApproachOffset(strokeWidth)`, `MIN_STRAIGHT_SEGMENT_W`
- `routing-*.ts` - All accept strokeWidth parameter now
- `ConnectorTool.ts` - Passes `frozenWidth` to routing
- `connector-preview.ts` - Trims polyline for end arrow (start arrow TODO)

---

## The Fundamental Problem

The previous implementation treated the arc-arrow overlap as a **rendering concern**. This is fundamentally wrong. **The path POINTS themselves were incorrect.** No amount of rendering tricks can fix geometry that doesn't have room for the arc and arrow to coexist.

### The Visual Symptom
The polyline arc was curving directly into the **side** of the arrow head, not smoothly into its center. This happened because:
1. The stroked arc has width - its outer edge "swings" wider than the centerline
2. There was no straight segment for the stroke to "straighten out" before the arrow
3. The arc's end tangent point was too close to the arrow base

---

## Why It Was Broken

### Original Constants (Before Any Fixes)
```
JETTY_W = 28           (toJetty distance from shape)
CORNER_RADIUS_W = 22   (arc radius)
arrowLength = 10-24    (depends on strokeWidth)
```

### The Geometry Math
For perpendicular approach, the final segment is `JETTY_W` units long:
```
|←────────── 28 units (JETTY_W) ──────────→|
|←── arc (22) ──→|←── remaining (6) ──→|
                 |←── arrow (10+) ────→| OVERFLOW!
```

The arc consumed 22 of the 28 units, leaving only 6 units for the arrow. But arrows are 10+ units long!

### After User's First Fix (ARROW_SAFE_OFFSET_W = 44)
```
|←────────────── 44 units ───────────────→|
|←── arc (22) ──→|←── remaining (22) ───→|
                 |←── arrow (10-20) ─────→|

Straight segment = 22 - arrowLength
- strokeWidth 2: 22 - 10 = 12 units ✓
- strokeWidth 4: 22 - 16 = 6 units  (barely visible)
- strokeWidth 5: 22 - 20 = 2 units  (almost none!)
- strokeWidth 6: 22 - 24 = -2 units (OVERLAP!)
```

The fixed 44 offset worked for thin strokes but broke for thick strokes.

---

## The Complete Fix

### New Formula
```typescript
approachOffset(strokeWidth) = CORNER_RADIUS_W + MIN_STRAIGHT_SEGMENT_W + arrowLength(strokeWidth)
                            = 22 + 8 + max(10, strokeWidth × 4)
```

### What Each Component Does

| Component | Value | Purpose |
|-----------|-------|---------|
| `CORNER_RADIUS_W` | 22 | Space consumed by the arcTo corner |
| `MIN_STRAIGHT_SEGMENT_W` | 8 | **THE KEY FIX** - Guaranteed straight segment for stroke to align before arrow |
| `arrowLength(strokeWidth)` | 10-24 | Space for the actual arrow head |

### Result by Stroke Width

| strokeWidth | arrowLength | approachOffset | Straight Segment |
|-------------|-------------|----------------|------------------|
| 2           | 10          | 40             | 8 units ✓        |
| 3           | 12          | 42             | 8 units ✓        |
| 4           | 16          | 46             | 8 units ✓        |
| 5           | 20          | 50             | 8 units ✓        |
| 6           | 24          | 54             | 8 units ✓        |

**The straight segment is now ALWAYS 8 units**, regardless of stroke width!

---

## What Was Actually Changed

### 1. constants.ts

**Removed:**
- `JETTY_W` (was fixed at 28, then 44)
- `ARROW_SAFE_OFFSET_W` (was fixed at 22, then 44)

**Added:**
```typescript
// Minimum straight segment before arrow (stroke straightens here)
MIN_STRAIGHT_SEGMENT_W: 8,

// Dynamic offset function
export function computeApproachOffset(strokeWidth: number): number {
  const arrowLength = computeArrowLength(strokeWidth);
  return (
    ROUTING_CONFIG.CORNER_RADIUS_W +
    ROUTING_CONFIG.MIN_STRAIGHT_SEGMENT_W +
    arrowLength
  );
}
```

### 2. routing-zroute.ts

```typescript
// Before
function computeJettyPoint(terminal: Terminal): [number, number] {
  return terminal.position + outwardVector * ROUTING_CONFIG.JETTY_W;
}

export function computeZRoute(from, to): RouteResult { ... }

// After
function computeJettyPoint(terminal: Terminal, strokeWidth: number): [number, number] {
  const offset = computeApproachOffset(strokeWidth);
  return terminal.position + outwardVector * offset;
}

export function computeZRoute(from, to, strokeWidth: number): RouteResult { ... }
```

### 3. routing-astar.ts

Same pattern - `computeJettyPoint()` and `computeAStarRoute()` now accept strokeWidth.

### 4. routing-grid.ts

```typescript
// Before
function buildNonUniformGrid(from, to, fromJetty, toJetty): Grid {
  const padding = ROUTING_CONFIG.ARROW_SAFE_OFFSET_W;  // Fixed 44
  ...
}

// After
function buildNonUniformGrid(from, to, fromJetty, toJetty, strokeWidth: number): Grid {
  const approachOffset = computeApproachOffset(strokeWidth);  // Dynamic
  ...
}
```

### 5. routing.ts

```typescript
// Before
export function computeRoute(from, to, prevSignature): RouteResult { ... }

// After
export function computeRoute(from, to, prevSignature, strokeWidth: number): RouteResult { ... }
```

### 6. ConnectorTool.ts

```typescript
// Before
const result = computeRoute(from, to, this.prevRouteSignature);

// After
const result = computeRoute(from, to, this.prevRouteSignature, this.frozenWidth);
```

---

## Visual Comparison

### Before Fix
```
Arc ends here, immediately into arrow:

    ─────────────────────╮▶ tip
                          ↑
                    arc curves directly
                    into arrow SIDE
```

### After Fix
```
Arc ends, then straight segment, then arrow:

    ─────────────────────╮────────▶ tip
                          │        │
                          │   8    │ arrow
                       arc ends  straight
                       here     segment
```

The 8-unit straight segment lets the stroked arc "straighten out" before the arrow, so the visual flows smoothly into the arrow's CENTER, not its side.

---

## Remaining Work: Start Caps

The current implementation only handles `endCap = 'arrow'`. For `startCap = 'arrow'`:

1. **Routing**: The `from` terminal's jetty should also use `computeApproachOffset()` when `from` has an arrow cap (currently it uses the same offset regardless)

2. **Rendering**: `connector-preview.ts` needs to trim the START of the polyline for `startCap = 'arrow'`, not just the end

3. **computeEndTrim**: Already supports `position: 'start' | 'end'`, but `drawConnectorPreview()` only calls it for `endCap`

### Quick Fix for Start Caps
```typescript
// In drawConnectorPreview():
const startTrim = startCap === 'arrow' ? computeEndTrim(points, width, 'start') : null;
const endTrim = endCap === 'arrow' ? computeEndTrim(points, width, 'end') : null;

// Then modify drawRoundedPolyline to accept both trims
drawRoundedPolyline(ctx, points, color, width, startTrim, endTrim);
```

---

## Why Each Part Mattered

### Q: Was it the MIN_STRAIGHT_SEGMENT that fixed it?
**Partially.** This introduced an explicit, guaranteed straight segment. Before, the straight segment was implicit and variable (whatever was left after arc and arrow).

### Q: Was it strokeWidth being accounted for?
**Critical.** The fixed 44 offset broke for thick strokes (strokeWidth 5+). Dynamic offset ensures the math works for ALL stroke widths.

### Q: Was it the corner radius accounting?
**Already there.** The corner radius was always 22, and the rendering already accounted for it in `computeEndTrim()`. The issue was the ROUTING didn't leave enough room.

### Q: All together?
**YES.** The fix required:
1. **MIN_STRAIGHT_SEGMENT_W** - Explicit guarantee of straight segment
2. **Dynamic offset** - Scales with strokeWidth so thick strokes work
3. **strokeWidth through pipeline** - Routing needs to know stroke size to compute correct offset

The formula `cornerRadius + minStraight + arrowLength` ties all three together into a single, mathematically correct offset.

---

## Key Insight

**The path points ARE the geometry. Get them right first. Rendering follows.**

The previous approach tried to fix geometry problems with rendering tricks (trimming, arc-aware calculations). But if the route points don't leave enough space, no amount of rendering cleverness can fix it.

The correct approach:
1. Compute how much space is needed: `arc + straight + arrow`
2. Make sure routing creates points with that much space
3. Rendering just draws what's there

---

*End of Redesign Document*
