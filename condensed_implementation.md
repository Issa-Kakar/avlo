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
- Registry methods: acquire()/release() for ref counting
- Test helper: createTestManager() for isolated test instances

**Y.Doc Reference Rules (NEVER VIOLATE):**
```typescript
// Helpers traverse 'root' on demand - no cached Y references
private getRoot(): Y.Map<unknown> { return this.ydoc.getMap('root'); }
private getStrokes(): Y.Array<Stroke> { return this.getRoot().get('strokes'); }
private getMeta(): Y.Map<unknown> { return this.getRoot().get('meta'); }
```

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
- publishSnapshot() method updates _currentSnapshot and notifies subscribers
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
- DPR handling: Canvas backing store sized to device pixels (width * dpr, height * dpr)
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
- Preview opacity: **0.35 for pen**, **0.15 for highlighter** (prevents commit flicker)
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
- `/client/src/lib/tools/types.ts`: `toolbarToDeviceUI` adapter

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

Create guarded `toolbarToDeviceUI` adapter:

- Default unknown tools to 'pen', clamp size 1-64, validate hex colors
- Wire Canvas.tsx to use Zustand store instead of static deviceUI
- Tool state frozen at pointer-down (existing DrawingTool mechanism)

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
  users: Map<UserId, {
    name: string;
    color: string;
    cursor?: { x: number; y: number };  // Smoothed world coords
    activity: 'idle' | 'drawing' | 'typing';
    lastSeen: number;
  }>;
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
- **Publishing**: Presence-only updates clone previous snapshot (Option B-prime optimization)
- **Pipeline**: RoomDocManager → `buildPresenceView()` → inject into snapshot → overlay renders
- **Single gate guard**: Draw presence ONLY when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`
- **No double-smoothing**: Manager interpolates, renderer draws as-is
- **WebRTC deferred**: Phase 7 is WebSocket-only, RTC in future phase

## Phase: RBush Spatial Indexing

**Deferred.** Interfaces may remain reserved (e.g., `spatialIndex`) but are not populated

## Phase 8: Eraser Tool Implementation

**Architecture.** Whole-stroke eraser following DrawingTool lifecycle pattern. Mirror pointer event handling, use same two-canvas overlay system, commit via single mutate() for atomic undo.

**Key Updates (Phase 8 Revision):**
- **Tool-Agnostic Canvas**: Canvas.tsx instantiates tools based on `activeTool`, routes events to uniform `PointerTool` interface
- **Preview Union Type**: `PreviewData = StrokePreview | EraserPreview` with eraser having world center coords and screen-space radius
- **Shared Cache**: Export `getStrokeCacheInstance()` singleton from stroke-builder for reuse in dimming pass
- **Coordinate Spaces**: Eraser cursor center in world coords (transformed by overlay), radius in CSS pixels (fixed size)
- **Two-Pass Rendering**: Pass A dims hit strokes in world space, Pass B draws cursor circle in screen space with lineWidth=1
- **Atomic Delete**: Single `mutate()` transaction for all deletions = one undo step

VIEW PHASE8.md for full implementation details.


## Phase 9: Text & Stamps

## Phase 10: Undo/Redo System

## Phase 11: Room Lifecycle Management

## Phase 12: Export

## Phase 13: Code Execution System

## Phase 14: Service Worker & PWA

## Phase 15: WebRTC & P2P (Optional Enhancement)
