# Phase 9: Text & Stamps Implementation Guide

## Overview

This guide provides a comprehensive, step-by-step implementation plan for adding Text and Stamps tools to Avlo. The implementation follows existing patterns from DrawingTool and EraserTool, maintaining consistency with the current architecture.

## CRITICAL ARCHITECTURE PATTERNS TO MAINTAIN

### Live View Pattern (From EraserTool)

- **Pattern**: Tools receive `getView?: () => ViewTransform` callback for live transform access
- **Purpose**: Ensures accurate coordinate conversion during pan/zoom
- **Implementation**: TextTool MUST use live view for repositioning DOM editor overlay

### Tool Lifecycle Pattern (From DrawingTool/EraserTool)

- **Pattern**: Unified PointerTool interface with polymorphic methods
- **Methods**: `canBegin()`, `begin()`, `move()`, `end()`, `cancel()`, `isActive()`, `getPointerId()`, `getPreview()`, `destroy()`
- **Canvas Integration**: Tool selection happens ONCE in useEffect, handlers remain unified

### Preview Architecture

- **Pattern**: Tools provide world-space preview data via `getPreview()`
- **Overlay Loop**: Applies view transform ONCE before drawing world previews
- **Critical**: Preview data stays fresh because overlay pulls live view every frame

## Architecture Analysis

### Current Tool Selection Pattern (Canvas.tsx)

```typescript
// Tool selection happens in Canvas.tsx useEffect (lines 469-509)
if (activeTool === 'eraser') {
  tool = new EraserTool(
    roomDoc,
    eraser,
    userId,
    () => overlayLoopRef.current?.invalidateAll(),
    () => ({ /* viewport */ }),
    () => viewTransformRef.current,  // LIVE VIEW PATTERN
  )
} else if (activeTool === 'pen' || activeTool === 'highlighter') {
  const adaptedUI = toolbarToDeviceUI(...)
  tool = new DrawingTool(...)
} else {
  return; // ⚠️ TEXT AND STAMP FALL THROUGH AS UNSUPPORTED
}
```

### Live View Access Pattern (Critical)

```typescript
// EraserTool.ts line 162 - Uses live view when available
const viewTransform = this.getView ? this.getView() : snapshot.view;

// Canvas.tsx provides live view via closure
getView: () => viewTransformRef.current; // Always fresh
```

### Missing Canvas Infrastructure

```typescript
// Current Canvas.tsx JSX (lines 676-696)
<div className="relative w-full h-full">
  <CanvasStage ref={baseStageRef} ... />     {/* Base canvas z-index: 1 */}
  <CanvasStage ref={overlayStageRef} ... />  {/* Overlay canvas z-index: 2 */}
  {/* ⚠️ MISSING: DOM overlay for text editor (needs z-index: 3) */}
</div>
```

### Unified Pointer Handlers

- Canvas.tsx lines 523-597: Unified handlers call tool methods polymorphically
- No tool-specific branching in handlers (critical for maintainability)
- Existing pattern for optional methods: `if (tool && 'clearHover' in tool)` (line 592)

### Key Integration Points

1. **RoomDocManager**: Already initializes texts[] array (line 718)
2. **Snapshot**: Already includes TextView type and filtering
3. **Renderer**: drawText() and drawShapes() stubbed but empty (layers/index.ts lines 37-48)
4. **Zustand Store**: Text settings exist, stamp settings completely missing
5. **ToolPanel**: Buttons present but typo and wrong tool name ('stamps' vs 'stamp')

---

## Step 0: Add DOM Overlay Infrastructure (CRITICAL)

### 0.1 Update Canvas.tsx JSX Structure

**File**: `/client/src/canvas/Canvas.tsx`

```typescript
// Add new ref for DOM overlay (around line 136)
const editorHostRef = useRef<HTMLDivElement>(null);

// Update JSX structure (replace lines 676-696)
return (
  <div className="relative w-full h-full">
    <CanvasStage
      ref={baseStageRef}
      className={className}
      style={{ position: 'absolute', inset: 0, zIndex: 1 }}
      onResize={handleBaseResize}
    />
    <CanvasStage
      ref={overlayStageRef}
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        pointerEvents: 'none',
      }}
      onResize={handleOverlayResize}
    />
    {/* NEW: DOM overlay for interactive HTML elements */}
    <div
      ref={editorHostRef}
      className="dom-overlay-root"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        pointerEvents: 'none', // Enable per-element when needed
      }}
    />
  </div>
);
```

## Step 1: Update Data Types and Store

### 1.1 Fix Tool Type Consistency

**File**: `/client/src/stores/device-ui-store.ts`

```typescript
// CRITICAL: Change 'stamps' to 'stamp' for consistency (line 4)
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'stamp' | 'pan' | 'select';
```

### 1.2 Add Stamps Settings to Zustand Store

**File**: `/client/src/stores/device-ui-store.ts`

```typescript
interface DeviceUIState {
  // Add after text settings (line 18)
  stamp: { selected: string; scale: number }; // Note: singular 'stamp'

  // Add setter after setTextSettings (line 35)
  setStampSettings: (settings: Partial<{ selected: string; scale: number }>) => void;
}

// In create() function, add default state (after line 58)
stamp: { selected: 'circle', scale: 1 },

// Add action implementation (after line 87)
setStampSettings: (settings) =>
  set((state) => ({
    stamp: { ...state.stamp, ...settings },
  })),
```

### 1.3 Extend Preview Union Type

**File**: `/client/src/lib/tools/types.ts`

```typescript
// Add after EraserPreview interface (line 47)
export interface TextPreview {
  kind: 'text';
  box: { x: number; y: number; w: number; h: number }; // World coords
  content?: string; // Optional preview content
  isPlacing?: boolean; // True when placing, false when editing
}

export interface StampPreview {
  kind: 'stamp';
  position: { x: number; y: number }; // World coords
  stampType: 'circle' | 'square' | 'triangle' | 'star' | 'heart'; // Basic shapes
  size: number; // World units (base 32px * scale)
  color: string; // Fill color
  opacity: number;
}

// Update PreviewData union (line 53)
export type PreviewData = StrokePreview | EraserPreview | TextPreview | StampPreview;
```

---

## Step 2: Implement TextTool

### 2.1 Create TextTool Class

**File**: `/client/src/lib/tools/TextTool.ts` (NEW FILE)

```typescript
import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { TextPreview } from './types';

export interface TextToolConfig {
  size: number;
  color: string;
}

export interface CanvasHandle {
  worldToClient: (worldX: number, worldY: number) => [number, number];
  getView: () => ViewTransform; // REQUIRED for live transforms
  getEditorHost: () => HTMLElement | null; // REQUIRED for DOM mounting
}

interface TextState {
  isEditing: boolean;
  editBox: HTMLDivElement | null;
  worldPosition: { x: number; y: number } | null;
  content: string;
}

export class TextTool {
  private state: TextState = {
    isEditing: false,
    editBox: null,
    worldPosition: null,
    content: '',
  };

  constructor(
    private room: any, // RoomDoc type
    private config: TextToolConfig,
    private userId: string,
    private canvasHandle: CanvasHandle,
    private onInvalidate?: () => void,
  ) {}

  canBegin(): boolean {
    return !this.state.isEditing;
  }

  begin(_pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isEditing) return;

    // Store world position
    this.state.worldPosition = { x: worldX, y: worldY };

    // Convert to screen coordinates
    const [clientX, clientY] = this.canvasHandle.worldToClient(worldX, worldY);

    // Create DOM editor overlay
    this.createEditor(clientX, clientY);

    // Update awareness
    this.room.updateActivity('typing');
  }

  move(_worldX: number, _worldY: number): void {
    // Text tool doesn't track movement during editing
  }

  end(): void {
    // Commit happens on blur/Enter, not pointer up
  }

  cancel(): void {
    this.closeEditor(false);
  }

  isActive(): boolean {
    return this.state.isEditing;
  }

  getPointerId(): number | null {
    return null; // Text tool doesn't track pointer
  }

  getPreview(): TextPreview | null {
    if (!this.state.isEditing || !this.state.worldPosition) return null;

    // Simple preview box while editing
    return {
      kind: 'text',
      box: {
        x: this.state.worldPosition.x,
        y: this.state.worldPosition.y,
        w: 200, // Default width in world units
        h: 30, // Default height
      },
    };
  }

  destroy(): void {
    this.closeEditor(false);
  }

  // Called when view transforms change (pan/zoom)
  onViewChange(): void {
    if (!this.state.isEditing || !this.state.worldPosition || !this.state.editBox) return;

    // Recompute screen position from world position using live view
    const [clientX, clientY] = this.canvasHandle.worldToClient(
      this.state.worldPosition.x,
      this.state.worldPosition.y,
    );

    // Update DOM editor position
    this.state.editBox.style.left = `${clientX}px`;
    this.state.editBox.style.top = `${clientY}px`;
  }

  private createEditor(clientX: number, clientY: number): void {
    // Get DOM overlay host from canvas
    const host = this.canvasHandle.getEditorHost?.() || document.body;

    // Create contenteditable div
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.className = 'text-editor-overlay';
    editor.style.cssText = `
      position: absolute; // Changed from fixed to absolute for host positioning
      left: ${clientX}px;
      top: ${clientY}px;
      min-width: 200px;
      min-height: 30px;
      padding: 4px;
      font-size: ${this.config.size}px;
      font-family: Inter, system-ui, -apple-system, sans-serif;
      line-height: 1.4;
      color: ${this.config.color};
      background: white;
      border: 2px solid #3b82f6;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      outline: none;
      cursor: text; // I-beam cursor ONLY on this element
      pointer-events: auto; // Enable input on this element only
    `;

    // Handle Enter key
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.commitText();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeEditor(false);
      }
    });

    // Handle blur
    editor.addEventListener('blur', () => {
      this.commitText();
    });

    // Handle input
    editor.addEventListener('input', () => {
      this.state.content = editor.textContent || '';
      this.onInvalidate?.();
    });

    host.appendChild(editor);
    editor.focus();

    this.state.editBox = editor;
    this.state.isEditing = true;
  }

  private closeEditor(commit: boolean): void {
    if (!this.state.editBox) return;

    if (commit) {
      this.commitText();
    }

    this.state.editBox.remove();
    this.state.editBox = null;
    this.state.isEditing = false;
    this.state.content = '';
    this.state.worldPosition = null;

    this.room.updateActivity('idle');
    this.onInvalidate?.();
  }

  private commitText(): void {
    if (!this.state.content || !this.state.worldPosition || !this.state.editBox) {
      this.closeEditor(false);
      return;
    }

    // Measure DOM element
    const rect = this.state.editBox.getBoundingClientRect();
    const viewTransform = this.canvasHandle.getView?.() || { scale: 1 };

    // Convert to world units
    const w = rect.width / viewTransform.scale;
    const h = rect.height / viewTransform.scale;

    // Commit to Y.Doc
    const textId = ulid();

    try {
      this.room.mutate((ydoc: Y.Doc) => {
        const root = ydoc.getMap('root');
        const texts = root.get('texts') as Y.Array<any>;
        const meta = root.get('meta') as Y.Map<any>;

        // Get current scene
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        const currentScene = sceneTicks ? sceneTicks.length : 0;

        // Push new text
        texts.push([
          {
            id: textId,
            x: this.state.worldPosition!.x,
            y: this.state.worldPosition!.y,
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
      });
    } catch (err) {
      console.error('Failed to commit text:', err);
    } finally {
      this.closeEditor(false);
    }
  }
}
```

---

## Step 3: Implement StampTool

### 3.1 Create StampTool Class

**File**: `/client/src/lib/tools/StampTool.ts` (NEW FILE)

```typescript
import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { StampPreview } from './types';

export interface StampToolConfig {
  selected: 'circle' | 'square' | 'triangle' | 'star' | 'heart';
  scale: number;
  color?: string; // Optional fill color
}

interface StampState {
  isPreviewing: boolean;
  previewPosition: { x: number; y: number } | null;
}

export class StampTool {
  private state: StampState = {
    isPreviewing: false,
    previewPosition: null,
  };

  constructor(
    private room: any, // RoomDoc type
    private config: StampToolConfig,
    private userId: string,
    private onInvalidate?: () => void,
  ) {}

  canBegin(): boolean {
    return true;
  }

  begin(_pointerId: number, worldX: number, worldY: number): void {
    // Immediate commit on click
    this.placeStamp(worldX, worldY);
  }

  move(worldX: number, worldY: number): void {
    // Update preview position
    this.state.previewPosition = { x: worldX, y: worldY };
    this.state.isPreviewing = true;
    this.onInvalidate?.();
  }

  end(): void {
    // Already committed on begin
  }

  cancel(): void {
    this.state.isPreviewing = false;
    this.state.previewPosition = null;
    this.onInvalidate?.();
  }

  isActive(): boolean {
    return false; // Stamps are instant, not modal
  }

  getPointerId(): number | null {
    return null;
  }

  getPreview(): StampPreview | null {
    if (!this.state.isPreviewing || !this.state.previewPosition) return null;

    return {
      kind: 'stamp',
      position: this.state.previewPosition,
      stampType: this.config.selected,
      size: 32 * this.config.scale, // Base size * scale
      color: this.config.color || '#666666',
      opacity: 0.5, // Preview opacity
    };
  }

  destroy(): void {
    this.cancel();
  }

  private placeStamp(worldX: number, worldY: number): void {
    const stampId = ulid();
    const size = 32 * this.config.scale; // World units

    try {
      this.room.mutate((ydoc: Y.Doc) => {
        const root = ydoc.getMap('root');
        const strokes = root.get('strokes') as Y.Array<any>;
        const meta = root.get('meta') as Y.Map<any>;

        // Get current scene
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        const currentScene = sceneTicks ? sceneTicks.length : 0;

        // Store stamp as special stroke (for MVP)
        strokes.push([
          {
            id: stampId,
            tool: 'stamp', // Special tool type
            stampType: this.config.selected, // Shape type
            color: this.config.color || '#666666', // Fill color
            size, // Stamp size in world units
            opacity: 1,
            points: [worldX, worldY], // Just center point
            bbox: [worldX - size / 2, worldY - size / 2, worldX + size / 2, worldY + size / 2],
            scene: currentScene,
            createdAt: Date.now(),
            userId: this.userId,
          },
        ]);
      });
    } catch (err) {
      console.error('Failed to place stamp:', err);
    } finally {
      // Clear preview
      this.state.isPreviewing = false;
      this.state.previewPosition = null;
      this.onInvalidate?.();
    }
  }
}
```

---

## Step 4: Update Canvas.tsx Tool Selection

### 4.1 Import New Tools

**File**: `/client/src/canvas/Canvas.tsx`

Add at top with other imports (around line 15):

```typescript
import { TextTool } from '@/lib/tools/TextTool';
import { StampTool } from '@/lib/tools/StampTool';
```

Update PointerTool type (line 18):

```typescript
type PointerTool = DrawingTool | EraserTool | TextTool | StampTool;
```

### 4.2 Add Tool Construction Branches

**File**: `/client/src/canvas/Canvas.tsx`

Add after eraser branch (after line 492):

```typescript
} else if (activeTool === 'text') {
  tool = new TextTool(
    roomDoc,
    text, // From Zustand store
    userId,
    {
      worldToClient,
      getView: () => viewTransformRef.current,
      getEditorHost: () => editorHostRef.current, // Pass DOM overlay ref
    },
    () => overlayLoopRef.current?.invalidateAll(),
  );
} else if (activeTool === 'stamp') { // Note: singular 'stamp'
  tool = new StampTool(
    roomDoc,
    stamp, // From Zustand store (includes selected, scale, color)
    userId,
    () => overlayLoopRef.current?.invalidateAll(),
  );
```

Update Zustand destructuring (line 158):

```typescript
const { activeTool, pen, highlighter, eraser, text, stamp } = useDeviceUIStore();
```

### 4.3 Add View Change Hook

**File**: `/client/src/canvas/Canvas.tsx`

Add to the transform effect (line 648):

```typescript
useEffect(() => {
  // Existing invalidation code...
  renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
  overlayLoopRef.current?.invalidateAll();

  // NEW: Notify tool of view change for DOM repositioning
  if (toolRef.current && 'onViewChange' in toolRef.current) {
    (toolRef.current as any).onViewChange();
  }
}, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);
```

### 4.4 Canvas Cursor Strategy (CRITICAL)

**File**: `/client/src/canvas/Canvas.tsx`

**IMPORTANT**: The canvas cursor should remain simple - either 'none' for eraser or 'crosshair' for everything else.
Do NOT set tool-specific cursors at the canvas level.

**Current Implementation (line 521) - KEEP AS IS**:

```typescript
// This is CORRECT - do not change
canvas.style.cursor = activeTool === 'eraser' ? 'none' : 'crosshair';
```

**Cursor Strategy by Tool**:

- **Eraser**: Hide OS cursor (`'none'`) - custom circle drawn in overlay (already implemented)
- **Pen/Highlighter**: Use `'crosshair'` (already working)
- **Text**: Use `'crosshair'` for placement mode. The I-beam cursor appears ONLY in the contenteditable DOM element
- **Stamp**: Use `'crosshair'` for placement (same as pen/highlighter)
- **Pan** (future): Will use `'grab'`/`'grabbing'` when implemented

**No changes needed to Canvas.tsx cursor logic** - it's already correct!

---

## Step 5: Implement Rendering Layers

### 5.1 Implement Text Rendering

**File**: `/client/src/renderer/layers/text.ts` (NEW FILE)

```typescript
import type { Snapshot, ViewTransform, TextView } from '@avlo/shared';
import type { ViewportInfo } from '../types';

export function drawText(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  _view: ViewTransform,
  viewport: ViewportInfo,
): void {
  const texts = snapshot.texts;
  if (!texts || texts.length === 0) return;

  // Save context state
  ctx.save();

  // Use viewport visible bounds for culling
  const visibleBounds = (viewport as any).visibleWorldBounds;

  for (const text of texts) {
    // Culling check
    if (visibleBounds) {
      if (
        text.x + text.w < visibleBounds.minX ||
        text.x > visibleBounds.maxX ||
        text.y + text.h < visibleBounds.minY ||
        text.y > visibleBounds.maxY
      ) {
        continue;
      }
    }

    // Draw text
    ctx.fillStyle = text.color;
    ctx.font = `${text.size}px Inter, system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';

    // Simple rendering at x,y position
    ctx.fillText(text.content, text.x, text.y);

    // Debug: Draw bounding box in dev
    if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
      ctx.strokeStyle = 'rgba(255, 0, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(text.x, text.y, text.w, text.h);
    }
  }

  ctx.restore();
}
```

### 5.2 Implement Stamp Rendering

**File**: `/client/src/renderer/layers/stamps.ts` (NEW FILE)

```typescript
import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';

// Stamp atlas - basic shapes
const STAMP_PATHS: Record<string, Path2D> = {};

// Initialize stamp paths
function initStampPaths() {
  if (Object.keys(STAMP_PATHS).length > 0) return;

  // Circle
  const circle = new Path2D();
  circle.arc(0, 0, 16, 0, Math.PI * 2);
  STAMP_PATHS['circle'] = circle;

  // Square
  const square = new Path2D();
  square.rect(-14, -14, 28, 28);
  STAMP_PATHS['square'] = square;

  // Triangle
  const triangle = new Path2D();
  triangle.moveTo(0, -16);
  triangle.lineTo(-14, 12);
  triangle.lineTo(14, 12);
  triangle.closePath();
  STAMP_PATHS['triangle'] = triangle;

  // Star
  const star = new Path2D();
  const spikes = 5;
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (i * Math.PI) / spikes;
    const radius = i % 2 === 0 ? 16 : 8;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) star.moveTo(x, y);
    else star.lineTo(x, y);
  }
  star.closePath();
  STAMP_PATHS['star'] = star;

  // Heart
  const heart = new Path2D();
  heart.moveTo(0, -8);
  heart.bezierCurveTo(-16, -20, -16, -8, 0, 4);
  heart.bezierCurveTo(16, -8, 16, -20, 0, -8);
  STAMP_PATHS['heart'] = heart;
}

export function drawStamps(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  _view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Filter strokes for stamps
  const stamps = snapshot.strokes.filter((s) => (s as any).tool === 'stamp');
  if (stamps.length === 0) return;

  initStampPaths();

  ctx.save();

  const visibleBounds = (viewport as any).visibleWorldBounds;

  for (const stamp of stamps) {
    // Culling
    if (visibleBounds && stamp.bbox) {
      if (
        stamp.bbox[2] < visibleBounds.minX ||
        stamp.bbox[0] > visibleBounds.maxX ||
        stamp.bbox[3] < visibleBounds.minY ||
        stamp.bbox[1] > visibleBounds.maxY
      ) {
        continue;
      }
    }

    // Get stamp properties
    const cx = stamp.points[0];
    const cy = stamp.points[1];
    const stampType = (stamp as any).stampType || 'circle';
    const path = STAMP_PATHS[stampType];
    const color = (stamp as any).color || stamp.style.color;
    const size = (stamp as any).size || stamp.style.size;

    if (!path) continue;

    // Draw stamp
    ctx.save();
    ctx.translate(cx, cy);

    const scale = size / 32; // Base size is 32
    ctx.scale(scale, scale);

    ctx.fillStyle = color;
    ctx.globalAlpha = stamp.style.opacity;
    ctx.fill(path);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 1 / scale;
    ctx.stroke(path);

    ctx.restore();
  }

  ctx.restore();
}
```

### 5.3 Update Layer Index

**File**: `/client/src/renderer/layers/index.ts`

Replace stub implementations:

```typescript
// Import new implementations
export { drawText } from './text';
import { drawStamps } from './stamps';

// Update drawShapes to call drawStamps
export function drawShapes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Phase 9: Stamps rendering
  drawStamps(ctx, snapshot, view, viewport);
}
```

---

## Step 6: Add Overlay Preview Support

### 6.1 Update Overlay Renderer

**File**: `/client/src/renderer/OverlayRenderLoop.ts`

Add in the preview discriminant block after eraser branch (after line 147):

```typescript
} else if (previewToDraw.kind === 'text') {
  // Text preview (world space)
  ctx.save();
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);

  // Draw placement box with dashed outline
  ctx.strokeStyle = previewToDraw.isPlacing ? 'rgba(59, 130, 246, 0.5)' : 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 2 / view.scale; // Keep consistent visual thickness
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(
    previewToDraw.box.x,
    previewToDraw.box.y,
    previewToDraw.box.w,
    previewToDraw.box.h
  );

  // Optional: Draw placement crosshair
  if (previewToDraw.isPlacing) {
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
    ctx.lineWidth = 1 / view.scale;
    ctx.setLineDash([]);
    // Vertical line
    ctx.beginPath();
    ctx.moveTo(previewToDraw.box.x, previewToDraw.box.y - 5);
    ctx.lineTo(previewToDraw.box.x, previewToDraw.box.y + 5);
    ctx.stroke();
    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(previewToDraw.box.x - 5, previewToDraw.box.y);
    ctx.lineTo(previewToDraw.box.x + 5, previewToDraw.box.y);
    ctx.stroke();
  }

  ctx.restore();
} else if (previewToDraw.kind === 'stamp') {
  // Stamp preview (world space)
  ctx.save();
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);

  // Draw ghost stamp based on shape type
  ctx.globalAlpha = previewToDraw.opacity;
  ctx.fillStyle = previewToDraw.color;

  const size = previewToDraw.size;
  const cx = previewToDraw.position.x;
  const cy = previewToDraw.position.y;

  ctx.save();
  ctx.translate(cx, cy);

  switch(previewToDraw.stampType) {
    case 'circle':
      ctx.beginPath();
      ctx.arc(0, 0, size/2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'square':
      ctx.fillRect(-size/2, -size/2, size, size);
      break;
    case 'triangle':
      ctx.beginPath();
      ctx.moveTo(0, -size/2);
      ctx.lineTo(-size/2, size/2);
      ctx.lineTo(size/2, size/2);
      ctx.closePath();
      ctx.fill();
      break;
    case 'star':
      // Simple 5-point star
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? size/2 : size/4;
        const angle = (i * Math.PI) / 5;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case 'heart':
      // Simple heart shape
      ctx.beginPath();
      const s = size / 32; // Scale factor
      ctx.moveTo(0, -8 * s);
      ctx.bezierCurveTo(-16 * s, -20 * s, -16 * s, -8 * s, 0, 4 * s);
      ctx.bezierCurveTo(16 * s, -8 * s, 16 * s, -20 * s, 0, -8 * s);
      ctx.fill();
      break;
  }

  ctx.restore();
  ctx.restore();
}
```

---

## Step 7: Add CSS for Text Editor

### 7.1 Add Text Editor Styles

**File**: `/client/src/styles/globals.css` (or create canvas.css)

```css
/* Text editor overlay styles */
.text-editor-overlay {
  font-family:
    Inter,
    system-ui,
    -apple-system,
    sans-serif;
  line-height: 1.4;
  word-wrap: break-word;
  max-width: 400px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transition: box-shadow 0.2s ease;
}

.text-editor-overlay:focus {
  border-color: #3b82f6;
  box-shadow:
    0 0 0 3px rgba(59, 130, 246, 0.1),
    0 2px 8px rgba(0, 0, 0, 0.15);
}

/* DOM overlay root - ensure it doesn't block events except for children */
.dom-overlay-root {
  pointer-events: none;
}

.dom-overlay-root > * {
  pointer-events: auto;
}
```

---

## Step 8: Handle Hit Testing for Eraser (CRITICAL)

### 8.1 Update Eraser Hit Testing for Stamps

**File**: `/client/src/lib/tools/EraserTool.ts`

Add specialized hit-testing for stamps in `updateHitTest` method (after line 211):

```typescript
// Test strokes starting from resume index
for (let i = this.resumeIndex; i < candidateStrokes.length; i++) {
  const stroke = candidateStrokes[i];

  // CRITICAL: Special handling for stamps (single point, no segments)
  if ((stroke as any).tool === 'stamp') {
    // Use LIVE VIEW for accurate radius conversion
    const view = this.getView ? this.getView() : snapshot.view;
    const radiusEraserWorld = this.state.radiusPx / view.scale;

    const [cx, cy] = stroke.points; // Center point only
    const size = (stroke as any).size ?? stroke.style.size ?? 32;
    const radiusStampWorld = size / 2;

    // Check circle-circle collision
    const dx = worldX - cx;
    const dy = worldY - cy;
    const distSq = dx * dx + dy * dy;
    const totalRadius = radiusEraserWorld + radiusStampWorld;

    if (distSq <= totalRadius * totalRadius) {
      this.state.hitNow.add(stroke.id);
    }
    continue; // Skip segment test for stamps
  }

  // Regular stroke hit-testing with segments...
  // (existing code)
}
```

## Step 9: Update ToolPanel with Settings UI

### 9.1 Fix Tool Naming and Add Settings Panels

**File**: `/client/src/pages/components/ToolPanel.tsx`

```typescript
// Fix typo on line 229
{/* Stamps Tools */}  // Changed from "SStamps Tools"

// Change tool from 'stamps' to 'stamp' (line 231-232)
<ToolButton
  tool="stamp"  // Changed from "stamps"
  isActive={activeTool === 'stamp'}  // Changed
  onClick={() => handleToolClick('stamp')}  // Changed
  tooltip="Stamps (V)"
>

// Update handleToolClick to handle stamp (line 149)
} else if (tool === 'eraser' || tool === 'text' || tool === 'stamp' || tool === 'pan') {
  // Changed from 'stamps'

// Add settings UI after the buttons (after line 290)
</button>

{/* Tool Settings Panels */}
{activeTool === 'text' && (
  <div className="tool-settings">
    <div className="tool-divider" />
    <label className="setting-row">
      <span className="setting-label">Size</span>
      <input
        type="range"
        min={10}
        max={48}
        value={text.size}
        onChange={(e) => setTextSettings({ size: Number(e.target.value) })}
        className="setting-slider"
      />
      <span className="setting-value">{text.size}px</span>
    </label>
    <label className="setting-row">
      <span className="setting-label">Color</span>
      <input
        type="color"
        value={text.color}
        onChange={(e) => setTextSettings({ color: e.target.value })}
        className="setting-color"
      />
    </label>
  </div>
)}

{activeTool === 'stamp' && (
  <div className="tool-settings">
    <div className="tool-divider" />
    <div className="stamp-picker">
      {['circle', 'square', 'triangle', 'star', 'heart'].map((shape) => (
        <button
          key={shape}
          className={`stamp-btn ${stamp.selected === shape ? 'active' : ''}`}
          onClick={() => setStampSettings({ selected: shape })}
          aria-label={`Select ${shape} stamp`}
        >
          {/* Simple shape icons */}
          {shape === 'circle' && '○'}
          {shape === 'square' && '□'}
          {shape === 'triangle' && '△'}
          {shape === 'star' && '☆'}
          {shape === 'heart' && '♡'}
        </button>
      ))}
    </div>
    <label className="setting-row">
      <span className="setting-label">Size</span>
      <input
        type="range"
        min={0.5}
        max={3}
        step={0.1}
        value={stamp.scale}
        onChange={(e) => setStampSettings({ scale: Number(e.target.value) })}
        className="setting-slider"
      />
      <span className="setting-value">{(stamp.scale * 100).toFixed(0)}%</span>
    </label>
  </div>
)}
```

### 9.2 Add Missing Store References

**File**: `/client/src/pages/components/ToolPanel.tsx`

```typescript
// Update destructuring at top (around line 31)
const {
  activeTool,
  toolbarPos,
  editorCollapsed,
  text, // Add text settings
  stamp, // Add stamp settings
  setActiveTool,
  setToolbarPosition,
  setTextSettings, // Add setter
  setStampSettings, // Add setter
} = useDeviceUIStore();
```

## Step 10: Add CSS for Tool Settings

**File**: `/client/src/styles/globals.css`

```css
/* Tool settings panel */
.tool-settings {
  padding: 8px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 0 0 8px 8px;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
  font-size: 12px;
}

.setting-label {
  min-width: 35px;
  color: #64748b;
}

.setting-slider {
  flex: 1;
  height: 4px;
}

.setting-value {
  min-width: 40px;
  text-align: right;
  color: #475569;
}

.setting-color {
  width: 32px;
  height: 24px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  cursor: pointer;
}

.stamp-picker {
  display: flex;
  gap: 4px;
  padding: 8px 4px;
  justify-content: space-around;
}

.stamp-btn {
  width: 28px;
  height: 28px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: white;
  color: #64748b;
  font-size: 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.stamp-btn:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.stamp-btn.active {
  background: #3b82f6;
  color: white;
  border-color: #3b82f6;
}
```

## References

- DrawingTool pattern: `/client/src/lib/tools/DrawingTool.ts`
- EraserTool live view: `/client/src/lib/tools/EraserTool.ts:162`
- Canvas tool selection: `/client/src/canvas/Canvas.tsx:469-509`
- Transform effect: `/client/src/canvas/Canvas.tsx:642-649`
- Layer rendering: `/client/src/renderer/layers/`
- Yjs mutation pattern: DrawingTool.ts:249-281
- Preview union types: `/client/src/lib/tools/types.ts`
- PointerTool interface pattern for polymorphic handling
