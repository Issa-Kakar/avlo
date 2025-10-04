# AVLO Implementation Guide - Phase 2 Onwards

## Phase 2: Core Data Layer & Models

### 2.1 Define Core TypeScript Types and Interfaces

**Files:**

- `/packages/shared/src/types/room.ts`: Core domain types (Stroke, TextBlock, Meta, etc.)
- `/packages/shared/src/types/snapshot.ts`: Snapshot interfaces and createEmptySnapshot()
- `/packages/shared/src/types/identifiers.ts`: Type aliases (StrokeId, TextId, SceneIdx, UserId)

**Key Implementation Details:**

- Stroke points stored as flat `number[]` array (NEVER Float32Array in Y.Doc)
- Scene field assigned at commit time using currentScene (for filtering)
- Snapshot includes docVersion (monotonic counter replacing svKey)
- ViewTransform provides worldToCanvas/canvasToWorld methods
- createEmptySnapshot() returns frozen object with all required fields

### 2.2 Implement RoomDocManager Foundation

**File:** `/client/src/lib/room-doc-manager.ts`

**Registry Pattern (CRITICAL):**

- RoomDocManagerImpl class is private - NEVER export directly
- Access only via RoomDocManagerRegistry (singleton per room guarantee)

**Initialization:**

- Constructor: `new Y.Doc({ guid: roomId })` - guid never mutated
- initializeYjsStructures(): Seeds root map in single transaction
- Seeding delayed until after G_IDB_READY + (G_WS_SYNCED or 350ms grace)
- Detection: `root.has('meta')` indicates initialized structure

**mutate() Implementation:**

- Wrapper around single yjs.transact()
- Guards: room ≥15MB (read-only), mobile (view-only), frame >2MB
- Defers writes if containers don't exist, replays after seeding

### 2.3 Implement Snapshot Publishing System

**File:** `/client/src/lib/room-doc-manager.ts`

**RAF Loop Architecture:**

- Continuous RAF loop starts on manager creation (never stops until destroy)
- publishState tracks: isDirty, presenceDirty, rafId, lastPublishTime
- Dirty flags set by: Y.Doc updates, awareness changes, gate transitions

**buildSnapshot() Method:**

- Early return if !root.has('meta') - returns current snapshot
- Filters strokes/texts by currentScene
- Includes docVersion (increments on Y.Doc changes only)
- Deep freezes arrays in development
- Opens G_FIRST_SNAPSHOT gate on first doc-derived publish

**Publishing Optimizations:**

- Option B-prime: Presence-only changes clone previous snapshot
- Document changes trigger full rebuild from Y.Doc
- publishSnapshot() method updates \_currentSnapshot and notifies subscribers
- Timing tracked for metrics (publishCostMs)

### 2.4 Set Up Subscription Management

**Files:**

- `/client/src/lib/room-doc-manager.ts`: Core subscription methods
- `/client/src/lib/room-doc-registry-context.tsx`: React context for registry access

**Subscription Methods:**

- subscribeSnapshot(): Immediate callback with currentSnapshot, returns unsubscribe
- subscribePresence(): Throttled via updatePresenceThrottled (30Hz), immediate callback
- subscribeRoomStats(): Returns current stats or null, updates on setRoomStats()
- subscribeGates(): Uses stable string primitives to prevent re-render loops

**React Integration:**

- RoomDocRegistryProvider: Wraps app, maintains single registry instance
- useRoomDocRegistry(): Hook to access registry (must be in provider)
- useHasRoomDocRegistry(): Check if within provider context

**Presence Throttling (Phase 7 preview):**

- Separate 30Hz throttle for UI updates (not network rate)
- buildPresenceView() includes cursor smoothing (lerp/interpolation)
- Presence dirty flag triggers snapshot republish

## Phase 3: Basic Canvas Infrastructure

### 3.1 Set Up Canvas Element and Context

**Files:**

- `/client/src/canvas/CanvasStage.tsx`: Low-level DPR-aware canvas substrate
- `/client/src/canvas/internal/context2d.ts`: Context configuration utilities

**Implementation Details:**

- CanvasStage component provides imperative handle with clear(), withContext(), getBounds()
- ResizeObserver fires onResize with ResizeInfo (cssWidth, cssHeight, dpr, pixelWidth, pixelHeight)
- DPR handling: Canvas backing store sized to device pixels (width _ dpr, height _ dpr)
- Apply DPR once with setTransform(dpr,0,0,dpr,0,0) - never mix into view transforms
- Clear() uses identity transform + device pixel dimensions for complete clearing
- DPR change detection via matchMedia listener on `(resolution: ${dpr}dppx)`

### 3.2 Implement Coordinate Transform System

**Files:**

- `/client/src/canvas/ViewTransformContext.tsx`: React context for view state management
- `/client/src/canvas/internal/transforms.ts`: Transform utilities (applyViewTransform, transformBounds, etc.)

**Implementation Details:**

- ViewTransform interface with worldToCanvas/canvasToWorld methods + scale/pan properties
- Pan is in WORLD UNITS (not screen pixels) - critical for proper zoom behavior
- Transform formulas (authoritative per OVERVIEW.MD):
  - worldToCanvas: `[(x - pan.x) * scale, (y - pan.y) * scale]`
  - canvasToWorld: `[x / scale + pan.x, y / scale + pan.y]`
- Context transform order: `ctx.scale(scale, scale)` THEN `ctx.translate(-pan.x, -pan.y)`
- View limits: MIN_ZOOM=0.1, MAX_ZOOM=10, MAX_PAN_DISTANCE=50000
- ViewTransformProvider manages state, provides setScale/setPan/resetView methods

### 3.3 Build Render Loop Foundation

**Files:**

- `/client/src/canvas/Canvas.tsx`: Main canvas component orchestrating both render loops
- `/client/src/renderer/RenderLoop.ts`: Base canvas render loop (world content)
- `/client/src/renderer/OverlayRenderLoop.ts`: Overlay canvas loop (preview + presence)
- `/client/src/renderer/DirtyRectTracker.ts`: Dirty rect optimization for base canvas

**Architecture (Two-Canvas):**

- Base canvas (RenderLoop): Renders world content, invalidates only on docVersion changes
- Overlay canvas (OverlayRenderLoop): Renders preview/presence, invalidates on any change
- Both canvases managed by Canvas.tsx with separate refs (baseStageRef, overlayStageRef)

**RenderLoop (Base Canvas) Details:**

- EVENT-DRIVEN: Only schedules RAF when needsFrame=true (via invalidation)
- DirtyRectTracker manages partial redraws vs full clears based on area threshold
- Transform changes force full clear (tracked via lastTransformState)
- Scene changes force full clear (tracked via lastRenderedScene)
- Hidden tab handling: Falls back to 8 FPS interval when document.hidden
- Render order: Background → Strokes → Shapes → Text → Authoring overlays → HUD
- Viewport culling: Skip strokes with bbox outside visible bounds

**OverlayRenderLoop Details:**

- Lightweight loop for preview (drawing in progress) and presence (cursors)
- Preview accessed via PreviewProvider interface (set by DrawingTool)
- Always does full clear (cheap operation for sparse overlay content)
- Render order: Preview pass (world-space) → Presence pass (screen-space)
- holdPreviewForOneFrame(): Special method to prevent flicker on commit

**Canvas.tsx Integration:**

- Subscribes to snapshots via roomDoc.subscribeSnapshot()
- Stores snapshot in ref (not state) to avoid React re-renders at 60 FPS
- diffBounds() computes dirty regions between snapshots for base canvas
- Handles viewport/resize events, propagates to both render loops
- Bridges DrawingTool preview to OverlayRenderLoop via setPreviewProvider()

## Phase 4: Stroke Data Model & Rendering

### 4.1 Implement Stroke Rendering Pipeline

**Files:**

- `/client/src/renderer/stroke-builder/path-builder.ts`: Builds Path2D and Float32Array at render time
- `/client/src/renderer/stroke-builder/stroke-cache.ts`: FIFO cache (max 1000 strokes) keyed by stroke ID
- `/client/src/renderer/layers/strokes.ts`: Main stroke rendering layer

**Key Implementation Details:**

- Store points as flat `[x,y,x,y,...]` arrays (plain number[], NEVER Float32Array in Y.Doc)
- `buildStrokeRenderData()`: Creates Float32Array and Path2D only at render time
- Path2D feature detection for test environments (falls back to manual path building)
- Module-level `StrokeRenderCache` persists across frames, cleared on scene change
- **Phase 8 Update**: Export `getStrokeCacheInstance()` for sharing with eraser dim layer
- Render strokes: strokeStyle=color, lineWidth=size (world units), globalAlpha=opacity
- Hairlines/HUD use `1/scale` for ~1 device pixel

### 4.2 Tool-Specific Rendering

- Pen: Standard rendering, round caps/joins, opacity from tool settings
- Highlighter: opacity=0.25 (default), normal blending (source-over)
- Respect scene order - no tool-based reordering
- Context save/restore per stroke for clean state isolation

### 4.3 Performance Optimizations

**Viewport Culling (`isStrokeVisible`):**

- Converts viewport to world bounds with margin (50px / scale)
- Inflates stroke bbox by half stroke width for accurate culling
- Uses CSS pixels for transforms, not device pixels

**Level of Detail (LOD):**

- `shouldSkipLOD()`: Skip strokes with bbox diagonal <2px in screen space
- Calculates screen diagonal as `worldDiagonal * viewTransform.scale`

**Cache Management:**

- FIFO eviction when cache exceeds 1000 strokes
- Cache cleared on scene change (tracked via lastScene)
- Cache keyed by stroke.id (strokes immutable post-commit)

## Phase 5: Drawing Input System

### 5.1 Implement Pointer Event Handling

**Files:**

- `/client/src/lib/tools/DrawingTool.ts`: Core drawing tool implementation
- `/client/src/canvas/Canvas.tsx`: Pointer event handling and tool lifecycle

**DrawingTool Constructor:**

```typescript
constructor(
  room: IRoomDocManager,
  settings: { size: number; color: string; opacity?: number },  // Direct settings
  toolType: 'pen' | 'highlighter',  // Explicit tool type
  userId: string,
  onInvalidate?: (bounds: [number, number, number, number]) => void,
)
```

**Implementation Details:**

- Attach pointer events with `setPointerCapture` on pointerdown, release on up/cancel/lostcapture
- RAF-coalesce pointermove via `pendingPoint` buffer (prevents event flooding)
- Tool settings **frozen at pointerdown** (stored in state.config)
- Convert screen→canvas→world coordinates via `screenToWorld()` helper
- Mobile detection: UA string + `maxTouchPoints>1` for iPadOS
- Event listeners attached with `{ passive: false }` for preventDefault
- Comprehensive cleanup on unmount (release capture, cancel drawing, remove listeners)
- Update awareness activity state: 'drawing' during gesture, 'idle' on up

### 5.2 Build Preview Rendering

**Files:**

- `/client/src/renderer/layers/preview.ts`: Preview rendering function
- `/client/src/renderer/OverlayRenderLoop.ts`: Preview provider interface

**Implementation Details:**

- `setPreviewProvider()` bridges DrawingTool to OverlayRenderLoop
- Preview opacity: **matches commit opacity** (pen: 1.0, highlighter: 0.45)
- Render on overlay canvas in world coordinates (transform already applied)
- `updateBounds()`: Invalidates old bounds first, then new bounds
- `holdPreviewForOneFrame()`: Prevents flicker on stroke commit
- Mobile gets no preview (view-only enforcement)

### 5.3 Commit a Stroke

**Files:**

- `/client/src/lib/tools/simplification.ts`: Douglas-Peucker and size estimation

**Implementation Flow:**

1. **Flush pending points** from RAF buffer
2. **Validate minimum** 4 values (2 points)
3. **Simplification** (`simplifyStroke()`):
   - Douglas-Peucker with **iterative algorithm** (prevents stack overflow on 10k+ points)
   - Base tolerance: pen 0.8, highlighter 0.5 world units
   - Budgets: ≤128KB encoded update, ≤10k points
   - One retry with `tol *= 1.4` if over limits
   - Highlighter tolerance capped at `baseTol * 1.5`
   - Hard downsample if still exceeds point count
   - Returns empty array if still exceeds 128KB (stroke rejected)
4. **Frame size check**: Verify < 2MB transport limit after simplification
5. **Calculate bbox** with stroke width inflation (world units)
6. **Commit via mutate()**:
   - Generate ULID for stroke ID
   - Get `currentScene` from `scene_ticks.length` at commit time
   - Push to `strokes` Y.Array in single transaction
7. **Invalidate regions**:
   - Preview bounds (clears preview rendering)
   - Simplified stroke bounds (draws committed stroke)
   - Both invalidations critical to avoid visual artifacts

**Size Estimation (`estimateEncodedSize`):**

- Each coordinate: ~16 bytes (8 for float64 + 8 for CRDT metadata)
- Stroke metadata: ~500 bytes
- Update envelope: ~1024 bytes

## Phase 6: Offline-First Infrastructure & Real-time Sync

Phase 6 establishes the complete persistence and sync infrastructure, connecting IndexedDB for offline storage, WebSocket for real-time collaboration, Redis for server persistence, and PostgreSQL for metadata.

### 6.1 Client-Side Persistence (y-indexeddb)

**Files:**

- `/client/src/lib/room-doc-manager.ts`: Provider initialization, gate management
- `/client/src/lib/config-schema.ts`: Client config validation with Zod

**Implementation:**

**Provider Initialization (`initializeIndexedDBProvider`):**

- Creates room-scoped IDB with key `avlo.v1.rooms.${roomId}`
- Attaches BEFORE WebSocket (offline-first principle)
- Sets 2s timeout for `G_IDB_READY` gate
- On timeout: continues with empty doc, keeps provider attached for late updates
- Wrapped in try/catch: on exception, opens gate immediately as fallback

**Seeding Discipline:**

- Waits for `G_IDB_READY` AND either `G_WS_SYNCED` OR 350ms grace period
- Seeds containers only if `!root.has('meta')` at that point
- Single `initializeYjsStructures()` call in one transaction
- Prevents race where fresh tab clobbers existing room data

**Boot Guarantees:**

- EmptySnapshot created synchronously on construct (never null)
- First paint always non-null via EmptySnapshot
- Doc-derived frame arrives ≤1 RAF after IDB/WS sync
- No boot-time render snapshot; always starts from empty

**Config Validation (`ClientConfigSchema`):**

- Validates `VITE_WS_BASE`, `VITE_API_BASE`, `VITE_ROOM_TTL_DAYS`
- Fails gracefully with user-friendly error panel
- Offline editing continues even on config failure

### 6.2 Server Infrastructure

**Files:**

- `/server/src/index.ts`: Express server setup, middleware
- `/server/src/config/env.ts`: Server environment validation with Zod
- `/server/src/lib/redis.ts`: Redis adapter with gzip compression
- `/server/src/lib/prisma.ts`: Prisma client singleton
- `/server/src/websocket-server.ts`: y-websocket server integration
- `/server/src/routes/rooms.ts`: HTTP API endpoints

**Environment Config (`ServerEnvSchema`):**

- Validates PORT, ORIGIN_ALLOWLIST, REDIS_URL, DATABASE_URL
- ROOM_TTL_DAYS (1-90), WS_MAX_FRAME_BYTES (2MB default)
- MAX_CLIENTS_PER_ROOM (105 default), GZIP_LEVEL (4)
- Fails fast on invalid config at startup

**Redis Persistence (`RedisAdapter`):**

- Stores compressed Y.Doc snapshots with TTL
- Key format: `room:<roomId>`
- Compression: gzip level 4 before storage
- Full state serialization (not incremental deltas)
- TTL extends only on accepted writes (not awareness)
- AOF enabled at deployment layer for durability
- Type mapping ensures binary data preserved as Buffers

**PostgreSQL Metadata:**

- Non-authoritative; Redis presence defines existence
- Schema: id, title, createdAt, lastWriteAt, sizeBytes
- Updates after each successful persist
- Returns 404 if Redis key missing (expired room)

### 6.3 WebSocket Integration

**Files:**

- `/server/src/websocket-server.ts`: Server-side WebSocket handling
- `/client/src/lib/room-doc-manager.ts`: Client WebSocket provider

**Server (`setupWebSocketServer`):**

- Binds `@y/websocket-server` to `/ws/:roomId` paths
- Origin allowlist enforcement on upgrade
- 2MB frame size cap with immediate close on violation
- Capacity check: sends `room_full` message before closing
- First connection loads from Redis, applies to Y.Doc
- On doc updates: serialize full state, gzip, save to Redis
- Updates Prisma metadata (sizeBytes, lastWriteAt)
- Debounced persistence (300ms) to batch rapid changes

**Client (`initializeWebSocketProvider`):**

- Connects immediately after IDB (no waiting)
- URL built from `VITE_WS_BASE` + roomId
- Opens `G_WS_CONNECTED` on socket open
- Opens `G_WS_SYNCED` after first state-vector exchange
- On disconnect: continues offline with IDB queue
- Connection indicator: Online/Offline/Read-only states

### 6.4 HTTP API & Metadata

**Files:**

- `/server/src/routes/rooms.ts`: REST endpoints
- `/client/src/hooks/use-room-metadata.ts`: TanStack Query hooks
- `/client/src/lib/api-client.ts`: Typed API client

**Endpoints:**

- `POST /api/rooms`: Create room (ULID), insert metadata
- `GET /api/rooms/:id/metadata`: Check Redis, return metadata or 404
- `PUT /api/rooms/:id/rename`: Update title with Zod validation
- `GET /api/rooms?limit=N`: Optional list for dev/admin

**Client Integration (`useRoomMetadata`):**

- TanStack Query with 10s polling, no window focus refetch
- Updates RoomDocManager stats on successful fetch
- Shows size warning at 13MB, read-only at 15MB
- Sets stats to null on 404 (expired room)
- Preserves local IDB copy for recovery

### 6.5 Gate System & UI Integration

**Files:**

- `/client/src/hooks/use-connection-gates.ts`: Gate subscription with stable primitives
- `/client/src/pages/RoomPage.tsx`: Dynamic room routing
- `/client/src/stores/device-ui-store.ts`: Zustand store for UI state
- `/client/src/lib/tools/types.ts`: Tool type definitions and preview types

**Gate Management:**

- Encodes gates as stable string primitives (`"0|1|0|1|1"`)
- Prevents re-render loops with `useSyncExternalStore`
- 150ms debounce on gate changes
- `queueMicrotask` wrapper prevents sync updates

**Routing & UI:**

- React Router with `/room/:roomId` dynamic routes
- ViewTransformProvider resets on room change
- Zustand persists toolbar state in localStorage
- Tool state frozen at pointer-down (DrawingTool)

**Connection States:**

- Before `G_WS_CONNECTED`: Drawing allowed, server actions disabled
- Before `G_WS_SYNCED`: Renders from IDB, no special indicator
- IDB timeout: Continues with EmptySnapshot
- Read-only enforcement: Local writes accepted, server rejects

### 6.6 Teardown & Error Handling

**Teardown Order:**

1. Stop RAF publisher
2. Unobserve Y.Doc listeners
3. Disconnect/destroy WebSocket provider
4. Destroy IndexedDB provider
5. Destroy Y.Doc (wrapped in try/catch)
6. Mark destroyed, guard all public methods

**Error Boundaries:**

- Config validation failures show user-friendly panel
- Network errors retry silently (1 retry, then fallback)
- Metadata 404 preserves local data for recovery
- Frame size violations close connection immediately
- Capacity exceeded shows read-only banner

**Critical Invariants:**

- Single RoomDocManager per roomId (registry enforced)
- No UI imports of yjs/providers (ESLint enforced)
- Provider attach order: IDB → WS → (future) RTC
- All mutations through single `mutate()` wrapper
- Awareness never persisted, only ephemeral

TODO IN FUTURE PHASE 7: **`G_AWARENESS_READY`** opens when WS connected (no timeout, no remote state requirement). Cursors/presence render only when both `G_AWARENESS_READY && G_FIRST_SNAPSHOT`. When offline: presence is best-effort; cursors simply hide

---

## Phase 6D: UI Integration & Routing

### 6D.1 Gate Subscription System

**Critical Fix**: Prevent infinite re-render loops by using stable primitive snapshots with `useSyncExternalStore`.

- Add `subscribeGates()` method to RoomDocManager with 150ms debounce
- Return string primitives (`"0|1|0|1|1"`) instead of objects for referential stability
- Use `queueMicrotask` to defer callbacks, avoiding synchronous state updates
- Call `notifyGateChange()` when gates change (IDB ready, WS connected/synced, first snapshot)

### 6D.2 React Router Integration

- Routes: `/` (test harness), `/room/:roomId` (dynamic rooms), `/test` (alt test path)
- Extract CanvasWithControls to RoomPage component
- Use `useParams()` for dynamic room ID, replace hardcoded 'test-room-001'
- Wrap with ViewTransformProvider, reset view on room change

### 6D.3 Zustand Store Integration

**Direct Tool Configuration Pipeline:**

- **Source of Truth:** Zustand store holds all tool settings (pen, highlighter, eraser, text, etc.)
- **Canvas.tsx Integration:** Reads settings directly from store, no intermediate adapters
- **Tool Instantiation Pattern (consistent across all tools):**
  - EraserTool: `new EraserTool(roomDoc, eraser, userId, ...)`
  - DrawingTool: `new DrawingTool(roomDoc, settings, toolType, userId, ...)`
  - TextTool: `new TextTool(roomDoc, text, userId, ...)`
- **Tool State Management:** Settings frozen at pointer-down (existing DrawingTool mechanism)
- **Benefits:** Simpler mental model, consistent pattern, easier to extend with new tools

## Phase 7: Awareness & Presence System

**Scope**: WebSocket-only awareness (no WebRTC), cursor trails, roster badges, and interpolation. Ephemeral data never persisted, injected into Snapshots.

### 7.1 Core Awareness Architecture

**Files:**

- `/client/src/lib/room-doc-manager.ts`: Awareness ownership, send/receive, interpolation
- `/client/src/lib/user-identity.ts`: Random name/color generation
- `/client/src/hooks/use-presence.ts`: React subscription hook

**Single-Owner Awareness:**

- RoomDocManager owns one `YAwareness` instance bound to Y.Doc (UI never imports Yjs directly)
- Import from `'y-protocols/awareness'` to avoid name collision with app's Awareness type
- Presence injected into every published Snapshot at ≤60 FPS
- `subscribePresence(cb)`: Throttled to ≤30 Hz for React protection&#x20;

**Gates & Lifecycle:**

- `G_AWARENESS_READY`: Opens on WS connect, closes on disconnect (immediate, no timeout)
- Presence renders only when both `G_AWARENESS_READY && G_FIRST_SNAPSHOT` are true
- On disconnect: `setLocalState(null)` + `clearCursorTrails()` for immediate hide
- Gate transitions trigger `presenceDirty` to flush visibility changes
- Teardown: Stop publisher → unsubscribe → close WS → preserve IDB

### 7.2 Local Identity & Sending

**Identity Generation (`/client/src/lib/user-identity.ts`):**

- Per-tab `userId` (ULID) generated on manager construct
- Random name: "Adjective Animal" (e.g., "Swift Fox") using crypto.getRandomValues()
- Random color from palette of 12 vetted hex colors
- Name is not editable in Phase 7 (no UI for custom names)

**Awareness Payload Structure:**

```typescript
{
  userId: string,         // Per-tab ULID
  name: string,          // "Adjective Animal"
  color: string,         // #RRGGBB from palette
  cursor?: { x, y },     // World coords (desktop only, undefined on mobile)
  activity: 'idle' | 'drawing' | 'typing',
  seq: number,           // Monotonic per-sender for ordering
  ts: number,           // ms epoch (advisory)
  aw_v?: number         // Version for future evolution
}
```

**Activity Tracking & Send Cadence:**

- **Cursor updates**: World coords on pointermove (desktop only, mobile sends no cursor)
- **Pointer leave**: Set cursor undefined immediately when leaving stage
- **Activity states**: `drawing` (pointer down), `typing` (Monaco focus), `idle` (default/blur)
- **Send interval**: `clamp(90ms + 3ms * max(0, N-10), 75ms, 150ms)` + ±10ms jitter
  - Small rooms: ~10-13 Hz, degrades to ~6-7 Hz as peer count grows
- **Backpressure**: Skip frame if `bufferedAmount > 64KB`, degrade rate if > 256KB
- **No heartbeats**: Silent when state unchanged (freshness over pings)

### 7.3 Cursor Interpolation & Receive Pipeline

**Interpolation (`ingestAwareness` in room-doc-manager.ts):**

- Track `PeerSmoothing` per user with last/prev samples and animation state
- Drop stale frames using `seq <= lastSeq` check (sequence-based ordering)
- Quantize cursor to 0.5 world units at ingest to reduce jitter&#x20;

- **Gap detection**: If `seq > lastSeq + 1`, snap immediately to avoid rubber-banding
- **Linear interpolation**: 66ms window (`INTERP_WINDOW_MS`) for 1-2 frame smoothing
- **RAF keep-alive**: Force `presenceDirty` while animating to publish interpolated frames

**Visibility Policy:**

- Cursors visible only when present in latest awareness state (no frozen cursors)
- Immediate hide on disconnect or pointer-leave (cursor undefined)
- Trails fade naturally by age using exponential decay: `α = exp(-(now - t)/τ)`
- No "away" states or post-disconnect grace periods

**PresenceView Structure:**

```typescript
interface PresenceView {
  users: Map<
    UserId,
    {
      name: string;
      color: string;
      cursor?: { x: number; y: number }; // Smoothed world coords
      activity: 'idle' | 'drawing' | 'typing';
      lastSeen: number;
    }
  >;
  localUserId: string;
}
```

### 7.4 Two-Canvas Rendering Architecture

**Files:**

- `/client/src/canvas/Canvas.tsx`: Orchestrates both canvas stages
- `/client/src/renderer/RenderLoop.ts`: Base canvas (world content)
- `/client/src/renderer/OverlayRenderLoop.ts`: Overlay canvas (preview + presence)
- `/client/src/renderer/layers/presence-cursors.ts`: Cursor trail rendering
- `/client/src/renderer/layers/index.ts`: `drawPresenceOverlays()` integration
- `/client/src/pages/components/UsersModal.tsx`: Roster modal UI

**Canvas Split:**

- **Base canvas**: Document content, invalidates only on `docVersion` change
- **Overlay canvas**: Preview strokes + presence cursors, invalidates on any change
- Export excludes overlay content (presence is ephemeral)

**Cursor Rendering (`drawCursors()` in presence-cursors.ts):**

- OS-style arrow pointer (10-12px tall × 7-9px wide) with 1px black outline at 30% alpha
- Fixed screen-space size (doesn't scale with zoom)
- Pointer tip aligns to cursor position
- Name label: 11px rounded pill below cursor, white text on user color background
  **Cursor Trails:**
- Rolling buffer of world-space `{x, y, t}` points per peer (max 22 points, 550ms age limit)
- Three-pass rendering for smooth appearance: outer glow, inner glow, main stroke
- Alpha decay: `α = exp(-(now - t)/260ms)` with position-based and stop-motion multipliers
- Stop detection: Fade aggressively (45% multiplier) when cursor stationary >80ms
- Trail width tapers from 2.2px (head) to 0.4px (tail)
- **Performance degradation**: >10 peers: cap to 12 points; >25 peers or <30 FPS: disable trails
- **Accessibility**: Respects `prefers-reduced-motion` (cursor-only when enabled)&#x20;

**Roster UI (UsersModal.tsx):**

- User count badge with activity indicators (✏️ drawing, ⌨️ typing)
- Immediate removal on disconnect (no "away" state or grace period)
- Updates capped to ≤1 Hz to prevent UI flicker

### 7.5 Policies & Error Handling

**Network & Performance:**

- **Send rate**: ~10-13 Hz (small rooms) → ~6-7 Hz (high peer count)
- **Backpressure**: Skip frame if `bufferedAmount > 64KB`, degrade if > 256KB
- **UI throttle**: `subscribePresence()` capped at 30 Hz (React protection)
- **Mobile**: View-only, no cursor emission, activity always 'idle'

**Privacy:**

- Awareness never persisted (ephemeral, server memory only)
- Names sanitized, capped at 40 chars
- No PII collection, random names per tab

**Failure Recovery:**

- **WS disconnect**: `G_AWARENESS_READY` closes → cursors hide immediately → `setLocalState(null)`
- **Reconnect**: Gate reopens → presence resumes → trails rebuild
- **Clock skew**: Use `seq` for ordering, `ts` is advisory only
- **Multiple tabs**: Each gets unique `userId` (shows as separate users)

### 7.6 Implementation Details

**Key Private Fields (RoomDocManager):**

- `yAwareness`: YAwareness instance from 'y-protocols/awareness'
- `peerSmoothers`: Map for interpolation state per peer
- `awarenessSeq`: Monotonic counter for send ordering
- `localProfile`: Per-tab { userId, name, color }
- `awarenessIsDirty`: Dirty flag for send scheduling

**Send Loop:**

- Mark dirty on cursor/activity/profile change
- Wait for `G_AWARENESS_READY` before sending
- Increment `seq` only on actual send
- Quantize cursor to 0.5 world units before equality check
- Skip frame on backpressure, coalesce to next tick

**Receive Processing:**

- Validate and drop stale frames (seq-based)
- Update `PeerSmoothing` state for interpolation
- Set `presenceDirty` to trigger RAF publish
- Ignore self updates

**Critical Implementation Notes:**

- **Publishing**: Presence-only updates clone previous snapshot
- **Pipeline**: RoomDocManager → `buildPresenceView()` → inject into snapshot → overlay renders
- **Single gate guard**: Draw presence ONLY when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`
- **No double-smoothing**: Manager interpolates, renderer draws as-is
- **WebRTC deferred**: Phase 7 is WebSocket-only, RTC in future phase

## Phase 8: Eraser Tool Implementation

### 8.1 Core Eraser Architecture

**Files:**

- `/client/src/lib/tools/EraserTool.ts`: Main eraser tool implementation
- `/client/src/lib/tools/types.ts`: Preview union types (StrokePreview | EraserPreview)

**PointerTool Interface:**
All tools (DrawingTool, EraserTool) implement a common interface for polymorphic handling:

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
};
```

**EraserTool State Machine:**

```typescript
interface EraserState {
  isErasing: boolean;
  pointerId: number | null;
  radiusPx: number; // CSS pixels (from deviceUI.eraser.size)
  lastWorld: [number, number] | null; // Last cursor position
  hitNow: Set<string>; // IDs under current cursor
  hitAccum: Set<string>; // IDs accumulated during drag
}
```

**Key Implementation Details:**

- **Live View Transform**: Uses `getView()` callback for accurate hit-testing (avoids stale transforms)
- **Pointer Leave Handling**: `clearHover()` method clears state when pointer leaves canvas
- **Performance Optimization**: Resume index tracks hit-test progress for continuation across frames
- **Spatial Index Integration**: Uses `snapshot.spatialIndex.queryCircle()` when available, falls back to linear scan
- **Stroke Width Accounting**: Inflates hit radius by `stroke.style.size / 2` for accurate detection
- **RAF Coalescing**: Batches pointer moves like DrawingTool

### 8.2 Preview Union Types

**File:** `/client/src/lib/tools/types.ts`

**Discriminated Union:**

```typescript
export interface StrokePreview {
  kind: 'stroke'; // Discriminant
  points: ReadonlyArray<number>;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  bbox: [number, number, number, number] | null;
}

export interface EraserPreview {
  kind: 'eraser'; // Discriminant
  circle: { cx: number; cy: number; r_px: number }; // Center in world, radius in CSS px
  hitIds: string[];
  dimOpacity: number; // 0.75 default
}

export type PreviewData = StrokePreview | EraserPreview | TextPreview | PerfectShapePreview;
```

### 8.3 Overlay Rendering Integration

**File:** `/client/src/renderer/OverlayRenderLoop.ts`

**Two-Pass Eraser Rendering:**

```typescript
if (previewToDraw.kind === 'eraser') {
  // Pass A: Dim hit strokes (world space)
  if (previewToDraw.hitIds.length > 0) {
    ctx.save();
    ctx.scale(view.scale, view.scale);
    ctx.translate(-view.pan.x, -view.pan.y);
    drawDimmedStrokes(ctx, previewToDraw.hitIds, snapshot, previewToDraw.dimOpacity);
    ctx.restore();
  }

  // Pass B: Draw cursor circle (screen space)
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0); // DPR only, no world transform
  const [screenX, screenY] = view.worldToCanvas(previewToDraw.circle.cx, previewToDraw.circle.cy);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.lineWidth = 1; // Device pixel for crisp line
  ctx.beginPath();
  ctx.arc(screenX, screenY, previewToDraw.circle.r_px, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
```

### 8.4 Adaptive Dimming System

**File:** `/client/src/renderer/layers/eraser-dim.ts`

**Adaptive Color Strategy:**

- **Brightness Calculation**: Uses relative luminance (0.299R + 0.587G + 0.114B)
- **Dark Strokes (<80)**: White overlay with 'screen' blend mode (lightens)
- **Mid-Tone (80-180)**: Inverted overlay for contrast
- **Light Strokes (>180)**: Black overlay with high opacity
- **Shared Cache**: Uses `getStrokeCacheInstance()` singleton for Path2D reuse
- **Extra Thickness**: Adds 3-4px to stroke width for better visibility

**Implementation:**

```typescript
function getDimmingStrategy(strokeColor: string): {
  overlayColor: string;
  blendMode: GlobalCompositeOperation;
  extraThickness: number;
} {
  const brightness = getColorBrightness(strokeColor);

  if (brightness < 80) {
    // Dark colors
    return {
      overlayColor: 'rgba(255, 255, 255, 0.7)',
      blendMode: 'screen',
      extraThickness: 4,
    };
  } else if (brightness < 180) {
    // Mid-tones
    return {
      overlayColor: brightness < 130 ? 'rgba(255, 200, 200, 0.8)' : 'rgba(0, 0, 0, 0.8)',
      blendMode: 'source-over',
      extraThickness: 3,
    };
  } else {
    // Light colors
    return {
      overlayColor: 'rgba(0, 0, 0, 0.9)',
      blendMode: 'source-over',
      extraThickness: 3,
    };
  }
}
```

### 8.5 Canvas Integration

**File:** `/client/src/canvas/Canvas.tsx`

**Tool-Agnostic Architecture:**

```typescript
// Branch ONCE during tool creation
let tool: PointerTool | null = null;

if (activeTool === 'eraser') {
  tool = new EraserTool(
    roomDoc,
    eraser, // Direct from Zustand store
    userId,
    () => overlayLoopRef.current?.invalidateAll(),
    () => ({
      /* viewport dimensions */
    }),
    () => viewTransformRef.current, // Live view transform
  );
} else if (activeTool === 'pen' || activeTool === 'highlighter') {
  const settings = activeTool === 'pen' ? pen : highlighter;
  tool = new DrawingTool(roomDoc, settings, activeTool, userId /* ... */);
}

// UNIFIED handlers - no tool branching
const handlePointerDown = (e: PointerEvent) => {
  if (isMobile) return; // Canvas gates mobile
  if (!tool?.canBegin()) return;
  // ...
  tool.begin(e.pointerId, worldCoords[0], worldCoords[1]);
};

const handlePointerLeave = () => {
  roomDoc.updateCursor(undefined, undefined);
  if (tool && 'clearHover' in tool) {
    (tool as any).clearHover(); // Clear eraser hover
  }
};
```

**Key Points:**

- Mobile gating at Canvas level (not in tools)
- Tool state stored in ref to survive React re-renders
- Preview provider set on overlay loop for both tools
- Cursor style: 'none' for eraser, 'crosshair' for drawing

### 8.6 Spatial Index Implementation

**Files:**

- `/client/src/lib/spatial/uniform-grid.ts`: Cell-based spatial grid
- `/client/src/lib/spatial/stroke-spatial-index.ts`: Stroke-specific wrapper
- `/client/src/lib/room-doc-manager.ts`: Integration in snapshot building

**UniformGrid Architecture:**

- Divides world into 128x128 unit cells
- Items inserted into all overlapping cells
- Query returns unique items from relevant cells
- Prevents duplicates with itemsById Map

**Integration:**

```typescript
// In RoomDocManager.buildSnapshot()
const spatialIndex = strokes.length > 0
  ? this.buildSpatialIndex(strokes)
  : null;

// In buildSpatialIndex()
private buildSpatialIndex(strokes: ReadonlyArray<StrokeView>): SpatialIndex {
  const cellSize = 128;  // World units
  return new StrokeSpatialIndex(strokes, cellSize);
}

// In EraserTool hit-testing
if (snapshot.spatialIndex) {
  candidateStrokes = snapshot.spatialIndex.queryCircle(
    worldX, worldY, radiusWorld + 32  // Max stroke width buffer
  );
} else {
  candidateStrokes = snapshot.strokes;  // Fallback
}
```

### 8.7 Atomic Deletion

**Commit Flow:**

```typescript
commitErase(): void {
  if (this.state.hitAccum.size === 0) return;

  // Single mutate() = one undo step
  this.room.mutate((ydoc) => {
    const root = ydoc.getMap('root');
    const yStrokes = root.get('strokes') as Y.Array<any>;
    const yTexts = root.get('texts') as Y.Array<any>;

    // Build id→index maps
    const strokeIdToIndex = new Map<string, number>();
    for (let i = 0; i < yStrokes.length; i++) {
      strokeIdToIndex.set(yStrokes.get(i).id, i);
    }

    // Sort indices descending for reverse deletion
    const strokeIndices = Array.from(this.state.hitAccum)
      .map(id => strokeIdToIndex.get(id))
      .filter((idx): idx is number => idx !== undefined)
      .sort((a, b) => b - a);

    // Delete in reverse to preserve indices
    for (const idx of strokeIndices) {
      yStrokes.delete(idx, 1);
    }
  });

  this.resetState();
  this.onInvalidate?.();  // Clear preview
}
```

### 8.8 Performance Optimizations

**Hit-Test Resumption:**

- Tracks `resumeIndex` for continuing across frames
- Resets when cursor moves significantly (>0.5 \* radius)
- Time budget: 10ms per frame, 500 segments max
- Schedules RAF continuation if interrupted

**Shared Stroke Cache:**

```typescript
// Singleton export for reuse
let globalCacheInstance: StrokeRenderCache | null = null;

export function getStrokeCacheInstance(): StrokeRenderCache {
  if (!globalCacheInstance) {
    globalCacheInstance = new StrokeRenderCache(1000);
  }
  return globalCacheInstance;
}
```

- Preview always cleared on commit/cancel via onInvalidate()
- Spatial index rebuilt per snapshot (strokes immutable for now)

## Phase 9: Text Tool (DOM overlay, atomic commit)

### 9.1 Text Tool — End-to-end implementation

**Purpose & constraints.**  
Provide WYSIWYG text entry via a **DOM overlay editor** that visually matches final world-space rendering. Commit the text atomically to `texts[]` with a single mutate. No per-keystroke CRDT traffic; rendering happens in the base (world) canvas like strokes.

#### 9.1.1 DOM overlay host & Canvas wiring

- We mount a **DOM overlay host** (z-index 3) above the base and overlay canvases. It is pointer-transparent by default; the active editor element enables pointer events while editing. Host stays pinned to the canvas container edges.
- **Canvas → Tool handles**: TextTool is instantiated with a small “canvas handle”: `worldToClient`, `getView()`, and `getEditorHost()` so the tool can position the editor and respond to pan/zoom/resize without owning canvas concerns.
- The **OverlayRenderLoop** continues to draw authoring previews for other tools and presence; TextTool itself returns **no overlay preview** because the DOM editor is the preview. (Overlay loop API: `setPreviewProvider`, `holdPreviewForOneFrame` remain available for other tools.)

#### 9.1.2 Lifecycle & state machine

`idle → placing → editing → (commit|cancel)`

- **begin(x,y)**: on pointer-down, cache **world** anchor `(x,y)`, create the contenteditable element in the overlay host, and position it using world→screen→host conversions (see 9.1.3).
- **move**: not used for text entry (cursor movement handled by the DOM).
- **end / cancel**: blur/escape cancels; blur/Enter commits (see 9.1.5 Commit).

#### 9.1.3 Coordinate chain & scale discipline

- **Three spaces**: **world** (document), **screen** (CSS px), **host-relative** (DOM overlay). We compute host-relative `(left, top, width, height)` from the world anchor using `worldToClient` + view transform.
- **Scale-aware rendering**: editor font size, padding, and border thickness scale with `view.scale` so the DOM editor looks identical to final canvas text at any zoom.
- **Offset alignment**: apply `totalOffset = scaledBorderWidth + scaledPadding` to align the editor’s top-left to the intended world anchor.
- **Pan/zoom**: on `onViewChange()` we recompute the editor’s CSS transform/size to track the view; this avoids re-creating the editor.

#### 9.1.4 Device UI → Text config pipeline

- **Source of truth**: text **color** and **size** flow from the **device-UI store**, not from the tool instance; while the editor is active we set `isTextEditing=true` to hide the Color/Size dock (prevents overlapping UI).
- **Live updates**: if the user changes text settings mid-edit (e.g., size/color), we **update the active tool config without re-creating the tool** (prevents DOM destruction).

#### 9.1.5 Commit (atomic) & storage

- **Trigger**: Enter key or editor **blur**.
- **Measure**: read `getBoundingClientRect()` of the editor, then divide width/height by `view.scale` to get world units.
- **Mutate once**: **single** `mutate(fn)` appends the `TextBlock` to `texts[]` (or replaces at the same index if editing an existing block). Fields: `{id, x, y, w, h, content, color, size, scene, createdAt, userId}`.
- **Invalidate & cleanup**: hide the editor, clear `isTextEditing`, and let the next snapshot render the text in the base loop. (Overlay can optionally hold one frame for other tools; not required for Text.)

#### 9.1.6 Render (world pass)

- **Layer & order**: base canvas draws Text after strokes using the existing world renderer; **viewport culling** applies before issuing `fillText`. Baseline is `top`; font family is Inter/system UI.
- **Dirty regions**: `diffBounds(prev,next)` already accounts for `texts[]` and returns dirty rects for text adds/moves/edits; base loop invalidates selectively.

#### 9.1.7 **FUTURE** Undo/redo & z-order

- The commit is a **single transaction**, producing one undo step. **FUTURE FEATURE**: When replacing an existing text, we write at the **same array index** to preserve z-order, consistent with strokes. (Matches snapshot diffing approach used elsewhere.)

#### 9.1.8 Failure & edge-case handling (minimum spec)

- **Empty content** on commit → cancel (no write). \_(UI/behavior inherited from the DOM editor; not persisted.)
- **Pan/zoom during edit** → `onViewChange()` repositions editor; no re-create.
- **Config change mid-edit** → `updateConfig()`; do not tear down editor.

### 9.2 Integration contracts (unchanged but relevant to Text)

- **Two-canvas model** remains: base (world) + overlay (preview/presence). Overlay clears fully, draws world previews with the **view transform once**, and draws presence in **screen space** (DPR only). `setPreviewProvider` & `holdPreviewForOneFrame()` are the stable overlay APIs.
- **Dirty rects for text**: base loop already diffs text bounds for selective invalidation.
- **Device-UI editing rule**: while TextTool is active, `isTextEditing=true` hides the dock; config changes update the active editor without recreating the tool.

---
### Perfect Shapes (IMPLEMENTED)

- **600ms dwell trigger:** HoldDetector fires after pointer stillness, runs recognition on stroke
- **Shape detection:** Circle (Taubin fit, coverage ≥67%) vs Rectangle (AABB not OBB, soft scoring) vs Line (strict fallback)
- **Locked refinement:** Post-snap, pointer drags adjust geometry only (radius/box-scale/line-endpoint)
- **Near-miss handling:** Shapes scoring within 0.10 of confidence (0.48-0.58) don't snap, preventing annoying line fallbacks
- **Standard commit:** Perfect shapes convert to polyline strokes on pointer-up, no special storage

## Phase 10: Undo/Redo System

## Phase 11: Room Lifecycle Management

## Phase 12: Export

## Phase 13: Code Execution System

## Phase 14: Service Worker & PWA

## Phase 15: WebRTC & P2P (Optional Enhancement)
