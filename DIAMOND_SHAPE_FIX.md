# Diamond Shape Fix - Proper Rounded Diamond Implementation

## Current Issue
The diamond shape is rendering as a distorted rectangle due to incorrect path calculations. The current implementation tries to create rounded corners but the math for the diamond vertices is wrong.

## Correct Rounded Diamond Implementation

A diamond is a 45-degree rotated square with 4 vertices at the midpoints of each edge of the bounding box:
- Top: (centerX, minY)
- Right: (maxX, centerY)
- Bottom: (centerX, maxY)
- Left: (minX, centerY)

### Fix for perfect-shape-preview.ts

**File**: `/client/src/renderer/layers/perfect-shape-preview.ts`
**Lines**: 141-176

Replace the diamond case with:
```typescript
if (anchors.kind === 'diamond') {
  // Corner-anchored diamond inscribed in AABB
  const { A } = anchors;
  const C = cursor;
  const minX = Math.min(A[0], C[0]);
  const maxX = Math.max(A[0], C[0]);
  const minY = Math.min(A[1], C[1]);
  const maxY = Math.max(A[1], C[1]);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Calculate corner radius (10% of min dimension, max 20)
  const width = maxX - minX;
  const height = maxY - minY;
  const radius = Math.min(20, Math.min(width, height) * 0.1);

  ctx.beginPath();

  if (radius > 0 && width > radius * 2 && height > radius * 2) {
    // Rounded diamond with proper vertices
    const offset = radius * 0.552284749831; // Optimal control point distance for quarter circle

    // Start just below top vertex (accounting for rounding)
    ctx.moveTo(cx, minY + radius);

    // Top vertex to right vertex
    ctx.lineTo(maxX - radius, cy);
    ctx.quadraticCurveTo(maxX, cy, maxX - radius, cy);

    // Right vertex to bottom vertex
    ctx.lineTo(cx, maxY - radius);
    ctx.quadraticCurveTo(cx, maxY, cx, maxY - radius);

    // Bottom vertex to left vertex
    ctx.lineTo(minX + radius, cy);
    ctx.quadraticCurveTo(minX, cy, minX + radius, cy);

    // Left vertex back to top
    ctx.lineTo(cx, minY + radius);
    ctx.quadraticCurveTo(cx, minY, cx, minY + radius);
  } else {
    // Sharp diamond (no rounding)
    ctx.moveTo(cx, minY);      // Top vertex
    ctx.lineTo(maxX, cy);       // Right vertex
    ctx.lineTo(cx, maxY);       // Bottom vertex
    ctx.lineTo(minX, cy);       // Left vertex
  }

  ctx.closePath();
  if (fillEnabled) ctx.fill();
  ctx.stroke();
  return;
}
```

### Fix for object-cache.ts

**File**: `/client/src/renderer/object-cache.ts`
**Lines**: 75-98

Replace the diamond case with:
```typescript
case 'diamond': {
  const cx = x + w / 2;
  const cy = y0 + h / 2;
  const radius = Math.min(15, Math.min(w, h) * 0.08); // Corner radius

  if (radius > 0 && w > radius * 4 && h > radius * 4) {
    // Rounded diamond - proper vertex positions
    const offset = radius * 0.552284749831; // Optimal bezier control point distance

    // Start just below top vertex
    path.moveTo(cx, y0 + radius);

    // Top to right with curve
    path.lineTo(x + w - radius, cy);
    path.quadraticCurveTo(x + w, cy, x + w - radius, cy);

    // Right to bottom with curve
    path.lineTo(cx, y0 + h - radius);
    path.quadraticCurveTo(cx, y0 + h, cx, y0 + h - radius);

    // Bottom to left with curve
    path.lineTo(x + radius, cy);
    path.quadraticCurveTo(x, cy, x + radius, cy);

    // Left back to top with curve
    path.lineTo(cx, y0 + radius);
    path.quadraticCurveTo(cx, y0, cx, y0 + radius);
  } else {
    // Sharp diamond (no rounding)
    path.moveTo(cx, y0);          // Top vertex
    path.lineTo(x + w, cy);        // Right vertex
    path.lineTo(cx, y0 + h);       // Bottom vertex
    path.lineTo(x, cy);            // Left vertex
  }
  path.closePath();
  break;
}
```

### Alternative: Smoother Rounded Diamond with Bezier Curves

For an even smoother rounded diamond, you can use cubic bezier curves:

```typescript
if (radius > 0 && width > radius * 2 && height > radius * 2) {
  const offset = radius;

  // Start at top (with radius offset)
  ctx.moveTo(cx, minY + offset);

  // Top to right
  ctx.lineTo(cx + (width/2 - offset) * 0.7, cy - (height/2 - offset) * 0.7);
  ctx.bezierCurveTo(
    maxX - offset * 0.3, cy - offset * 0.3,
    maxX - offset * 0.3, cy + offset * 0.3,
    cx + (width/2 - offset) * 0.7, cy + (height/2 - offset) * 0.7
  );

  // Right to bottom
  ctx.lineTo(cx, maxY - offset);
  ctx.bezierCurveTo(
    cx + offset * 0.3, maxY - offset * 0.3,
    cx - offset * 0.3, maxY - offset * 0.3,
    cx, maxY - offset
  );

  // Bottom to left
  ctx.lineTo(cx - (width/2 - offset) * 0.7, cy + (height/2 - offset) * 0.7);
  ctx.bezierCurveTo(
    minX + offset * 0.3, cy + offset * 0.3,
    minX + offset * 0.3, cy - offset * 0.3,
    cx - (width/2 - offset) * 0.7, cy - (height/2 - offset) * 0.7
  );

  // Left back to top
  ctx.lineTo(cx, minY + offset);
  ctx.bezierCurveTo(
    cx - offset * 0.3, minY + offset * 0.3,
    cx + offset * 0.3, minY + offset * 0.3,
    cx, minY + offset
  );
}
```

## Testing the Fix

After applying the fix:

1. Select the diamond shape tool
2. Draw a diamond - it should have 4 clear vertices at the midpoints
3. The corners should be slightly rounded, not sharp
4. The shape should be symmetrical in both axes
5. Fill should work correctly

## Visual Reference

```
      ◆        <- Top vertex at (cx, minY)
     / \
    /   \
   ◆     ◆     <- Left (minX, cy) and Right (maxX, cy) vertices
    \   /
     \ /
      ◆        <- Bottom vertex at (cx, maxY)
```

The rounded version softens each vertex with a small curve radius.