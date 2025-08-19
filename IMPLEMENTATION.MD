# Avlo Implementation Guide

## Overview
This guide provides a step-by-step implementation plan for building Avlo, an offline-first collaborative whiteboard. Follow each phase sequentially, as later phases depend on earlier foundations. Each step includes specific constraints from avlo.md to prevent over-engineering.
---
## Phase 1: Project Foundation & Infrastructure Setup

### 1.1 Initialize Monorepo Structure
1. Create root directory with two workspaces: `client` and `server`
2. Set up shared TypeScript configuration at root level
3. Configure workspace package.json with exact versions from avlo.md:
   - React 18.3.1, Vite 5.4.11, TypeScript 5.9.2
   - Yjs 13.6.27, y-websocket 3.x, y-indexeddb 9.x
   - Prisma 5.22.0, Monaco 0.52.2
4. Install development dependencies: ESLint, Prettier, Husky, lint-staged
5. Create `.nvmrc` file specifying Node version
6. Initialize git repository with `.gitignore` covering build artifacts and node_modules

### 1.2 Configure Build Pipeline
1. Set up Vite configuration for client with:
   - Output directory pointing to `server/public`
   - Asset hashing enabled for cache busting
   - Chunk splitting for lazy-loaded modules
   - Source maps for development only
2. Configure server build to compile TypeScript to JavaScript
3. Create build script that runs client build first, then server build
4. Set up watch mode for development with concurrent client and server processes
5. Configure environment variable loading with dotenv


### 1.3 Set Up Development Environment
1. Configure ESLint with strict rules including:
   - `no-restricted-imports` rule blocking direct imports of yjs, y-webrtc, y-websocket, y-indexeddb in UI code
   - TypeScript strict mode enabled
   - React hooks rules
2. Set up Prettier with consistent formatting rules
3. Configure git hooks via Husky:
   - Pre-commit: lint-staged for formatting and linting
   - Pre-push: type checking
4. Create development environment variables file template
5. Set up VS Code workspace settings with recommended extensions

### 1.4 Initialize Testing Framework
1. Install and configure Vitest for unit tests
2. Set up Playwright for E2E tests with:
   - Root configuration file
   - Test directory structure (`e2e/*`)
   - Helper utilities for common operations
3. Create test data generators for rooms, strokes, and users
4. Set up coverage reporting configuration
5. Add test scripts to package.json

**Deliverables:**
- Monorepo with client/server workspaces
- Build and development scripts
- Linting and formatting configuration
- Basic test infrastructure

---
## Phase 2: Core Data Layer & Models

Out of scope
Any UI components, canvas work, or network providers—this phase is models + plumbing only. 
Multi-node scaling, auth/permissions, or admin tooling. 

Constraints
UI must not import yjs/providers; expose access only through RoomDocManager + hooks. Snapshots are immutable and never null. 
Authoritative storage is Redis (TTL-based); Postgres is non-authoritative metadata only. 
Store stroke points as number[] in Yjs; create Float32Array only at render time. 
Enforce budgets in WriteQueue.validate: MAX_POINTS_PER_STROKE=10k, encoded update < 128 KB, text ≤ 500 chars. 
UI components must not import Yjs/providers directly; all mutations go through WriteQueue → CommandBus; snapshots are immutable. 
Store numeric arrays in Yjs as number[]; only create Float32Array at render time. 
Command limits: ≤10,000 points per stroke; code ≤200KB; text ≤500 chars; specific server rate limits apply later. 
Snapshot publish loop max 60fps; coalesce updates within ~8–16ms; drop to ~8fps when tab hidden.
Y.Doc({guid:roomId}) must equal resolved roomId; never mutate guid.
Snapshot builder must be O(changes), publish ≤1/rAF, and freeze in dev.
All commands carry idempotencyKey; duplicates discard without side-effects.
Validation guards cover MAX_TOTAL_STROKES and per-command rate limits.

Things to watch out for
Single consumer for yjs.transact; coalesce within a transact; yield if > 8 ms to avoid jank. 
Backpressure: widen micro-batch window to 24–32 ms when queue grows; drop superseded deltas.
Always emit an initial EmptySnapshot; never allow null snapshot. 
Enforce queue backpressure (max ~100 pending) and idempotency to prevent duplicate writes. 
Keep Yjs state-vector–derived svKey stable to avoid spurious re-renders.
Re-entrancy of observers during batch updates.
Publish thrash when micro-batching windows widen; keep ≤32 ms under pressure.
Memory pressure from large arrays; avoid accidental Float32Array retention.

### 2.1 Define TypeScript Types and Interfaces
1. Create shared types file with all data models from Section 4:
   - StrokeId, TextId, SceneIdx type aliases
   - Stroke interface with all required fields
   - TextBlock interface
   - CodeCell and Output interfaces
   - Meta interface with scene_ticks array
2. Define awareness payload structure (ephemeral data)
3. Create device UI state interfaces for localStorage
4. Define command types for WriteQueue pattern
5. Create snapshot interface (immutable view structure)
6. Add validation helper types and guards

### 2.2 Implement RoomDocManager Foundation
1. Create RoomDocManager class skeleton with:
   - Private Y.Doc instance property
   - Private provider references (will be null initially)
   - Current snapshot property (never null - start with EmptySnapshot)
   - Subscription management maps
2. Implement constructor that:
   - Creates Y.Doc with guid matching roomId
   - Initializes EmptySnapshot synchronously
   - Sets up internal event emitters
3. Add destroy method that will handle cleanup (stub for now)
4. Implement subscription methods (return unsubscribe functions):
   - subscribeSnapshot
   - subscribePresence  
   - subscribeRoomStats
5. Create singleton registry to ensure one manager per room

### 2.3 Set Up Yjs Document Structure
1. Initialize Y.Map as document root in RoomDocManager
2. Create Y.Array for strokes with proper typing
3. Create Y.Array for texts
4. Create Y.Map for code cell
5. Create Y.Array for outputs with size enforcement
6. Create Y.Map for meta including scene_ticks array
7. Add helper methods to safely access these structures
8. Important: Store arrays as plain number[], never Float32Array in Yjs

### 2.4 Implement Snapshot Publishing System
1. Create snapshot builder that:
   - Reads current Y.Doc state
   - Generates unique svKey from state vector
   - Creates frozen arrays (Object.freeze in development)
   - Builds immutable snapshot object
2. Set up requestAnimationFrame loop for publishing:
   - Maximum 60 FPS rate limiting
   - Batch multiple Y updates within single frame
   - Coalesce updates within 8-16ms windows
3. Implement dirty tracking to avoid unnecessary publishes
4. Add logic to detect tab visibility and reduce to 8 FPS when hidden
5. Ensure EmptySnapshot is published immediately on creation

### 2.5 Create WriteQueue and CommandBus
1. Implement WriteQueue class with:
   - Queue data structure with max 100 pending commands
   - Validation method checking room size, mobile status, frame size
   - Backpressure handling when queue exceeds limits
   - Idempotency tracking map
2. Create CommandBus that:
   - Consumes from WriteQueue
   - Wraps each command in single yjs.transact()
   - Applies commands to Y.Doc structures
   - Handles command-specific logic
3. Add command validation for each command type:
   - Size limits (MAX_POINTS_PER_STROKE = 10,000)
   - Content limits (code body ≤ 200KB)
   - Text length limits (500 chars)
4. Implement rate limiting for specific commands (ClearBoard: 1/15s)

**Deliverables:**
- Complete TypeScript type system
- Basic RoomDocManager with subscription system
- Yjs document structure initialized
- Snapshot publishing pipeline
- WriteQueue and CommandBus infrastructure

---
## Phase 3: Canvas Rendering & Drawing System
Out of scope
Partial/soft eraser, shape editing/selection, image uploads. (Whole-stroke eraser only; shapes later.) Presence/awareness rendering (Phase 4).  Tools like text/eraser/clear-board (Phase 6).

Constraints 
Commit on pointer-up via DrawStrokeCommit; no writes during preview. 
Simplify in world units (Douglas–Peucker); keep encoded update < 128 KB. 
Maintain strict draw order (strokes → stamps → text → cursors/overlays). 
World/canvas/screen spaces must remain distinct; store everything in world coords; apply transforms at render time only. 
Zoom limits 0.1×–10×; maintain strict draw order (bg → strokes → stamps → text → cursors → UI). 
LOD rules: skip/simplify sub-pixel strokes; preview layer must not write to Yjs.
All geometry in world units; DPR only affects canvas scale at paint time.
Strict draw order never changes (including overlays/minimap).
Preview layer MUST be cleared deterministically on pointer-up/cancel.

Things to watch out for
Device-pixel-ratio sizing and transform correctness across 0.5×/1×/2× zoom. 
Dirty-rect and culling to stay within frame budget (ties into Phase 10 perf).
Commit size: encoded stroke must be <128KB before submit. 
DevicePixelRatio math—rounding errors can cause blurring; debounce resize. 
Keep 60fps target; use dirty rects/culling aggressively. 
GC churn from per-frame path construction; reuse buffers where safe.
High-DPI rounding errors at extreme zoom; verify hit-tests at 0.5×/10×.

### 3.1 Set Up Canvas Infrastructure
1. Create main canvas element with proper sizing:
   - Get device pixel ratio for high DPI support
   - Size canvas backing store appropriately
   - Handle resize events with debouncing
2. Implement ViewTransform system:
   - World to canvas coordinate conversion
   - Canvas to world coordinate conversion
   - Scale and pan state management
   - Zoom limits (0.1x to 10x)
3. Create render loop connected to snapshot updates:
   - Subscribe to RoomDocManager snapshots
   - Implement dirty rectangle tracking
   - Set up culling for off-screen elements
4. Establish draw order (critical for correct rendering):
   - Background (white for export)
   - Strokes, then stamps, then text
   - Local preview overlays
   - Presence cursors (when available)
   - UI overlays (minimap, toasts)

### 3.2 Implement Stroke Rendering
1. Create stroke renderer that:
   - Converts stored number[] to Float32Array at render time only
   - Handles pen vs highlighter opacity differences
   - Implements proper line caps and joins
   - Applies world-to-canvas transform
2. Add LOD (Level of Detail) system:
   - Skip strokes smaller than 1 pixel at current zoom
   - Simplify very small strokes to single points
   - Use coarser rendering for tiny elements
3. Implement stroke preview during drawing:
   - Render to separate preview layer
   - No writes to Yjs during preview
   - Clear preview on pointer up
4. Add proper pressure support where available

### 3.3 Build Spatial Indexing with RBush
1. Initialize RBush spatial index in RoomDocManager
2. Populate index with stroke bounding boxes
3. Implement index maintenance:
   - Incremental updates for small changes
   - Full rebuild when (added+removed) > 256
   - Rebuild when bbox area change > 15%
4. Create hit-testing methods using index:
   - Point-in-stroke detection
   - Rectangle intersection queries
   - Nearest element finding
5. Ensure index is included in immutable snapshots

### 3.4 Implement Pointer Event Handling
1. Set up pointer event listeners with:
   - Unified mouse/touch/pen handling
   - Proper pointer capture on drag
   - Pressure detection where supported
2. Create drawing state machine:
   - Idle state (no interaction)
   - Preview state (pointer down, collecting points)
   - Commit state (pointer up, write to Yjs)
3. Implement point collection during drawing:
   - Convert screen to world coordinates immediately
   - Store in temporary buffer
   - Apply streaming simplification if needed
4. Add pointer-up commit flow:
   - Run Douglas-Peucker simplification in world units
   - Check encoded size (must be < 128KB)
   - Build DrawStrokeCommit command
   - Submit to WriteQueue
5. Handle edge cases:
   - Pointer leave during draw
   - Right-click cancellation
   - Multi-touch rejection

### 3.5 Implement Coordinate Space Contract
1. Define three coordinate spaces clearly:
   - Document/world space (stable, stored)
   - Canvas space (device pixels)
   - Screen space (CSS pixels)
2. Create transform utilities:
   - Screen to canvas (accounting for device pixel ratio)
   - Canvas to world (applying view transform)
   - Chain transforms correctly
3. Store all data in world coordinates only
4. Apply transforms at render time only
5. Test transforms at multiple zoom levels (0.5x, 1x, 2x)

**Deliverables:**
- Working canvas with proper coordinate systems
- Stroke rendering with LOD
- Spatial indexing for hit-testing
- Complete drawing pipeline from pointer to commit
- Preview rendering during draw

---

## Phase 4: Real-time Collaboration Infrastructure
Out of scope
WebRTC/P2P transport and direct pairing—those land in Phase 9. 
Constraints
WebSocket is the authoritative path; inbound frame cap 2 MB; origin allowlist required. 
Awareness is ephemeral (never persisted); throttle ~30 Hz with dynamic interval + jitter. 
Reconnect with backoff (300 ms→20 s, ±20% jitter). 
Server limits: ≤105 clients/room; ≤8 concurrent/IP; 2MB inbound frame. 
Reconnect backoff: exp(300ms base) with jitter; reset after 30s stable. 
Awareness: base ~30Hz; dynamic interval 50–150ms w/ ±10ms jitter; never persisted. 
Things to watch out for
Drop old awareness frames by seq; skip under backpressure. 
Multi-tab primary election (BroadcastChannel) to avoid double TTL extensions.
Emit specific error envelopes (room_full, room_full_readonly, offline_delta_too_large). 
Multi-tab: primary handles awareness/TTL; secondaries are receive-only; promote within ~1s on primary exit. 
Don’t attempt persistence via WS here; WS is authoritative path but data durability is Phase 5.
Reconnect thundering-herd; jittered backoff and roster debounce.

### 4.1 Set Up WebSocket Server
1. Install @y/websocket-server (v0.1.x) on server
2. Create WebSocket endpoint at `/ws/<roomId>`:
   - Extract roomId from URL path
   - Validate origin against allowlist
   - Set up per-connection state tracking
3. Configure connection limits:
   - Maximum 105 clients per room
   - Maximum 8 concurrent connections per IP
   - 2MB inbound frame size limit
4. Implement error envelopes for client:
   - room_full
   - room_full_readonly
   - offline_delta_too_large
5. Set up connection lifecycle logging

### 4.2 Integrate y-websocket Provider in Client
1. Add y-websocket provider to RoomDocManager:
   - Create provider with room-specific URL
   - Pass existing Y.Doc instance
   - Store provider reference for cleanup
2. Set up connection state tracking:
   - G_WS_CONNECTED gate on open
   - G_WS_SYNCED gate after first sync
   - Handle disconnection states
3. Implement reconnection logic:
   - Exponential backoff (300ms base, 20s max)
   - ±20% jitter to prevent thundering herd
   - Reset retry counter after 30s stable connection
4. Add connection indicator UI component:
   - Online (green)
   - Reconnecting (yellow)
   - Offline (red)
   - Read-only (red with different icon)

### 4.3 Implement Awareness System
1. Set up awareness protocol via y-websocket:
   - Create awareness instance tied to Y.Doc
   - Configure ~30Hz base send rate
   - Implement throttling based on peer count
2. Add awareness payload structure:
   - userId (device:tab format)
   - name and color
   - cursor position (world coordinates)
   - activity state (idle/drawing/typing)
   - Sequence number for ordering
3. Implement dynamic send interval:
   - Calculate: 50ms * (1 + max(0,(N-10)/20))
   - Clamp between 50ms and 150ms
   - Add ±10ms jitter
   - Recompute only on ≥15% peer count change
4. Set up awareness subscription in RoomDocManager:
   - Subscribe to awareness changes
   - Inject into snapshot for rendering
   - Apply smoothing/interpolation
5. Handle awareness edge cases:
   - Skip frames under backpressure
   - Drop old frames (seq number based)
   - Never persist awareness data

### 4.4 Create Presence UI Components
1. Build cursor renderer:
   - Render remote cursors from snapshot presence data
   - Apply interpolation for smooth movement
   - Show user name and color badges
2. Implement cursor trails:
   - Keep rolling buffer of 12-24 points
   - Trim points older than 600ms
   - Reduce to dots only when peers > 25
3. Create active users list:
   - Show all connected users
   - Display activity indicators
   - Update from awareness data
4. Add collaboration mode indicator:
   - Show "Server" or "P2P" mode
   - Update based on active transport

### 4.5 Handle Multi-Tab Coordination
1. Set up BroadcastChannel for same room:
   - Channel name: 'room:<id>'
   - Elect primary tab (lowest openedAt)
   - Handle primary/secondary roles
2. Primary tab responsibilities:
   - Send awareness updates
   - Perform TTL extensions
   - Start WebRTC if applicable
3. Secondary tab behavior:
   - Receive-only for awareness
   - No TTL extensions
   - No WebRTC initialization
4. Implement promotion on primary departure:
   - Detect via visibilitychange/unload
   - Secondary promotes within 1 second

**Deliverables:**
- WebSocket server with Yjs integration
- Client-side WebSocket provider
- Working awareness system with presence
- Cursor rendering with trails
- Multi-tab coordination

---
## Phase 5: Persistence & Storage Layer
Out of scope
Recovery of expired rooms; cold storage beyond TTL; multi-node Redis. PWA caching (Phase 8) and WebRTC transport (Phase 9).  UI features (Phase 6) and code execution (Phase 7). 

Constraints
Redis is source of truth; gzip level 4; ROOM_TTL_DAYS=14 extended only on accepted writes. 
8 MB warning pill; 10 MB hard cap makes room read-only. 
Batch flushes every 2–3 s; final flush on SIGTERM (3 s grace). 
Postgres: non-authoritative metadata; return 404 if Redis key missing. 
Redis is the single source of truth; PostgreSQL is non-authoritative. Return 404 when Redis key missing. 
TTL defaults to 14 days; extend only on accepted writes (never on reads/awareness). 
Batch flushes every ~2–3s; flush on SIGTERM (3s grace); track sizes post-compression (gzip level 4). 
IDB: proceed if load >2s; rehydrate in background; batch writes per frame.

Things to watch out for
Use persist-ack from server (size_bytes, new TTL) to drive pills/banners. 
Guard against “large offline delta” on reconnect; surface clear recovery UX.
Alias mapping (local-* → server ids) and provisional room flows during publish. 
TTL extension command must be minimal and rate-limited (~10 min). 
Rate limit APIs (e.g., 10 rooms/hour/IP; 5 renames/min).

### 5.1 Set Up Redis for Authoritative Storage
1. Configure Redis instance with:
   - AOF (Append Only File) enabled
   - Appropriate memory limits
   - Backup configuration
2. Create Redis adapter for Yjs documents:
   - Key format: 'room:<roomId>'
   - Compress with gzip level 4 before storage
   - Store as binary buffer
3. Implement TTL management:
   - Set TTL to ROOM_TTL_DAYS (default 14)
   - Extend only on accepted writes
   - Never extend on reads or awareness
4. Add flush mechanism:
   - Batch writes every 2-3 seconds
   - Flush on SIGTERM with 3 second grace
   - Track flush sequence numbers
5. Implement size tracking:
   - Calculate compressed size after each write
   - Store size_bytes for capacity checks

### 5.2 Configure PostgreSQL with Prisma
1. Set up PostgreSQL database
2. Create Prisma schema with room metadata:
   - id (room identifier)
   - title (user-provided name)
   - createdAt timestamp
   - lastWriteAt timestamp  
   - size_bytes (from Redis)
3. Configure connection pooling:
   - Pool size 10-20 connections
   - Set idle and acquire timeouts
   - Log slow queries
4. Important: PostgreSQL is non-authoritative
   - Redis defines room existence
   - Return 404 if Redis key missing even if DB row exists
5. Handle degraded mode:
   - System continues if PostgreSQL unavailable
   - Metadata endpoints return 503

### 5.3 Implement IndexedDB for Offline Storage
1. Add y-indexeddb provider to RoomDocManager:
   - One provider per room
   - Attach immediately after Y.Doc creation
   - Set G_IDB_READY gate when loaded
2. Configure IndexedDB schema:
   - Store full Y.Doc per room
   - Store room metadata (My Rooms list)
   - Store alias mappings (local-* to server ids)
3. Implement 2-second timeout:
   - If IDB doesn't load within 2s, proceed with empty doc
   - Schedule background re-hydration attempt
4. Handle IDB write strategy:
   - Batch writes once per frame
   - Flush when queue ≥ 1,000 strokes
5. Add chunked read strategy:
   - Read in 1k-5k record chunks
   - Yield to event loop between chunks

### 5.4 Create Room Lifecycle Management
1. Implement local-first room creation:
   - Generate 'local-<ulid>' identifier
   - Create Y.Doc with provisional id
   - Store in IndexedDB with provisional flag
   - Add to My Rooms list
2. Build publish flow to server:
   - POST /api/rooms endpoint
   - Merge local doc with server doc
   - Update alias mapping
   - Change provisional flag to false
3. Add join flow for existing rooms:
   - Resolve any aliases first
   - Connect WebSocket
   - Load metadata
   - Check and display expiry time
   - Enforce capacity limits
4. Implement room expiry:
   - Check TTL on metadata fetch
   - Return 404 when expired
   - Clean up local storage
5. Create TTL extension mechanism:
   - Minimal write to Y.Doc
   - Rate limit to once per 10 minutes
   - Show confirmation toast

### 5.5 Build REST API Endpoints
1. Create POST /api/rooms:
   - Generate permanent room ID
   - Initialize in Redis
   - Return roomId and shareLink
   - Make idempotent (200 on retry)
2. Implement GET /api/rooms/{id}/metadata:
   - Fetch from PostgreSQL
   - Check Redis for existence first
   - Return 404 if Redis key missing
   - Include size_bytes, expires_at
3. Add PUT /api/rooms/{id} for rename:
   - Update title in PostgreSQL
   - Rate limit to 5 per minute
   - Validate title length
4. Set up rate limiting:
   - 10 rooms per hour per IP
   - Track with Redis or in-memory

**Deliverables:**
- Redis persistence with compression
- PostgreSQL metadata storage
- Complete offline storage via IndexedDB
- Room lifecycle (create, publish, join, expire)
- REST API for room management

---

## Phase 6: UI Components & Tools
Out of scope
Auto-panning due to remote actions; any auth UX; mobile editing (MVP is view-only). Editor/code execution (Phase 7), PWA (Phase 8), and RTC (Phase 9).
Constraints
Whole-object eraser only(with preview, stroke lightens on touch and erases on mouse release); text becomes immutable on commit (≤500 chars). 
“Clear board” appends a scene tick (excluded from undo/redo) and is rate-limited. 
Show ≥8 MB size pill, enforce read-only at 10 MB. 
Eraser is whole-object only; must integrate with RBush hit-testing. 
Text: single commit (immutable after), ≤500 chars. 
Clear Board appends a scene tick, not undoable; server rate-limited (1/15s). 
PNG export: edge ≤8192px; white bg; 24px padding; 2s full-board timeout then fallback. 
Things to watch out for
Accessibility on sliders/popovers; never auto-reveal toolbar while drawing. 
Gate minimap/export on G_FIRST_SNAPSHOT to avoid null state. 
Exclude presence/UI overlays from export/clipboard. 
Keep undo/redo per-user (device:tab).

### 6.1 Build Toolbar System
1. Create docked toolbar component:
   - Left side, pinned, expanded by default
   - Optional auto-hide behavior
   - Device-local state persistence
2. Implement tool buttons:
   - Pen tool with size/color/opacity
   - Highlighter (fixed 0.25 opacity)
   - Text tool
   - Eraser (whole-object only)
   - Stamp selector
3. Add advanced controls panel:
   - Size slider with preview
   - Color picker (HSV)
   - Opacity control (pen only)
   - Keyboard navigation support
4. Store toolbar state in localStorage:
   - Key: 'avlo:v1:ui'
   - Include selected tool, colors, sizes
   - Version and provide migrator
5. Never auto-reveal toolbar while drawing

### 6.2 Implement Eraser Functionality
1. Create eraser hit-testing:
   - Use RBush spatial index
   - Find intersecting objects
   - Highlight on hover
2. Build delete command:
   - Collect all intersecting stroke/text IDs
   - Create single EraseObjects command
   - Submit as one transaction
3. Add visual feedback:
   - Preview what will be erased
   - Show eraser cursor size
   - Animate deletion
4. Ensure proper cleanup:
   - Remove from spatial index
   - Update snapshot

### 6.3 Create Text Tool
1. Build text overlay component:
   - Click to place text cursor
   - Inline editing interface
   - Commit on blur or Enter
2. Implement text constraints:
   - Maximum 500 characters
   - Single commit (immutable after)
   - Store position and dimensions
3. Add text rendering to canvas:
   - Render after strokes but before cursors
   - Apply proper font metrics
   - Handle multi-line text
4. Include in hit-testing:
   - Add text blocks to RBush
   - Make erasable like strokes

### 6.4 Build Clear Board Feature
1. Create Clear Board command:
   - Appends to meta.scene_ticks[]
   - Increments current scene
   - Excludes from undo/redo
2. Add confirmation dialog:
   - Require explicit confirmation
   - Show warning about affecting everyone
3. Implement rate limiting:
   - Server-side: 1 per 15 seconds
   - Client-side: 10 second undo window
4. Update rendering:
   - Only show elements matching current scene
   - Hide previous scene content

### 6.5 Implement Undo/Redo System
1. Set up per-user command history:
   - Track by userId (device:tab)
   - Store command references
   - Limit history size
2. Create undo/redo commands:
   - Build inverse operations
   - Apply via WriteQueue
   - Maintain consistency
3. Add keyboard shortcuts:
   - Ctrl/Cmd+Z for undo
   - Ctrl/Cmd+Shift+Z for redo
4. Exclude from undo:
   - Scene ticks (Clear Board)
   - TTL extensions
   - Awareness updates

### 6.6 Create Export Functionality
1. Build PNG export system:
   - Viewport or entire board options
   - Maximum edge 8192px
   - White background
   - 24px padding
2. Implement progressive rendering:
   - Chunk work into 16ms slices
   - Yield between chunks
   - Show progress indicator
3. Add timeout handling:
   - 2 second timeout for full export
   - Fall back to viewport with toast
   - Never block UI thread
4. Support clipboard export:
   - Use Clipboard API where available
   - Fallback to download
5. Exclude from export:
   - Cursors and presence
   - UI overlays
   - Selection handles

### 6.7 Build Minimap Component
1. Create minimap renderer:
   - Small overview in corner
   - Update from snapshots
   - Show viewport rectangle
2. Add navigation:
   - Click to jump
   - Drag viewport rectangle
3. Gate on G_FIRST_SNAPSHOT:
   - Hide until first snapshot ready
   - Show loading state
4. Optimize performance:
   - Lower resolution rendering
   - Debounced updates
   - Suspend when hidden

**Deliverables:**
- Complete toolbar with all tools
- Working eraser with preview
- Text tool with editing
- Clear Board with confirmation
- Undo/redo per user
- PNG export with fallbacks
- Minimap for navigation

---

## Phase 7: Code Execution System
Out of scope
Any network/FS access inside workers(workers are sandboxed); persistent notebooks; multi-file projects.  
Constraints
Fresh worker per run; 5 s timeout; output ≤ 10 KB per run; keep last 10 outputs, total ≤ 128 KB. 
Pyodide 0.26.4; warm on desktop only; skip on constrained devices. 
Things to watch out for
Versioned code-cell updates; handle concurrency with version tokens to avoid stale writes. 
Large asset downloads (Monaco/Pyodide) interplay with PWA caching from Phase 8.

### 7.1 Integrate Monaco Editor
1. Set up Monaco with lazy loading:
   - Dynamic import on first use
   - Pre-cache via Service Worker
   - Show loading state
2. Configure for JavaScript and Python:
   - Syntax highlighting
   - Basic autocomplete
   - Error highlighting
3. Create editor component:
   - Resizable panel
   - Theme matching app
   - Keyboard shortcuts
4. Connect to code cell in Y.Doc:
   - Sync content changes
   - Track version numbers
   - Handle concurrent edits

### 7.2 Implement JavaScript Execution
1. Create web worker for isolation:
   - Fresh worker per execution
   - No network access
   - No filesystem access
2. Set up execution pipeline:
   - Pass code to worker
   - Capture console output
   - Handle errors gracefully
3. Implement timeouts:
   - 5 second hard limit
   - Terminate worker on timeout
   - Show timeout message
4. Capture and limit output:
   - Maximum 10KB per run
   - Stream to UI progressively
   - Truncate if exceeds limit

### 7.3 Set Up Pyodide for Python
1. Configure Pyodide loading:
   - Version 0.26.4 exactly
   - Lazy load on first Python run
   - Cache via Service Worker
2. Implement warm-up strategy:
   - Silent warm on desktop after activate
   - Skip on mobile/low-memory
   - Queue early runs while loading
3. Create Python worker:
   - Fresh worker per execution
   - Load Pyodide in worker
   - No network/filesystem
4. Handle execution:
   - Same timeout/output limits as JS
   - Capture stdout/stderr
   - Show Python-specific errors

### 7.4 Build Output Management
1. Create output storage in Y.Doc:
   - Append to outputs array
   - Keep last 10 outputs
   - Enforce 128KB total limit
2. Implement output display:
   - Scrollable output panel
   - Syntax highlighting
   - Clear output button
3. Add execution controls:
   - Run button with loading state
   - Stop button during execution
   - Keyboard shortcut (Ctrl/Cmd+Enter)
4. Handle concurrent executions:
   - Queue if already running
   - Cancel previous on new run
   - Show execution status

**Deliverables:**
- Monaco editor integration
- JavaScript execution in workers
- Python execution via Pyodide
- Output capture and display
- Proper isolation and timeouts
---

## Phase 8: PWA & Service Worker
Out of scope
Caching /api/**, /yjs/**, or any WebSocket traffic. 

Constraints
Versioned caches; separate buckets (app-shell-vN, offline-pack-vN, avatars-thumbs-vN, media-cache-vN). 
Runtime strategies: allowlisted CDN media via SWR; avatars/thumbnails SWR unless immutable. Caps and eviction rules apply. 
Respect storage/save-data; quota handling must evict LRU from media cache and expose a “Clear offline data”.
Cache-first only for app shell; version cache names; delete old caches on activate. 
Show update prompts and allow skip-waiting flow; handle multi-tab upgrades cleanly. 
Manifest must include correct icon sizes, standalone display, theme/background colors.

Things to watch out for
Install/activate/warmup flow correctness; updates prompt users safely, but silently warm Pyodide for professional UI/UX.
Don’t cache server-driven flags in SW; precache Monaco and heavy lazies with idle cue

### 8.1 Create Service Worker Foundation
1. Set up Service Worker registration:
   - Register on page load
   - Handle update flow
   - Show update prompts
2. Configure cache strategies:
   - Cache-first for app shell
   - Never cache /api/**, /yjs/**, wss:
   - Version cache names
3. Implement basic offline support:
   - Serve cached app shell
   - Show offline indicator
   - Queue actions when offline

### 8.2 Implement Asset Caching
1. Pre-cache critical assets:
   - HTML shell
   - Core JavaScript/CSS
   - Fonts and icons
2. Cache Monaco assets:
   - Pre-cache on install
   - Include language files
   - Version properly
3. Set up Pyodide caching:
   - Cache after first download
   - Warm on desktop only
   - Skip on constrained devices
4. Configure cache cleanup:
   - Delete old versions on activate
   - Respect storage quotas
   - Provide clear cache option

### 8.3 Build Update Flow
1. Detect new Service Worker:
   - Check on navigation
   - Compare versions
2. Show update prompt:
   - Non-intrusive notification
   - Allow dismiss
   - Force update option
3. Handle update installation:
   - Wait for all tabs to close
   - Or skip waiting on user action
   - Reload after update

### 8.4 Create Web App Manifest
1. Configure manifest.json:
   - App name and description
   - Icon sizes (192, 512, maskable)
   - Theme and background colors
   - Display mode (standalone)
2. Set up install prompts:
   - Detect install capability
   - Show custom install UI
   - Handle installation flow
3. Configure app behavior:
   - Start URL
   - Orientation preferences
   - Status bar styling

### 8.5 Implement Offline Enhancements
1. Add offline detection:
   - Monitor online/offline events
   - Update UI accordingly
   - Pause certain operations
2. Create offline fallbacks:
   - Static offline page
   - Cached data display
   - Clear offline indicators
3. Handle sync on reconnect:
   - Trigger metadata refresh
   - Resume WebSocket connection
   - Sync IndexedDB changes
4. Build Quick Tools for offline:
   - Local-only utilities
   - No server dependency
   - Clear offline labeling

**Deliverables:**
- Complete Service Worker with caching
- PWA manifest and install flow
- Offline support with fallbacks
- Update detection and prompts
- Asset pre-caching strategy

---

## Phase 9: WebRTC & Peer-to-Peer Enhancement
Out of scope
Starting RTC in large rooms (>15 peers), or when direct pairing mode is chosen (they’re mutually exclusive with provider signaling). Do not make y-webrtc authoritative, Websocket stays authoritative.
Constraints
Only enable y-webrtc for ≤12 peers; keep WS connected as the source-of-record. 
Probe policy: keep RTC only if rtcMedianRtt ≤ wsRtt − 20 ms (or WS ≥ 70 ms and RTC < WS); add hysteresis. 
Deduplicate awareness across WS/RTC via monotonic seq and short debounce. 
Things to watch out for
Drop RTC on peer-count > 15, ICE fail, CPU hot, or high bufferedAmount. 
When Peer Mode (direct pairing) is active, do not instantiate WebrtcProvider; reflect mode in UI.

### 9.1 Set Up WebRTC Infrastructure
1. Configure TURN server:
   - TCP+TLS on port 443
   - Long-term credentials
   - Rotation mechanism
2. Set up signaling servers:
   - Primary: self-hosted
   - Fallback: public yjs signaling
   - Room-scoped HMAC passwords
3. Create ICE configuration:
   - TURN for production
   - STUN for development only
   - Bundle policy max-bundle

### 9.2 Implement WebRTC Provider
1. Add y-webrtc to RoomDocManager:
   - Create only for small rooms (≤12 peers)
   - Use same Y.Doc instance
   - Share awareness with WebSocket
2. Configure provider settings:
   - maxConns: 12-15
   - Password from room HMAC
   - Proper ICE servers
3. Keep WebSocket connected:
   - WS remains authoritative
   - WebRTC for latency only
   - Fallback on WebRTC failure

### 9.3 Build Probe System
1. Implement RTT measurement:
   - Measure WebSocket RTT (5 samples)
   - Measure WebRTC RTT (2.5 seconds)
   - Calculate medians
2. Create keep/drop logic:
   - Keep if RTC median ≤ WS - 20ms
   - Or if WS ≥ 70ms and RTC < WS
   - Apply hysteresis to prevent flapping
3. Add drop conditions:
   - Peers exceed 15
   - CPU overheating
   - ICE connection failed
   - Buffered amount too high

### 9.4 Handle Awareness Deduplication
1. Implement sequence numbers:
   - Monotonic per sender
   - Shared across channels
   - Handle wraparound
2. Create dedup logic:
   - Track lastSeq per sender
   - Drop if seq ≤ lastSeq
   - Prefer RTC when available
3. Add muting mechanism:
   - Mute WS awareness when RTC active
   - Continue receiving for fallback
   - Short window debounce

### 9.5 Create Collaboration Mode UI
1. Build mode selector:
   - Server (default)
   - Peer Mode (P2P)
   - Remember preference
2. Add visual indicators:
   - Header badge showing mode
   - Network quality indicator
   - Peer count display
3. Handle mode transitions:
   - Smooth fallback to server
   - Update UI immediately
   - Show degradation reasons
4. Implement constraints:
   - Disable P2P for large rooms
   - Show tooltips explaining why
   - Auto-switch on conditions

**Deliverables:**
- WebRTC provider integration
- RTT probe and decision system
- Awareness deduplication
- Collaboration mode UI
- Automatic fallback handling

---

## Phase 10: Production Polish & Optimization
Out of scope
Feature additions beyond MVP scope (auth, admin tools, cold storage). Focus on polish, perf, security, deploy. 

Constraints
Targets: p95 collaboration latency ≤125 ms, 60 FPS rendering; persist lag p95 ≤3000 ms (hard cap 5000 ms). 
Mobile is view-only for MVP. Enforce in WriteQueue + UI. 
Security headers (CSP, HSTS after TLS), origin allowlist, rate limiting per IP. 

Things to watch out for
Instrument the custom metrics: probe results, awareness drops/skip counts, WS sync timings, queue length, snapshot FPS. 

Production deploy on a single container (Railway). No NGINX. Ensure final flush/TTL janitor.
### 10.1 Implement Observability
1. Set up Sentry integration:
   - Error tracking
   - Performance monitoring
   - User session replay
2. Add custom metrics:
   - Collaboration latency p50/p95
   - Persist lag measurements
   - Room size tracking
   - WebRTC probe results
3. Create dashboards:
   - Real-time metrics
   - Historical trends
   - Alert configurations
4. Implement logging:
   - Structured logs
   - Appropriate log levels
   - No sensitive data

### 10.2 Add Mobile View-Only Support
1. Detect mobile devices:
   - User agent detection
   - Touch capability checks
   - Screen size thresholds
2. Block write operations:
   - WriteQueue validates and rejects
   - Show view-only banner
   - Disable drawing tools
3. Optimize mobile UI:
   - Simplified toolbar
   - Touch-friendly controls
   - Responsive layout
4. Test on real devices:
   - Various screen sizes
   - Different browsers
   - Performance validation

### 10.3 Performance Optimization
1. Implement dirty-rect rendering:
   - Track changed regions
   - Redraw only affected areas
   - Maintain 60 FPS target
2. Add render budgeting:
   - 16ms frame budget
   - Yield for long tasks
   - Progressive rendering
3. Optimize memory usage:
   - Cleanup unused references
   - Limit history sizes
   - Efficient data structures
4. Add performance monitoring:
   - Frame rate tracking
   - Memory usage alerts
   - Slow operation logging

### 10.4 Security Hardening
1. Configure CSP headers:
   - Strict content policy
   - Script source restrictions
   - Style source limits
2. Add security headers:
   - HSTS (after TLS stable)
   - X-Content-Type-Options: nosniff
   - Referrer-Policy: no-referrer
3. Implement rate limiting:
   - Per-IP connection limits
   - Room creation throttling
   - API endpoint protection
4. Validate all inputs:
   - Frame size limits
   - Content sanitization
   - Origin checking

### 10.5 Final Testing & Validation
1. Run acceptance tests:
   - All features from Section 10
   - Size enforcement (8MB warning, 10MB cap)
   - TTL expiry behavior
   - Offline functionality
2. Execute E2E test suite:
   - Happy path flows
   - Error conditions
   - Network failures
   - Concurrent users
3. Performance testing:
   - Load test with 50 users
   - Measure p95 latency
   - Verify 125ms target
4. Manual QA:
   - Cross-browser testing
   - Accessibility audit
   - Usability review

### 10.6 Deployment Preparation
1. Configure production environment:
   - Environment variables
   - Redis with AOF
   - PostgreSQL with backups
   - Monitoring setup
2. Set up deployment pipeline:
   - Railway configuration (NO NGINX)
   - Health checks
   - Rollback plan
3. Create operational runbook:
   - Common issues
   - Debug procedures
   - Recovery steps
   - Contact information
4. Plan launch:
   - Gradual rollout
   - Feature flags
   - Monitoring dashboard
   - Support readiness

**Deliverables:**
- Complete observability
- Mobile view-only implementation
- Performance optimizations
- Security hardening
- Deployment-ready application

---

## Critical Constraints to Maintain Throughout

### Never Violate These Rules:
1. Components must never import or directly access Yjs, y-websocket, or y-indexeddb
2. All mutations must go through WriteQueue and CommandBus
3. Snapshots are always immutable and never null
4. Store number[] in Yjs, create Float32Array only at render time
5. WebSocket is always the authoritative persistence path
6. Room size hard cap at 10MB becomes read-only
7. Mobile devices are view-only for MVP
8. No authentication system - link-based access only
9. Awareness is never persisted
10. TTL extends only on accepted writes, not reads
11. Never apply any async work against a mismatched svKey. 
12. Never exceed the 2 MB inbound WS frame cap—close with 1009 and surface a clear error. 
13. Never relax the 8 MB warn / 10 MB read-only gates by “one-off” logic. 
14. Never let RTC decide authority or remain up when probe shows no win; WS stays connected regardless. 
15. Never persist or replay awareness. It is ephemeral and lossy by design. 
16. Never cache /api/**, /yjs/**, or any wss: traffic in the Service Worker. 
17. Never accept UI imports of Yjs/providers in components—enforce via no-restricted-imports.

### Performance Targets:
- p95 collaboration latency ≤ 125ms with 50 users
- Maintain 60 FPS rendering
- Persist lag ≤ 3000ms p95, hard cap 5000ms
- Export timeout 2 seconds before viewport fallback

### Architectural Principles:
- Offline-first with IndexedDB
- CRDT-based conflict resolution
- Single source of truth (Redis for persistence)
- Immutable snapshot-based rendering
- Per-user undo/redo scoping
- Progressive enhancement (start with WS, add RTC if beneficial)
- Idempotent-by-key writes. Every command carries an idempotencyKey; duplicates must be dropped before yjs.transact(...). (aligns with WriteQueue semantics) 
- Command-bus isolation. UI never calls Y APIs; the only write path is WriteQueue → CommandBus → single transact. (restates rule as a principle, not policy) 
- Snapshot-first rendering. All reads use immutable Snapshot objects; no UI keeps references to live Y data across frames. 
- svKey-gated async. Any async apply (export, probe, layout, code output) must verify svKey === currentSnapshot.svKey or drop. 
- Authority never bifurcates. WS/Redis remain source-of-record; RTC can accelerate fan-out but never become authoritative. 
- Budgeted concurrency. Subsystems publish explicit budgets (frame ≤ 16 ms; encoded delta < 128 KB; write queue ≤ 100; awareness Hz degrades with N) and shed work predictably when exceeded. 
- Primary-tab primacy. One tab per room owns TTL extension & RTC orchestration; others are passive. 
- Forward-only evolution. Schema & storage changes define forward-only migrators; never mutate historical Y data in place (migrate-on-read if necessary).
- Typed protocol envelopes. Envelopes are additive & versioned; extend via optional fields, never breaking existing parsers. 
- Fail-closed gates. If a gate condition is ambiguous, treat the feature as closed (e.g., G_FIRST_SNAPSHOT, G_WS_CONNECTED).
---

## Success Criteria Checklist
Before considering any phase complete, verify:

- [ ] All TypeScript types are properly defined
- [ ] ESLint rules pass (especially no-restricted-imports)
- [ ] Acceptance tests for the phase pass
- [ ] Performance remains within targets
- [ ] Memory leaks are checked and fixed
- [ ] Error handling is comprehensive
- [ ] Observability is in place
- [ ] Documentation is updated
- [ ] Code follows the WriteQueue pattern
- [ ] Snapshots remain immutable
- [ ] No direct Yjs access from UI components
- [ ] Mobile view-only is enforced
- [ ] Size limits are respected
- [ ] TTL behavior is correct