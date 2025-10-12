# Pixi.js Migration Implementation Guide

## Executive Summary

This guide provides detailed, step-by-step instructions for migrating from Canvas 2D to Pixi.js for the AVLO whiteboard. The migration preserves the existing architecture's strengths while enabling GPU-accelerated rendering through direct Yjs observation.

**Core Strategy:**
- Create a read-only Y access adapter in RoomDocManager
- Implement PixiManager to own the Pixi application and stage graph
- Create PixiRoomBinder to observe Yjs changes and update Pixi graphics
- Preserve stable event handler patterns from Canvas.tsx
- Maintain pixel-perfect Perfect Freehand rendering with canonical tuples

---

## Phase 1: Core Infrastructure Setup

### Step 1.1: Install Pixi.js v8

```bash
npm install pixi.js@^8
```

Pixi v8 provides native SVG path support which is critical for Perfect Freehand rendering.

### Step 1.2: Create Read-Only Y Access Adapter

**File:** `client/src/lib/room-doc-manager.ts`

Add after line 109 in the IRoomDocManager interface:

```typescript
export interface IRoomDocManager {
  // ... existing methods ...

  /**
   * INTERNAL: Read-only Y access for renderer binding.
   * DO NOT USE from React components - use subscription hooks instead.
   * @internal
   */
  __internal_getYReadAccess(): YReadOnlyAccess | null;
}

// Add new interface after IRoomDocManager
export interface YReadOnlyAccess {
  getYDoc(): Y.Doc;
  getYStrokes(): Y.Array<any>;
  getYSceneTicks(): Y.Array<number>;
  getYTexts(): Y.Array<any>;
  getYMeta(): Y.Map<any>;
  getCurrentScene(): number;
  getUserId(): string;
}
```

Add implementation in RoomDocManagerImpl (around line 950):

```typescript
public __internal_getYReadAccess(): YReadOnlyAccess | null {
  // Only allow after initialization
  if (!this.ydoc.getMap('root').has('meta')) {
    return null;
  }

  return {
    getYDoc: () => this.ydoc,
    getYStrokes: () => this.getStrokes(),
    getYSceneTicks: () => this.getSceneTicks(),
    getYTexts: () => this.getTexts(),
    getYMeta: () => this.getMeta(),
    getCurrentScene: () => this.getCurrentScene(),
    getUserId: () => this.userId,
  };
}
```

### Step 1.3: Create PixiManager Class

**File:** `client/src/pixi/PixiManager.ts`

```typescript
import { Application, Container, Graphics } from 'pixi.js';
import type { IRoomDocManager, YReadOnlyAccess, ViewTransform } from '@avlo/shared';
import { PixiRoomBinder } from './PixiRoomBinder';
import type { PreviewProvider } from '../renderer/types';

export interface PixiManagerOptions {
  room: IRoomDocManager;
}

export class PixiManager {
  private app: Application;
  private world = new Container();
  private overlayWorld = new Container();
  private overlayHUD = new Container();
  private binder: PixiRoomBinder | null = null;
  private destroyed = false;

  // Store refs for stable access
  private viewTransformRef: ViewTransform | null = null;

  constructor(private opts: PixiManagerOptions) {
    // Create Pixi app with ticker stopped (event-driven rendering)
    this.app = new Application();

    // Build stage hierarchy
    this.app.stage.addChild(this.world);
    this.world.addChild(this.overlayWorld);
    this.app.stage.addChild(this.overlayHUD);
  }

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    if (this.destroyed) return;

    // Initialize Pixi with the canvas
    await this.app.init({
      canvas,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      backgroundColor: 0xffffff,
      backgroundAlpha: 1,
    });

    // Stop ticker - we render on demand
    this.app.ticker.stop();

    // Get Y access and create binder
    const yAccess = this.opts.room.__internal_getYReadAccess();
    if (!yAccess) {
      console.warn('[PixiManager] Y structures not initialized yet');
      return;
    }

    this.binder = new PixiRoomBinder({
      yAccess,
      world: this.world,
      overlayHUD: this.overlayHUD,
      renderNow: (reason: string) => this.renderNow(reason),
    });

    // Attach Y observers
    this.binder.attach();

    // Initial render
    this.renderNow('mount');
  }

  destroy(): void {
    this.destroyed = true;
    this.binder?.detach();
    this.app.destroy(true, { children: true });
  }

  applyTransform(scale: number, pan: { x: number; y: number }): void {
    if (this.destroyed) return;

    // Apply to world container only
    this.world.scale.set(scale);
    this.world.position.set(-pan.x * scale, -pan.y * scale);

    // Store for reference
    this.viewTransformRef = {
      scale,
      pan,
      worldToCanvas: (x: number, y: number) => [(x - pan.x) * scale, (y - pan.y) * scale],
      canvasToWorld: (x: number, y: number) => [x / scale + pan.x, y / scale + pan.y],
    };

    this.renderNow('transform');
  }

  renderNow(reason: string): void {
    if (this.destroyed || !this.app.renderer) return;

    console.debug(`[PixiManager] Rendering: ${reason}`);
    this.app.render();
  }

  getOverlayWorld(): Container {
    return this.overlayWorld;
  }

  getViewTransform(): ViewTransform | null {
    return this.viewTransformRef;
  }

  resize(width: number, height: number): void {
    if (this.destroyed || !this.app.renderer) return;

    this.app.renderer.resize(width, height);
    this.renderNow('resize');
  }
}
```

### Step 1.4: Create PixiRoomBinder Class

**File:** `client/src/pixi/PixiRoomBinder.ts`

```typescript
import { Container, Graphics, GraphicsPath } from 'pixi.js';
import type { YReadOnlyAccess, Stroke } from '@avlo/shared';
import * as Y from 'yjs';
import { getStroke } from 'perfect-freehand';
import { getSvgPathFromStroke } from '../renderer/stroke-builder/pf-svg';
import { PF_OPTIONS_BASE } from '../renderer/stroke-builder/pf-config';

interface PixiRoomBinderOptions {
  yAccess: YReadOnlyAccess;
  world: Container;
  overlayHUD: Container;
  renderNow: (reason: string) => void;
}

export class PixiRoomBinder {
  private world: Container;
  private overlayHUD: Container;
  private yAccess: YReadOnlyAccess;
  private renderNow: (reason: string) => void;

  private strokeGraphics = new Map<string, Graphics>();
  private strokesContainer = new Container();
  private currentScene = 0;

  // Store observer functions for cleanup
  private observers: Array<() => void> = [];

  constructor(private opts: PixiRoomBinderOptions) {
    this.world = opts.world;
    this.overlayHUD = opts.overlayHUD;
    this.yAccess = opts.yAccess;
    this.renderNow = opts.renderNow;

    // Add strokes container to world
    this.world.addChild(this.strokesContainer);
  }

  attach(): void {
    const yStrokes = this.yAccess.getYStrokes();
    const ySceneTicks = this.yAccess.getYSceneTicks();

    // Get current scene
    this.currentScene = this.yAccess.getCurrentScene();

    // Initial materialization of existing strokes
    yStrokes.forEach((stroke: Stroke) => {
      this.materializeStroke(stroke);
    });

    // Observe stroke array changes
    const strokesObserver = (event: Y.YArrayEvent<Stroke>) => {
      let needsRender = false;

      event.changes.added.forEach((item) => {
        item.content.getContent().forEach((stroke: Stroke) => {
          this.materializeStroke(stroke);
          needsRender = true;
        });
      });

      event.changes.deleted.forEach((item) => {
        item.content.getContent().forEach((stroke: Stroke) => {
          this.removeStrokeGraphics(stroke.id);
          needsRender = true;
        });
      });

      if (needsRender) {
        this.renderNow('strokes-changed');
      }
    };

    yStrokes.observe(strokesObserver);
    this.observers.push(() => yStrokes.unobserve(strokesObserver));

    // Observe scene changes
    const sceneObserver = () => {
      const newScene = this.yAccess.getCurrentScene();
      if (newScene !== this.currentScene) {
        this.currentScene = newScene;
        this.updateSceneVisibility();
        this.renderNow('scene-changed');
      }
    };

    ySceneTicks.observe(sceneObserver);
    this.observers.push(() => ySceneTicks.unobserve(sceneObserver));

    // Initial render
    this.renderNow('attach');
  }

  detach(): void {
    // Unobserve all
    this.observers.forEach(unobserve => unobserve());
    this.observers = [];

    // Clear graphics
    this.strokeGraphics.forEach(g => g.destroy());
    this.strokeGraphics.clear();
  }

  private materializeStroke(stroke: Stroke): void {
    // Check if already exists
    if (this.strokeGraphics.has(stroke.id)) {
      return;
    }

    const g = new Graphics();

    // Store stroke data for later reference
    (g as any).__strokeData = stroke;

    // Build geometry based on kind
    if (stroke.kind === 'freehand' && stroke.pointsTuples) {
      this.buildFreehandGeometry(g, stroke);
    } else {
      // Shape strokes (future)
      this.buildPolylineGeometry(g, stroke);
    }

    // Set visibility based on scene
    g.visible = (stroke.scene === this.currentScene);

    // Add to container and map
    this.strokesContainer.addChild(g);
    this.strokeGraphics.set(stroke.id, g);
  }

  private buildFreehandGeometry(g: Graphics, stroke: Stroke): void {
    if (!stroke.pointsTuples || stroke.pointsTuples.length < 2) {
      return;
    }

    // Build Perfect Freehand outline
    const outline = getStroke(stroke.pointsTuples, {
      ...PF_OPTIONS_BASE,
      size: stroke.size,
      last: true, // Finalized geometry
    });

    if (outline.length < 3) {
      return;
    }

    // Convert to SVG path (NOT closed - PF provides complete outline)
    const svgPath = getSvgPathFromStroke(outline, false);

    // Parse color and build a GraphicsPath from the raw SVG "d" string
    const color = parseInt(stroke.color.replace('#', '0x'), 16);
    const path = new GraphicsPath(svgPath);

    // Pixi v8: Build geometry first, then style with .fill()
    g.clear();
    g.path(path).fill({ color, alpha: stroke.opacity });
  }

  private buildPolylineGeometry(g: Graphics, stroke: Stroke): void {
    if (!stroke.points || stroke.points.length < 4) {
      return;
    }

    const color = parseInt(stroke.color.replace('#', '0x'), 16);

    // Pixi v8: Build geometry first, then style with .stroke()
    g.clear();

    // Draw polyline from flat points array
    g.moveTo(stroke.points[0], stroke.points[1]);

    for (let i = 2; i < stroke.points.length; i += 2) {
      g.lineTo(stroke.points[i], stroke.points[i + 1]);
    }

    // Apply stroke styling after geometry
    g.stroke({
      width: stroke.size,
      color,
      alpha: stroke.opacity,
      cap: 'round',
      join: 'round',
    });
  }

  private removeStrokeGraphics(strokeId: string): void {
    const g = this.strokeGraphics.get(strokeId);
    if (!g) return;

    this.strokesContainer.removeChild(g);
    g.destroy();
    this.strokeGraphics.delete(strokeId);
  }

  private updateSceneVisibility(): void {
    this.strokeGraphics.forEach((g, id) => {
      const strokeData = (g as any).__strokeData;
      if (strokeData) {
        g.visible = (strokeData.scene === this.currentScene);
      }
    });
  }
}
```

---

## Phase 2: Tool Manager Implementation

### Step 2.1: Create PixiDrawingTool

**File:** `client/src/pixi/tools/PixiDrawingTool.ts`

```typescript
import { Container, Graphics, GraphicsPath } from 'pixi.js';
import type { IRoomDocManager, PreviewData } from '@avlo/shared';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { getStroke } from 'perfect-freehand';
import { getSvgPathFromStroke } from '../../renderer/stroke-builder/pf-svg';
import { PF_OPTIONS_BASE } from '../../renderer/stroke-builder/pf-config';

export interface PixiDrawingToolOptions {
  room: IRoomDocManager;
  toolType: 'pen' | 'highlighter';
  settings: { color: string; size: number; opacity: number };
  overlayWorld: Container;
  renderNow: () => void;
}

export class PixiDrawingTool {
  private overlay = new Graphics();
  private isDrawing = false;
  private pointerId: number | null = null;

  // Dual arrays maintained in lockstep
  private points: number[] = [];          // Flat array for bbox
  private pointsTuples: [number, number][] = []; // PF canonical tuples

  private config: { color: string; size: number; opacity: number };

  constructor(private opts: PixiDrawingToolOptions) {
    this.config = { ...opts.settings };
    opts.overlayWorld.addChild(this.overlay);
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.isDrawing) return;

    this.isDrawing = true;
    this.pointerId = pointerId;

    // Initialize both arrays
    this.points = [worldX, worldY];
    this.pointsTuples = [[worldX, worldY]];

    // Start preview
    this.updatePreview();
  }

  move(worldX: number, worldY: number): void {
    if (!this.isDrawing) return;

    // Check for duplicates
    const L = this.points.length;
    if (L >= 2 && this.points[L-2] === worldX && this.points[L-1] === worldY) {
      return;
    }

    // Append to both arrays (lockstep!)
    this.points.push(worldX, worldY);
    this.pointsTuples.push([worldX, worldY]);

    // Update preview
    this.updatePreview();
  }

  end(worldX?: number, worldY?: number): void {
    if (!this.isDrawing) return;

    // Add final point if provided
    if (worldX !== undefined && worldY !== undefined) {
      this.points.push(worldX, worldY);
      this.pointsTuples.push([worldX, worldY]);
    }

    // Commit stroke
    this.commitStroke();

    // Clear preview
    this.overlay.clear();
    this.opts.renderNow();

    // Reset state
    this.isDrawing = false;
    this.pointerId = null;
    this.points = [];
    this.pointsTuples = [];
  }

  cancel(): void {
    this.overlay.clear();
    this.opts.renderNow();
    this.isDrawing = false;
    this.pointerId = null;
    this.points = [];
    this.pointsTuples = [];
  }

  isActive(): boolean {
    return this.isDrawing;
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    if (!this.isDrawing) return null;

    return {
      kind: 'stroke',
      points: this.pointsTuples, // PF-native tuples
      tool: this.opts.toolType,
      color: this.config.color,
      size: this.config.size,
      opacity: this.config.opacity,
      bbox: this.calculateBBox(),
    };
  }

  destroy(): void {
    this.overlay.destroy();
  }

  private updatePreview(): void {
    if (this.pointsTuples.length < 2) return;

    // Build Perfect Freehand outline for preview
    const outline = getStroke(this.pointsTuples, {
      ...PF_OPTIONS_BASE,
      size: this.config.size,
      last: false, // Live preview
    });

    if (outline.length < 3) return;

    // Convert to SVG path (NOT closed - PF provides complete outline)
    const svgPath = getSvgPathFromStroke(outline, false);

    // Parse color and build a GraphicsPath from the raw SVG "d" string
    const color = parseInt(this.config.color.replace('#', '0x'), 16);
    const path = new GraphicsPath(svgPath);

    // Pixi v8: Build geometry first, then style with .fill()
    this.overlay.clear();
    this.overlay.path(path).fill({ color, alpha: this.config.opacity });

    // Trigger render
    this.opts.renderNow();
  }

  private commitStroke(): void {
    if (this.pointsTuples.length < 2) return;

    // Clone canonical tuples for immutability
    const canonicalTuples = this.pointsTuples.slice();

    // Calculate final bbox
    const bbox = this.calculateBBox();
    if (!bbox) return;

    // Get Y access for scene info
    const yAccess = this.opts.room.__internal_getYReadAccess();
    if (!yAccess) return;

    const currentScene = yAccess.getCurrentScene();
    const userId = yAccess.getUserId();

    // Commit to Yjs
    this.opts.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const strokes = root.get('strokes') as Y.Array<any>;

      strokes.push([{
        id: ulid(),
        tool: this.opts.toolType,
        color: this.config.color,
        size: this.config.size,
        opacity: this.config.opacity,
        points: this.points,           // Flat array (backward compat)
        pointsTuples: canonicalTuples, // Canonical PF tuples
        bbox,
        scene: currentScene,
        createdAt: Date.now(),
        userId,
        kind: 'freehand',
      }]);
    });
  }

  private calculateBBox(): [number, number, number, number] | null {
    if (this.points.length < 2) return null;

    let minX = this.points[0];
    let minY = this.points[1];
    let maxX = this.points[0];
    let maxY = this.points[1];

    for (let i = 2; i < this.points.length; i += 2) {
      minX = Math.min(minX, this.points[i]);
      maxX = Math.max(maxX, this.points[i]);
      minY = Math.min(minY, this.points[i + 1]);
      maxY = Math.max(maxY, this.points[i + 1]);
    }

    // Inflate by stroke size
    const padding = this.config.size * 0.5 + 1;
    return [minX - padding, minY - padding, maxX + padding, maxY + padding];
  }
}
```

---

## Phase 3: Canvas Integration

### Step 3.1: Create PixiCanvas Component

**File:** `client/src/canvas/PixiCanvas.tsx`

```typescript
import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { RoomId, ViewTransform } from '@avlo/shared';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useViewTransform } from './ViewTransformContext';
import { PixiManager } from '../pixi/PixiManager';
import { PixiDrawingTool } from '../pixi/tools/PixiDrawingTool';
import { useDeviceUIStore } from '@/stores/device-ui-store';

interface PixiCanvasProps {
  roomId: RoomId;
}

export const PixiCanvas: React.FC<PixiCanvasProps> = ({ roomId }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixiManagerRef = useRef<PixiManager | null>(null);
  const toolRef = useRef<PixiDrawingTool | null>(null);

  // Get room and transform
  const roomDoc = useRoomDoc(roomId);
  const { viewTransform, setScale, setPan } = useViewTransform();

  // Get device UI state
  const {
    activeTool,
    pen,
    highlighter,
    eraser,
    text,
    shape,
  } = useDeviceUIStore();

  // Store refs for stable event handlers
  const viewTransformRef = useRef(viewTransform);
  const roomDocRef = useRef(roomDoc);

  useEffect(() => {
    viewTransformRef.current = viewTransform;
  }, [viewTransform]);

  useEffect(() => {
    roomDocRef.current = roomDoc;
  }, [roomDoc]);

  // Initialize PixiManager
  useEffect(() => {
    if (!canvasRef.current) return;

    const manager = new PixiManager({
      room: roomDoc,
    });

    pixiManagerRef.current = manager;

    // Mount to canvas
    manager.mount(canvasRef.current);

    return () => {
      manager.destroy();
      pixiManagerRef.current = null;
    };
  }, [roomDoc]);

  // Apply transform changes
  useEffect(() => {
    if (!pixiManagerRef.current) return;

    pixiManagerRef.current.applyTransform(
      viewTransform.scale,
      viewTransform.pan
    );
  }, [viewTransform]);

  // Tool management
  useEffect(() => {
    if (!pixiManagerRef.current) return;

    // Clean up previous tool
    if (toolRef.current) {
      toolRef.current.destroy();
      toolRef.current = null;
    }

    // Create new tool based on active tool
    if (activeTool === 'pen' || activeTool === 'highlighter') {
      const settings = activeTool === 'pen' ? pen : highlighter;

      toolRef.current = new PixiDrawingTool({
        room: roomDoc,
        toolType: activeTool,
        settings: {
          color: settings.color,
          size: settings.size,
          opacity: settings.opacity ?? 1,
        },
        overlayWorld: pixiManagerRef.current.getOverlayWorld(),
        renderNow: () => pixiManagerRef.current?.renderNow('tool-preview'),
      });
    }
    // Add other tools (eraser, text, shape) later

  }, [activeTool, pen, highlighter, roomDoc]);

  // Stable coordinate conversion functions
  const screenToWorld = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const canvas = canvasRef.current;
    const transform = viewTransformRef.current;
    if (!canvas || !transform) return null;

    const rect = canvas.getBoundingClientRect();
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;

    return transform.canvasToWorld(canvasX, canvasY);
  }, []);

  // Pointer event handlers (stable with refs)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handlePointerDown = (e: PointerEvent) => {
      e.preventDefault();

      // Skip if not left button
      if (e.button !== 0) return;

      // Skip on mobile for now
      if ('ontouchstart' in window) return;

      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;

      // Update awareness
      roomDocRef.current.updateActivity('drawing');

      // Start tool
      if (toolRef.current) {
        canvas.setPointerCapture(e.pointerId);
        toolRef.current.begin(e.pointerId, world[0], world[1]);
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;

      // Update cursor
      roomDocRef.current.updateCursor(world[0], world[1]);

      // Move tool
      if (toolRef.current?.isActive()) {
        toolRef.current.move(world[0], world[1]);
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      const world = screenToWorld(e.clientX, e.clientY);

      // Release capture
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}

      // Update awareness
      roomDocRef.current.updateActivity('idle');

      // End tool
      if (toolRef.current?.isActive()) {
        if (world) {
          toolRef.current.end(world[0], world[1]);
        } else {
          toolRef.current.end();
        }
      }
    };

    const handlePointerCancel = (e: PointerEvent) => {
      // Cancel tool
      if (toolRef.current?.isActive()) {
        toolRef.current.cancel();
      }

      // Update awareness
      roomDocRef.current.updateActivity('idle');
    };

    const handlePointerLeave = (e: PointerEvent) => {
      // Clear cursor
      roomDocRef.current.updateCursor(undefined, undefined);
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Normalize wheel delta
      const delta = e.deltaY;
      const steps = delta / 120;
      const factor = Math.exp(-steps * Math.log(1.09));

      const v = viewTransformRef.current;

      // Calculate new scale
      const newScale = Math.max(0.1, Math.min(10, v.scale * factor));

      // Calculate pan to zoom around cursor
      const worldX = canvasX / v.scale + v.pan.x;
      const worldY = canvasY / v.scale + v.pan.y;

      const newPan = {
        x: worldX - canvasX / newScale,
        y: worldY - canvasY / newScale,
      };

      // Apply transform
      setScale(newScale);
      setPan(newPan);
    };

    // Attach listeners
    canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
    canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
    canvas.addEventListener('pointerup', handlePointerUp, { passive: false });
    canvas.addEventListener('pointercancel', handlePointerCancel, { passive: false });
    canvas.addEventListener('lostpointercapture', handlePointerCancel, { passive: false });
    canvas.addEventListener('pointerleave', handlePointerLeave, { passive: false });
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerCancel);
      canvas.removeEventListener('lostpointercapture', handlePointerCancel);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [screenToWorld, setScale, setPan]);

  // Handle resize
  useEffect(() => {
    if (!pixiManagerRef.current || !canvasRef.current) return;

    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        pixiManagerRef.current?.resize(width, height);
      }
    });

    observer.observe(canvasRef.current);

    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full touch-none"
        style={{ cursor: activeTool === 'eraser' ? 'none' : 'crosshair' }}
      />
    </div>
  );
};
```

---

## Phase 4: Integration Steps

### Step 4.1: Update App Component

Add the PixiCanvas component alongside the existing Canvas component for A/B testing:

**File:** `client/src/App.tsx` or wherever Canvas is used

```typescript
// Add feature flag
const USE_PIXI = process.env.NODE_ENV === 'development' && window.location.search.includes('pixi=true');

// In render:
{USE_PIXI ? (
  <PixiCanvas roomId={roomId} />
) : (
  <Canvas roomId={roomId} />
)}
```

### Step 4.2: Export Required Utilities

Ensure these utilities are exported from their respective modules:

**File:** `client/src/renderer/stroke-builder/pf-svg.ts`
- Export `getSvgPathFromStroke` function

**File:** `client/src/renderer/stroke-builder/pf-config.ts`
- Export `PF_OPTIONS_BASE` constant

---

## Testing Checklist

### Basic Functionality
- [ ] Canvas mounts without errors
- [ ] Pen tool creates strokes
- [ ] Highlighter tool creates semi-transparent strokes
- [ ] Strokes appear on commit
- [ ] Preview matches committed stroke exactly

### Yjs Integration
- [ ] Strokes persist to Y.Doc
- [ ] Strokes survive page refresh
- [ ] Remote strokes appear via WebSocket
- [ ] Scene filtering works (Clear Board)

### Performance
- [ ] No continuous RAF loop (check DevTools)
- [ ] Render only on events
- [ ] Memory usage stable during drawing
- [ ] No memory leaks on unmount

### Coordinate System
- [ ] World coordinates consistent
- [ ] Zoom works around cursor
- [ ] Pan updates correctly
- [ ] Strokes stay in correct position after zoom/pan

---

## Key Architecture Decisions

### 1. Read-Only Y Access Pattern
The `__internal_getYReadAccess()` method provides controlled access to Y structures without breaking RoomDocManager encapsulation. This is internal-only and should never be used from React components.

### 2. Event-Driven Rendering
Pixi ticker is stopped; rendering happens only on:
- Yjs changes
- Tool preview updates
- Transform changes
- Initial mount

### 3. Canonical Tuples Strategy
Maintaining `pointsTuples` alongside flat `points` ensures:
- Zero conversion overhead in preview
- Pixel-perfect preview-commit match
- Consistent Perfect Freehand rendering

### 4. Container Hierarchy
```
stage
├── world (pan/zoom applied here)
│   ├── strokesContainer (committed strokes)
│   └── overlayWorld (tool previews)
└── overlayHUD (screen-space cursors)
```

### 5. Stable Event Handlers
Using refs and empty dependency arrays prevents the "monster effect" where handlers are recreated on every state change.

---

## Performance Optimizations (Future Phases)

### Viewport Culling
```typescript
// In PixiRoomBinder
private cullStrokes(viewport: { minX, minY, maxX, maxY }): void {
  this.strokeGraphics.forEach((g, id) => {
    const stroke = (g as any).__strokeData;
    if (stroke?.bbox) {
      const [minX, minY, maxX, maxY] = stroke.bbox;
      const visible = !(maxX < viewport.minX || minX > viewport.maxX ||
                       maxY < viewport.minY || minY > viewport.maxY);
      g.visible = visible && (stroke.scene === this.currentScene);
    }
  });
}
```

### LOD (Level of Detail)
```typescript
// Skip tiny strokes
const diagonal = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
const screenDiagonal = diagonal * viewTransform.scale;
if (screenDiagonal < 2) {
  g.visible = false;
}
```

### Texture Caching
```typescript
// For complex strokes
if (outline.length > 100) {
  g.cacheAsBitmap = true;
}
```

---

## Troubleshooting

### Common Issues

**1. "Y structures not initialized"**
- Ensure RoomDocManager has completed initialization
- Check gates: `room.getGateStatus()`

**2. Preview doesn't match commit**
- Verify `pointsTuples` are maintained in lockstep with `points`
- Check `last: false` for preview, `last: true` for commit

**3. Strokes not appearing**
- Check scene visibility logic
- Verify Yjs observers are attached
- Check `renderNow()` is called after changes

**4. Memory leaks**
- Ensure all observers are unobserved in `detach()`
- Destroy Graphics objects when removing
- Clean up tools on unmount

---

## Next Phases

### Phase 5: Additional Tools
- Eraser with dim layer
- Text tool with DOM overlay
- Perfect shapes with snap detection
- Lasso selection

### Phase 6: Presence & Cursors
- Remote cursor rendering in overlayHUD
- Cursor interpolation
- Activity indicators

### Phase 7: Optimizations
- Viewport culling with spatial index
- LOD system
- Texture caching for complex strokes
- WebGL batch optimization

### Phase 8: Advanced Features
- Multi-scene support
- Undo/redo integration
- Export to PNG
- Mobile support

---

## Conclusion

This implementation provides a solid foundation for GPU-accelerated rendering with Pixi.js while preserving the existing architecture's strengths. The key is maintaining the canonical tuple strategy for Perfect Freehand consistency and using direct Yjs observation for incremental scene graph updates.

The migration can be done incrementally, starting with basic stroke rendering and progressively adding features. The architecture ensures no regression in functionality while enabling significant performance improvements through WebGL rendering.