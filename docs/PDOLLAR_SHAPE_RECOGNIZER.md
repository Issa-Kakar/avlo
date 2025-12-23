# $P Point-Cloud Shape Recognizer

## Overview

This document provides comprehensive documentation for the $P point-cloud shape recognition system used in the hold-detected perfect shape feature. After a 600ms dwell (hold), the system attempts to recognize if the user drew a circle, box (rectangle), or diamond, and snaps to a perfect version.

**Primary File:** `client/src/lib/geometry/pdollar-recognizer.ts`

---

## The $P Algorithm (Core Theory)

### What is $P?

$P (Dollar P) is a gesture recognition algorithm from the paper:
> Vatavu, R-D., Anthony, L., & Wobbrock, J.O. (2012). "Gestures as Point Clouds"

It treats gestures as **unordered point clouds** and uses **greedy nearest-neighbor matching** with weighted distances.

### Why $P Over Parametric Fitting?

| Approach | Problem |
|----------|---------|
| Parametric (circle fit, AABB fit) | Brittle with multiple shape-specific heuristics |
| Feature engineering (corners, edges) | Unstable across zoom/scale, 15+ tunable parameters |
| $P | Single normalized space, ~3 tunable parameters |

### The Normalization Pipeline (Critical!)

All points (candidate AND templates) go through this exact pipeline:

```
Raw Points → Resample → Scale to Unit → Translate to Origin → Normalized Point Cloud
```

1. **Resample to N points** (N=32): Evenly-spaced points along path length
2. **Scale to Unit**: Divide by `max(width, height)` - **PRESERVES ASPECT RATIO**
3. **Translate to Origin**: Centroid at (0,0)

This makes matching:
- Scale-invariant (any size drawing)
- Position-invariant (anywhere on canvas)
- **Aspect-ratio-aware** (preserves width/height proportions)

### The Matching Metric

```typescript
// Greedy weighted matching (from $P paper)
for each point i in candidate:
    find closest unmatched template point j
    sum += weight[i] * sqrDist(candidate[i], template[j])
    weight decreases from n to 1 (early points matter more)
```

Try multiple starting points and both directions (candidate→template and template→candidate), take minimum.

**Result:** A single scalar "distance" where **lower is better**.

---

## Current Implementation Status

### File Structure

```
client/src/lib/geometry/
├── pdollar-recognizer.ts      # NEW: $P implementation (primary)
├── recognize-open-stroke.ts   # LEGACY: Parametric fitting (unused by hold detector)
├── geometry-helpers.ts        # Corner/edge detection, side coverage
├── fit-circle.ts              # Circle least-squares fit
├── fit-aabb.ts                # AABB rectangle fit
├── score.ts                   # Scoring functions
├── shape-params.ts            # Tunable parameters
└── types.ts                   # Vec2, Edge, Corner types
```

### Integration Point

**File:** `client/src/lib/tools/DrawingTool.ts`

```typescript
// Lines 381-448: Hold detector callback
private onHoldFire(): void {
  const result = recognizePerfectShapePointCloud(this.state.points);

  if (!result || result.ambiguous) {
    // Continue freehand
    return;
  }

  switch (result.best.kind) {
    case 'circle': this.snap = { kind: 'circle', anchors: { center } }; break;
    case 'box': this.snap = { kind: 'box', anchors: { cx, cy, hx0, hy0 } }; break;
    case 'diamond': this.snap = { kind: 'diamondHold', anchors: { cx, cy, hx0, hy0 } }; break;
  }
}
```

---

## Template System

### Template Counts (Current)

| Shape   | Ratios | Variants | Total   |
|---------|--------|----------|---------|
| Box     | 23     | 5        | **115** |
| Diamond | 11     | 5        | **55**  |
| Circle  | 1      | 1        | **1**   |
| Line    | 2      | 1        | **2**   |
| **Total** |      |          | **173** |

### Template Ratios (Fixed Aspect Ratios)

The key fix in the current implementation: templates use **FIXED** aspect ratios, not the candidate's aspect ratio.

```typescript
const TEMPLATE_RATIOS = {
  // Box: log-spaced from 0.08 to 12.5
  box: [
    1.0, 1.25, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0, 6.3, 8.0, 10.0, 12.5, // wide
    0.8, 0.625, 0.5, 0.4, 0.3125, 0.25, 0.2, 0.159, 0.125, 0.1, 0.08, // tall
  ],

  // Diamond: capped at 3:1 (prevents line-like degeneracy)
  diamond: [
    1.0, 1.25, 1.6, 2.0, 2.5, 3.0, // wide
    0.8, 0.625, 0.5, 0.4, 0.333,   // tall
  ],

  // Circle: only 1:1
  circle: [1.0],

  // Line: extreme ratios for rejection
  line: [25.0, 0.04],
};
```

### Template Variants (Per Ratio)

For each aspect ratio, we generate:

1. **Closed** (4 edges): Complete loop
2. **Open-s0** (3 edges): Missing edge from corner 0
3. **Open-s1** (3 edges): Missing edge from corner 1
4. **Open-s2** (3 edges): Missing edge from corner 2
5. **Open-s3** (3 edges): Missing edge from corner 3

The "open" variants handle users who don't fully close their shapes.

### Template Generation Functions

```typescript
// Circle: 64-point polyline around unit circle
function circlePolyline(segments = 64): Point2[]

// Rectangle vertices at given width/height
function rectVertices(w: number, h: number): Point2[]
// Returns: [TL, TR, BR, BL]

// Diamond vertices at given width/height
function diamondVertices(w: number, h: number): Point2[]
// Returns: [top, right, bottom, left]

// Create polyline from 4 vertices with n edges
function polylineFromCycle(vertices, startIndex, edges: 3|4): Point2[]
```

---

## Configuration

```typescript
export const PDOLLAR_CONFIG = {
  NUM_POINTS: 32,           // Resample count
  MAX_DISTANCE: 6,          // Absolute acceptance gate (lower = stricter)
  MIN_MARGIN: 0.1,          // Separation gate (10% between best/second)
  CLOSE_EPS_RATIO: 0.12,    // Auto-close if gap <= 12% of diagonal
  EPSILON: 0.5,             // Greedy step exponent (sqrt(n) starting points)
  MIN_INPUT_POINTS: 6,      // Minimum points for recognition
};
```

### Tuning Guidelines

| Parameter | Effect | Typical Adjustment |
|-----------|--------|-------------------|
| `MAX_DISTANCE` | Lower = stricter matching | Increase if good shapes rejected |
| `MIN_MARGIN` | Higher = need more separation | Decrease if shapes too ambiguous |
| `NUM_POINTS` | More = higher precision but slower | Usually keep at 32 |

---

## Recognition Flow

```
User draws stroke and holds for 600ms
          │
          ▼
DrawingTool.onHoldFire()
          │
          ▼
recognizePerfectShapePointCloud(points)
          │
          ├──► Compute bbox, diagonal
          │
          ├──► Auto-close if gap <= 12% of diagonal
          │
          ├──► Normalize candidate (resample → scale → translate)
          │
          ├──► Match against ALL 173 templates
          │    └── greedyCloudMatchQ() for each
          │
          ├──► Sort by distance (lower = better)
          │
          ├──► If best.kind === 'line' → ambiguous: true
          │
          ├──► Compute margin = (2nd - best) / 2nd
          │
          ├──► ambiguous if: distance > MAX_DISTANCE OR margin < MIN_MARGIN
          │
          ▼
Return { best, secondBest, ambiguous, margin, all }
          │
          ▼
If !ambiguous → Set snap state → Render preview → Commit on pointer-up
```

---

## Known Issues & Improvement Areas

### Issue 1: Circle Recognition Too Strict

**Problem:** Mathematical circle template doesn't match human-drawn circles well.

**Symptoms:**
- Slightly oval circles get rejected
- Almost-closed circles fail
- Circles often match diamond better

**Solution Direction:**
- Add hand-drawn circle templates (capture real user circles)
- Add ellipse templates at various aspect ratios
- Use `serializePointCloud()` to capture user drawings

### Issue 2: Open Templates Too Permissive

**Problem:** Any 3-side match counts as a shape, even if the 4th side is far from closed.

**Current Behavior:**
```
User draws U-shape → Matches box/open-s1 → Snaps to box
```

**Solution Direction:**
- Check if the stroke is "nearly closed" before accepting open templates
- Use gap detection from legacy code: `gap <= closeEpsRatio * diagonal`
- Only allow open templates when the unclosed edge is near the stroke start

### Issue 3: Diamond Overpowers Ellipse/Circle

**Problem:** Diamond templates with matching aspect ratios score better than circles.

**Root Cause:**
- Only 1 circle template vs 55 diamond templates
- Diamond vertices align well with normalized point clouds

**Solution Direction:**
- Add ellipse as a new shape kind
- Add multiple ellipse aspect ratios (0.5, 0.67, 0.8, 1.0, 1.25, 1.5, 2.0)
- Use corner detection to discriminate: circles have 0 corners, diamonds have 4

### Issue 4: No Corner/Turn Detection

**Problem:** $P normalization loses sequential information about corners.

**Observation:**
The legacy code (`geometry-helpers.ts`) has robust corner detection:
- `detectCorners()`: Finds turn angles > 45 degrees
- `detectEdges()`: Finds straight segments between corners
- `reconstructRectangleEdges()`: Builds 4-edge loop from best corners

**Solution Direction:**
- Hybrid approach: Use $P for shape classification, legacy corner detection for validation
- Example: If best=$P says "box" but corner count < 3, mark ambiguous
- Example: If best=$P says "circle" but corner count > 0, mark ambiguous

---

## Legacy Code Reference

### Corner Detection (geometry-helpers.ts)

```typescript
interface Corner {
  index: number;      // Position in point array
  angle: number;      // Turn angle in degrees
  strength: number;   // Peak at 90 degrees (1.0 = perfect right angle)
}

function detectCorners(
  points: Vec2[],
  minSegmentLength: number = 10,  // WU
  minTurnAngleDeg: number = 45,
  closed: boolean = false
): Corner[]
```

**Key Logic:**
- Iterates through points looking for angle changes > 45 degrees
- Requires minimum segment length on both sides of corner
- Strength peaks at 90 degrees (good for rectangles)
- Handles wrap-around for closed strokes

### Edge Reconstruction

```typescript
function reconstructRectangleEdges(
  points: Vec2[],
  corners: Corner[],
  minEdgeLengthWU: number = 8
): Edge[]
```

- Takes best 4 corners by strength
- Sorts by position along stroke
- Builds edges between consecutive corners
- Uses PCA for robust angle calculation

### Side Coverage (AABB)

```typescript
function aabbCoverageAcrossDistinctSides(
  points: Vec2[],
  aabb: { minX, minY, maxX, maxY }
): number  // 0-1 score
```

- Checks how many of 4 sides have points nearby
- Combines coverage (0.7 weight) with evenness (0.3 weight)
- Useful for validating rectangle detection

---

## Snap State Types

```typescript
// Types in lib/tools/types.ts

type ForcedSnapKind = 'line' | 'circle' | 'box' | 'diamondHold' | 'rect' | 'ellipseRect' | 'diamond';

// Hold-detected shapes use:
// - 'circle': { anchors: { center: [x, y] } }
// - 'box': { anchors: { cx, cy, angle: 0, hx0, hy0 } }
// - 'diamondHold': { anchors: { cx, cy, hx0, hy0 } }
```

### Adding a New Shape (Ellipse Example)

1. Add to `PerfectShapeKind` in pdollar-recognizer.ts:
   ```typescript
   export type PerfectShapeKind = 'circle' | 'box' | 'diamond' | 'line' | 'ellipse';
   ```

2. Add template ratios:
   ```typescript
   ellipse: [0.5, 0.67, 0.8, 1.0, 1.25, 1.5, 2.0],
   ```

3. Add template generation (ellipse vertices at various ratios)

4. Add snap kind to `ForcedSnapKind`:
   ```typescript
   | 'ellipseHold'
   ```

5. Handle in DrawingTool.onHoldFire()

6. Handle in preview renderer (perfect-shape-preview.ts)

7. Handle in commit logic (commitPerfectShapeFromPreview)

---

## Debug Utilities

### Console Logging

```typescript
debugRecognize(points)  // Called automatically in onHoldFire()
```

Output:
```
🔍 $P Recognition Debug
  Input: 530 points, aspect: 2.17
  Templates: 173 (fixed ratios)
  Thresholds: maxDistance=6, minMargin=0.1
  Template scores (top 10, lower distance = better):
    ✅ BEST box/closed@2.00: 2.618
    🥈 2nd  diamond/closed@2.00: 3.338
    ...
  ---
  Best: box/closed@2.00 (2.618)
  Second: diamond/closed@2.00 (3.338)
  Margin: 21.6%
  Ambiguous: false
```

### Template Capture

To capture a user-drawn gesture as a template:

```typescript
import { serializePointCloud } from './pdollar-recognizer';

// In onHoldFire() or a debug button:
console.log('Template JSON:', serializePointCloud(points));
```

This outputs normalized coordinates that can be added as a custom template.

---

## Performance

- **Template generation:** ~5ms at module load (once)
- **Recognition:** ~10-15ms per call (173 templates × O(n²))
- **Acceptable:** After 600ms hold, user doesn't notice 15ms

### Optimization Options (if needed)

1. **Early termination:** Stop if a template scores below `MAX_DISTANCE * 0.5`
2. **Aspect pre-filtering:** Only test templates within 2x of candidate's aspect ratio
3. **$Q LUT:** Precompute lookup tables for faster bounds (not implemented)

---

## Future Work Checklist

- [ ] Add hand-drawn circle templates
- [ ] Add ellipse shape kind with multiple aspect ratios
- [ ] Integrate corner detection for validation
- [ ] Improve open template handling (closure check)
- [ ] Add shape-specific thresholds (e.g., stricter for diamonds)
- [ ] Consider hybrid $P + parametric approach

---

## Reference: $P Paper

Vatavu, R-D., Anthony, L., & Wobbrock, J.O. (2012). "Gestures as Point Clouds: A $P Recognizer for User Interface Prototypes". Proceedings of the 14th ACM International Conference on Multimodal Interaction (ICMI '12). Santa Monica, CA, USA.

Key insights from paper:
- Point clouds are order-independent (good for rough drawings)
- Greedy matching is O(n²) but fast for n=32
- Weighted matching (early points matter more) improves accuracy
- Multiple starting points handle rotation variation
