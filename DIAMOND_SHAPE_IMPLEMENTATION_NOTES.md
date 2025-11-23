# Additional Implementation Notes

## Important Corrections to Main Guide

### 1. Perfect Shape Preview Fill Support
Since perfect-shape-preview.ts needs color tinting but shouldn't import from client utils, include inline helper:

```typescript
// Add at top of perfect-shape-preview.ts
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}
```

### 2. Pass Fill Through Preview
The PerfectShapePreview interface should include fill:

```typescript
export interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow' | 'diamond';
  color: string;
  size: number;
  opacity: number;
  fill?: boolean;  // NEW: Add optional fill flag
  anchors: PerfectShapeAnchors;
  cursor: [number, number];
  bbox: null;
}
```

### 3. DrawingTool getPreview() Update
Update getPreview() to include fill in perfect shape preview:

```typescript
if (this.snap && this.liveCursorWU) {
  const { color, size } = this.state.config;
  return {
    kind: 'perfectShape',
    shape: this.snap.kind,
    color,
    size,
    opacity: this.state.config.opacity,
    fill: this.settings.fill,  // NEW: Include fill flag
    anchors: { kind: this.snap.kind, ...this.snap.anchors } as any,
    cursor: this.liveCursorWU,
    bbox: null
  };
}
```

### 4. Diamond Rounded Corner Math Fix
The rounded diamond implementation in object-cache needs better corner radius calculation:

```typescript
case 'diamond': {
  const cx = x + w / 2;
  const cy = y0 + h / 2;
  const radius = Math.min(15, Math.min(w, h) * 0.08); // Smaller radius for diamond

  if (radius > 0 && w > radius * 4 && h > radius * 4) {
    // Calculate offset for smooth curves
    const offset = radius * 0.6; // Offset for control points

    path.moveTo(cx, y0 + offset);
    // Top to right
    path.lineTo(x + w - offset, cy - (h/2 - offset) * ((w-offset*2)/w));
    path.quadraticCurveTo(x + w, cy, x + w - offset, cy + (h/2 - offset) * ((w-offset*2)/w));
    // Right to bottom
    path.lineTo(cx, y0 + h - offset);
    path.quadraticCurveTo(cx, y0 + h, cx - (w/2 - offset), cy + (h/2 - offset) * ((w-offset*2)/w));
    // Bottom to left
    path.lineTo(x + offset, cy);
    path.quadraticCurveTo(x, cy, x + offset, cy - (h/2 - offset) * ((w-offset*2)/w));
    // Left back to top
    path.lineTo(cx, y0 + offset);
    path.closePath();
  } else {
    // Sharp diamond fallback
    path.moveTo(cx, y0);
    path.lineTo(x + w, cy);
    path.lineTo(cx, y0 + h);
    path.lineTo(x, cy);
    path.closePath();
  }
  break;
}
```

### 5. Click-to-Place Fixed Size

The fixed size should be calculated based on current zoom level for consistent visual size:

```typescript
// In DrawingTool end() method
const view = viewTransformRef.current;
const fixedVisualSize = 100; // Fixed size in CSS pixels
const fixedWorldSize = fixedVisualSize / view.scale; // Convert to world units
```

### 6. Type Safety for Settings

Add type guard for fill property:

```typescript
interface DrawingToolSettings extends ToolSettings {
  fill?: boolean;
}
```

### 7. Handle Missing Fill Property
In the renderer, handle backward compatibility:

```typescript
// In drawShape() in objects.ts
const fillColor = y.get('fillColor') as string | undefined;
// Fill is only rendered if explicitly set, no default
```

## Critical Points

1. **Diamond anchors** work exactly like rect/ellipseRect - corner anchored AABB
2. **Fill tinting** must be consistent between preview and render (15% stroke, 85% white)
3. **Click detection** uses both time (<200ms) and distance (<5 world units)
4. **Rounded corners** should be proportional but capped (max 15-20 world units)
5. **Cache eviction** - fill color changes don't affect geometry, only style

## Order of Implementation

1. First add diamond to types and DrawingTool snap handling
2. Then add preview rendering
3. Update object-cache Path2D generation
4. Add fill support (can be done in parallel)
5. Finally implement click-to-place
6. Update UI last