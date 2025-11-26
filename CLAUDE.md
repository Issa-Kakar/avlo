# AVLO Project Overview for Agents(Front-end focused)
 **CRITICAL**: VIEW THIS AS A MIXTURE OF IMPLEMENTATION STATE/PLANNING, NOT INVARIANTS AND CONSTRAINTS

## Path Aliases
- `@avlo/shared` → `../packages/shared/src/*`
- `@/*` → `./src/*` (within client workspace)

## Essential Commands
**DEV SERVER IS ALWAYS RUNNING - DON'T START WITHOUT USER PERMISSION**
```bash
npm run dev              # Start client (port 3000) & worker (port 8787)
npm run typecheck        # Type check all workspaces (RUN FROM ROOT!)
```

## 1. Executive Summary

**Purpose:** Link-based offline-first collaborative whiteboard, with build in code blocks and execution. Offline via IndexedDB + CRDT.

**Tech Stack:**
- **Frontend:** React/TS/Tailwind/Canvas/Monaco(will change to Yjs code mirror)
- **Realtime:** Yjs + y-partyserver + y-indexeddb
- **Backend:** Cloudflare Workers + Durable Objects + R2
- **State:** Zustand (device-local), TanStack Query(dormant right now)
- **PWA:** Service Workers for offline support

**Write Path:** UI → tool.commit() → mutate(fn) / ydoc.transact() / Y.Map.set() → Observer fire / providers sync → R2 persist

## 2. Core Architecture
- Note: there are dormant checks with size guards, mobile restrictions, TTL expiry, we will be removing these in the future so ignore them

### The RoomDocManager Model

**Principle:** Single RoomDocManager per room owns Y.Doc, providers, spatial index, and publishes snapshots with live Y.map references via `objectHandle.y` at 60 FPS (30 FPS mobile). UI components subscribe to snapshots. Tools mutate via `mutate(fn)` wrapper.

**Ownership:**
- Y.Doc instance (guid = roomId, NEVER mutate)
- y-indexeddb provider (offline persistence)
- y-partyserver provider (WebSocket sync + awareness)
- Y.UndoManager (per-user, origin-tracked by userId)
- Authoritative state: `objectsById: Map<string, ObjectHandle>`
- Spatial index: RBush R-tree (derived acceleration structure)
- RAF publishing loop (event-driven, never stops until destroy)

**Registry Pattern:**
- Production: `useRoomDoc()` hook or `registry.acquire(roomId)`
- Tests: `createTestManager()` for isolated instances
- Interface-based access as well (IRoomDocManager)

**Interface:**
```typescript
export interface IRoomDocManager {
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub;
  subscribeGates(cb: (gates: GateStatus) => void): Unsub;
  mutate(fn: (ydoc: Y.Doc) => void): void;
  undo(): void;  // Per-user undo via Y.UndoManager
  redo(): void;  // Per-user redo via Y.UndoManager
  extendTTL(): void;
  destroy(): void;
  // ... getters and setters
}
```

**Publishing:**
- Dirty flags: `isDirty` (document or presence change), `presenceDirty` (presence only)
- **Presence-only updates:** Clone previous snapshot, update presence field only
- **Document changes:** Increment `docVersion`, build new snapshot from state
- Throttle: 60 FPS base canvas, Overlay: Native device FPS (e.g., 144Hz)

## 3. Data Models & Schema

### Yjs Document Structure (v2 - Y.Map Migration)

```typescript
Y.Doc → root: Y.Map → {
  v: 2,                           // Schema version (v2 = Y.Map architecture)
  meta: Y.Map,                    // Metadata (TTL extension timestamps)
  objects: Y.Map<Y.Map<any>>,     // All objects as nested Y.Maps (indexed by ULID)
  code: Y.Map,                    // Code cell (legacy, future migration)
  outputs: Y.Array<Output>        // Output array (legacy, future migration)
}
```

**Objects Container:**
- Type: `Y.Map<Y.Map<any>>` - map of maps
- Key: ULID string (object ID)
- Value: Nested Y.Map with object fields
- Access: `root.get('objects').get(id)` → Y.Map for that object

**Object Kinds:**
```typescript
export type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector';
```

Semantic separation:
- `stroke`: Pen/highlighter strokes (Perfect Freehand polygons)
- `shape`: Geometric shapes (rectangles, ellipses, diamonds - polylines)
- `text`
- `connector`

### Object Schemas

#### Stroke (Freehand Drawing)
```typescript
Y.Map {
  id: string,                      // ULID
  kind: 'stroke',                  // Discriminant
  tool: 'pen' | 'highlighter',
  color: string,                   // #RRGGBB
  width: number,                   // World units (renamed from 'size')
  opacity: number,                 // 0..1 (pen: 1.0, highlighter: 0.25)
  points: [number, number][],      // Tuple arrays in world coords
  ownerId: string,                 // User ID
  createdAt: number                // Milliseconds epoch
}
```

**CRITICAL:** Points stored as `[number, number][]` tuples, NOT flattened or Float32Arrays.

#### Shape (Geometric Primitives)
```typescript
Y.Map {
  id: string,                      // ULID
  kind: 'shape',                   // Discriminant
  shapeType: 'rect' | 'ellipse' | 'diamond' | 'roundedRect',
  color: string,                   // Stroke color 
  width: number,                   // Stroke width 
  opacity: number,                 // 0..1
  fillColor?: string,              // Optional fill color
  frame: [number, number, number, number],  // [x, y, width, height]
  ownerId: string,
  createdAt: number
  // PLANNED (not implemented): text within shapes and sticky connectors
  label?: Y.Text;          // Collaborative text inside shape
  padding?: [number, number, number, number];
  textAlignH: string,               // 'left' | 'center' | 'right'
  textAlignV?: 'top' | 'middle' | 'bottom';
  connectorIds?: string[]; // Reverse lookup for attached connectors
}
```

Shape types:
- `rect`: Sharp rectangle (unused in current UI)
- `roundedRect`: Rounded corners (default - created by rectangle tool and rect snap)
- `ellipse`: Ellipse (created by ellipse tool and ellipseRect snap)
- `diamond`: Diamond with rounded corners (created by diamond tool and diamond snap)

**Note:** Arrows(future) will be sticky to shapes, and committed as `kind: 'connector'`, not a shape.

**Fill Rendering:**
- If `fillColor` present: Fill first with fillColor, then stroke with color/width
- No fill: Stroke only with color/width
- Fill color computed: Tint stroke color 85% toward white (15% color, 85% white)

#### Text
```typescript
Y.Map {
  id: string,                      // ULID
  kind: 'text',                    // Discriminant
  frame: [number, number, number, number],  // [x, y, width, height]
  text: string,                    // Plain string (TODO: Y.Text for collab editing)
  color: string,
  fontSize: number,                // Renamed from 'size'
  fontFamily: string,              // e.g., 'sans-serif'
  fontWeight: string,              // e.g., 'normal'
  fontStyle: string,               // e.g., 'normal'
  textAlignH: string,               // 'left' | 'center' | 'right'
  opacity: number,
  ownerId: string,
  createdAt: number
}
```

#### Connector (Lines/Arrows)
```typescript
{
  id: string;
  kind: 'connector';
  points: [number, number][];  // Path points
  startCap?: 'arrow' | 'circle';
  endCap?: 'arrow' | 'circle';
  color: string;
  width: number;
  opacity: number;
  ownerId: string;
  createdAt: number;

  // PLANNED (sticky connectors):
  fromId?: string;         // Attached shape ID
  fromAnchor?: 'top' | 'right' | 'bottom' | 'left';
  toId?: string;
  toAnchor?: 'top' | 'right' | 'bottom' | 'left';
  routingMode?: 'auto' | 'manual';
  routingType?: 'linear' | 'elbow' | 'curved';
  label?: Y.Text;
  labelOffset?: number;
}
```

-Timestamp Policy: Always `number` type (milliseconds since epoch)

### Awareness (Ephemeral, Never Persisted)
```typescript
{
  userId: string,
  name: string,
  color: string,
  cursor?: { x: number, y: number },  // World coordinates
  activity: 'idle' | 'drawing' | 'typing',
  seq: number,                        // Monotonic sequence
  ts: number,                         // Timestamp
  aw_v: 1                             // Awareness version
}
```
**Send Rate:**: Base: 15 Hz via WebSocket, Degraded: 8 Hz under backpressure (ws.bufferedAmount > 64KB)

### Stable User IDs
- **UserProfileManager** singleton provides stable userId across refresh
- ULID format, Persisted in localStorage: `avlo:user:v1`
- Used as transaction origin: `ydoc.transact(fn, this.userId)`
- Access: `userProfileManager.getIdentity()` (synchronous)

### Snapshot Structure

```typescript
export interface Snapshot {
  docVersion: number;                               // Monotonic, increments on Y.Doc changes only
  objectsById: ReadonlyMap<string, ObjectHandle>;   // Live references to ObjectHandles
  spatialIndex: ObjectSpatialIndex | null;          // Shared R-tree acceleration structure
  presence: PresenceView;                           // Derived + smoothed presence
  view: ViewTransform;                              // World-to-canvas transform
  meta: SnapshotMeta;                               // Size, expiry, read-only status
  createdAt: number;                                // Milliseconds epoch
  dirtyPatch?: DirtyPatch | null;                   // Incremental invalidation hints
}
```

**ObjectHandle:**
```typescript
export interface ObjectHandle {
  id: string;                                       // ULID
  kind: ObjectKind;                                 // 'stroke' | 'shape' | 'text' | 'connector'
  y: Y.Map<any>;                                    // LIVE Y.Map reference (direct access!)
  bbox: [number, number, number, number];           // Computed locally, NOT in Y.Map
}
```

**CRITICAL:** The `y` field is a **live reference** to the Y.Map. Rendering reads styles directly from it.
**EmptySnapshot:** Created synchronously on construct with `docVersion: 0`, empty maps.

### Zustand (Device-Local): **File:** `client/src/stores/device-ui-store.ts`

**Persistence:** localStorage key `'avlo.toolbar.v3'`, version 4 with migration support.

**Architecture Pattern:** Unified settings for drawing tools with per-tool overrides.

```typescript
interface DeviceUIState {
  activeTool: Tool; // 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape' | 'image'
  // UNIFIED drawing settings (shared across pen/shapes)
  drawingSettings: {
    size: SizePreset;      // 10 | 14 | 18 | 22 (S/M/L/XL)
    color: string;         // Hex color
    opacity: number;       // 0..1
    fill: boolean;         // Fill enabled (shapes apply it, exposed for all)
  };
  // Tool-specific overrides
  highlighterOpacity: number;    // 0.45 (always)
  textSize: TextSizePreset;      // 20 | 30 | 40 | 50 (different scale!)
  shapeVariant: ShapeVariant;    // 'diamond' | 'rectangle' | 'ellipse' | 'arrow'
  // UI state
  isTextEditing: boolean;
  fixedColors: string[];         // 8 fixed palette colors
  recentColors: string[];        // Last 5 custom colors (excludes fixed)
  isColorPopoverOpen: boolean;
}
```

**Key Method:**
- `getCurrentToolSettings()`: Merges base drawingSettings with active tool overrides
- Returns correct size/color/opacity/fill for current tool context

### ToolPanel & Inspector UI: **File:** `client/src/pages/components/ToolPanel.tsx`

**Architecture:** Single toolbar component with embedded Inspector sub-component.

**Tool Buttons:**
- Select, Pen, Highlighter, Eraser, Text | Rectangle, Ellipse, Arrow, Diamond | Image, Pan
- Shape tools: Set BOTH `activeTool='shape'` AND `shapeVariant` (e.g., 'rectangle')

**Inspector (Conditional Rendering):**
- **Shows when:** activeTool in ['pen', 'highlighter', 'text', 'shape']
- **Components (left to right):** Sizes → Fill Toggle → Colors
- **Sizes:** 4 presets as pills (S/M/L/XL) - routes to correct setter via `handleSizeChange()`
  - Text: 20/30/40/50 → `setTextSize()`
  - Default: 10/14/18/22 → `setDrawingSize()`
- **Note:** Eraser has NO inspector - fixed 10px radius, no configurable settings
- **Fill Toggle:** Icon button, only visible for shape/pen/highlighter/select
- **Colors:**
  - Rainbow swatch (leftmost) → opens popover, shows custom color dot when active
  - 8 fixed palette swatches (reversed order in UI for visual balance)
  - Popover sections: Recent (max 5) | More (12 colors) | Hex input

**Color System:**
- Fixed colors never added to recents
- Custom colors validated (#RGB or #RRGGBB), added to front of recents, max 5
- Popover closes on color select or outside click

**Settings Flow in Canvas.tsx:**
- Canvas.tsx uses **narrow selectors** to avoid spurious rerenders:
  ```typescript
  const activeTool = useDeviceUIStore(s => s.activeTool);
  const shapeVariant = useDeviceUIStore(s => s.shapeVariant);
  const textSize = useDeviceUIStore(s => s.textSize);
  const textColor = useDeviceUIStore(s => s.drawingSettings.color);
  ```
- **Tools read settings from store at `begin()` time** (not constructor params):
  - `DrawingTool(roomDoc, toolType, userId, ...)` - no settings param
  - `EraserTool(roomDoc, onInvalidate, getView)` - no settings param (fixed 10px radius)
  - Tools call `useDeviceUIStore.getState()` at gesture start to freeze settings
  - Exception: `fill` is read **LIVE** via `getFillEnabled()` for real-time toggle during preview
- Shape tool uses DrawingTool with `{ forceSnapKind }` option
- Variant mapping: 'rectangle' → 'rect', 'ellipse' → 'ellipseRect', 'diamond' → 'diamond'

### **Whiteboard Tools:**
- Pen: Freehand drawing with Perfect Freehand (always filled polygon)
- Highlighter: Freehand with 0.45 opacity
- Eraser: Fixed radius hit-test with shape-aware geometry, custom `.cur` cursor, screen-space trail
- Text: DOM overlay
- Pan: Drag viewport (updates ViewTransform.pan)
- Shapes(uses DrawingTool.ts under the hood): Forced snap to rect/ellipse/diamond/arrow (bypasses hold detector)
**Undo/Redo:** Y.UndoManager with per-user origin tracking (500ms capture timeout)

## 5. Mutations & Write Path

**Write Flow (Example: Draw Stroke):**
1. **UI:** Captures pointer stream → local preview (no writes)
2. **Pointer-up: **Commit:**
   ```typescript
   this.room.mutate((ydoc) => {
     const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<any>>;
     const strokeMap = new Y.Map();
     strokeMap.set('id', ulid());
     strokeMap.set('kind', 'stroke');
     strokeMap.set('points', this.state.points);  // Tuple array
     // ... set other fields
     objects.set(strokeId, strokeMap);
   });
   ```
4. **DocManager:** Y.Doc update event → mark dirty → RAF publishes new snapshot
5. **Transport:** y-partyserver sends delta to Durable Object → debounced save to R2

**Undo/Redo:**
- UndoManager tracks transactions with `origin = this.userId`
- Scoped to objects map only (meta excluded)
- `trackedOrigins: new Set([this.userId])`

## 6. Canvas & Rendering

### Two-Canvas Architecture

**Files:**
- `client/src/canvas/Canvas.tsx` (main orchestrator)
- `client/src/canvas/CanvasStage.tsx` (low-level substrate)
- `client/src/renderer/RenderLoop.ts` (base canvas)
- `client/src/renderer/OverlayRenderLoop.ts` (overlay canvas)

**Base Canvas:**
- World content (strokes, shapes, text)
- Dirty-rect optimization (DirtyRectTracker - see pipeline below)
- Invalidates ONLY on `docVersion` change AND bounds from dirtyPatch are in view
- Hidden tab: Falls back to 8 FPS interval

**Overlay Canvas:**
- Preview + presence (cursors, local preview)
- Always full clear (cheap for sparse overlay)
- `pointer-events: none`
- `holdPreviewForOneFrame()`: Prevents flicker on commit

**Canvas.tsx Integration:**
- Subscribes to snapshots via `roomDoc.subscribeSnapshot()`
- Stores snapshot in ref (not state) to avoid React re-renders
- uses dirtyPatch from snapshot, RDM computes dirty regions + cache eviction IDs through deep observer
- Bridges tool preview to OverlayRenderLoop via `setPreviewProvider()`
- Pointer capture: `setPointerCapture` on down, release on up/cancel
- Event listeners: `{ passive: false }` for preventDefault

**Coordinate Spaces & Transforms:**
```typescript
interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number;                  // World px → canvas px
  pan: { x: number; y: number };  // World offset (in WORLD UNITS)
}
// Transform formulas:
worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
canvasToWorld: [x / scale + pan.x, y / scale + pan.y]
// Context transform order:
ctx.scale(scale, scale);
ctx.translate(-pan.x, -pan.y);
```

**DPR Handling:**
- Canvas backing store: `width * dpr, height * dpr`
- Apply DPR ONCE: `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`
- Never mix DPR into view transforms
- Clear uses identity transform + device pixel dimensions

**Render Order:**
- Base: Background (white) → Objects (sorted by ULID)
- Overlay: Preview (world-space) → Presence (screen-space with DPR only)

### Object Rendering Pipeline: **File:** `client/src/renderer/layers/objects.ts`

**Flow:**
1. **Spatial Query:** spatialIndex.query `(viewport.clipRegion?.worldRects)` -> entrySet Map = `IndexEntry[]`
2. **ULID Sort:** `entries.sort((a, b) => a.id < b.id ? -1 : 1)` (deterministic z-order)
3. **LOD Culling:** Skip if screen diagonal <2px
4. **Render Loop:** For each entry:
   - Lookup handle: `objectsById.get(entry.id)`
   - **Read styles directly from Y.Map:** `handle.y.get('color')`
   - Get/Build cached Path2D: `cache.getOrBuild(id, handle)`
   - Render with canvas API

**Render Dispatch:**
```typescript
switch (handle.kind) {
  case 'stroke':    drawStroke(ctx, handle);    break; // Fill PF polygon
  case 'shape':     drawShape(ctx, handle);     break; // Fill + stroke
  case 'text':      drawTextBox(ctx, handle);   break; // fillText
  case 'connector': drawConnector(ctx, handle); break; // Stroke polyline + arrows
}
```

**CRITICAL:** Renderer reads **directly from Y.Map** via `handle.y.get('field')`. No intermediate view objects!

### RenderLoop.ts and Dirty Rect Pipeline (Incremental Rendering)

**Files:**
- `client/src/renderer/DirtyRectTracker.ts` - Accumulates and manages dirty regions
- `client/src/renderer/RenderLoop.ts` - Consumes dirty rects and renders
- `client/src/canvas/Canvas.tsx` - Invalidates world bounds on doc changes

**Pipeline Flow:**

1. **Invalidation (Canvas.tsx)**
```typescript
  // Document change detected in snapshot subscription
if (newSnapshot.dirtyPatch) {
  const { rects, evictIds } = newSnapshot.dirtyPatch;
  cache.evictMany(evictIds);
  for (const bounds of rects) {
    if (boundsIntersect(bounds, viewport)) {
    renderLoop.invalidateWorld(bounds); // WorldBounds → DirtyTracker
    }
  }
}
```

2. **Accumulation (DirtyRectTracker)**
- Canvas.tsx checks if bounds is in view before invalidation
   ```typescript
   invalidateWorldBounds(bounds: WorldBounds, view: ViewTransform) 
   // → worldToCanvas() converts to CSS pixels
   // → invalidateCanvasPixels() converts CSS → device pixels
   // → Inflates by AA_MARGIN + strokeMargin (scale-aware)
   // → Snaps to COALESCE_SNAP grid (8px)
   // → Stores DevicePixelRect
   ```
3. **Promotion Logic (DirtyRectTracker.checkPromotion)**
   - **Conditions for full clear:**
     - Rect count >8
     - Union area >40% of canvas
     - Transform changed (scale/pan)
     - Any translucent object visible (prevents alpha accumulation)
   - Otherwise: Keep dirty rects

4. **Coalescing (DirtyRectTracker.coalesce)**
5. **Clear Pass (RenderLoop.tick)**
   ```typescript
   const instructions = dirtyTracker.getClearInstructions();
   // type: 'full' | 'dirty' | 'none'
   if (instructions.type === 'dirty') {
     for (const rect of instructions.rects) {
       ctx.clearRect(rect.x, rect.y, rect.width, rect.height); // Device pixels
     }
   }
   ```

6. **Clip Region (RenderLoop.tick)**
   ```typescript
   // Convert dirty rects back to world coords for spatial query
   const clipRegion = {
     worldRects: instructions.rects.map(rect => {
       // Device px → CSS px → World coords
       return view.canvasToWorld(rect.x / dpr, rect.y / dpr, ...);
     })
   };

   // Create canvas clip path in world space
   ctx.save();
   ctx.beginPath();
   for (const worldRect of clipRegion.worldRects) {
     ctx.rect(worldRect.minX, worldRect.minY, width, height);
   }
   ctx.clip(); // Constrains drawing to dirty regions
   ```

7. **Spatial Query (objects.ts / drawObjects)**
   ```typescript
   if (viewport.clipRegion?.worldRects) {
     // Query spatial index for each dirty rect
     const entrySet = new Map<string, IndexEntry>();
     for (const rect of viewport.clipRegion.worldRects) {
       const results = spatialIndex.query(rect);
       for (const entry of results) {
         entrySet.set(entry.id, entry); // Dedup by ID
       }
     }
     candidateEntries = Array.from(entrySet.values());
   }
   // Sort by ULID for deterministic z-order
   candidateEntries.sort((a, b) => a.id < b.id ? -1 : 1);
   // Render only affected objects
   for (const entry of candidateEntries) {
     drawObject(ctx, objectsById.get(entry.id));
   }
   ```

**Coordinate Spaces:**
- World bounds → CSS pixels (via worldToCanvas) → Device pixels (× DPR)
- Clear/clip in device pixels → Convert back to world for spatial queries

### Object Cache

**File:** `client/src/renderer/object-cache.ts`

**Type:** Simple Path2D cache by object ID
```typescript
class ObjectRenderCache {
  private cache = new Map<string, Path2D>();

  getOrBuild(id: string, handle: ObjectHandle): Path2D;
  evict(id: string): void;
  evictMany(ids: string[]): void;
  clear(): void;
}
```

**What Gets Cached:**
- Path2D geometry only (NOT styles)
- Single variant per ID (no size/width variants)
- Built from `ObjectHandle.y` fields

**Geometry Builders:**
- **Stroke:** Perfect Freehand polygon from `points` + `width` (with `last: true`)
- **Shape:** Geometric path from `shapeType` + `frame` (rect/ellipse/diamond/roundedRect)

**Eviction Triggers(From room-doc-manager diffing after objects observer fire):**
- Object deleted
- Bbox changed (geometry changed)
- **NOT evicted** on style-only changes (color, opacity) but marked dirty

**Diff Algorithm:**
```typescript
type DiffResult = { dirty: WorldBounds[]; evictIds: string[] };

// For each object:
// - Bbox changed → Evict + mark dirty
// - Style-only changed → Mark dirty (no eviction)
// - Added → Mark dirty
// - Removed → Evict + mark dirty
```

**Perfect Freehand Integration:**
```typescript
// Commit (last: true)
const outline = getStroke(points, { ...PF_OPTIONS_BASE, size: width, last: true });
const path = new Path2D(getSvgPathFromStroke(outline, false));  // CRITICAL: For smooth bezier curves

// Preview (last: false)
const outline = getStroke(points, { ...PF_OPTIONS_BASE, size: width, last: false });
```

**PF Options:**
```typescript
export const PF_OPTIONS_BASE = {
  thinning: 0.60,
  smoothing: 0.6,
  streamline: 0.5,
  simulatePressure: true
};
```

### Spatial Index (RBush R-Tree)

**File:** `packages/shared/src/spatial/object-spatial-index.ts`

**Implementation:**
```typescript
export class ObjectSpatialIndex {
  private tree = new RBush<IndexEntry>(9);

  insert(id: string, bbox: [...], kind: ObjectKind): void;
  update(id: string, oldBBox: [...], newBBox: [...], kind: ObjectKind): void;
  remove(id: string, bbox: [...]): void;
  query(bounds: { minX, minY, maxX, maxY }): IndexEntry[];
  bulkLoad(handles: ObjectHandle[]): void;
  clear(): void;
}
```

**IndexEntry:**
```typescript
export interface IndexEntry {
  minX: number; minY: number; maxX: number; maxY: number;
  id: string;         // ULID for lookup
  kind: ObjectKind;   // Type hint
  // NO data field - lookup via objectsById map
}
```

**BBox Computation:**
```typescript
// File: packages/shared/src/utils/bbox.ts
export function computeBBoxFor(kind: ObjectKind, yMap: Y.Map<any>): [...]

// Stroke/Connector: Scan points, inflate by (width * 0.5 + 1)
// Shape: Use frame, inflate by (width * 0.5 + 1)
```

**CRITICAL:** Width IS part of bbox! Width changes → bbox changes → cache eviction.THIS WILL BE CHANGED IN THE FUTURE

### Two-Epoch Spatial Index Model

**File:** `client/src/lib/room-doc-manager.ts`

**Authoritative State:**
- `objectsById: Map<string, ObjectHandle>` - Single source of truth
- `spatialIndex: ObjectSpatialIndex` - Derived acceleration structure
- `needsSpatialRebuild: boolean` - Epoch flag

**Epoch 1: Rebuild**
- Triggered by: First attach, sanity check failures
- Flow: `hydrateObjectsFromY()` → walk objects Y.Map → build ObjectHandles with bbox → `bulkLoad()` RBush
- Objects container Observer ignored during rebuild

**Epoch 2: Steady-State**
- Y.Map deep observer fires on changes
- Incremental updates: `objectsById.set()` + `spatialIndex.insert/update/remove()`
- Compute dirty rects + eviction IDs for Canvas.tsx

**Observer Logic:**
```typescript
objects.observeDeep((events, txn) => {
  if (this.needsSpatialRebuild) return; // Skip during rebuild epoch

  // Extract touched/deleted IDs from Y.Map events
  // Build dirty rects and eviction IDs
  this.applyObjectChanges({ touchedIds, deletedIds });
});
```

**Incremental Update Flow:**
```typescript
private applyObjectChanges({ touchedIds, deletedIds }): void {
  // 1. Handle deletions: remove from spatialIndex, mark for eviction
  // 2. Handle additions/updates:
  //    - Compute new bbox from Y.Map
  //    - Update objectsById map
  //    - Update spatialIndex (insert or update)
  //    - Determine cache eviction (bbox changed) vs dirty-only (style changed)
  //    - Track dirty rects
}
```

### Tools

**File:** `client/src/lib/tools/`

**Unified Interface:**
```typescript
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;

interface PointerTool {
  canBegin(): boolean;
  begin(pointerId: number, worldX: number, worldY: number, ...): void;
  move(worldX: number, worldY: number): void;
  end(worldX?: number, worldY?: number): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  destroy(): void;
  clearHover?(): void;    // EraserTool
  onViewChange?(): void;  // TextTool, EraserTool
}
```

**DrawingTool:** 
- **REMEMBER**: Drawing tool handles pen, highlighter, **AND shape drawing**
**IMPORTANT**: The snap model is to differentiate between the shape behaviour with the shape tool during preview. 
**We use the DrawingTool as the "ShapeTool" under the hood.** Both use the same preview provider from the drawing tool.
The shape tool uses the first pointer down to create a corner anchored shape, hold and drag to shape the snap.kind rectangle(`rect`), diamond(`diamond`), and CORNER ANCHORED ellipse(`ellipseRect`).
- The Perfect Shape recognizor, if it detects ONLY a rect(`box`) or perfect circle(`circle`), will "snap", but
**NOT TO THE SAME SNAP AS THE SHAPES FROM THE TOOLBAR**, The `box` AABB rectangle and circle ellipse `circle`changes geometry to reshape from the center, unlike the dedicated shapes in the toolbar which use corners.
- We only commit the canon shape types so we map the snapKind accordingly:
  'box': 'rect',           // Hold-detected box → sharp rect
  'circle': 'ellipse',     // Hold-detected circle → ellipse
  'rect': 'roundedRect',   // Tool rect → rounded rect (default)
  'ellipseRect': 'ellipse', // Tool ellipse → ellipse
  'diamond': 'diamond'      // Diamond → diamond

**DRAWING TOOL SHAPE RECOGNIZER**
- **Trigger:** HoldDetector - 600ms dwell with 6px screen-space jitter tolerance
- **Recognizes( Minimum 0.58 score):** box and circles ONLY
- **Snap Flow:**
  1. Hold detected → analyze points → compute shape scores
  2. If confident → freeze anchors, enter refinement mode
  3. Preview shows perfect shape with live cursor refinement
  4. Commit creates shape object with `kind: 'shape'`, `shapeType`, `frame`
- **Anchors (frozen after snap):**
  - `line/arrow`: will be removed for a dedicated connector Tool
  - `circle`: Fixed center, cursor defines radius
  - `rect/ellipseRect/diamond`: Fixed corner A, cursor is opposite corner C
  - `box`: Fixed center/angle/aspect, cursor scales uniformly
- **Shape Tool (Forced Snap):** Bypasses hold detector, immediately enters snap mode with `forceSnapKind`
- **Click-to-Place:** Stationary click creates 180 world-unit fixed-size perfect shape from Toolbar
---

**EraserTool:** **File:** `client/src/lib/tools/EraserTool.ts`

**Fixed Radius (not configurable):**
```typescript
const ERASER_RADIUS_PX = 10;   // Fixed screen-space radius
const ERASER_SLACK_PX = 2.0;   // Forgiving feel for touch
// World radius = (ERASER_RADIUS_PX + ERASER_SLACK_PX) / view.scale
```

**Cursor:** Custom `.cur` file at `/cursors/avloEraser.cur` (no overlay-drawn ring)

**Hit-Testing Pipeline:**
1. RBush spatial query with world-space bounding box
2. For each candidate, dispatch by `handle.kind`:
   - **Stroke/Connector:** Point-to-segment distance test on polyline
   - **Shape:** Dispatch by `shapeType` with geometry-aware tests
   - **Text:** Circle-rect intersection on frame

**Shape-Specific Hit-Testing:**
```typescript
switch (shapeType) {
  case 'diamond':
    // Vertices at frame edge midpoints: top, right, bottom, left
    // Test distance to 4 line segments (edges)
    // For filled: also check point-in-diamond (cross product signs)
    break;
  case 'ellipse':
    // Normalize to unit circle space: dx/rx, dy/ry
    // For filled: normalizedDist <= 1 + tolerance
    // For unfilled: |normalizedDist - 1| <= tolerance
    break;
  case 'rect':
  case 'roundedRect':
  default:
    // For filled: circle-rect intersection (anywhere inside)
    // For unfilled: test distance to 4 edge segments
    break;
}
```

**Fill Behavior:**
- **Filled shapes** (`fillColor` present): Hit anywhere inside OR near stroke
- **Unfilled shapes**: Hit ONLY near stroke edges (interior is "empty")

**State & Dimming:**
- `hitNow`: Objects under cursor this frame
- `hitAccum`: Union of all hits during drag (stays dimmed until commit)
- **Preview only during active erasing** (pointer down) - NO hover dimming
- Dimming: `eraser-dim.ts` uses `globalCompositeOperation = 'screen'` with white overlay

**Eraser Trail (Overlay):** **File:** `client/src/renderer/OverlayRenderLoop.ts`
- Screen-space Perfect Freehand trail (decoupled from tool)
- Age-based pseudo-pressure for thickness taper
- 200ms lifetime, light grey, 0.35 alpha
- Self-animating via `invalidateAll()` while trail exists

**Atomic Commit:** Single `mutate()` deletes all `hitAccum` IDs on pointer-up

**TextTool: WILL BE REPLACED**
- DOM overlay: contenteditable div at world coordinates
- Scale-aware: Font size/padding scale with `view.scale`
- Commit: Enter/blur triggers commit with measured rect
- Returns null preview (DOM IS the preview)

**PanTool:**
- Drag viewport (updates ViewTransform.pan)
- No data writes, local-only
- Sets `grabbing` cursor

**Preview Types:**
```typescript
type PreviewData = StrokePreview | EraserPreview | TextPreview | PerfectShapePreview; //text is null

interface StrokePreview {
  kind: 'stroke';
  points: [number, number][];  // Tuples in world coords
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  bbox: [...] | null; // dormant
}

interface EraserPreview {
  kind: 'eraser';
  circle: { cx: number; cy: number; r_px: number };
  hitIds: string[];
  dimOpacity: number;
}

interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow' | 'diamond';
  fill?: boolean;
  color: string;
  size: number;
  opacity: number;
  anchors: PerfectShapeAnchors;  // Frozen at snap
  cursor: [number, number];       // Live cursor
  bbox: null; //d ormant
}
```

## 7. Awareness & Presence
- Awareness updates throttled (15 Hz base, 8 Hz degraded)
- Cursor positions interpolated for smooth motion
- Keyed by clientId for proper cleanup
- On disconnect: `setLocalState(null)` + clear cursor trails

## 8. Initialization & Gates

**Init Order:**
1. **Construct RoomDocManager**
   - Create `Y.Doc({ guid: roomId })` exactly once, NEVER mutate GUID

2a. **Setup Doc(Not objects) observer** (`ydoc.on`) must be before IDB to catch updates

2b. **Initialize y-indexeddb provider**
   - Database: `avlo.v1.rooms.{roomId}`
   - Gate `idbReady` when initial load applies (2s timeout)

3. **Initialize y-partyserver provider**
   - Connect immediately (don't wait for IDB)
   - Gate `wsConnected` on open
   - Gate `wsSynced` after first sync
4. **Seed structures**
   - **CRITICAL:** Only after `idbReady` AND (`wsSynced` OR 5000ms grace)
   - If `root.has('meta')` is false, run `initializeYjsStructures()` once
5. **Attach UndoManager**
   - `Y.UndoManager([objects], { trackedOrigins: new Set([userId]), captureTimeout: 500 })`
   - After `setupObjectsObserver()` to ensure structures exist
6. **Start awareness**
   - Gate `awarenessReady` when WS awareness is live
7. **Snapshot publishing**
   - Build EmptySnapshot synchronously on construct
   - Gate `firstSnapshot` when first doc-derived snapshot published
8. **Start RAF publisher**

**Gates Table:**
| Gate | Opens When | Timeout | On Timeout |
|------|-----------|---------|------------|
| `idbReady` | IDB loaded | 2s | Proceed empty |
| `wsConnected` | WS open | 5s | Proceed offline |
| `wsSynced` | First Y sync | 10s | Keep rendering from IDB |
| `awarenessReady` | WS connected | None | N/A |
| `firstSnapshot` | First doc update(On load) | 1 rAF | N/A |

**Teardown Order:**
1. Stop RAF publisher
2. Unsubscribe awareness listeners
3. Close WS provider
4. Close IDB provider
5. Destroy UndoManager
6. Guard all public methods with `if (this._destroyed) return;`

## 9. Backend & Sync

### Backend Infrastructure

**Stack:** Cloudflare Workers + Durable Objects + PartyServer + R2, **Location:** `worker/src/`, `wrangler.toml`

