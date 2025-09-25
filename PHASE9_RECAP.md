# Phase 9 Implementation Recap: Text & Stamps Tools

## Executive Summary

Phase 9 successfully implements two new creative tools for the Avlo whiteboard: **Text Tool** and **Stamps Tool**. These tools integrate seamlessly with the existing drawing infrastructure while introducing new patterns for DOM-based editing (Text) and shape-based instant placement (Stamps). The implementation follows the established PointerTool interface and maintains consistency with existing rendering and state management patterns.

## Key Achievements

### 1. Text Tool - DOM-Based Direct Manipulation

- **Live contenteditable editor** that appears exactly where text will be placed
- **World-space aware scaling** - text editor scales with canvas zoom
- **Coordinate system alignment** - proper conversion between screen, host, and world coordinates
- **Live configuration updates** - color and size changes apply without recreating the tool
- **Smart lifecycle management** - prevents tool recreation during active editing

### 2. Stamps Tool - Instant Shape Placement

- **Five shape types**: circle, square, triangle, star, heart
- **Single-click placement** with hover preview
- **Stored as special strokes** for compatibility with existing infrastructure
- **Eraser-compatible** through special hit-testing logic
- **Configurable scale** from 50% to 300% of base size

### 3. Unified UI Integration

- **ColorSizeDock extended** to support text tool with dynamic size ranges
- **Smart visibility** - dock hides during text editing to avoid UI clutter
- **Stamp picker UI** with visual shape selection
- **Consistent tool switching** through existing toolbar infrastructure

## Technical Architecture

### Core Components Created

#### 1. TextTool (`/client/src/lib/tools/TextTool.ts`)

The TextTool manages a DOM-based contenteditable div for text input. Key features:

```typescript
interface CanvasHandle {
  worldToClient: (worldX: number, worldY: number) => [number, number];
  getView: () => ViewTransform; // Live transform access
  getEditorHost: () => HTMLElement | null; // DOM overlay container
}
```

**Critical Implementation Details:**

- **Coordinate conversion chain**: World → Screen → Host-relative → Offset-adjusted
- **Scale-aware rendering**: All dimensions (font-size, padding, borders) scale with view.scale
- **Position offset calculation**: `totalOffset = scaledBorderWidth + scaledPadding` ensures text alignment
- **Live updates via `onViewChange()`**: Repositions and rescales during pan/zoom
- **Store integration**: Notifies `isTextEditing` state to hide ColorSizeDock

**Text Commit Process:**

```typescript
// Measure DOM element and convert to world units
const rect = this.state.editBox.getBoundingClientRect();
const w = rect.width / viewTransform.scale;
const h = rect.height / viewTransform.scale;

// Store in Y.Doc texts array with scene assignment
texts.push([
  {
    id: textId,
    x: worldPosition.x,
    y: worldPosition.y,
    w,
    h,
    content: this.state.content,
    color: this.config.color,
    size: this.config.size,
    scene: currentScene,
    createdAt: Date.now(),
    userId: this.userId,
  },
]);
```

#### 2. StampTool (`/client/src/lib/tools/StampTool.ts`)

The StampTool provides instant shape placement with hover preview:

```typescript
interface StampToolConfig {
  selected: 'circle' | 'square' | 'triangle' | 'star' | 'heart';
  scale: number; // Multiplier for base 32px size
  color?: string; // Optional, defaults to #666666
}
```

**Storage Strategy - Stamps as Special Strokes:**

```typescript
strokes.push([
  {
    id: stampId,
    tool: 'stamp', // Special tool type marker
    stampType: this.config.selected, // Shape variant
    color: this.config.color || '#666666',
    size: 32 * this.config.scale, // World units
    opacity: 1,
    points: [worldX, worldY], // Single center point
    bbox: [
      /* calculated bounds */
    ],
    scene: currentScene,
    createdAt: Date.now(),
    userId: this.userId,
  },
]);
```

### DOM Overlay Infrastructure

#### Canvas.tsx Integration (`/client/src/canvas/Canvas.tsx`)

**New DOM overlay layer for text editing:**

```tsx
// Three-layer architecture:
// 1. Base canvas (z-index: 1) - strokes, text, stamps
// 2. Overlay canvas (z-index: 2) - previews, cursors
// 3. DOM overlay (z-index: 3) - text editor

<div
  ref={editorHostRef}
  className="dom-overlay-root"
  style={{
    position: 'absolute',
    inset: 0,
    zIndex: 3,
    pointerEvents: 'none', // Enable per-element
  }}
/>
```

**Tool instantiation with proper handles:**

```typescript
// Text tool gets special canvas handle
tool = new TextTool(
  roomDoc,
  text,
  userId,
  {
    worldToClient,
    getView: () => viewTransformRef.current,
    getEditorHost: () => editorHostRef.current,
  },
  () => overlayLoopRef.current?.invalidateAll(),
);

// Stamp tool follows standard pattern
tool = new StampTool(roomDoc, stamp, userId, () => overlayLoopRef.current?.invalidateAll());
```

**Smart tool recreation prevention:**

```typescript
// Prevents DOM destruction during config changes
if (activeTool === 'text' && toolRef.current?.isActive()) {
  const textTool = toolRef.current as any;
  if ('updateConfig' in textTool) {
    textTool.updateConfig(text);
    return; // Skip recreation
  }
}
```

### Rendering Layers

#### Text Rendering (`/client/src/renderer/layers/text.ts`)

Simple canvas-based text rendering with culling:

```typescript
export function drawText(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  _view: ViewTransform,
  viewport: ViewportInfo
): void {
  // Viewport culling for performance
  if (visibleBounds && /* text outside bounds */) continue;

  // Direct text rendering
  ctx.fillStyle = text.color;
  ctx.font = `${text.size}px Inter, system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(text.content, text.x, text.y);
}
```

#### Stamps Rendering (`/client/src/renderer/layers/stamps.ts`)

Path2D-based shape rendering with caching:

```typescript
// Pre-computed shape paths (initialized once)
const STAMP_PATHS: Record<string, Path2D> = {
  circle: /* arc path */,
  square: /* rect path */,
  triangle: /* triangular path */,
  star: /* 5-point star path */,
  heart: /* bezier curve path */
};

// Critical fix: Filter stamps using nested tool property
const stamps = snapshot.strokes.filter(s => s.style.tool === 'stamp');

// Scaled rendering
ctx.translate(cx, cy);
ctx.scale(size / 32, size / 32);  // Base size is 32
ctx.fill(STAMP_PATHS[stampType]);
```

### State Management

#### Device UI Store Updates (`/client/src/stores/device-ui-store.ts`)

**New state properties:**

```typescript
interface DeviceUIState {
  text: { size: number; color: string };
  stamp: {
    selected: 'circle' | 'square' | 'triangle' | 'star' | 'heart';
    scale: number;
    color: string;
  };
  isTextEditing: boolean; // Controls ColorSizeDock visibility
}
```

**New actions:**

- `setTextSettings(settings)` - Updates text tool configuration
- `setStampSettings(settings)` - Updates stamp selection and scale
- `setIsTextEditing(editing)` - Tracks DOM editor state

### UI Components Integration

#### ColorSizeDock (`/client/src/pages/components/ColorSizeDock.tsx`)

**Dynamic tool support:**

```typescript
// Visibility logic - hide during text editing
const showDock =
  (activeTool === 'pen' || activeTool === 'highlighter' || activeTool === 'text') && !isTextEditing;

// Dynamic size ranges
const sizeRange = useMemo(() => {
  if (activeTool === 'text') return { min: 10, max: 48 };
  return { min: 1, max: 20 };
}, [activeTool]);

// Unified settings handling
if (activeTool === 'text') {
  setTextSettings({ color: newColor, size });
}
```

#### ToolPanel (`/client/src/pages/components/ToolPanel.tsx`)

**Stamp picker UI:**

```tsx
{
  activeTool === 'stamp' && (
    <div className="stamp-picker">
      {['circle', 'square', 'triangle', 'star', 'heart'].map((shape) => (
        <button
          className={`stamp-btn ${stamp.selected === shape ? 'active' : ''}`}
          onClick={() => setStampSettings({ selected: shape })}
        >
          {/* Unicode shape representations */}
          {shape === 'circle' && '○'}
          {shape === 'square' && '□'}
          {shape === 'triangle' && '△'}
          {shape === 'star' && '☆'}
          {shape === 'heart' && '♡'}
        </button>
      ))}
    </div>
  );
}
```

### Preview System Integration

#### OverlayRenderLoop (`/client/src/renderer/OverlayRenderLoop.ts`)

**Text preview (currently disabled for better UX):**

```typescript
// TextTool returns null preview - DOM editor IS the preview
// This provides better WYSIWYG experience
```

**Stamp preview rendering:**

```typescript
if (previewToDraw.kind === 'stamp') {
  ctx.save();
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);

  // Ghost stamp at 50% opacity
  ctx.globalAlpha = previewToDraw.opacity;
  ctx.fillStyle = previewToDraw.color;

  // Shape-specific rendering
  switch (previewToDraw.stampType) {
    case 'circle': /* arc */
    case 'square': /* rect */
    case 'triangle': /* path */
    case 'star': /* complex path */
    case 'heart': /* bezier curves */
  }
  ctx.restore();
}
```

### Special Integrations

#### Eraser Tool Stamp Handling (`/client/src/lib/tools/EraserTool.ts`)

```typescript
// Special hit-testing for stamps (single point, no segments)
if ((stroke as any).tool === 'stamp') {
  const view = this.getView ? this.getView() : snapshot.view;
  const radiusEraserWorld = this.state.radiusPx / view.scale;

  const [cx, cy] = stroke.points;  // Center point only
  const size = (stroke as any).size ?? stroke.style.size ?? 32;
  const radiusStampWorld = size / 2;

  // Circle-circle collision test
  const distSq = /* distance squared calculation */;
  const totalRadius = radiusEraserWorld + radiusStampWorld;
  if (distSq <= totalRadius * totalRadius) {
    this.state.hitNow.add(stroke.id);
  }
  continue;  // Skip segment test
}
```

## Data Flow Summary

### Text Tool Flow

1. **User clicks canvas** → TextTool.begin() stores world position
2. **DOM editor created** → Positioned in host-relative coordinates
3. **User types** → Content tracked in state
4. **Pan/zoom** → onViewChange() repositions and rescales editor
5. **Enter/blur** → commitText() measures DOM, converts to world units, stores in Y.Doc
6. **Render** → drawText() renders committed text from snapshot

### Stamp Tool Flow

1. **User hovers** → StampTool.move() updates preview position
2. **Preview renders** → OverlayRenderLoop draws ghost stamp
3. **User clicks** → placeStamp() immediately commits to Y.Doc
4. **Storage** → Saved as special stroke with tool='stamp'
5. **Render** → drawStamps() filters strokes and renders shapes

## Critical Implementation Details

### Coordinate System Mastery

The Text Tool implementation demonstrates sophisticated coordinate system management:

- **World coordinates**: Stored position, consistent across all clients
- **Screen coordinates**: worldToClient() conversion for display
- **Host-relative coordinates**: Adjusted for DOM container offset
- **Scaled dimensions**: All visual properties scale with zoom level

### Data Structure Compatibility

Stamps cleverly reuse the stroke infrastructure:

- Stored in existing `strokes` Y.Array
- Tagged with `tool: 'stamp'` for identification
- Uses `points[0], points[1]` for center position
- Compatible with scene filtering and eraser

### Performance Optimizations

- **Viewport culling** in both text and stamp rendering
- **Path2D caching** for stamp shapes (initialized once)
- **Tool recreation prevention** during config changes
- **Debounced gate updates** for state changes

## Files Modified/Created

### New Files

- `/client/src/lib/tools/TextTool.ts` - Text tool implementation
- `/client/src/lib/tools/StampTool.ts` - Stamp tool implementation
- `/client/src/renderer/layers/text.ts` - Text rendering layer
- `/client/src/renderer/layers/stamps.ts` - Stamps rendering layer

### Modified Files

- `/client/src/canvas/Canvas.tsx` - DOM overlay, tool integration, update prevention
- `/client/src/stores/device-ui-store.ts` - Text/stamp state, isTextEditing flag
- `/client/src/lib/tools/types.ts` - TextPreview, StampPreview interfaces
- `/client/src/pages/components/ColorSizeDock.tsx` - Text tool support, dynamic ranges
- `/client/src/pages/components/ToolPanel.tsx` - Stamp picker UI, fixed tool naming
- `/client/src/renderer/OverlayRenderLoop.ts` - Stamp preview rendering
- `/client/src/renderer/layers/index.ts` - Export text/stamp renderers
- `/client/src/lib/tools/EraserTool.ts` - Stamp hit-testing logic
- `/client/src/lib/room-doc-manager.ts` - Text snapshot building (already supported)

## Conclusion

Phase 9 successfully extends Avlo's creative capabilities with two complementary tools that showcase different implementation strategies:

- **Text Tool** demonstrates sophisticated DOM manipulation and coordinate system management
- **Stamps Tool** shows clever reuse of existing infrastructure with minimal changes

The implementation maintains architectural consistency while introducing new patterns that will be valuable for future tools. The careful attention to coordinate systems, state management, and performance optimizations ensures these tools integrate seamlessly with the existing whiteboard experience.
