# Diamond Shape & Fill Implementation Guide

## Executive Summary

This guide provides step-by-step instructions to:
1. Add diamond shape to the shape tool
2. Implement fill color support with tinting (15% stroke color, 85% white)
3. Add click-to-place behavior for instant shape creation
4. Update UI to replace line tool with diamond

## Prerequisites

- Y.Map migration is complete
- Shape tool uses DrawingTool with forceSnapKind
- Object-cache already has diamond Path2D generation (but needs rounded corners)

## Implementation Steps

### Phase 1: Add Diamond Shape Type Support

#### 1.1 Update Type Definitions
**File**: `/client/src/lib/tools/types.ts`

Add `'diamond'` to PerfectShapeAnchors union:
```typescript
export type PerfectShapeAnchors =
  | { kind: 'line';        A: [number, number] }
  | { kind: 'circle';      center: [number, number] }
  | { kind: 'box';         cx: number; cy: number; angle: number; hx0: number; hy0: number }
  | { kind: 'rect';        A: [number, number] }
  | { kind: 'ellipseRect'; A: [number, number] }
  | { kind: 'arrow';       A: [number, number] }
  | { kind: 'diamond';     A: [number, number] };  // NEW: corner-anchored diamond
```

Update PerfectShapePreview shape field:
```typescript
export interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow' | 'diamond'; // ADD 'diamond'
  // ... rest stays same
}
```

#### 1.2 Update DrawingTool
**File**: `/client/src/lib/tools/DrawingTool.ts`

1. Update ForcedSnapKind type (line 19):
```typescript
type ForcedSnapKind = 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow' | 'diamond';
```

2. Add diamond to getShapeTypeFromSnapKind mapping (line 22):
```typescript
function getShapeTypeFromSnapKind(snapKind: string): 'rect' | 'ellipse' | 'diamond' | 'roundedRect' {
  const mapping: Record<string, 'rect' | 'ellipse' | 'diamond' | 'roundedRect'> = {
    'box': 'rect',
    'circle': 'ellipse',
    'rect': 'roundedRect',
    'ellipseRect': 'ellipse',
    'diamond': 'diamond'      // NEW: diamond → diamond
  };
  return mapping[snapKind] ?? 'rect';
}
```

3. Update snap field type (line 45):
```typescript
private snap:
  | null
  | (
      | { kind: 'line';        anchors: { A: [number, number] } }
      | { kind: 'circle';      anchors: { center: [number, number] } }
      | { kind: 'box';         anchors: { cx: number; cy: number; angle: number; hx0: number; hy0: number } }
      | { kind: 'rect';        anchors: { A: [number, number] } }
      | { kind: 'ellipseRect'; anchors: { A: [number, number] } }
      | { kind: 'arrow';       anchors: { A: [number, number] } }
      | { kind: 'diamond';     anchors: { A: [number, number] } }  // NEW
    ) = null;
```

4. Add diamond handling in begin() method (after line 121):
```typescript
// If Shape tool requested forced snap, seed it immediately
if (this.opts.forceSnapKind) {
  const k = this.opts.forceSnapKind;
  this.snap =
    k === 'line'        ? { kind: 'line',        anchors: { A: [worldX, worldY] } }
  : k === 'circle'      ? { kind: 'circle',      anchors: { center: [worldX, worldY] } }
  : k === 'box'         ? { kind: 'box',         anchors: { cx: worldX, cy: worldY, angle: 0, hx0: 0.5, hy0: 0.5 } }
  : k === 'rect'        ? { kind: 'rect',        anchors: { A: [worldX, worldY] } }
  : k === 'ellipseRect' ? { kind: 'ellipseRect', anchors: { A: [worldX, worldY] } }
  : k === 'diamond'     ? { kind: 'diamond',     anchors: { A: [worldX, worldY] } }  // NEW
  : /* arrow */           { kind: 'arrow',       anchors: { A: [worldX, worldY] } };
  // ... rest stays same
}
```

5. Add diamond frame calculation in commitPerfectShapeFromPreview() (after line 491):
```typescript
} else if (this.snap.kind === 'diamond') {
  // Corner-anchored diamond (same as rect/ellipse)
  const { A } = this.snap.anchors;
  const C = finalCursor;
  const minX = Math.min(A[0], C[0]);
  const minY = Math.min(A[1], C[1]);
  const maxX = Math.max(A[0], C[0]);
  const maxY = Math.max(A[1], C[1]);
  frame = [
    minX,
    minY,
    maxX - minX,
    maxY - minY
  ];
```

### Phase 2: Add Diamond Preview Rendering

**File**: `/client/src/renderer/layers/perfect-shape-preview.ts`

Add diamond preview rendering (after ellipseRect, before circle):
```typescript
if (anchors.kind === 'diamond') {
    const { A } = anchors;
    const C = cursor;
    const minX = Math.min(A[0], C[0]);
    const maxX = Math.max(A[0], C[0]);
    const minY = Math.min(A[1], C[1]);
    const maxY = Math.max(A[1], C[1]);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const width = maxX - minX;
    const height = maxY - minY;

    // Safety check to prevent drawing if size is 0
    if (width === 0 || height === 0) return;

    // Calculate corner radius
    const radius = Math.min(20, Math.min(width, height) * 0.1);

    ctx.beginPath();

    // 1. Start somewhere safe on the Top-Right edge (midpoint)
    // This ensures the first line drawn connects smoothly to the last curve
    ctx.moveTo(cx + width / 4, minY + height / 4);

    // 2. Round the Right Corner
    // arcTo(CornerX, CornerY, DestinationX, DestinationY, Radius)
    ctx.arcTo(maxX, cy, cx, maxY, radius);

    // 3. Round the Bottom Corner
    ctx.arcTo(cx, maxY, minX, cy, radius);

    // 4. Round the Left Corner
    ctx.arcTo(minX, cy, cx, minY, radius);

    // 5. Round the Top Corner
    // (This curves around the top tip and connects back to the start)
    ctx.arcTo(cx, minY, maxX, cy, radius);

    ctx.closePath();
    if (fillEnabled) ctx.fill();
      ctx.stroke();
      return;
  }
```

### Phase 3: Update Object Cache for Rounded Diamond

**File**: `/client/src/renderer/object-cache.ts`

Replace existing diamond case (line 75-83) with rounded version:
```typescript
case 'diamond': {
  const cx = x + w / 2;
  const cy = y0 + h / 2;          
  // Match preview logic exactly for WYSIWYG (20px max, or 10% of size)
  const radius = Math.min(20, Math.min(w, h) * 0.1);
  // Start on the top-right edge (midpoint)
  path.moveTo(cx + w / 4, y0 + h / 4);
  // Right Tip
  // arcTo(cornerX, cornerY, destX, destY, radius)
  path.arcTo(x + w, cy, cx, y0 + h, radius);
  // Bottom Tip
  path.arcTo(cx, y0 + h, x, cy, radius);
  // Left Tip
  path.arcTo(x, cy, cx, y0, radius);
  // Top Tip
  path.arcTo(cx, y0, x + w, cy, radius);
  path.closePath();
  break;
  }   
```

### Phase 4: Fill Color Support

#### 4.1 Update Device UI Store
**File**: `/client/src/stores/device-ui-store.ts`

1. Update ShapeVariant type (line 5):
```typescript
export type ShapeVariant = 'diamond' | 'rectangle' | 'ellipse' | 'arrow';
// Remove 'line' - it will be combined with arrow later
```

2. Add fill property to ToolSettings (line 11):
```typescript
export interface ToolSettings {
  size: SizePreset;
  color: string;
  opacity?: number;
  fill?: boolean;  // NEW: whether fill is enabled
}
```

#### 4.2 Pass Fill to DrawingTool

**File**: `/client/src/canvas/Canvas.tsx`

Update shape tool instantiation (line 508):
```typescript
} else if (activeTool === 'shape') {
  // Map shape variant to forced snap kind
  const variant = shape?.variant ?? 'rectangle';
  const forceSnapKind =
    variant === 'rectangle' ? 'rect' :
    variant === 'ellipse'   ? 'ellipseRect' :
    variant === 'diamond'   ? 'diamond' :    // NEW
    variant === 'arrow'     ? 'arrow' : 'line';

  // Get fill state from UI store
  const fillEnabled = useDeviceUIStore.getState().fillEnabledUI;

  // Add fill to settings
  const settings = {
    ...shape?.settings,
    fill: fillEnabled  // NEW: pass fill state
  };

  tool = new DrawingTool(
    roomDoc,
    settings,
    'pen',
    userId,
    (_bounds) => overlayLoopRef.current?.invalidateAll(),
    () => overlayLoopRef.current?.invalidateAll(),
    () => viewTransformRef.current,
    { forceSnapKind }
  );
}
```

#### 4.3 Add Color Tinting Utility

**File**: `/client/src/lib/utils/color.ts` (NEW FILE)
```typescript
/**
 * Convert hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Convert RGB to hex color
 */
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Create a tinted fill color from stroke color
 * @param strokeColor - The stroke color in hex format
 * @param mixRatio - Ratio of stroke color (default 0.15 = 15% stroke, 85% white)
 */
export function createFillFromStroke(strokeColor: string, mixRatio = 0.15): string {
  const rgb = hexToRgb(strokeColor);
  if (!rgb) return strokeColor;  // Fallback to original if parsing fails

  // Mix with white (255, 255, 255)
  const tinted = {
    r: Math.round(rgb.r * mixRatio + 255 * (1 - mixRatio)),
    g: Math.round(rgb.g * mixRatio + 255 * (1 - mixRatio)),
    b: Math.round(rgb.b * mixRatio + 255 * (1 - mixRatio))
  };

  return rgbToHex(tinted.r, tinted.g, tinted.b);
}
```

#### 4.4 Update DrawingTool to Handle Fill

**File**: `/client/src/lib/tools/DrawingTool.ts`

1. Import color utility:
```typescript
import { createFillFromStroke } from '@/lib/utils/color';
```

2. Update commitPerfectShapeFromPreview to include fill (line 512):
```typescript
const shapeMap = new Y.Map();
shapeMap.set('id', shapeId);
shapeMap.set('kind', 'shape');
shapeMap.set('shapeType', shapeType);
shapeMap.set('color', this.state.config.color);
shapeMap.set('width', this.state.config.size);

// NEW: Add fill color if enabled
if (this.settings.fill) {
  const fillColor = createFillFromStroke(this.state.config.color);
  shapeMap.set('fillColor', fillColor);
}

shapeMap.set('opacity', this.state.config.opacity);
shapeMap.set('frame', frame);
shapeMap.set('ownerId', this.userId);
shapeMap.set('createdAt', Date.now());
```

3. Update perfect shape preview to show fill:

**File**: `/client/src/renderer/layers/perfect-shape-preview.ts`

Add fill rendering support:
```typescript
export function drawPerfectShapePreview(
  ctx: CanvasRenderingContext2D,
  preview: PerfectShapePreview
): void {
  // Apply tool styling
  ctx.globalAlpha = preview.opacity;
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);

  // NEW: Check if fill is enabled (passed via preview)
  const fillEnabled = (preview as any).fill ?? false;
  if (fillEnabled) {
    // Import utility or inline the tinting calculation
    const rgb = hexToRgb(preview.color);
    if (rgb) {
      const tinted = {
        r: Math.round(rgb.r * 0.15 + 255 * 0.85),
        g: Math.round(rgb.g * 0.15 + 255 * 0.85),
        b: Math.round(rgb.b * 0.15 + 255 * 0.85)
      };
      ctx.fillStyle = `rgb(${tinted.r}, ${tinted.g}, ${tinted.b})`;
    }
  }

  // ... existing drawing code ...
  // For each shape, after drawing the path:
  if (fillEnabled) {
    ctx.fill();
  }
  ctx.stroke();
}
```

### Phase 5: Click-to-Place Behavior

**File**: `/client/src/lib/tools/DrawingTool.ts`

Add click detection:

1. Add state fields:
```typescript
private clickToPlaceStartTime: number = 0;
private clickToPlaceStartPos: [number, number] | null = null;
private isClickToPlace: boolean = false;
```

2. Update begin() method:
```typescript
begin(pointerId: number, worldX: number, worldY: number): void {
  this.startDrawing(pointerId, worldX, worldY);

  // If Shape tool requested forced snap, seed it immediately
  if (this.opts.forceSnapKind) {
    // Store time and position for click detection
    this.clickToPlaceStartTime = Date.now();
    this.clickToPlaceStartPos = [worldX, worldY];
    this.isClickToPlace = false;

    // ... existing snap setup code ...
  }
}
```

3. Update end() method:
```typescript
end(worldX?: number, worldY?: number): void {
  this.hold.cancel();

  if (this.snap && this.liveCursorWU) {
    // Check if this is a click (not drag)
    const timeDelta = Date.now() - this.clickToPlaceStartTime;
    const isClick = timeDelta < 200;  // 200ms threshold for click

    if (this.clickToPlaceStartPos && worldX !== undefined && worldY !== undefined) {
      const distMoved = Math.hypot(
        worldX - this.clickToPlaceStartPos[0],
        worldY - this.clickToPlaceStartPos[1]
      );
      const isStationary = distMoved < 5;  // 5 world units threshold

      if (isClick && isStationary && this.opts.forceSnapKind) {
        // Place fixed-size shape at click position
        const fixedSize = 100;  // Fixed size in world units

        // Determine cursor position for fixed shape
        let fixedCursor: [number, number];

        if (this.snap.kind === 'rect' || this.snap.kind === 'ellipseRect' || this.snap.kind === 'diamond') {
          // For corner-anchored shapes, place centered at click
          fixedCursor = [
            this.clickToPlaceStartPos[0] + fixedSize,
            this.clickToPlaceStartPos[1] + fixedSize
          ];
          // Adjust anchor to center the shape
          this.snap.anchors.A = [
            this.clickToPlaceStartPos[0] - fixedSize/2,
            this.clickToPlaceStartPos[1] - fixedSize/2
          ];
        } else {
          // Other shapes - adjust as needed
          fixedCursor = [
            this.clickToPlaceStartPos[0] + fixedSize/2,
            this.clickToPlaceStartPos[1] + fixedSize/2
          ];
        }

        this.liveCursorWU = fixedCursor;
      }
    }

    // Continue with normal commit
    this.commitPerfectShapeFromPreview();
    return;
  }

  // ... existing freehand commit code ...
}
```

### Phase 6: UI Updates

#### 6.1 Replace Line Tool with Diamond

**File**: `/client/src/components/Toolbar.tsx` (or wherever the toolbar is defined)

1. Remove line tool button
2. Add diamond tool button between rectangle and ellipse
3. Update icon imports/references

Example toolbar order:
```tsx
// Shape tools in order
<ToolButton tool="shape" variant="rectangle" icon={RectangleIcon} />
<ToolButton tool="shape" variant="diamond" icon={DiamondIcon} />
<ToolButton tool="shape" variant="ellipse" icon={CircleIcon} />
<ToolButton tool="shape" variant="arrow" icon={ArrowIcon} />
```

#### 6.2 Add Diamond Icon

Either import from an icon library or create inline SVG:
```tsx
const DiamondIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M12 2l8 10-8 10-8-10z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
```

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
## Testing Checklist

### Diamond Shape
- [ ] Diamond appears in toolbar between rectangle and ellipse
- [ ] Click-drag creates diamond from corner anchor
- [ ] Diamond has rounded corners by default
- [ ] Small diamonds render with sharp corners
- [ ] Diamond preview matches committed shape exactly

### Fill Support
- [ ] Fill toggle in UI enables/disables fill
- [ ] Fill color is lighter tint of stroke color (15% stroke, 85% white)
- [ ] Fill renders correctly in preview
- [ ] Fill renders correctly in committed shape
- [ ] Fill works for all shape types (rect, diamond, ellipse)

### Click-to-Place
- [ ] Single click places fixed-size shape (100x100 world units)
- [ ] Shape is centered at click position
- [ ] Rectangle places as perfect square
- [ ] Ellipse places as perfect circle
- [ ] Diamond places with equal width/height
- [ ] Click-drag still works normally for custom sizing

### Performance
- [ ] No regression in rendering performance
- [ ] Cache eviction works correctly for shapes with fill
- [ ] Spatial index includes shapes correctly

## Migration Notes

- Line tool removed from toolbar (will be merged with arrow/connector tool later)
- Existing shapes without fillColor will render stroke-only (backward compatible)
- Fixed shape size (100 WU) may need adjustment based on typical zoom levels



