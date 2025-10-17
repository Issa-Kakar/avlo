# AVLO Project Overview (Frontend-Focused)

## 1. Executive Summary

**Purpose:** Link-based, account-less, offline-first collaborative whiteboard with integrated code execution. MVP targets ≤125ms p95 latency, ~100 concurrent users, offline via IndexedDB + CRDT, Redis-backed rooms (14-day TTL).

**Tech Stack:** Frontend (React/TS/Tailwind/Canvas/Monaco), Realtime (Yjs + y-websocket + y-indexeddb), Execution (JS/Pyodide workers), Persistence (Redis + Postgres), PWA.

**Scope (Out):** auth/permissions, minimap, admin tools, recovery, CDN, multi-node scaling, **RBUSH DEFERRED**.

**Write Path:** UI → `mutate(fn)` wrapper → guards → `yjs.transact` → Y.Doc update → providers sync → Redis persist

## 2. Core Architecture

### The RoomDocManager Model (Unified)

**Principle:** Components never receive `Y.Doc`, providers, or awareness directly. A single **RoomDocManager** per room owns them. Rendering reads immutable **Snapshots** published at most once per `requestAnimationFrame`. Writes are coarse-grained through `mutate(fn)`. No component reads live Y structures.

**Ownership:** RoomDocManager owns Y.Doc, y-indexeddb provider, y-websocket provider, UndoManager (Yjs), mutate(fn) wrapper, Spatial index (UniformGrid), publish loop, cursor interpolation, snapshot construction.

**Registry Pattern:** RoomDocManager instances accessed exclusively through **RoomDocManagerRegistry** (singleton-per-room guarantee):

- Production: `useRoomDocRegistry()` hook or `registry.acquire(roomId)`
- Tests: `createTestManager()` helper for isolated instances
- Interface-based access only (IRoomDocManager) - implementation never exposed
- Reference counting with acquire/release for lifecycle management

```typescript
export interface RoomDocManager {
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  subscribeRoomStats(cb: (s: { bytes: number; cap: number } | null) => void): Unsub;
  subscribeGates(cb: (gates: Readonly<GateStatus>) => void): Unsub;
  getGateStatus(): Readonly<GateStatus>;
  mutate(fn: (ydoc: Y.Doc) => void): void;
  extendTTL(): void;
  destroy(): void;
}
```

**Y.Doc Reference Rules (CRITICAL - NEVER VIOLATE):**

1. **No cached Y references as class fields**:

   ```typescript
   // ❌ WRONG
   class RoomDocManager {
     private yStrokes: Y.Array<any>; // NEVER
   }

   // ✅ CORRECT
   class RoomDocManager {
     private getRoot(): Y.Map<any> {
       return this.ydoc.getMap('root');
     }
     private getStrokes(): Y.Array<any> {
       return this.getRoot().get('strokes') as Y.Array<any>;
     }
   }
   ```

   **Y references never cached** - always traverse from root on demand

3. **Helpers return Y types only for internal use** (never expose from public methods)

**Publishing Discipline (Event-driven RAF):**

- Continuous RAF loop starts on manager creation (never stops until destroy)
- Set dirty flag when: Yjs updates, local edits, presence updates
- Schedule one RAF callback when dirty
- Default 60 FPS, switch to 30 FPS on mobile/battery/heavy scenes
- **Presence-only updates clone previous snapshot with updated presence**
- Document changes(docVersion++) trigger full snapshot rebuild from Y.Doc
- Typed arrays: Store `[number, number][]` in Yjs, construct `Float32Array` at render time only
- **Snapshot versioning:** Each carries `docVersion: number` (monotonic) that increments on Y.Doc changes only (not presence)

## 3. Data Models & Schema

### Yjs Document Structure

```typescript
Y.Doc → root: Y.Map → {
  v: number,                    // schema version
  meta: Y.Map<Meta>,
  strokes: Y.Array<Stroke>,     // append only
  texts: Y.Array<TextBlock>,
  code: Y.Map<CodeCell>,
  outputs: Y.Array<Output>      // keep last 10
}

interface Stroke {
  id: StrokeId;
  tool: 'pen' | 'highlighter';
  color: string; // #RRGGBB format
  size: number; // world units (px at scale=1)
  opacity: number; // 0..1; highlighter default 0.45
  points: number[]; // CRITICAL: flattened [x0,y0, x1,y1, ...]
  // NEVER Float32Array in storage
  pointsTuples?: [number, number][]; // NEW: Regular non shape stroke points (Perfect Freehand)
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] world units
  scene: SceneIdx; // assigned at commit time
  createdAt: number; // ms epoch timestamp
  userId: UserId; // awareness id at commit
  /**
   * Semantic origin of the geometry:
   *  - 'freehand' => renderer builds a Perfect Freehand polygon and fills it
   *  - 'shape'    => renderer strokes the polyline as-is (perfect/snap shapes)
   */
  kind: 'freehand' | 'shape';
}

interface TextBlock {
  id: TextId;
  x: number;
  y: number; // world anchor
  w: number;
  h: number; // layout box
  content: string;
  color: string;
  size: number;
  scene: SceneIdx;
  createdAt: number;
  userId: string;
}

interface Meta {
  scene_ticks: number[]; // append-only (excluded from undo)
  canvas?: { baseW: number; baseH: number };
}
```

**Constraints:**
- `MAX_POINTS_PER_STROKE = 10_000`, `MAX_TOTAL_STROKES = 5_000`
- Ensure points.length/2 ≤ 10_000 and encoded update ≤ 128KB

**Timestamp Policy:**
- CRDT/Document fields: `number` type (milliseconds since epoch)
- Examples: REST `{ "expires_at": "2025-08-19T12:34:56Z" }`, Yjs `{ createdAt: 1724070000123 }`

**Awareness (ephemeral, never persisted):**
```typescript
interface Awareness {
  userId: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number }; // world coordinates
  activity: 'idle' | 'drawing' | 'typing';
  seq: number; // monotonic per-sender
  ts: number;
}
```
### Snapshot current Structures

```typescript
export interface Snapshot {
  docVersion: number; // Incremental version, replaces svKey
  scene: SceneIdx; // Current scene index
  strokes: ReadonlyArray<StrokeView>;
  texts: ReadonlyArray<TextView>;
  presence: PresenceView; // Derived + smoothed presence
  spatialIndex: SpatialIndex | null; // Spatial index for efficient hit-testing
  view: ViewTransform; // World-to-canvas transform
  meta: SnapshotMeta;
  createdAt: number; // ms epoch when snapshot was frozen
}

export interface StrokeView {
  id: StrokeId;
  points: ReadonlyArray<number>; // Raw points from Y.Doc (stored as number[], never Float32Array)
  pointsTuples?: [number, number][] | null; // NEW: Perfect Freehand Canonical Points
  polyline: Float32Array | null; // Built at RENDER time ONLY from points
  // Will be null in snapshot, created during canvas render from points
  style: {
    color: string;
    size: number;
    opacity: number;
    tool: 'pen' | 'highlighter';
  };
  bbox: [number, number, number, number];
  scene: SceneIdx; // Scene where stroke was committed (assigned at commit time using currentScene)
  createdAt: number;
  userId: string;
  kind: 'freehand' | 'shape'; //Renderer maps kind -> geometry pipeline(polygon vs polyline)
}
```
- **Never null:** EmptySnapshot created synchronously on construct with scene=0, empty arrays
- **Typed arrays** constructed at render only, stored doc remains plain arrays
- **Publishing invariants:** docVersion only changes after Yjs update (dev-only assertion)

### Zustand (device-local UI only): **File:** `/client/src/stores/device-ui-store.ts`
**Scope:** Small, device-local UI state only (toolbar, lastSeenScene). NEVER mirror Yjs doc. Persistence: localStorage key `avlo:vN:ui`; bump `vN` if needed; include migrate fn. Usage: Use selectors to avoid re-renders; keep slices tiny.
**Tools in Zustand:**
```typescript
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape';
export type ShapeVariant = 'line' | 'rectangle' | 'ellipse' | 'arrow';
interface DeviceUIState {
  activeTool: Tool;
  pen: ToolSettings;         // { size: number; color: string; opacity?: number }
  highlighter: ToolSettings;
  eraser: { size: number };  // CSS pixels for cursor ring
  text: { size: number; color: string };
  shape: { variant: ShapeVariant; settings: ToolSettings };
  pan: {};                   // Pan tool has no settings
  select: {};                // Lasso placeholder
  // Actions: setActiveTool, setPenSettings, setHighlighterSettings, setEraserSize, setTextSettings, setShapeSettings
}
```

**Shape Tool Integration (Phase: Shape Tools):** Shape variant maps to forced snap kind in Canvas.tsx: `rectangle` → `'rect'`, `ellipse` → `'ellipseRect'`, `arrow` → `'arrow'`, `line` → `'line'`. Shape tool uses DrawingTool with `opts: { forceSnapKind }` to bypass HoldDetector and start in "already snapped" mode.

### State Synchronization & Derivation

**Sources:**
- Authoritative: Yjs doc (Redis mirror)
- Ephemeral: Awareness (WS/RTC)
- Local: Device UI state (localStorage)
- Metadata: `/api/rooms/{id}/metadata` (size, expiry)

**Derived State (computed inside manager on publish):**
- `currentScene = meta.scene_ticks.length`
- `docStats = { bytes, cap: 15MB }` from metadata poll
- `presenceView` throttled & interpolated

**Consistency Rules:**
- Never write derived values into Yjs (bbox MAY be stored to avoid recompute)
- Snapshot carries docVersion that increments on Y.Doc change only, not Presence only updates

## 4. Functional Requirements

**Whiteboard Tools:**

- Pointer-down: preview only, commit on pointer-up
- Scene assigned at commit using currentScene
- Docked toolbar (left/pinned) with Pen/Highlighter/Text/Eraser/Lasso/Undo/Redo
- Undo/Redo via Yjs UndoManager with per-user origin

**Clear Board:** Appends scene tick; renderer filters by currentScene; 10s local undo window
**Export:** PNG for viewport/board (max 8192px edge), white background, 2s timeout fallback
**Mobile:** View-only with banner, no cursor emission

## 5. Mutations & Write Path

**mutate(fn)- **Guards (immediate before transact):\*\*

- Room ≥15MB → read-only rejection
- Mobile → view-only rejection
- Frame >2MB → cap rejection

**Write Flow (Draw Stroke Example):**
1. **UI** captures pointer stream → local preview (no writes)
2. On **pointer-up**:
   - Derive world points from screen coords
   - Compute bbox with stroke width inflation
   - **Assign scene at commit using currentScene**
3. **mutate(fn)** with minimal guards
4. Execute in one `yjs.transact()` → append to `strokes[]`
5. **DocManager**: Batches Y updates, publishes new Snapshot at next rAF
6. **Transport**: y-websocket sends delta, server persists, Redis TTL extended

**Clear Board Flow:**
- Append to `root.meta.scene_ticks[]`; currentScene = length
- Rendering includes only elements with scene === currentScene
**Undo/Redo:** Yjs UndoManager with `origin = userId` (per-user history), scene ticks excluded from undo scope
**Backpressure:** Coalesce pointer-move on rAF, drop stale events if queue backs up

## 6. Canvas & Rendering

### Two-Canvas Architecture
**Files:** `/client/src/canvas/Canvas.tsx` (main orchestrator), `/client/src/canvas/CanvasStage.tsx` (low-level substrate), `/client/src/renderer/RenderLoop.ts` (base canvas), `/client/src/renderer/OverlayRenderLoop.ts` (overlay canvas)

- **Base canvas:** World content, invalidates ONLY on `docVersion` change, dirty-rect optimization
- **Overlay canvas:** Preview + presence, full clear each frame, `pointer-events: none`
- **Scene tick (Clear Board):** Both canvases perform full clear before drawing new scene
- **No auto-pan** due to remote actions

**RenderLoop (Base Canvas) Implementation:**
- **EVENT-DRIVEN:** Only schedules RAF when needsFrame=true (via invalidation)
- DirtyRectTracker manages partial redraws vs full clears based on area threshold
- Transform changes force full clear (tracked via lastTransformState)
- Scene changes force full clear (tracked via lastRenderedScene)
- Hidden tab handling: Falls back to 8 FPS interval when document.hidden
- Viewport culling: Skip strokes with bbox outside visible bounds + 50px margin
- **LOD:** Skip strokes with bbox diagonal <2px in screen space

**OverlayRenderLoop:**
- Lightweight loop for local preview (drawing in progress) and global presence (cursors)
- Preview accessed via PreviewProvider interface (set by active tool)
- Always does full clear (cheap for sparse overlay content)
- `holdPreviewForOneFrame()`: Prevents flicker on stroke commit

**Canvas.tsx Integration:**
- Subscribes to snapshots via `roomDoc.subscribeSnapshot()`
- Stores snapshot in ref (not state) to avoid React re-renders at 60 FPS
- `diffBounds()` computes dirty regions between snapshots for base canvas
- Handles viewport/resize events, propagates to both render loops
- Bridges tool preview to OverlayRenderLoop via `setPreviewProvider()`
- **Pointer Events:** `setPointerCapture` on down, release on up/cancel/lost
- Event listeners with `{ passive: false }` for preventDefault
- Comprehensive cleanup on unmount

**Coordinate Spaces & Transforms:**

```typescript
interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number;      // world px → canvas px
  pan: { x: number; y: number };  // world offset (in WORLD UNITS)
}

// Transform formulas (authoritative):
worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
canvasToWorld: [x / scale + pan.x, y / scale + pan.y]
// Context transform order:
ctx.scale(scale, scale) THEN ctx.translate(-pan.x, -pan.y)
```

**DPR Handling:**
- Canvas backing store sized to device pixels (width _ dpr, height _ dpr)
- Apply DPR ONCE with `setTransform(dpr,0,0,dpr,0,0)` - never mix into view transforms
- Clear() uses identity transform + device pixel dimensions

**Render Order:**
- Base: Background (white) → Strokes → Text → Authoring overlays → HUD
- Overlay: Preview (world-space) → Presence (screen-space with DPR only)

**Viewport Culling (`isStrokeVisible`):**

```
### Stroke Rendering Pipeline & Caching

**Files:** `/client/src/renderer/stroke-builder/path-builder.ts` (buildStrokeRenderData), `/client/src/renderer/stroke-builder/stroke-cache.ts` (StrokeRenderCache, getStrokeCacheInstance), `/client/src/renderer/layers/strokes.ts` (drawStrokes)

**CRITICAL** PERFECT FREEHAND LIBRARY FULL IMPLEMENTED. DRAWING TOOL AUTOMATICALLY DRAWS WITH THIS UNTIL A SHAPE IS DETECTED OR IF SHAPE TOOL IS USED

**Typed Array Construction (Render Time Only):**
```
```typescript
// File: /client/src/renderer/stroke-builder/path-builder.ts
export type PolylineData = {
  kind: 'polyline';
  path: Path2D | null;
  polyline: Float32Array;
  bounds: { x: number; y: number; width: number; height: number };
  pointCount: number;
};

export type PolygonData = {
  kind: 'polygon';
  path: Path2D | null;
  polygon: Float32Array;
  bounds: { x: number; y: number; width: number; height: number };
  pointCount: number;
};

export type StrokeRenderData = PolylineData | PolygonData;
  // Constructs Float32Array from plain number[] at render time
  // Builds Path2D for hardware-accelerated rendering

//excerpt from polygon data:
export function buildPFPolygonRenderData(stroke: StrokeView): PolygonData {
  const size = stroke.style.size;

  // CRITICAL FIX: canonical tuples for polygon
  const inputTuples = stroke.pointsTuples ?? [];
  // Use the canonical tuples or fallback conversion
  const outline = getStroke(inputTuples, {
    ...PF_OPTIONS_BASE,
    size,
    last: true, // finalized geometry on base canvas
  });
  // PF returns [[x,y], ...]; flatten once into typed array for draw
  const polygon = new Float32Array(outline.length * 2);
  for (let i = 0; i < outline.length; i++) {
    polygon[i * 2] = outline[i][0];
    polygon[i * 2 + 1] = outline[i][1];
  }

  const pointCount = outline.length;
  // Build smooth SVG path from outline points instead of lineTo segments
  // CRITICAL: Do NOT close the path - PF already provides a complete outline
  const path = hasPath2D && pointCount > 1
    ? new Path2D(getSvgPathFromStroke(outline, false))
    : null;
  // Bounds from polygon (not centerline) for accurate dirty-rects
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < polygon.length; i += 2) {
    const x = polygon[i], y = polygon[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
  return { kind: 'polygon', path, polygon, bounds, pointCount };
```
**PERFECT FREEHAND GET SVG PATH FROM STROKE**
```typescript
//client/src/renderer/stroke-builder/pf-svg.ts
export function getSvgPathFromStroke(
  points: number[][],
  closed = true
): string {
  const len = points.length;
  if (len < 2) return '';

  const avg = (a: number, b: number) => (a + b) / 2;
  // Handle degenerate case with exactly 2 points
  if (len === 2) {
    const [a, b] = points;
    return `M${a[0]},${a[1]} L${b[0]},${b[1]}${closed ? ' Z' : ''}`;
  }
  // Build smooth quadratic Bézier path
  let a = points[0];
  let b = points[1];
  let c = points[2];
  // Start with M (moveTo), then Q (quadratic curve) to midpoint
  let d = `M${a[0]},${a[1]} Q${b[0]},${b[1]} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`;
  // Continue with T (smooth quadratic) commands for continuous tangents
  for (let i = 2; i < len - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${avg(a[0], b[0])},${avg(a[1], b[1])} `;
  }
  // Close the path if requested
  if (closed) d += 'Z';
  return d;
}
//client/src/renderer/stroke-builder/pf-config.ts
export const PF_OPTIONS_BASE = {
  // 'size' will be supplied at call-site to match stroke.style.size
  thinning: 0.60,
  smoothing: 0.6,
  streamline: 0.5,
  simulatePressure: true
  
} as const;
```
**Stroke Cache:**
```typescript
// File: /client/src/renderer/stroke-builder/stroke-cache.ts

// Module-level cache persists across frames
/**
 * Stroke render cache (LRU) with geometry variants per stroke ID.
 * - Entry keyed by stroke.id
 * - Variant keyed by a small "geometry key"
 *   • polyline: independent of style.size (stroke width does not affect geometry)
 *   • polygon (Perfect Freehand): depends on style.size (width affects geometry)
 *
 * Style-only edits (color, opacity, polyline width) DO NOT invalidate geometry.
 */
// Cache cleared on scene change (tracked via lastScene in strokes.ts)
// Shared by both base canvas (stroke rendering) and overlay canvas (eraser dim layer)

```
**Stroke Rendering Loop:**
```typescript
// File: /client/src/renderer/layers/strokes.ts
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Clear cache on scene change
  if (snapshot.scene !== lastScene) {
    strokeCache.clear();
    lastScene = snapshot.scene;
  }
  // Calculate visible world bounds for culling
  const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);
  // Filter and render strokes
  const strokes = snapshot.strokes;
  let renderedCount = 0;
  let culledCount = 0;
  for (const stroke of strokes) {
    // Scene filtering already done in snapshot
    // Just check visibility
    if (!isStrokeVisible(stroke, visibleBounds));
    // Apply LOD: Skip tiny strokes (< 2px diagonal in screen space)
    if (shouldSkipLOD(stroke, viewTransform)) ;
  }
  renderStroke(ctx, stroke, viewTransform);
}

/**
 * Renders a single stroke.
 * Branches on stroke.kind to use different geometry pipelines:
 * - Freehand (PF polygon) → fill
 * - Shapes (polyline) → stroke
 *
 * Note: viewTransform is passed for consistency but not used here since
 * RenderLoop has already applied the world transform to the context.
 */
function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeView,
  _viewTransform: ViewTransform,
): void {
  // Get or build render data (cache selects geometry based on stroke.kind)
  const renderData = strokeCache.getOrBuild(stroke);

  if (renderData.pointCount < 2) {
    return; // Need at least 2 points for a line
  }

  ctx.save();
  ctx.globalAlpha = stroke.style.opacity;

  if (renderData.kind === 'polygon') {
    // FREEHAND (PF polygon) → fill with default nonzero rule (no closing)
    ctx.fillStyle = stroke.style.color;
    if (renderData.path) {
      // Use default nonzero fill rule for open PF outlines
      ctx.fill(renderData.path);
    } else {
      // Rare test fallback (no Path2D)
      ctx.beginPath();
      const pg = renderData.polygon;
      ctx.moveTo(pg[0], pg[1]);
      for (let i = 2; i < pg.length; i += 2) {
        ctx.lineTo(pg[i], pg[i + 1]);
      }
      // CRITICAL: Do NOT closePath() - PF already provides complete outline
      ctx.fill();
    }
  } else {
    // SHAPES (polyline) → stroke
    ctx.strokeStyle = stroke.style.color;
    ctx.lineWidth = stroke.style.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.style.tool === 'highlighter') {
      ctx.globalCompositeOperation = 'source-over';
    }

    if (renderData.path) {
      ctx.stroke(renderData.path);
    } 
  }
  ctx.restore();
}

function shouldSkipLOD(stroke: StrokeView, viewTransform: ViewTransform): boolean {
  const [minX, minY, maxX, maxY] = stroke.bbox;
  const diagonal = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  const screenDiagonal = diagonal * viewTransform.scale;

  // Skip if less than 2 CSS pixels
  return screenDiagonal < 2;
}

/**
 * Calculate visible world bounds for culling.
 * Converts viewport to world coordinates.
 *
 * CRITICAL: Uses CSS pixels from viewport, not device pixels.
 * The ViewTransform operates in CSS coordinate space.
 * ViewportInfo provides both:
 * - pixelWidth/pixelHeight: Device pixels for canvas operations
 * - cssWidth/cssHeight: CSS pixels for coordinate transforms
 */
function getVisibleWorldBounds(
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): { minX: number; minY: number; maxX: number; maxY: number } {
  // Convert viewport corners to world space using CSS pixels (NOT device pixels)
  const [minX, minY] = viewTransform.canvasToWorld(0, 0);
  const [maxX, maxY] = viewTransform.canvasToWorld(viewport.cssWidth, viewport.cssHeight);

  // Add small margin for strokes partially in view
  const margin = 50 / viewTransform.scale; // 50px margin in world units

  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  };
}
```

### Drawing Tool

- **State frozen at pointer-down** (stored in state.config)
- **Invalidate renderloop every pointer move for full clear** 
- **Preview opacity:** Matches commit (pen: 1.0, highlighter: 0.45)
- Simplification: **SKIPPED FOR OPTIMAL VISUAL UX**
- **Size estimation:** ~16 bytes per coordinate + 500 metadata + 1024 envelope
- **Commit:** Generate ULID, assign currentScene, push to strokes[]
- **Invalidation:** Preview bounds AND commit **CRITICAL: PREVIEW RENDERLOOP INVALIDATES ALL ANYWAY SO PARAMETERS ON PREVIEW DO NOT MATTER HERE**

### Eraser Tool (Phase 8)

**State Machine:**

```typescript
interface EraserState {
  isErasing: boolean;
  pointerId: number | null;
  radiusPx: number; // CSS pixels (from deviceUI.eraser.size)
  lastWorld: [number, number] | null;
  hitNow: Set<string>; // Current cursor
  hitAccum: Set<string>; // Accumulated during drag
  dimOpacity: number; // 0.75 for strong effect
}
```

**Hit-Testing Algorithm (Spatial Index with Fallback):**

1. Spatial query: Use `snapshot.spatialIndex.queryCircle()` when available
2. Viewport prune: Skip strokes outside visible bounds + margin
3. Stroke width: Inflate hit radius by `stroke.style.size / 2`
4. Segment distance: Point-to-line distance for each segment
5. Text blocks: Simple bbox-circle intersection (glyph precision deferred)
6. Resume index: Track progress for continuation (10ms budget, 500 segments max)
7. Live view: Uses `getView()` callback for accurate transforms

**Visual Feedback (Two-Pass Overlay):**

- **Pass A (World):** Uniform white lighten effect
  - White overlay (#ffffff) with 'screen' blend mode
  - 0.75 opacity for strong "will be erased" feedback
  - Shared stroke cache (`getStrokeCacheInstance()`) for Path2D reuse
- **Pass B (Screen):** Cursor circle after `setTransform(dpr,0,0,dpr,0,0)`
  - 1px stroke at ~0.8 alpha, no fill
  - Fixed screen pixels (12-32px typical)

**Atomic Commit:**

```typescript
this.room.mutate((ydoc) => {
  // Build id→index maps
  // Sort indices descending
  // Delete in reverse to preserve indices
  for (const idx of strokeIndices) {
    yStrokes.delete(idx, 1);
  }
});
```

### Spatial Index (UniformGrid)

- Divides world into 128×128 unit cells
- Items inserted into all overlapping cells
- Query returns unique items from relevant cells
- Built per snapshot (strokes immutable)
- Integration: `buildSpatialIndex()` in RoomDocManager

### Text Tool (Phase 9)

**DOM Overlay Architecture:**

- Editor host z-index 3, pointer-transparent by default
- Active editor enables pointer events temporarily
- TextTool returns null preview (DOM editor IS the preview)

**Lifecycle:**

- **begin(x,y):** Cache world anchor, create contenteditable at position
- **State:** `idle → placing → editing → commit/cancel`
- **Commit:** Enter/blur → measure rect → divide by scale for world units → mutate()
- **Cancel:** Escape or empty content

**Coordinate Chain:**

- Three spaces: world → screen (CSS px) → host-relative (DOM)
- Scale-aware: Font size, padding, border scale with `view.scale`
- Pan/zoom: `onViewChange()` repositions without recreating editor

**Device UI Integration:**

- Color/size from device-UI store (not tool instance)
- `isTextEditing=true` hides Color/Size dock
- Live config updates without tool recreation

**Render:** Base canvas draws text after strokes, viewport culling applies

### Canvas.tsx Integration Patterns

**Tool Creation (branch ONCE):**

```typescript
let tool: PointerTool | null = null;
if (activeTool === 'eraser') {
  tool = new EraserTool(roomDoc, eraser, userId, ...callbacks);
} else if (activeTool === 'pen' || activeTool === 'highlighter') {
  const settings = activeTool === 'pen' ? pen : highlighter;
  tool = new DrawingTool(roomDoc, settings, activeTool, userId, ...);
}

// Set preview provider (polymorphic)
overlayLoopRef.current?.setPreviewProvider({
  getPreview: () => tool.getPreview(), // Returns union type
});

// Hide OS cursor when eraser active
canvas.style.cursor = activeTool === 'eraser' ? 'none' : 'crosshair';
```

**Tool-Agnostic Pointer Surface**
To keep Canvas uniform, both tools expose the same PointerTool interface:

```typescript
type PointerTool = {
  canBegin(): boolean;
  begin(pointerId: number, x: number, y: number): void;
  move(x: number, y: number): void;
  end(x?: number, y?: number): void;   // DrawingTool uses (x,y); EraserTool ignores final coords
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  destroy(): void;
  clearHover?(): void;  // Optional: EraserTool clears hover state on pointer leave
};

```
Canvas instantiates the appropriate tool once per effect run (based on `activeTool`) and routes unified handlers to this surface. Mobile gating happens in Canvas, not tools. Live view transform passed via `getView()` callback for accurate hit-testing.

****Preview Union Type:**
```typescript
// File: /client/src/lib/tools/types.ts
export type PreviewData = StrokePreview | EraserPreview | TextPreview | PerfectShapePreview;

export interface StrokePreview {
  kind: 'stroke'; // Discriminant for union type
  points: [number, number][]; // PF-native tuples: [[x,y], [x,y], ...] in world coordinates
  tool: 'pen' | 'highlighter';
  color: string;
  size: number; // World units
  opacity: number;
  bbox: [number, number, number, number] | null; 
}

export interface EraserPreview {
  kind: 'eraser';
  circle: { cx: number; cy: number; r_px: number }; // Center in world, radius in CSS px
  hitIds: string[];                                  // World object IDs to dim
  dimOpacity: number;                                // 0.75 for strong "will be erased" effect
}

export interface TextPreview {
  kind: 'text';
  // TextTool returns null preview (DOM editor IS the preview)
}

export interface PerfectShapePreview {
  kind: 'perfect_shape';
  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow';
  anchors: PerfectShapeAnchors; // Discriminated union based on shape
  cursor: [number, number];     // Live cursor in world coords
  style: { color: string; size: number; opacity: number };
  // No bbox for overlay previews; computed once at commit
}
```

**Unified Handlers (no tool branching):**

- `handlePointerDown`: Mobile check → tool.canBegin() → tool.begin()
- `handlePointerMove`: RAF coalesce → tool.move()
- `handlePointerUp`: tool.end() → awareness 'idle'
- `handlePointerLeave`: Clear cursor, call tool.clearHover() if exists

**Critical Patterns:**

- Tool state in ref (survives React re-renders)
- Preview provider set on overlay loop
- Cursor: 'none' for eraser, 'crosshair' for drawing
- Mobile gating at Canvas level (not in tools)

**PERFECT FREEHAND(NON SHAPES) STROKE PREVIEW**:
```typescript
export function drawPreview(ctx: CanvasRenderingContext2D, preview: StrokePreview): void {
  if (!preview || preview.points.length < 2) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity; // Tool-specific opacity

  // PF input: [x,y][]; output: [x,y][] (not flat)
  const outline = getStroke(preview.points, {
    ...PF_OPTIONS_BASE,
    size: preview.size,
    last: false, // live preview
    
  });

  if (outline.length > 1) {
    // Convert PF outline to smooth SVG path with quadratic Bézier curves
    // CRITICAL: Do NOT close the path - PF already provides a complete outline
    const svgPath = getSvgPathFromStroke(outline, false);
    const path = new Path2D(svgPath);
    ctx.fillStyle = preview.color;
    // Use default nonzero fill rule (not even-odd) for open PF outlines
    ctx.fill(path);
  }

  ctx.restore();
}
```
## 8. Awareness & Presence

**Cursor Interpolation (`ingestAwareness`):** , **Cursor Rendering:** and **Cursor Trails**

**Gates & Lifecycle:**

- `G_AWARENESS_READY`: Opens on WS connect, closes on disconnect
- Presence renders only when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`
- On disconnect: `setLocalState(null)` + `clearCursorTrails()`
- Gate transitions trigger presenceDirty to flush visibility

**Mobile:** View-only, no cursor emission, activity always 'idle'

## 9. Initialization & Gates

**Init Order (single tab, one room):**

1. **Construct RoomDocManager**
   - Create `Y.Doc({ guid: roomId })` exactly once, NEVER MUTATE GUID
2. **Attach y-indexeddb provider**
   - Gate `G_IDB_READY` when initial load applies
   - Timeout 2s (fallback to empty doc)
3. **Attach y-websocket provider**
   - Connect immediately (do not wait for IDB)
   - Gate `G_WS_CONNECTED` on open
   - Gate `G_WS_SYNCED` after first syncStep2/state-vector exchange
4. **Start awareness (WS-only in Phase 7)**
   - Gate `G_AWARENESS_READY` when WS awareness is live
5. **Snapshot publishing**
   - Build non-null EmptySnapshot synchronously
   - Gate `G_FIRST_SNAPSHOT` when first doc-derived snapshot published
   - Detection: `sawAnyDocUpdate === true`
6. **Start rAF publisher** on manager creation

**Gates Table:**
| Gate | Opens When | Unblocks | Timeout | On Timeout |
|------|-----------|----------|---------|------------|
| `G_IDB_READY` | IDB loaded or 2s | initial hydration | 2s | Render EmptySnapshot |
| `G_WS_CONNECTED` | WS open | awareness, sync | 5s | proceed offline |
| `G_WS_SYNCED` | first Y sync | authoritative render | 10s | keep rendering from IDB |
| `G_AWARENESS_READY` | WS connected | presence cursors | none | N/A |
| `G_FIRST_SNAPSHOT` | first doc update | export, minimap | 1 rAF | N/A |

**Teardown Order:**

1. Stop RAF publisher
2. Destroy RTC provider (if any)
3. Unsubscribe awareness listeners
4. Leave/close WS
5. Flush pending mutations
6. Close IDB (optional)
7. Guard all public methods with `if (this._destroyed) return;`

## 10. Lasso Tool (Upcoming)

### Goals

- Arbitrary polygon selection with even-odd PIP test
- No handles - move/scale from anywhere inside
- Uniform scaling only
- Atomic commit at same indices

### State Machine

`idle → lassoCapture → selected → transforming → commit → selected`

### Mechanics

- **Auto-close:** Within 12px_screen of start with ≥8 points
- **Selection:** Strokes if any point inside, texts if center inside
- **Move:** Left-drag anywhere inside
- **Scale:** Right-drag or Shift+left-drag (radial from center)
- **Transform:** `s = clamp(distance(center, now) / distance(center, start), 0.1, 10)`

**Commit**: Single `mutate()` replaces at same indices (preserves z-order)

**Perfect Shape Recognition Details (Phase: Perfect Shapes):**

- **600ms dwell trigger:** HoldDetector fires after pointer stillness (6px screen-space jitter tolerance). File: `/client/src/lib/input/HoldDetector.ts`.
- **Shape detection:** Circle (Taubin fit, coverage ≥67%, axis ratio ≤1.70, RMS ≤0.24) vs Rectangle (AABB with trimmed percentiles, soft scoring: 30% side proximity + 20% side coverage evenness + 50% corner quality) vs Line (strict fallback, score 1.0).
- **Near-miss handling:** Shapes scoring within 0.10 of confidence threshold (0.48-0.58) don't snap, preventing annoying line fallbacks.
- **Ambiguity guards:** Self-intersection detection, near-closure check (gap <6% diagonal), near self-touch detection. Files: `/client/src/lib/geometry/recognize-open-stroke.ts`, `/client/src/lib/geometry/fit-circle.ts`, `/client/src/lib/geometry/fit-aabb.ts`, `/client/src/lib/geometry/score.ts`.
- **Locked refinement:** Post-snap, pointer drags adjust geometry only (circle: radius from center; box: X/Y scale from center; rect/ellipse: corner-to-corner AABB; arrow/line: endpoint).
- **Standard commit:** Perfect shapes convert to polyline strokes on pointer-up, no special storage.

### Ownership Model
- **Single ownership:** RoomDocManager owns providers and solely observes Y types
- **Centralized subscription:** UI relies on subscriptions only, no direct Y observers
---

## Backend/Infrastructure (Stubbed)

- **Redis:** Compressed Y.Doc with TTL, key `room:<id>`
- **PostgreSQL:** Non-authoritative metadata
- **IndexedDB:** Per-room offline storage
- **y-websocket:** Doc updates + awareness

### Room Lifecycle - Local creation → online publish → TTL extension on writes

### Service Worker - Cache HTML/assets, no `/api/**` or `/yjs/**` caching

### The "Monster Effect" Root Cause (FIXED)
The `worldToClient` callback previously had `viewTransform` as a dependency, causing recreation on every pan/zoom. This has been fixed by making it stable with empty dependencies, reading the latest transform from a ref.
## Implementation Details
### 1. Fixed Temporal Dead Zone (TDZ) Error
**File**: `client/src/canvas/Canvas.tsx`
Moved `useDeviceUIStore()` call BEFORE `activeToolRef` initialization to prevent TDZ error:
### 2. Stabilized Callbacks and Refs
Added refs for stable access to context setters and transforms:
### 3. Stabilized worldToClient Function
Made `worldToClient` stable with empty dependencies:
### 4. Fixed Effect Dependencies
Added `worldToClient` and `applyCursor` to Tool Lifecycle effect dependencies (both are now stable):

2. **Tool state in refs** - Survives React re-renders at 60 FPS
3. **Event handlers read from refs** - No closure dependencies (critical for mount-once pattern)
4. **MMB is ephemeral** - Never touches Zustand store
5. **Single tool branch point** - Route events polymorphically
6. **Transform math** - Pan is in world units, not screen pixels
7. **Presence first** - Update cursor position before handling gestures
8. **Stable callbacks** - Functions with empty deps read everything from refs
9. **Value setter for pan** - Context uses `setPan(pan)`, not `setPan((prev) => ...)`