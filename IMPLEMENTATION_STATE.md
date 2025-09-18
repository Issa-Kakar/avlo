# AVLO IMPLEMENTATION STATE - Complete Technical Documentation

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Core Data Layer & State Management](#2-core-data-layer--state-management)
3. [Canvas Rendering System](#3-canvas-rendering-system)
4. [Drawing & Tools System](#4-drawing--tools-system)
5. [Real-time Collaboration & Awareness](#5-real-time-collaboration--awareness)
6. [Infrastructure & Persistence](#6-infrastructure--persistence)
7. [UI Components & Integration](#7-ui-components--integration)
8. [Critical Implementation Details](#8-critical-implementation-details)
9. [Performance Optimizations](#9-performance-optimizations)
10. [Testing Architecture](#10-testing-architecture)

---

## 1. Architecture Overview

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                        │
├───────────────────────────┬─────────────────────────────────┤
│      UI Components        │        Core Systems              │
│  Canvas.tsx               │  RoomDocManager                 │
│  Toolbar/                 │  DrawingTool                    │
│  RoomPage.tsx            │  RenderLoop/OverlayRenderLoop  │
├───────────────────────────┴─────────────────────────────────┤
│                    Data Layer (Y.js)                        │
│  Y.Doc → Snapshots → Subscriptions                         │
├─────────────────────────────────────────────────────────────┤
│                      Providers                              │
│  IndexedDB (offline) | WebSocket (sync) | Awareness        │
└───────────────┬─────────────────────────┬───────────────────┘
                ↓                         ↓
┌───────────────────────────┐ ┌─────────────────────────────┐
│    SERVER (Node.js)       │ │   PERSISTENCE               │
│  Express + WebSocket      │ │   Redis (AOF)               │
│  @y/websocket-server      │ │   PostgreSQL (metadata)     │
└───────────────────────────┘ └─────────────────────────────┘
```

### Data Flow Architecture

```
User Input → mutate(fn) → Guards → Y.Doc Transaction → Update Event
     ↓                                                      ↓
Mobile/Size/Frame Guards                            docVersion++
     ↓                                                      ↓
View-Only/Reject                              publishState.isDirty = true
                                                           ↓
                                                      RAF Loop
                                                           ↓
                                              buildSnapshot() or clone
                                                           ↓
                                              Notify All Subscribers
                                                           ↓
                                                    UI Re-render
```

---

## 2. Core Data Layer & State Management

### 2.1 RoomDocManager (`client/src/lib/room-doc-manager.ts`)

The central authority managing Y.Doc, providers, and state publishing.

#### Core Architecture

```typescript
class RoomDocManagerImpl implements IRoomDocManager {
  // Core Y.js instances
  private readonly ydoc: Y.Doc; // Created once with guid: roomId
  private yAwareness?: YAwareness; // Awareness for presence

  // Providers
  private indexeddbProvider: IndexeddbPersistence | null = null;
  private websocketProvider: WebsocketProvider | null = null;

  // Snapshot management
  private _currentSnapshot: Snapshot; // Never null, starts with EmptySnapshot
  private docVersion = 0; // Increments on Y.Doc changes
  private sawAnyDocUpdate = false; // Tracks if any update occurred

  // Publishing state
  private publishState = {
    isDirty: false, // Document changed
    presenceDirty: false, // Presence changed
    rafId: 0, // Current RAF ID
  };

  // Gate system
  private gates = {
    idbReady: false, // IndexedDB synced (2s timeout)
    wsConnected: false, // WebSocket connected (5s timeout)
    wsSynced: false, // WebSocket synced (10s timeout)
    awarenessReady: false, // Awareness ready (immediate)
    firstSnapshot: false, // First doc snapshot published
  };
}
```

#### Critical Y.Doc Management Rules

**NEVER CACHE Y REFERENCES**

```typescript
// ❌ WRONG - Cached reference
private yStrokes: Y.Array<any>;  // NEVER DO THIS

// ✅ CORRECT - Traverse on demand
private getStrokes(): Y.Array<any> {
  return this.getRoot().get('strokes') as Y.Array<any>;
}
```

#### Y.Doc Structure

```typescript
// Y.Doc → root: Y.Map → {
//   v: number,                    // Schema version (1)
//   meta: Y.Map<Meta>,           // scene_ticks: Y.Array<number>
//   strokes: Y.Array<Stroke>,    // Append-only stroke data
//   texts: Y.Array<TextBlock>,   // Future: immutable text blocks
//   code: Y.Map<CodeCell>,       // Future: code cells
//   outputs: Y.Array<Output>     // Future: execution outputs
// }
```

#### Snapshot Publishing System

**buildSnapshot() Method**

```typescript
private buildSnapshot(): Snapshot {
  const currentScene = this.getCurrentScene(); // scene_ticks.length

  // Filter by current scene
  const strokes = this.getStrokes()
    .toArray()
    .filter(s => s.scene === currentScene)
    .map(s => ({
      id: s.id,
      points: s.points,        // Raw number[] from Y.Doc
      polyline: null,          // Float32Array created at RENDER time only
      style: { /* ... */ },
      bbox: s.bbox,
      scene: s.scene,
      createdAt: s.createdAt,
      userId: s.userId,
    }));

  return Object.freeze({
    docVersion: this.docVersion,
    scene: currentScene,
    strokes: Object.freeze(strokes),
    texts: Object.freeze([]),
    presence: this.buildPresenceView(),
    spatialIndex: null,  // Phase 8: RBush deferred
    view: this.getViewTransform(),
    meta: { /* size, readOnly, cap */ },
    createdAt: Date.now(),
  });
}
```

**RAF Publishing Loop**

```typescript
private startPublishLoop(): void {
  const rafLoop = () => {
    if (this.publishState.isDirty) {
      // Document changed - expensive full build
      const newSnapshot = this.buildSnapshot();
      this.publishSnapshot(newSnapshot);
      this.publishState.isDirty = false;
      this.publishState.presenceDirty = false;
    } else if (this.publishState.presenceDirty) {
      // Presence only - cheap clone with new presence
      const snap = {
        ...this._currentSnapshot,  // Reuse frozen arrays
        presence: this.buildPresenceView(),
        createdAt: Date.now(),
      };
      this.publishSnapshot(snap);
      this.publishState.presenceDirty = false;
    }

    if (!this.destroyed) {
      this.publishState.rafId = requestAnimationFrame(rafLoop);
    }
  };

  this.publishState.rafId = requestAnimationFrame(rafLoop);
}
```

#### Mutation System with Guards

**mutate() Method - Single Entry Point**

```typescript
mutate(fn: (ydoc: Y.Doc) => void): void {
  // Pre-init guard: Defer until structures ready
  if (!this.getRoot().has('meta')) {
    this.whenGateOpen('idbReady').then(async () => {
      await Promise.race([
        this.whenGateOpen('wsSynced'),
        this.delay(350),  // Grace period
      ]);
      if (!this.getRoot().has('meta')) {
        this.initializeYjsStructures();
      }
      this.mutate(fn);  // Replay
    });
    return;
  }

  // Guard 1: Room read-only (≥15MB)
  if (this.roomStats?.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    console.warn('Room is read-only');
    return;
  }

  // Guard 2: Mobile view-only
  if (this.isMobileDevice()) {
    console.warn('Mobile devices are view-only');
    return;
  }

  // Execute in single transaction
  this.ydoc.transact(() => {
    fn(this.ydoc);
  }, this.userId);  // Origin for undo/redo
}
```

#### Provider Management

**IndexedDB Provider (Offline-First)**

```typescript
private initializeIndexedDBProvider(): void {
  const dbName = `avlo.v1.rooms.${this.roomId}`;
  this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);

  // 2s timeout for gate
  const timeoutId = setTimeout(() => {
    this.handleIDBReady();
  }, 2000);

  this.indexeddbProvider.whenSynced
    .then(() => this.handleIDBReady())
    .catch(() => this.handleIDBReady());  // Continue on error
}
```

**WebSocket Provider (Authoritative Sync)**

```typescript
private initializeWebSocketProvider(): void {
  const wsUrl = this.buildWebSocketUrl(clientConfig.VITE_WS_BASE);

  this.websocketProvider = new WebsocketProvider(
    wsUrl,
    this.roomId,
    this.ydoc,
    {
      awareness: this.yAwareness,
      maxBackoffTime: 10000,
      resyncInterval: 5000,
    }
  );

  // Gate management
  this.websocketProvider.on('status', (event) => {
    if (event.status === 'connected') {
      this.openGate('wsConnected');
      this.openGate('awarenessReady');
    } else {
      this.closeGate('wsConnected');
      this.closeGate('awarenessReady');
    }
  });
}
```

### 2.2 Registry Pattern (`client/src/lib/room-doc-registry-context.tsx`)

Ensures singleton-per-room guarantee with reference counting.

```typescript
export class RoomDocManagerRegistry {
  private managers = new Map<RoomId, IRoomDocManager>();
  private refCounts = new Map<RoomId, number>();

  acquire(roomId: RoomId): IRoomDocManager {
    let manager = this.managers.get(roomId);

    if (!manager) {
      manager = new RoomDocManagerImpl(roomId);
      this.managers.set(roomId, manager);
      this.refCounts.set(roomId, 0);
    }

    const count = (this.refCounts.get(roomId) || 0) + 1;
    this.refCounts.set(roomId, count);

    return manager;
  }

  release(roomId: RoomId): void {
    const count = this.refCounts.get(roomId);
    if (!count) return;

    const newCount = count - 1;
    if (newCount <= 0) {
      this.managers.get(roomId)?.destroy();
      this.managers.delete(roomId);
      this.refCounts.delete(roomId);
    } else {
      this.refCounts.set(roomId, newCount);
    }
  }
}
```

### 2.3 Type System (`packages/shared/src/types/`)

#### Core Data Types

```typescript
interface Stroke {
  id: StrokeId; // ULID
  tool: 'pen' | 'highlighter';
  color: string; // #RRGGBB
  size: number; // World units
  opacity: number; // 0-1
  points: number[]; // [x,y,x,y,...] NEVER Float32Array
  bbox: [number, number, number, number];
  scene: SceneIdx; // Assigned at commit
  createdAt: number; // ms epoch
  userId: UserId;
}

interface Snapshot {
  docVersion: number; // Monotonic counter
  scene: SceneIdx;
  strokes: ReadonlyArray<StrokeView>;
  texts: ReadonlyArray<TextView>;
  presence: PresenceView;
  spatialIndex: null; // Phase 8: RBush
  view: ViewTransform;
  meta: SnapshotMeta;
  createdAt: number;
}
```

---

## 3. Canvas Rendering System

### 3.1 Two-Canvas Architecture (`client/src/canvas/Canvas.tsx`)

**Base Canvas** (Z-index: 1)

- Renders persistent content: strokes, text, shapes
- Uses dirty rect optimization
- Handled by `RenderLoop.ts`

**Overlay Canvas** (Z-index: 2)

- Renders ephemeral content: preview, presence
- Always full-clear (cheap)
- `pointerEvents: 'none'`
- Handled by `OverlayRenderLoop.ts`

#### Canvas Component Structure

```typescript
export function Canvas({ roomId }: CanvasProps) {
  const baseStageRef = useRef<CanvasStageImperativeApi>(null);
  const overlayStageRef = useRef<CanvasStageImperativeApi>(null);
  const renderLoopRef = useRef<RenderLoop>();
  const overlayLoopRef = useRef<OverlayRenderLoop>();

  // Initialize render loops
  useEffect(() => {
    renderLoopRef.current = new RenderLoop(baseStageRef.current, roomDoc, viewTransform);

    overlayLoopRef.current = new OverlayRenderLoop(overlayStageRef.current, roomDoc, viewTransform);

    // Wire preview provider
    overlayLoopRef.current.setPreviewProvider({
      getPreview: () => tool.getPreview(),
    });
  }, [roomId]);
}
```

### 3.2 Coordinate System (`client/src/canvas/ViewTransformContext.tsx`)

**Three Spaces**

1. **World Space**: Y.Doc storage, stable across zoom/pan
2. **Canvas Space**: CSS pixels with view transform
3. **Device Space**: Physical pixels with DPR

**Transform Math**

```typescript
// World → Canvas
const canvasX = (worldX - pan.x) * scale;
const canvasY = (worldY - pan.y) * scale;

// Canvas → World
const worldX = canvasX / scale + pan.x;
const worldY = canvasY / scale + pan.y;

// Apply to context (order matters!)
ctx.scale(scale, scale); // Scale first
ctx.translate(-pan.x, -pan.y); // Then translate
```

### 3.3 Base Render Loop (`client/src/renderer/RenderLoop.ts`)

**Event-Driven Architecture**

- Zero idle CPU usage
- Immediate first frame after invalidation
- FPS throttling: 60fps desktop, 30fps mobile, 8fps hidden

**Render Pipeline (2-Pass)**

```typescript
// Pass 1: World content (with transform)
ctx.save();
ctx.scale(view.scale, view.scale);
ctx.translate(-view.pan.x, -view.pan.y);

drawBackground(ctx, snapshot, view, viewport);
drawStrokes(ctx, snapshot, view, viewport); // ✅ Implemented
drawShapes(ctx, snapshot, view, viewport); // Future
drawText(ctx, snapshot, view, viewport); // Future
drawAuthoringOverlays(ctx, snapshot, view); // Future

ctx.restore();

// Pass 2: HUD (screen space, DPR only)
drawHUD(ctx, snapshot, view, viewport); // Future
```

### 3.4 Dirty Rectangle Optimization (`client/src/renderer/DirtyRectTracker.ts`)

**Smart Invalidation**

```typescript
invalidateWorldBounds(bounds: WorldBounds, viewTransform: ViewTransform): void {
  // World → Canvas → Device with margins
  const strokeMargin = MAX_WORLD_LINE_WIDTH * scale * dpr;
  const totalMargin = AA_MARGIN + strokeMargin;

  // Track rectangle for targeted clear
  this.dirtyRects.push(inflatedRect);

  // Promote to full clear if:
  // - >64 rectangles
  // - Union covers >33% of canvas
  // - Transform changed
  // - Scene changed
  // - Translucent content visible
}
```

### 3.5 Stroke Rendering (`client/src/renderer/layers/strokes.ts`)

**Rendering Pipeline**

```typescript
export function drawStrokes(ctx, snapshot, viewTransform, viewport) {
  // Scene change clears cache
  if (snapshot.scene !== lastScene) {
    strokeCache.clear();
    lastScene = snapshot.scene;
  }

  for (const stroke of snapshot.strokes) {
    // Visibility culling
    if (!isStrokeVisible(stroke, visibleBounds)) continue;

    // LOD culling (<2px diagonal)
    if (shouldSkipLOD(stroke, viewTransform)) continue;

    // Get cached render data
    const renderData = strokeCache.getOrBuild(stroke);

    // Render with tool-specific settings
    ctx.strokeStyle = stroke.style.color;
    ctx.lineWidth = stroke.style.size;
    ctx.globalAlpha = stroke.style.opacity;

    if (renderData.path) {
      ctx.stroke(renderData.path); // Fast Path2D
    } else {
      // Fallback to polyline
      ctx.beginPath();
      for (let i = 0; i < renderData.polyline.length; i += 2) {
        ctx.lineTo(renderData.polyline[i], renderData.polyline[i + 1]);
      }
      ctx.stroke();
    }
  }
}
```

### 3.6 Path2D Caching (`client/src/renderer/stroke-builder/stroke-cache.ts`)

**Cache Architecture**

```typescript
class StrokeRenderCache {
  private cache = new Map<string, StrokeRenderData>();
  private readonly maxSize = 1000;

  getOrBuild(stroke: StrokeView): StrokeRenderData {
    const cached = this.cache.get(stroke.id);
    if (cached) return cached;

    // Build Path2D and Float32Array at render time only
    const renderData = {
      path: hasPath2D ? new Path2D() : null,
      polyline: new Float32Array(stroke.points), // Created here, not stored
      bounds: calculateBounds(stroke.points),
      pointCount: stroke.points.length / 2,
    };

    // FIFO eviction
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(stroke.id, renderData);
    return renderData;
  }
}
```

### 3.7 Preview Rendering (`client/src/renderer/layers/preview.ts`)

**Preview System**

```typescript
export function drawPreview(ctx: CanvasRenderingContext2D, preview: PreviewData) {
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.size;
  ctx.globalAlpha = preview.opacity; // 0.35 pen, 0.15 highlighter

  ctx.beginPath();
  ctx.moveTo(preview.points[0], preview.points[1]);
  for (let i = 2; i < preview.points.length; i += 2) {
    ctx.lineTo(preview.points[i], preview.points[i + 1]);
  }
  ctx.stroke();
}
```

### 3.8 Presence Cursors & Trails (`client/src/renderer/layers/presence-cursors.ts`)

**Trail Algorithm**

```typescript
const TRAIL_CONFIG = {
  MAX_POINTS: 22, // Ultra-smooth curves
  MAX_AGE: 550, // ms visibility
  DECAY_TAU: 260, // ms fade rate
  MIN_POINT_DIST: 0.35, // World units
  STOP_THRESHOLD: 80, // ms for stop detection
};

// Multi-pass rendering for glow effect
const passes = [
  { widthMultiplier: 3.0, alphaMultiplier: 0.15 }, // Outer glow
  { widthMultiplier: 1.8, alphaMultiplier: 0.35 }, // Inner glow
  { widthMultiplier: 1.0, alphaMultiplier: 1.0 }, // Main stroke
];

// Per-user trail management
interface CursorTrail {
  points: Array<{ x: number; y: number; t: number }>;
  lastUpdate: number;
  lastMovement: number;
  length: number; // Total world distance
}
```

---

## 4. Drawing & Tools System

### 4.1 DrawingTool (`client/src/lib/tools/DrawingTool.ts`)

Central coordinator for the drawing pipeline.

**Core State**

```typescript
class DrawingTool {
  private state: {
    isDrawing: boolean;
    pointerId: number;
    points: number[]; // Accumulating points
    config: {
      // Frozen at pointer-down
      tool: 'pen' | 'highlighter';
      color: string;
      size: number;
      opacity: number;
    };
    startTime: number;
  };

  private rafId: number | null = null;
  private pendingPoint: { x: number; y: number } | null = null;
}
```

**Complete Drawing Flow**

1. **Start Drawing**

```typescript
startDrawing(pointerId: number, worldX: number, worldY: number): void {
  if (!this.canStartDrawing()) return;

  // Freeze tool settings at gesture start
  this.state.config = {
    tool: this.deviceUI.tool,
    color: this.deviceUI.color,
    size: this.deviceUI.size,
    opacity: tool === 'highlighter' ? 0.25 : this.deviceUI.opacity,
  };

  this.state.isDrawing = true;
  this.state.pointerId = pointerId;
  this.state.points = [worldX, worldY];
  this.state.startTime = Date.now();
}
```

2. **RAF Coalescing**

```typescript
addPoint(worldX: number, worldY: number): void {
  if (!this.state.isDrawing) return;

  // Coalesce to RAF (only keep latest point)
  this.pendingPoint = { x: worldX, y: worldY };

  if (!this.rafId) {
    this.rafId = requestAnimationFrame(() => {
      if (this.pendingPoint) {
        this.state.points.push(this.pendingPoint.x, this.pendingPoint.y);
        this.updateBounds();
      }
      this.rafId = null;
    });
  }
}
```

3. **Stroke Commit**

```typescript
commitStroke(): void {
  // Flush pending RAF
  if (this.rafId && this.pendingPoint) {
    cancelAnimationFrame(this.rafId);
    this.state.points.push(this.pendingPoint.x, this.pendingPoint.y);
  }

  // Validate minimum points
  if (this.state.points.length < 4) return;  // Need 2 points minimum

  // Apply simplification
  const { points: simplified } = simplifyStroke(
    this.state.points,
    this.state.config.tool
  );

  // Build stroke data
  const stroke = buildStrokeFromPoints(
    simplified,
    this.state.config,
    this.userId
  );

  // Commit to Y.Doc
  this.room.mutate((ydoc) => {
    const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
    strokes.push([stroke]);
  });

  // Clean up
  this.reset();
}
```

### 4.2 Simplification System (`client/src/lib/tools/simplification.ts`)

**Douglas-Peucker Algorithm**

```typescript
function douglasPeucker(points: number[], tolerance: number): number[] {
  // Iterative implementation to prevent stack overflow
  const stack = [{ start: 0, end: pointCount - 1 }];
  const keep = new Uint8Array(pointCount); // Memory efficient
  keep[0] = 1; // Always keep first
  keep[pointCount - 1] = 1; // Always keep last

  while (stack.length > 0) {
    const { start, end } = stack.pop()!;

    // Find point with maximum distance
    let maxDist = 0;
    let maxIdx = -1;

    for (let i = start + 1; i < end; i++) {
      const dist = perpendicularDistance(/* ... */);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    // Keep point if distance exceeds tolerance
    if (maxDist > tolerance) {
      keep[maxIdx] = 1;
      stack.push({ start, end: maxIdx });
      stack.push({ start: maxIdx, end });
    }
  }

  // Build simplified array
  const simplified = [];
  for (let i = 0; i < pointCount; i++) {
    if (keep[i]) {
      simplified.push(points[i * 2], points[i * 2 + 1]);
    }
  }

  return simplified;
}
```

**Size Validation Pipeline**

```typescript
// Tolerances
const PEN_TOLERANCE = 0.8;
const HIGHLIGHTER_TOLERANCE = 0.5;

// Size limits
const MAX_POINTS_PER_STROKE = 10_000;
const MAX_STROKE_UPDATE_BYTES = 128 * 1024; // 128KB

// Progressive simplification
let tolerance = tool === 'pen' ? PEN_TOLERANCE : HIGHLIGHTER_TOLERANCE;
let simplified = douglasPeucker(points, tolerance);

// Retry with higher tolerance if too big
if (estimateEncodedSize(simplified) > MAX_STROKE_UPDATE_BYTES) {
  tolerance *= 1.4;
  simplified = douglasPeucker(points, tolerance);

  // Hard downsample if still too big
  if (simplified.length / 2 > MAX_POINTS_PER_STROKE) {
    simplified = hardDownsample(simplified, MAX_POINTS_PER_STROKE);
  }
}
```

### 4.3 Stroke Building (`client/src/renderer/stroke-builder.ts`)

```typescript
export function buildStrokeFromPoints(
  points: number[],
  config: StrokeConfig,
  userId: string,
  scene?: number,
): Stroke {
  const strokeId = ulid();
  const bbox = calculateBBox(points, config.size);

  return {
    id: strokeId,
    tool: config.tool,
    color: config.color,
    size: config.size,
    opacity: config.opacity,
    points, // Plain number[] array
    bbox,
    scene: scene ?? getCurrentScene(), // Assigned at commit
    createdAt: Date.now(),
    userId,
  };
}
```

### 4.4 Tool State Management (`client/src/stores/device-ui-store.ts`)

**Zustand Store**

```typescript
interface ToolbarState {
  activeTool: 'pen' | 'highlighter' | 'eraser' | 'text' | 'stamps' | 'pan' | 'select';
  pen: { size: number; color: string };
  highlighter: { size: number; color: string; opacity?: number };
  // ... other tools
}

// Guarded adapter for drawing
export function toolbarToDeviceUI(toolbar: ToolbarState): DeviceUIState {
  // Default unknown tools to 'pen'
  const tool = toolbar.tool === 'pen' || toolbar.tool === 'highlighter' ? toolbar.tool : 'pen';

  // Clamp size to 1-64
  const size = Math.max(1, Math.min(64, toolbar.size || 4));

  // Validate color format
  const color = /^#[0-9A-Fa-f]{6}$/.test(toolbar.color) ? toolbar.color : '#000000';

  // Clamp opacity
  const opacity = Math.max(0, Math.min(1, toolbar.opacity || 1));

  return { tool, color, size, opacity };
}
```

---

## 5. Real-time Collaboration & Awareness

### 5.1 Awareness System (`client/src/lib/room-doc-manager.ts`)

**Awareness Data Structure**

```typescript
interface Awareness {
  userId: UserId;
  name: string; // Random adjective + animal
  color: string; // From palette
  cursor?: { x: number; y: number }; // World coordinates
  activity: 'idle' | 'drawing' | 'typing';
  seq: number; // Monotonic per-sender
  ts: number; // ms epoch
  aw_v?: number; // Version for evolution
}
```

**Cursor Update with Quantization**

```typescript
updateCursor(worldX: number | undefined, worldY: number | undefined): void {
  // 0.5 world-unit quantization
  const quantize = (v: number) => Math.round(v / 0.5) * 0.5;

  const newCursor = worldX !== undefined && worldY !== undefined
    ? { x: quantize(worldX), y: quantize(worldY) }
    : undefined;

  if (cursorChanged) {
    this.localCursor = newCursor;
    this.awarenessIsDirty = true;

    if (this.gates.awarenessReady) {
      this.scheduleAwarenessSend();
    }
  }
}
```

**Sending with Backpressure**

```typescript
private sendAwareness(): void {
  // Check WebSocket buffer
  const ws = (this.websocketProvider as any)?.ws;
  if (ws?.bufferedAmount > 64 * 1024) {
    // Skip frame if backpressured
    this.awarenessSkipCount++;
    this.awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_DEGRADED;
    this.scheduleAwarenessSend();
    return;
  }

  // Send state
  this.awarenessSeq++;
  this.yAwareness.setLocalState({
    userId: this.userId,
    name: this.userProfile.name,
    color: this.userProfile.color,
    cursor: this.localCursor,
    activity: this.localActivity,
    seq: this.awarenessSeq,
    ts: Date.now(),
  });

  this.awarenessIsDirty = false;
}
```

### 5.2 Cursor Interpolation

**Receiver-Side Smoothing**

```typescript
private ingestAwareness(userId: string, state: any, now: number): void {
  let ps = this.peerSmoothers.get(userId);
  if (!ps) {
    ps = { hasCursor: false, lastSeq: -1 };
    this.peerSmoothers.set(userId, ps);
  }

  // Drop stale frames
  if (state.seq <= ps.lastSeq) return;

  // Quantize incoming cursor
  const quantize = (v: number) => Math.round(v / 0.5) * 0.5;
  const nx = quantize(state.cursor.x);
  const ny = quantize(state.cursor.y);

  // Start interpolation window
  if (!gap) {
    ps.animStartMs = now;
    ps.animEndMs = now + 66;  // ~1-2 frames
    this.presenceAnimDeadlineMs = Math.max(
      this.presenceAnimDeadlineMs,
      ps.animEndMs
    );
  }

  ps.last = { x: nx, y: ny, t: now };
  ps.lastSeq = state.seq;
}

private getDisplayCursor(userId: string, now: number): { x: number; y: number } | undefined {
  const ps = this.peerSmoothers.get(userId);
  if (!ps?.hasCursor) return undefined;

  // Linear interpolation during animation window
  if (now >= ps.animStartMs && now <= ps.animEndMs) {
    const t = (now - ps.animStartMs) / (ps.animEndMs - ps.animStartMs);
    return {
      x: ps.displayStart.x + (ps.last.x - ps.displayStart.x) * t,
      y: ps.displayStart.y + (ps.last.y - ps.displayStart.y) * t,
    };
  }

  return ps.last;
}
```

### 5.3 Presence View Building

```typescript
private buildPresenceView(): PresenceView {
  const users = new Map();
  const now = this.clock.now();

  // Add remote users
  this.yAwareness.getStates().forEach((state, userId) => {
    if (userId === this.yAwareness.clientID) return;

    const cursor = this.getDisplayCursor(userId, now);
    users.set(userId, {
      name: state.name,
      color: state.color,
      cursor,
      activity: state.activity,
      lastSeen: now,
    });
  });

  // Add local user
  users.set(this.userId, {
    name: this.userProfile.name,
    color: this.userProfile.color,
    cursor: this.localCursor,
    activity: this.localActivity,
    lastSeen: now,
  });

  return { users, localUserId: this.userId };
}
```

---

## 6. Infrastructure & Persistence

### 6.1 Server Architecture (`server/src/`)

**Main Server (`index.ts`)**

```typescript
const app = express();
const server = createServer(app);

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(securityHeaders());

// Routes
app.use('/api', roomRoutes);
app.use('/api', healthRoutes);

// WebSocket
setupWebSocketServer(server, env);

// Static files with SPA fallback
app.use(express.static('../public'));
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: '../public' });
});

server.listen(env.PORT);
```

**WebSocket Server (`websocket-server.ts`)**

```typescript
export function setupWebSocketServer(server: Server, env: ServerEnv) {
  // Y.js document management
  const docs = new Map<string, Y.Doc>();

  server.on('upgrade', (request, socket, head) => {
    // Parse room ID from URL
    const match = request.url?.match(/^\/ws\/([^\/]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const roomId = match[1];

    // Origin validation
    if (!validateOrigin(request.headers.origin, env.ORIGIN_ALLOWLIST)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Get or create Y.Doc for room
    let doc = docs.get(roomId);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(roomId, doc);

      // Load from Redis
      loadRoom(roomId, doc);

      // Setup persistence
      doc.on(
        'update',
        debounce(() => {
          persistRoom(roomId, doc);
        }, 100),
      );
    }

    // Handle connection with @y/websocket-server
    setupWSConnection(socket, request, { doc });
  });
}
```

### 6.2 Redis Persistence (`server/src/lib/redis.ts`)

```typescript
class RedisAdapter {
  async saveRoom(roomId: string, docState: Uint8Array): Promise<number> {
    // Compress with gzip level 4
    const compressed = await gzipAsync(docState, { level: 4 });

    // Store with TTL
    const ttlSeconds = this.env.ROOM_TTL_DAYS * 24 * 60 * 60;
    await this.client.setex(`room:${roomId}`, ttlSeconds, compressed);

    return compressed.length; // Return size for metadata
  }

  async loadRoom(roomId: string): Promise<Uint8Array | null> {
    const compressed = await this.client.getBuffer(`room:${roomId}`);
    if (!compressed) return null;

    // Decompress
    return gunzipAsync(compressed);
  }
}
```

### 6.3 PostgreSQL Metadata (`server/src/lib/prisma.ts`)

**Schema (`prisma/schema.prisma`)**

```prisma
model RoomMetadata {
  id          String   @id
  title       String   @default("")
  createdAt   DateTime @default(now())
  lastWriteAt DateTime @default(now())
  sizeBytes   Int      @default(0)

  @@index([lastWriteAt(sort: Desc)])
}
```

**Operations**

```typescript
// Update metadata after persist
await prisma.roomMetadata.upsert({
  where: { id: roomId },
  create: {
    id: roomId,
    sizeBytes: compressedSize,
    lastWriteAt: new Date(),
  },
  update: {
    sizeBytes: compressedSize,
    lastWriteAt: new Date(),
  },
});
```

### 6.4 API Endpoints (`server/src/routes/`)

```typescript
// Create room
router.post('/api/rooms', async (req, res) => {
  const roomId = ulid();
  await prisma.roomMetadata.create({
    data: { id: roomId, title: req.body.title || '' },
  });
  res.json({ id: roomId });
});

// Get metadata
router.get('/api/rooms/:id/metadata', async (req, res) => {
  // Check Redis for authoritative existence
  const exists = await redis.exists(`room:${req.params.id}`);
  if (!exists) {
    return res.status(404).json({ error: 'Room expired' });
  }

  const metadata = await prisma.roomMetadata.findUnique({
    where: { id: req.params.id },
  });

  const expiresAt = new Date(metadata.lastWriteAt.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);

  res.json({ ...metadata, expires_at: expiresAt });
});
```

### 6.5 Client API Integration (`client/src/lib/api-client.ts`)

```typescript
class ApiClient {
  constructor(private baseUrl: string) {}

  async getRoomMetadata(roomId: string): Promise<RoomMetadata> {
    const response = await fetch(`${this.baseUrl}/rooms/${roomId}/metadata`);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Room expired');
      }
      throw new Error('Failed to fetch metadata');
    }
    const data = await response.json();
    return RoomMetadataSchema.parse(data);
  }

  async createRoom(title?: string): Promise<{ id: string }> {
    const response = await fetch(`${this.baseUrl}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const data = await response.json();
    return CreateRoomResponseSchema.parse(data);
  }
}
```

---

## 7. UI Components & Integration

### 7.1 Root Application (`client/src/App.tsx`)

```typescript
export function App() {
  return (
    <ErrorBoundary>
      <RoomDocRegistryProvider>
        <ToastProvider>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<TestHarness />} />
                <Route path="/test" element={<TestHarness />} />
                <Route path="/room/:roomId" element={<RoomPage />} />
              </Routes>
            </BrowserRouter>
          </QueryClientProvider>
        </ToastProvider>
      </RoomDocRegistryProvider>
    </ErrorBoundary>
  );
}
```

### 7.2 Room Page (`client/src/pages/RoomPage.tsx`)

```typescript
export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();

  return (
    <ViewTransformProvider>
      <div className="flex flex-col h-screen">
        <Header roomId={roomId} />
        <main className="flex-1 relative">
          <Workspace roomId={roomId}>
            <Canvas roomId={roomId} />
            <Toolbar />
            <ConnectionStatus roomId={roomId} />
            <UsersModal roomId={roomId} />
          </Workspace>
        </main>
      </div>
    </ViewTransformProvider>
  );
}
```

### 7.3 Toolbar Component (`client/src/components/Toolbar/`)

```typescript
export function Toolbar() {
  const {
    activeTool,
    pen,
    highlighter,
    setActiveTool,
    setPenSize,
    setPenColor,
    // ...
  } = useDeviceUIStore();

  return (
    <div className="fixed left-4 top-20 z-10">
      <div className="bg-white rounded-lg shadow-lg p-2">
        {/* Tool buttons */}
        <button
          onClick={() => setActiveTool('pen')}
          className={activeTool === 'pen' ? 'active' : ''}
        >
          <PenIcon />
        </button>

        <button
          onClick={() => setActiveTool('highlighter')}
          className={activeTool === 'highlighter' ? 'active' : ''}
        >
          <HighlighterIcon />
        </button>

        {/* Size slider */}
        {activeTool === 'pen' && (
          <input
            type="range"
            min="1"
            max="64"
            value={pen.size}
            onChange={(e) => setPenSize(Number(e.target.value))}
          />
        )}

        {/* Color picker */}
        <input
          type="color"
          value={pen.color}
          onChange={(e) => setPenColor(e.target.value)}
        />
      </div>
    </div>
  );
}
```

### 7.4 Connection Status (`client/src/components/ConnectionStatus.tsx`)

```typescript
export function ConnectionStatus({ roomId }: { roomId: string }) {
  const gates = useConnectionGates(roomId);

  const status = useMemo(() => {
    if (!gates.wsConnected) return 'offline';
    if (!gates.wsSynced) return 'syncing';
    return 'online';
  }, [gates]);

  return (
    <div className="fixed top-4 right-4">
      <div className={`status-indicator ${status}`}>
        {status === 'offline' && <OfflineIcon />}
        {status === 'syncing' && <SyncIcon />}
        {status === 'online' && <OnlineIcon />}
        <span>{status}</span>
      </div>
    </div>
  );
}
```

### 7.5 React Hooks (`client/src/hooks/`)

**Core Hooks**

```typescript
// Get room document manager
export function useRoomDoc(roomId: string): IRoomDocManager {
  const registry = useRoomDocRegistry();

  useEffect(() => {
    const manager = registry.acquire(roomId);
    return () => registry.release(roomId);
  }, [roomId, registry]);

  return registry.acquire(roomId);
}

// Subscribe to snapshots
export function useRoomSnapshot(roomId: string): Snapshot {
  const room = useRoomDoc(roomId);

  return useSyncExternalStore(
    (onStoreChange) => room.subscribeSnapshot(onStoreChange),
    () => room.currentSnapshot,
    () => room.currentSnapshot, // Server snapshot
  );
}

// Subscribe to presence
export function usePresence(roomId: string): PresenceView {
  const room = useRoomDoc(roomId);
  const [presence, setPresence] = useState(/* ... */);

  useEffect(() => {
    return room.subscribePresence(setPresence);
  }, [room]);

  return presence;
}

// Subscribe to gates with stable primitives
export function useConnectionGates(roomId: string): GateStatus {
  const room = useRoomDoc(roomId);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return room.subscribeGates(() => {
        queueMicrotask(onStoreChange); // Defer to prevent loops
      });
    },
    [room],
  );

  const getSnapshot = useCallback(
    () => encodeGates(room.getGateStatus()), // String primitive
    [room],
  );

  const encoded = useSyncExternalStore(subscribe, getSnapshot);
  return decodeGates(encoded);
}
```

---

## 8. Critical Implementation Details

### 8.1 Invariants That Must Never Be Violated

1. **No Cached Y.Doc References**
   - Always traverse from root on demand
   - Never store Y.Array/Y.Map as class fields

2. **Float32Array Only at Render Time**
   - Store as `number[]` in Y.Doc
   - Create Float32Array in render loop only

3. **Snapshots Never Null**
   - EmptySnapshot created synchronously on init
   - Always have valid snapshot for UI

4. **Single Transaction Wrapper**
   - All mutations through `mutate(fn)`
   - One `yjs.transact()` per operation

5. **Scene Assignment at Commit**
   - Use `getCurrentScene()` at commit time
   - Never capture scene at gesture start

### 8.2 Memory Safety Rules

1. **Registry Pattern**
   - Singleton per room via registry
   - Reference counting for cleanup
   - Never export implementation class

2. **Cache Limits**
   - Stroke cache: 1000 entries max
   - Trail points: 22 per user max
   - FIFO eviction on overflow

3. **Provider Cleanup**
   - Destroy in deterministic order
   - Null references after destroy
   - Guard all public methods

### 8.3 Coordinate Space Rules

1. **Transform Order**

   ```typescript
   ctx.scale(scale, scale); // Scale first
   ctx.translate(-pan.x, -pan.y); // Then translate
   ```

2. **DPR Application**
   - Apply once at canvas setup
   - Never mix into view transforms
   - Use for backing store sizing only

3. **World Units**
   - All Y.Doc data in world coordinates
   - Transform at render time only
   - Quantize awareness to 0.5 units

### 8.4 Gate Dependencies

| Feature    | Required Gates                    | Fallback     |
| ---------- | --------------------------------- | ------------ |
| Drawing    | None (offline-first)              | Always works |
| Presence   | `awarenessReady && firstSnapshot` | Hidden       |
| Export     | `firstSnapshot`                   | Disabled     |
| Minimap    | `firstSnapshot`                   | Hidden       |
| TTL Extend | `wsConnected`                     | Disabled     |

---

## 9. Performance Optimizations

### 9.1 Rendering Optimizations

1. **Event-Driven Scheduling**
   - Zero idle CPU usage
   - RAF only when dirty
   - Immediate first frame

2. **Dirty Rectangle Tracking**
   - 5-20x faster for small changes
   - Smart promotion to full clear
   - Coalescing with grid snapping

3. **Path2D Caching**
   - 2-3x faster stroke rendering
   - FIFO eviction at 1000 entries
   - Scene change clears cache

4. **LOD Culling**
   - Skip strokes <2px diagonal
   - Viewport culling with bbox
   - Scene filtering in snapshot

### 9.2 Data Optimizations

1. **Snapshot Reuse**
   - Presence-only updates clone previous
   - Frozen arrays prevent mutations
   - Reference equality for React

2. **RAF Coalescing**
   - Batch pointer events to 60fps
   - Single pending point only
   - Flush on commit

3. **Simplification**
   - Douglas-Peucker reduces points 5-10x
   - Progressive tolerance increases
   - Hard downsample as last resort

4. **Awareness Throttling**
   - Send: 10-13Hz normal, 6-7Hz degraded
   - UI: 30Hz max for React
   - Backpressure skip at 64KB buffer

### 9.3 Network Optimizations

1. **Compression**
   - Gzip level 4 (4x reduction)
   - 2MB frame limit
   - Size estimation with EWMA

2. **Debouncing**
   - Persistence: 100ms debounce
   - Gates: 150ms debounce
   - Metadata polling: 10s interval

3. **Connection Management**
   - 10s max backoff
   - 5s resync interval
   - Origin allowlist validation

---

## 10. Testing Architecture

### 10.1 Test Infrastructure

**Registry Pattern for Tests**

```typescript
export function createTestManager(roomId = 'test-room') {
  const clock = new TestClock();
  const frames = new TestFrameScheduler();

  const registry = createRoomDocManagerRegistry();
  registry.setDefaultOptions({ clock, frames });

  const manager = registry.createIsolated(roomId, { clock, frames });

  return {
    manager,
    clock,
    frames,
    registry,
    cleanup: () => {
      manager.destroy();
      registry.reset();
    },
  };
}
```

### 10.2 Timing Abstractions

```typescript
// Manual time control for tests
class TestClock implements Clock {
  private currentTime = 0;

  now(): number {
    return this.currentTime;
  }

  advance(ms: number): void {
    this.currentTime += ms;
  }
}

// Manual frame advancement
class TestFrameScheduler implements FrameScheduler {
  private callbacks = new Map();

  request(callback: FrameRequestCallback): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  advanceFrame(time: number): void {
    const cbs = Array.from(this.callbacks.values());
    this.callbacks.clear();
    cbs.forEach((cb) => cb(time));
  }
}
```

### 10.3 Test Helpers

```typescript
// Wait for snapshot with condition
export async function waitForSnapshot(
  manager: IRoomDocManager,
  condition: (snap: Snapshot) => boolean,
  timeout = 1000,
): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timeout waiting for snapshot'));
    }, timeout);

    const unsubscribe = manager.subscribeSnapshot((snap) => {
      if (condition(snap)) {
        clearTimeout(timeoutId);
        unsubscribe();
        resolve(snap);
      }
    });
  });
}

// Collect multiple snapshots
export async function collectSnapshots(
  manager: IRoomDocManager,
  count: number,
): Promise<Snapshot[]> {
  const snapshots: Snapshot[] = [];

  return new Promise((resolve) => {
    const unsubscribe = manager.subscribeSnapshot((snap) => {
      snapshots.push(snap);
      if (snapshots.length >= count) {
        unsubscribe();
        resolve(snapshots);
      }
    });
  });
}
```

---

## Configuration Values (`packages/shared/src/config.ts`)

### Key Limits

| Config                     | Value  | Description            |
| -------------------------- | ------ | ---------------------- |
| `ROOM_SIZE_WARNING_BYTES`  | 13MB   | Show warning banner    |
| `ROOM_SIZE_READONLY_BYTES` | 15MB   | Block writes           |
| `MAX_INBOUND_FRAME_BYTES`  | 2MB    | WebSocket frame limit  |
| `MAX_POINTS_PER_STROKE`    | 10,000 | Point limit per stroke |
| `MAX_TOTAL_STROKES`        | 5,000  | Total strokes per room |
| `MAX_STROKE_UPDATE_BYTES`  | 128KB  | Transport limit        |
| `ROOM_TTL_DAYS`            | 14     | Default expiration     |
| `MAX_CLIENTS_PER_ROOM`     | 105    | Connection limit       |

### Performance Settings

| Config                  | Value | Description         |
| ----------------------- | ----- | ------------------- |
| `TARGET_FPS_NORMAL`     | 60    | Desktop frame rate  |
| `TARGET_FPS_MOBILE`     | 30    | Mobile frame rate   |
| `TARGET_FPS_HIDDEN`     | 8     | Hidden tab rate     |
| `AWARENESS_HZ_BASE_WS`  | 15    | Base awareness rate |
| `AWARENESS_HZ_DEGRADED` | 8     | Degraded rate       |
| `GZIP_LEVEL`            | 4     | Compression level   |

---

## Implementation Status Summary

### ✅ Completed (Phases 1-7)

- **Core Data Layer**: RoomDocManager, Registry, Type System
- **Canvas Infrastructure**: Two-canvas architecture, transforms, DPR
- **Rendering System**: RenderLoop, OverlayRenderLoop, dirty rects
- **Stroke System**: Drawing, simplification, Path2D caching
- **Preview System**: Real-time preview on overlay canvas
- **Tool Management**: Pen, highlighter with Zustand store
- **Offline Persistence**: IndexedDB provider integration
- **Server Infrastructure**: Express, WebSocket, Redis, PostgreSQL
- **Real-time Sync**: Y.js WebSocket provider
- **Awareness System**: Cursors, trails, presence, interpolation
- **UI Components**: Canvas, Toolbar, ConnectionStatus
- **Routing**: React Router with dynamic rooms

### 🚧 Future Phases (8-17)

- **Phase 8**: RBush spatial indexing (deferred)
- **Phase 9**: Enhanced UI components
- **Phase 10**: Eraser tool
- **Phase 11**: Text & stamps
- **Phase 12**: Undo/Redo system
- **Phase 13**: Room lifecycle management
- **Phase 14**: Export & minimap
- **Phase 15**: Code execution (Monaco + Pyodide)
- **Phase 16**: Service Worker & PWA
- **Phase 17**: WebRTC optimization

---

This document represents the complete implementation state of Avlo as of Phase 7 completion, with all critical implementation details, file locations, data flows, and architectural patterns documented for future reference and agent navigation.
