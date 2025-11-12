# AVLO Project Overview for Agents (Frontend-Focused)
**CRITICAL: IN FUTURE: SCENE TICKS WILL BE REMOVED, INSTEAD THE CLEAR BOARD WILL BE A PER USER CLEAR BOARD, WITH A YJS ATOMIC DELETE ON ALL OBJECTS TAGGED WITH ITS USERID**
**CRITICAL** VIEW THIS OVERVIEW AS A RECAP, WE WILL BE MAKING MANY CHANGES TO ARCHITECTURE SOON. THIS VERSION IS ALSO LACKING BACKEND DETAILED CONTEXT: THIS IS FRONTEND-FOCUS OVERVIEW 

### Path Aliases
- `@avlo/shared` → `../packages/shared/src/*` (access shared config/types)
- `@/*` → `./src/*` (within client workspace)
## Essential Commands
**DEV SERVER IS ALWAYS RUNNING, DON'T START WITHOUT USER PERMISSION, OR npm run build!**
```bash
# Core development
npm run dev              # Start client & server
npm run typecheck        # Type check all workspaces #RUN FROM ROOT!
```
## 1. Executive Summary

**Purpose:** Link-based, account-less, offline-first collaborative whiteboard with integrated code editor and execution. MVP targets ≤125ms p95 latency, ~100 concurrent users, offline via IndexedDB + CRDT, Redis-backed rooms (14-day TTL).

**Tech Stack:** Frontend (React/TS/Tailwind/Canvas/Monaco), Realtime (Yjs + y-websocket (future hybrid with y-webrtc) + y-indexeddb), Execution (JS/Pyodide workers), Persistence (Redis + Postgres), PWA, Service Workers, TanStackQuery, Express, PostgreSQL(non-authoritative metadata), Prisma

**Write Path:** UI → internal tools call `mutate(fn)` wrapper → guards → `yjs.transact` → Y.Doc update → providers sync → Redis persist

## 2. Core Architecture
**NOTE: THIS FILE IS INTENTIONALLY FOCUSED MORE ON FRONTEND TO SAVE CONTEXT**
### The RoomDocManager Model (Unified)

**Principle:** UI Components subscribe to snapshots that reflect the global state of the room.  Yjs and awareness/providers allow access through helper methods or subscription. A single **RoomDocManager** per room owns them. Rendering reads immutable **Snapshots** published at most once per `requestAnimationFrame`.  tools can perform  `mutate(fn)` for any writes from the interface-based access(IRoomDocManager) .

**Ownership:** RoomDocManager owns Y.Doc, y-indexeddb provider, y-websocket provider, Y.UndoManager (scoped to strokes/texts, origin-tracked by userId), mutate(fn) wrapper, authoritative registries (strokesById/textsById Maps), spatial index (RBush R-tree, acceleration structure), publish loop, cursor interpolation (keyed by clientId for proper cleanup), snapshot construction, Y.Array observers with direct updates.

**Registry Pattern:** RoomDocManager instances accessed exclusively through **RoomDocManagerRegistry** (singleton-per-room guarantee):

- Production: `useRoomDoc()` hook or `registry.acquire(roomId)`
- Tests: `createTestManager()` helper for isolated instances
- Interface-based access only (IRoomDocManager) - implementation never exposed

```typescript
export interface RoomDocManager {
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  subscribeRoomStats(cb: (s: { bytes: number; cap: number } | null) => void): Unsub;
  subscribeGates(cb: (gates: Readonly<GateStatus>) => void): Unsub;
  getGateStatus(): Readonly<GateStatus>;
  updateCursor(worldX: number | undefined, worldY: number | undefined): void;
  updateActivity(activity): void;
  mutate(fn: (ydoc: Y.Doc) => void): void;
  undo(): void;  // Per-user undo via Yjs UndoManager
  redo(): void;  // Per-user redo via Yjs UndoManager
  extendTTL(): void;
  destroy(): void;
}
```

**Y.Doc Reference:**
Traverse from root initially if calling helpers for first time
   ```typescript
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
- **Helpers return Y types, only tools mutate** 

**Publishing (Event-driven RAF):**

- Continuous event-driven RAF loop starts on manager creation (never stops until destroy)
- Set dirty flag when: Yjs updates (docVersion++) or presence updates
- Schedule one RAF callback when dirty
- Default 60 FPS for base canvas, switch to 30 FPS on mobile/battery/heavy scenes
- Overlay Canvas(previews, presence) is native device FPS(i.e. 144hz)
- **Presence-only updates clone previous snapshot with updated presence**
- Document changes(docVersion++) trigger incremental snapshot rebuild from Y.Doc
- Typed arrays: Store `[number, number][]` in Yjs, construct `Float32Array` at render time only
- **Snapshot versioning:** Each carries `docVersion: number` (monotonic) that increments on Y.Doc changes only (not presence)

## 3. Data Models & Schema

### Yjs Document Structure

```typescript
Y.Doc → root: Y.Map → {
  v: number,                    // schema version
  meta: Y.Map<Meta>,
  strokes: Y.Array<Stroke>,    
  texts: Y.Array<TextBlock>,
  code: Y.Map<CodeCell>,
  outputs: Y.Array<Output>      // keep last 10
}

interface Stroke {
  id: StrokeId;  // ulid generated on pointer up
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
  scene_ticks: number[]; // (FUTURE REMOVAL) append-only (excluded from undo)
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
  activity: 'idle' | 'drawing' | 'typing';  //useless, will probably change soon
  seq: number; // monotonic per-sender
  ts: number;
}
```

**Stable User IDs:**
- **UserProfileManager** singleton (`/client/src/lib/user-profile-manager.ts`) provides stable userId across refresh
- Persisted in localStorage as `avlo:user:v1` with graceful fallback for private browsing
- Plain ULID format (no prefix) for consistency
- Used as transaction origin for UndoManager tracking: `ydoc.transact(fn, this.userId)`
- Accessed via `userProfileManager.getIdentity()` (synchronous, safe for constructors)

### Snapshot current Structures

```typescript
export interface Snapshot {
  docVersion: number; // Incremental version
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
//TextView as well

interface GateStatus {
idbReady: boolean;
wsConnected: boolean;
wsSynced: boolean;
awarenessReady: boolean;
firstSnapshot: boolean;
}
```
- **Never null:** EmptySnapshot created synchronously on construct with scene=0, empty arrays
- **Typed arrays** constructed at render only, stored doc remains plain arrays
- **Publishing invariants:** docVersion only changes after Yjs update (dev-only assertion)

### Zustand (device-local): **File:** `/client/src/stores/device-ui-store.ts`
**Scope:** Device-local UI state only (toolbar, lastSeenScene). Persistence: localStorage key `avlo:vN:ui`; bump `vN` if needed; include migrate fn. 
- Canvas reads tools from zustand
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
  select: {};                //  placeholder
  // Actions: setActiveTool, setPenSettings, setHighlighterSettings, setEraserSize, setTextSettings, setShapeSettings
}
```

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
- Snapshot carries docVersion that increments on Y.Doc change only, not Presence only updates

## 4. Functional Requirements

**Whiteboard Tools:**

- Pointer-down: preview only, commit on pointer-up
- Scene assigned at commit using currentScene
- Docked toolbar (top/pinned) with Pen/Highlighter/Text/Eraser/Select/Ellipse/Rectangle/Line/Arrow
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
5. **DocManager**: Publishes new Snapshot at next rAF
6. **Transport**: y-websocket sends delta, server persists, Redis TTL extended

**Clear Board Flow:**
- Append to `root.meta.scene_ticks[]`; currentScene = length
- Rendering includes only elements with scene === currentScene

**Undo/Redo:** Yjs UndoManager with `origin = userId` (per-user history)

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
- Runs at native device FPS (intentionally higher FPS for preview responsiveness)
- Lightweight loop for local preview (drawing in progress) and global presence (cursors)
- Preview accessed via PreviewProvider interface (set by active tool)
- Always does full clear on invalidate (cheap for sparse overlay content)
- `holdPreviewForOneFrame()`: Prevents flicker on stroke commit

**Canvas.tsx Integration:**
- Subscribes to snapshots via `roomDoc.subscribeSnapshot()`
- Stores snapshot in ref (not state) to avoid React re-renders at 60 FPS
- `diffBoundsAndEvict()` computes dirty regions between snapshots for base canvas and determines Cache eviction
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

```
### Stroke Rendering Pipeline & Caching
```
**Files:** `/client/src/renderer/stroke-builder/path-builder.ts` (buildStrokeRenderData), `/client/src/renderer/stroke-builder/stroke-cache.ts` (StrokeRenderCache, getStrokeCacheInstance), `/client/src/renderer/layers/strokes.ts` (drawStrokes)

```
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
```
**Polygon Builder (`buildPFPolygonRenderData`):**
1. Extract canonical `pointsTuples` from stroke
2. Call Perfect Freehand `getStroke()` with `last: true` (finalized geometry)
3. Flatten outline to Float32Array for rendering
4. Build Path2D via `getSvgPathFromStroke(outline, false)` (no close)
5. Compute tight bounds from polygon points (not centerline)
6. Return `{ kind: 'polygon', path, polygon, bounds, pointCount }`
**Perfect Freehand Integration:**

**SVG Path Builder (`pf-svg.ts`):** Converts PF outline points to smooth quadratic Bézier SVG path. Uses `M` (moveTo), `Q` (quadratic curve), and `T` (smooth continuation) commands. Never closes path for PF outlines.

**PF Options (`pf-config.ts`):**
```typescript
export const PF_OPTIONS_BASE = {
  thinning: 0.60,
  smoothing: 0.6,
  streamline: 0.5,
  simulatePressure: true
} as const;
```
**Stroke Cache (client/src/renderer/stroke-builder/stroke-cache.ts):**

Module-level LRU cache with geometry variants per stroke ID. Each entry maps geometry keys to render data:
- **Polyline (shapes):** Width-independent → single variant key `'pl'`
- **Polygon (PF freehand):** Width-dependent → key includes size `'pf:s=<size>;...'`

**Invalidation:** Style-only changes (color, opacity) don't evict geometry. Scene changes trigger full clear. Shared by base canvas and overlay eraser dim layer.

**Stroke Rendering (strokes.ts):**

**Main Loop (`drawStrokes`):**
1. Clear cache on scene change
2. Calculate visible world bounds from viewport (CSS pixels, 50px margin)
3. Spatial query: RBush `queryRect` for visible bounds (viewport culling), 50px margin in world units padded through getVisibleWorldBounds()
4. **CRITICAL, CRITICAL**: Sort results by ULID (deterministic z-order across tabs)
5. Filter: LOD (<2px screen diagonal)
6. Render each stroke via `renderStroke()`

**Render Branching (`renderStroke`):**
- Get cached render data via `strokeCache.getOrBuild(stroke)`
- **Freehand (kind='freehand'):** Fill PF polygon with Path2D (nonzero rule, no close)
- **Shapes (kind='shape'):** Stroke polyline with round caps/joins

**Canvas.tsx Cache Invalidation:**

Snapshot diffing determines both dirty regions (for repaint) and cache evictions (for geometry changes).

```typescript
type DiffResult = {
  dirty: WorldBounds[];
  evictIds: string[];
};
```

**Principle:** Evict cache when stroke disappears or bbox changes (geometry changed). Mark dirty-only when style changed but bbox unchanged.

**Algorithm:**
1. Build ID maps for prev/next strokes and texts
2. For each stroke: Compare bbox and style separately
   - **Bbox changed** → Evict + mark old/new regions dirty
   - **Style-only changed** → Mark region dirty (no eviction)
   - **Added** → Mark region dirty
   - **Removed** → Evict + mark region dirty
3. Apply similar logic for text blocks
4. Return `{ dirty, evictIds }`

**Usage:**
```typescript
const { dirty, evictIds } = diffBoundsAndEvicts(prevSnapshot, newSnapshot);
if (evictIds.length) invalidateStrokeCacheByIds(evictIds);
for (const b of dirty) renderLoopRef.current.invalidateWorld(b);
overlayLoopRef.current.invalidateAll();
```
**Cache Eviction Behavior Matrix**
Change Type	Freehand (PF polygon)	/ Perfect Shape PS (polyline)
- PF: Color/Opacity/ change	No evict (bbox unchanged)	/ PS: No evict (bbox unchanged)
- PF: Size(width) change	No evict (Cache stores new Variant)	/ PS: No evict (render-time width)
- PF: Move/Resize (points change)	Evict (bbox changes) /	PS: Evict (bbox changes)
- PF: Delete	Evict	/ Evict
- PF: Add new	No evict (no prior cache)	/ PS: No evict (no prior cache)
- PF/ PS: Style-only change (color, opacity, width) with bbox unchanged:		
- Dirty: YES (you need a repaint).		
- Evict: NO (geometry didn’t change)

Cache entry scope: one entry per stroke id.
Variants: each entry holds a tiny map of geometry variants, keyed by a geokey:
Shapes (stroked polyline) ⇒ geometry is width-independent → geokey 'pl'.
Freehand (PF polygon) ⇒ geometry depends on width → geokey like pf:s=<size>;sm=0.5;sl=0.5;th=0;pr=0.
The cache decides which builder to run (polyline vs PF polygon) by the stroke’s semantic kind.
LRU policy: map insertion order acts as LRU over stroke ids. When over the cap, pop the oldest id. Invalidating an id drops all its variants. **Cache size 3000 currently**

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

**Hit-Testing Algorithm (RBush Spatial Query):**

1. Convert eraser radius to world units: `radiusWorld = radiusPx / viewTransform.scale`
2. Query RBush with bounding rect: `queryRectAll(cx-r, cy-r, cx+r, cy+r)` returns both strokes AND texts
3. **Strokes:** Segment-level distance test (stored bbox already includes stroke width)
4. **Texts:** Circle-rect intersection test
5. Accumulate hits in `hitNow` set; merge to `hitAccum` during drag
6. Live view: Uses `getView()` callback for accurate transforms
- Stored bbox already includes `(strokeSize * 0.5 + 1)` inflation from commit time. No additional inflation needed during hit-testing.


**Visual Feedback (Two-Pass Overlay):**

- **Pass A (World):** Uniform white lighten effect
  - Shared stroke cache (`getStrokeCacheInstance()`) for Path2D reuse
- **Pass B (Screen):** Cursor circle after `setTransform(dpr,0,0,dpr,0,0)`
  - 1px stroke at ~0.8 alpha, no fill
  - Fixed screen pixels 

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

### Spatial Index (RBush R-tree)

**Location:** `packages/shared/src/spatial/rbush-spatial-index.ts`

**Architecture:** R-tree acceleration structure maintained via two-epoch model: rebuild on initialization/scene-change, incremental updates during steady-state.

**RBush Adapter (Pure Spatial Structure):**

```typescript
export class RBushSpatialIndex implements SpatialIndex {
  private tree: RBush<IndexEntry>;
  private strokesById: Map<string, StrokeView>;  // RBush internal bookkeeping
  private textsById: Map<string, TextView>;      // RBush internal bookkeeping

  // Methods
  bulkLoad(strokes, texts): void;      // Rebuild epoch: O(N log N)
  insertStroke(stroke): void;          // Steady-state: O(log N)
  insertText(text): void;              // Steady-state: O(log N)
  removeById(id): void;                // Steady-state: O(log N)
  queryRect(...): StrokeView[];        // Strokes only, O(log N + K)
  queryRectAll(...): {strokes, texts}; // Both types, O(log N + K)
}
```

**RoomDocManager Two-Epoch Model:**

**Authoritative State:**
- `strokesById: Map<string, StrokeView>` - Single source of truth for all strokes
- `textsById: Map<string, TextView>` - Single source of truth for all texts
- `spatialIndex: RBushSpatialIndex` - Derived acceleration structure (queryable facade)
- `needsSpatialRebuild: boolean` - Epoch flag (rebuild vs steady-state)
- all local, we build and maintain from the Yjs doc on room join for deterministic behaviour
**Epoch 1: Rebuild (needsSpatialRebuild = true)**
- Triggered by: First attach, scene change, sanity check failures
- Flow: `hydrateViewsFromY()` (walk Y.Arrays → build Maps) → `rebuildSpatialIndexFromViews()` (clear + bulkLoad RBush from Maps) → reset flag
- Observers ignored during rebuild (upcoming hydration reads fresh Y.Doc state)

**Epoch 2: Steady-State (needsSpatialRebuild = false)**
- Observers update Maps and RBush directly on each Y.Array change
- Insert deltas: Build StrokeView/TextView → add to Map → `spatialIndex.insertStroke()`
- Delete deltas: Extract IDs from `event.changes.deleted.getContent()` → remove from Map → `spatialIndex.removeById()`
**Snapshot Composition:**
- Snapshot arrays derived from Maps via `Array.from(strokesById.values())`
- Map insertion order is NOT semantic (renderer sorts by ULID before drawing)
- Spatial index shared live (not cloned, read-only facade)

**Initialization Order (CRITICAL):**
- Wait for Yjs structures to inititialize, **Then attach observers** via `setupArrayObservers()` (after structures exist)
- Set `needsSpatialRebuild = true` to trigger first hydration

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
- `handlePointerMove`: → tool.move()
- `handlePointerUp`: tool.end() → awareness 'idle'
- `handlePointerLeave`: Clear cursor, call tool.clearHover() if exists

**Critical Patterns:**

- Tool state in ref (survives React re-renders)
- Preview provider set on overlay loop
- Cursor: 'none' for eraser, 'crosshair' for drawing
- Mobile gating at Canvas level (not in tools)

**Freehand Preview Rendering:**

Preview strokes use Perfect Freehand with `last: false` (live preview mode). Generate outline, convert to SVG path (no close), create Path2D, and fill with nonzero rule. Matches commit rendering except for `last` flag.
## 8. Awareness & Presence

**Cursor Interpolation (`ingestAwareness`):** , **Cursor Rendering:** and **Cursor Trails**

**Gates & Lifecycle:**

- `G_AWARENESS_READY`: Opens on WS connect, closes on disconnect
- Presence renders only when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`
- On disconnect: `setLocalState(null)` + `clearCursorTrails()`
- Gate transitions trigger presenceDirty to flush visibility

**Mobile:** View-only, no cursor emission, activity always 'idle'

## 9. Initialization & Gates

**Init Order:**

1. **Construct RoomDocManager**
   - Create `Y.Doc({ guid: roomId })` exactly once, NEVER MUTATE GUID
2. **Attach y-indexeddb provider**
   - Gate `G_IDB_READY` when initial load applies
   - Timeout 2s (fallback to empty doc)
3. **Attach y-websocket provider**
   - Connect immediately (do not wait for IDB)
   - Gate `G_WS_CONNECTED` on open
   - Gate `G_WS_SYNCED` after first syncStep2/state-vector exchange
**NOTE** - **WS-aware seeding.** Seed containers only **after** `G_IDB_READY` **and** either `G_WS_SYNCED` **or** a 5000 ms grace. If `root.has('meta')` is still false, run `initializeYjsStructures()` **once** and never reassign `root.*` thereafter.
4. **Attach UndoManager**
   - Create `Y.UndoManager([strokes, texts], { trackedOrigins: new Set([this.userId]), captureTimeout: 500 })`
   - Attached after `setupArrayObservers()` to ensure structures exist
   - Scoped to strokes/texts arrays only (meta excluded)
   - Origin-tracked: Only tracks transactions with matching userId
5. **Start awareness (WS-only in Phase 7)**
   - Gate `G_AWARENESS_READY` when WS awareness is live
6. **Snapshot publishing**
   - Build non-null EmptySnapshot synchronously
   - Gate `G_FIRST_SNAPSHOT` when first doc-derived snapshot published
   - Detection: `sawAnyDocUpdate === true`
7. **Start rAF publisher** on manager creation

**Gates Table:**
| Gate | Opens When | Unblocks | Timeout | On Timeout |
|------|-----------|----------|---------|------------|
| `G_IDB_READY` | IDB loaded or 2s | initial hydration | 2s | Render EmptySnapshot |
| `G_WS_CONNECTED` | WS open | awareness, sync | 5s | proceed offline |
| `G_WS_SYNCED` | first Y sync | authoritative render | 10s | keep rendering from IDB |
| `G_AWARENESS_READY` | WS connected | presence cursors | none | N/A |
| `G_FIRST_SNAPSHOT` | first doc update | export, minimap | 1 rAF | N/A |
- Seed containers only **after** `G_IDB_READY` **and** either `G_WS_SYNCED` **or** a short 350 ms 

**Teardown Order(slightly outdated, needs update):**
1. Stop RAF publisher
2. Destroy RTC provider (if any)
3. Unsubscribe awareness listeners
4. Leave/close WS
5. Flush pending mutations
6. Close IDB 
7. Guard all public methods with `if (this._destroyed) return;`

## 10. Select Tool (Upcoming)


### **Perfect Shape Recognition Details (Phase: Perfect Shapes):**

- **600ms dwell trigger:** HoldDetector fires after pointer stillness (6px screen-space jitter tolerance). File: `/client/src/lib/input/HoldDetector.ts`.
- **RDP RECURSIVE SIMPLIFICATION DUPLICATE PASS RUN ON SHAPE RECOGNIZOR FOR CORNER DETECTION**
- **Shape detection:** Circle (Taubin fit, coverage ≥67%, axis ratio ≤1.70, RMS ≤0.24) vs Rectangle (AABB with trimmed percentiles, soft scoring: 30% side proximity + 20% side coverage evenness + 50% corner quality) vs Line (strict fallback, score 1.0).
- **Ambiguity guards:** Self-intersection detection, near-closure check (gap <6% diagonal), near self-touch detection. Files: `/client/src/lib/geometry/recognize-open-stroke.ts`, `/client/src/lib/geometry/fit-circle.ts`, `/client/src/lib/geometry/fit-aabb.ts`, `/client/src/lib/geometry/score.ts`.
- **Locked refinement:** Post-snap, pointer drags adjust geometry only (circle: radius from center; box: X/Y scale from center; rect/ellipse: corner-to-corner AABB; arrow/line: endpoint).
- **Standard commit:** Perfect shapes convert to polyline strokes on pointer-up, no special storage.

### **Shape Tool Integration (DESIGNATED SHAPE TOOL, DIFFERING FROM FREEHAND STROKE SHAPE DETECTOR ON PAUSE):** Shape variant maps to forced snap kind in Canvas.tsx: `rectangle` → `'rect'`, `ellipse` → `'ellipseRect'`, `arrow` → `'arrow'`, `line` → `'line'`. Shape tool uses DrawingTool with `opts: { forceSnapKind }` to bypass HoldDetector and start in "already snapped" mode.
- Anchor Semantics:
  - `rect` and `ellipseRect`: Point A is the fixed corner, cursor defines opposite corner
  - `arrow` and `line`: Point A is the start, cursor defines the end
  - `circle` (hold-detected): Center is fixed, cursor defines radius
  - `box` (hold-detected): Center is fixed, cursor scales X/Y axes

### Polyline Generation
All shapes convert to polylines at commit time:
- **Rectangle**: 5 points (closed)
- **Ellipse**: Adaptive point density based on perimeter
- **Arrow**: 5 points (shaft + two head segments)
- **Line**: 2 points

### Shape Tools Preview Flow
1. Pointer down → uses the DrawingTool, seeds snap immediately (no hold)
2. Pointer move → Updates liveCursorWU, requests overlay frame
3. Overlay renders preview from anchors + cursor
4. Pointer up → Generates polyline, commits as regular stroke

---

## Backend/Infrastructure (Stubbed)

- **Redis:** Compressed Y.Doc with TTL, key `room:<id>`
- **PostgreSQL:** Non-authoritative metadata
- **IndexedDB:** Per-room offline storage
- **y-websocket:** Doc updates + awareness

### Room Lifecycle - Local creation → online publish → TTL extension on writes

### Service Worker - Cache HTML/assets, no `/api/**` or `/yjs/**` caching
