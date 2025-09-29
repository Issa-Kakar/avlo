# AVLO Project Overview (Frontend-Focused)

## 1. Executive Summary

**Purpose:** Link-based, account-less, offline-first collaborative whiteboard with integrated code execution. MVP targets ≤125ms p95 latency, ~100 concurrent users, offline via IndexedDB + CRDT, Redis-backed rooms (14-day TTL).

**Tech Stack:** Frontend (React/TS/Tailwind/Canvas/Monaco), Realtime (Yjs + y-websocket + y-indexeddb), Execution (JS/Pyodide workers), Persistence (Redis + Postgres), PWA.

**Scope (Out):** auth/permissions, minimap, admin tools, recovery, CDN, multi-node scaling, **RBUSH DEFERRED**.

**Write Path:** UI → `mutate(fn)` wrapper → guards → `yjs.transact` → Y.Doc update → providers sync → Redis persist

## 2. Core Architecture

### The RoomDocManager Model (Unified)

**Principle:** Components never receive `Y.Doc`, providers, or awareness directly. A single **RoomDocManager** per room owns them. Rendering reads immutable **Snapshots** published at most once per `requestAnimationFrame`. Writes are coarse-grained through `mutate(fn)`. No component reads live Y structures.

**Ownership:** RoomDocManager owns Y.Doc, y-indexeddb provider, y-websocket provider, UndoManager (Yjs), mutate(fn) wrapper, Spatial index (UniformGrid), and publish loop.

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

2. **UI components MUST NOT import Yjs** (ESLint enforced)
3. **Helpers return Y types only for internal use** (never expose from public methods)

**Publishing Discipline (Event-driven RAF):**

- Continuous RAF loop starts on manager creation (never stops until destroy)
- Set dirty flag when: Yjs updates, local edits, presence updates
- Schedule one RAF callback when dirty
- Default 60 FPS, switch to 30 FPS on mobile/battery/heavy scenes
- **Option B-prime optimization:** Presence-only updates clone previous snapshot with updated presence
- Document changes trigger full snapshot rebuild from Y.Doc
- Typed arrays: Store `number[]` in Yjs, construct `Float32Array` at render time only
- **Snapshot versioning:** Each carries `docVersion: number` (monotonic) that increments on Y.Doc changes only (not presence)

## 3. Data Models & Schema

### Yjs Document Structure

```typescript
// Y.Doc → root: Y.Map → {
//   v: number,                    // schema version
//   meta: Y.Map<Meta>,
//   strokes: Y.Array<Stroke>,     // append only
//   texts: Y.Array<TextBlock>,
//   code: Y.Map<CodeCell>,
//   outputs: Y.Array<Output>      // keep last 10
// }

interface Stroke {
  id: StrokeId; // ULID
  tool: 'pen' | 'highlighter';
  color: string; // #RRGGBB
  size: number; // world units
  opacity: number; // 0..1
  points: number[]; // [x0,y0, x1,y1, ...] NEVER Float32Array
  bbox: [number, number, number, number];
  scene: SceneIdx; // assigned at commit from currentScene
  createdAt: number;
  userId: string;
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
- Stroke simplification at pointer-up (Douglas-Peucker in world units)
- Base tolerance: pen 0.8px, highlighter 0.5px
- Ensure points.length/2 ≤ 10_000 and encoded update ≤ 128KB
- If over limits: retry once with tol \*= 1.4; if still over, uniform downsample

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
}
```

- **Never null:** EmptySnapshot created synchronously on construct with scene=0, empty arrays
- **Typed arrays** constructed at render only, stored doc remains plain arrays
- **Publishing invariants:** docVersion only changes after Yjs update (dev-only assertion)

### Zustand (device-local UI only)

- Scope: toolbar state, lastSeenScene - **never** mirror Yjs
- Persistence: localStorage `avlo:vN:ui` - bump vN on shape changes, include migrate fn
- Use selectors to avoid re-renders, keep slices tiny
- **Tools in Zustand:** pen, highlighter, text, eraser, pan, select (lasso placeholder).

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
   - Simplify per rules (Douglas-Peucker)
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
- RAF-coalesce pointermove via `pendingPoint` buffer
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

- Base: Background → Strokes → Text → Authoring overlays → HUD
- Overlay: Preview (world-space) → Presence (screen-space with DPR only)

## 7. Tool Implementations

### PointerTool Interface (Polymorphic)

All tools (DrawingTool, EraserTool, future LassoTool) implement:

```typescript
type PointerTool = {
  canBegin(): boolean;
  begin(pointerId: number, x: number, y: number): void;
  move(x: number, y: number): void;
  end(x?: number, y?: number): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  destroy(): void;
  clearHover?(): void; // Optional (EraserTool)
};
```

### Drawing Tool

- **State frozen at pointer-down** (stored in state.config)
- **RAF-coalesced pointermove** via pendingPoint buffer
- **Preview opacity:** 0.35 (pen), 0.15 (highlighter) to prevent commit flicker
- **Simplification:** Douglas-Peucker iterative (prevents stack overflow)
  - Base tolerance: pen 0.8, highlighter 0.5 world units
  - One retry with tol \*= 1.4 if over limits
  - Hard downsample if still exceeds 10k points
- **Size estimation:** ~16 bytes per coordinate + 500 metadata + 1024 envelope
- **Commit:** Generate ULID, assign currentScene, push to strokes[]
- **Invalidation:** Preview bounds AND simplified stroke bounds **CRITICAL: PREVIEW RENDERLOOP INVALIDATES ALL ANYWAY SO PARAMETERS ON PREVIEW DO NOT MATTER HERE**

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
  dimOpacity: number; // 0.35 base, adjusted for highlighters
}
```

**Hit-Testing Algorithm (Spatial Index with Fallback):**

1. Spatial query: Use `snapshot.spatialIndex.queryCircle()` when available
2. Viewport prune: Skip strokes outside visible bounds + margin
3. Stroke width: Inflate hit radius by `stroke.style.size / 2`
4. Segment distance: Point-to-line distance for each segment
5. Text blocks: Simple bbox-circle intersection (glyph precision deferred)
5. Resume index: Track progress for continuation (10ms budget, 500 segments max)
6. Live view: Uses `getView()` callback for accurate transforms

**Visual Feedback (Two-Pass Overlay):**

- **Pass A (World):** Adaptive dimming based on brightness
  - Dark (<80): White overlay with 'screen' blend
  - Mid (80-180): Inverted overlay
  - Light (>180): Black overlay
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

**Preview Union Type:**
```typescript
export type PreviewData = StrokePreview | EraserPreview | TextPreview; //TextPreview is kept here but not used for the actual text preview

export interface EraserPreview {
  kind: 'eraser';
  /**
   * Center is in **world** coordinates (so overlay can handle transforms).
   * Radius is in **screen pixels** (CSS px), fixed regardless of zoom.
   */
  circle: { cx: number; cy: number; r_px: number };
  /** World object IDs to dim in pass A. */
  hitIds: string[];
  /** 0.2–0.6 base opacity; highlighters get a lighter treatment in renderer. */
  dimOpacity: number;
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

### Commit

Single `mutate()` replaces at same indices (preserves z-order)

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
