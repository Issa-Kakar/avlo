# AVLO Implementation Guide - Phase 2 Onwards

## Phase 2: Core Data Layer & Models

### 2.1 Define Core TypeScript Types and Interfaces

#### 2.1.1 Create Coordinate and Geometry Types
1. Define StrokePoint interface with x, y coordinates and optional pressure value (0 to 1 range)
2. Create bbox type as tuple of four numbers representing minX, minY, maxX, maxY in world units
3. Define SceneIdx as alias for number type representing scene index
4. Create ULID type aliases for StrokeId and TextId to ensure type safety
5. Add ViewTransform interface with worldToCanvas and canvasToWorld conversion methods
6. Include scale and pan properties in ViewTransform for zoom and offset tracking

#### 2.1.2 Define Document Data Structures
1. Create Stroke interface with all required fields per avlo.md specification
   - Include id as ULID string, tool type limited to pen or highlighter
   - Add color as hex string, size in world units, opacity from 0 to 1
   - Points array as flat number array (never Float32Array in storage)
   - Include bbox, scene index, createdAt timestamp, and userId
2. Define TextBlock interface with positioning, content, and styling properties
   - Position with x, y anchor points and w, h layout dimensions
   - Content as immutable string with 500 character maximum
   - Include scene assignment and user attribution
3. Create CodeCell interface for code execution with language and version tracking
4. Define Output interface with timestamp and text content (10KB limit)
5. Create Meta interface for document-level metadata including scene_ticks array

#### 2.1.3 Define Snapshot and View Types
1. Create immutable Snapshot interface as the frozen view of document state
   - Include svKey as base64 string of state vector (never null)
   - Add scene index derived from meta.scene_ticks.length
   - Arrays of stroke and text views filtered by current scene
   - Presence view for cursor and user information
   - Spatial index placeholder (null initially, RBush later)
   - Meta object with size bytes, capacity, read-only flag
2. Define StrokeView as read-only projection of stroke for rendering
3. Create PresenceView interface for ephemeral user state
4. Add RoomStats interface for size and capacity tracking

### 2.2 Implement RoomDocManager Foundation

#### 2.2.1 Create Manager Class Structure
1. Define RoomDocManager class with private Y.Doc instance
2. Add private fields for room ID and current snapshot
3. Create subscription management maps for snapshot and presence callbacks
4. Initialize dirty flag for render scheduling
5. Add animation frame ID for publish loop tracking
6. Create destroyed flag to prevent operations after cleanup

#### 2.2.2 Implement Y.Doc Initialization
1. Create Y.Doc with guid parameter set to roomId (exactly once)
2. Get root map from Y.Doc using getMap('root') method
3. Check if root map has 'meta' key to detect initialization state
4. If uninitialized, create root structure in single transaction:
   - Set version number to 1
   - Create empty Y.Map for meta with scene_ticks as empty Y.Array
   - Initialize strokes as empty Y.Array
   - Create texts as empty Y.Array
   - Set up code as Y.Map and outputs as Y.Array
5. Store room ID but never mutate the guid after creation
6. Set up helper methods that traverse root on demand (never cache Y references)

#### 2.2.3 Set Up Mutation Wrapper
1. Create mutate method accepting function with Y.Doc parameter
2. Implement minimal guards before transaction:
   - Check if room is read-only (size >= 15MB)
   - Verify not on mobile in view-only mode
   - Estimate frame size doesn't exceed 2MB
3. Wrap function execution in yjs.transact call with origin tracking
4. Set dirty flag after successful transaction
5. Handle errors gracefully without corrupting state
6. Log mutations for debugging in development mode only

### 2.3 Implement Snapshot Publishing System

#### 2.3.1 Create Empty Snapshot Generator
1. Define createEmptySnapshot function returning non-null snapshot
2. Set svKey to base64 of empty state vector
3. Initialize scene to 0, empty arrays for strokes and texts
4. Create identity view transform with scale 1 and zero pan
5. Set meta with readOnly false and 15MB capacity
6. Return frozen object to prevent mutations

#### 2.3.2 Build Snapshot Creation Pipeline
1. Create buildSnapshot method reading from Y.Doc
2. Extract current scene from meta.scene_ticks array length
3. Convert Y.Array of strokes to plain JavaScript array
4. Filter strokes where scene equals current scene
5. Transform each stroke to StrokeView with read-only properties
6. Apply same filtering and transformation to texts
7. Calculate state vector and convert to base64 for svKey
8. Include current presence state if available
9. Freeze entire snapshot object before returning

#### 2.3.3 Implement RAF-Based Publishing
1. Set up requestAnimationFrame loop starting on manager creation
2. Check dirty flag at each frame
3. If dirty, build new snapshot from Y.Doc
4. Compare svKey with previous snapshot to detect changes
5. Only publish if svKey differs or presence updated: Publish only when svKey differs from the previous snapshot or presence has changed since the last publish; otherwise skip the frame.
6. Call all registered snapshot callbacks with new snapshot
7. Reset dirty flag after publishing
8. Schedule next frame with requestAnimationFrame

### 2.4 Set Up Subscription Management

#### 2.4.1 Implement Snapshot Subscription
1. Create subscribeSnapshot method accepting callback function
2. Generate unique subscription ID
3. Store callback in subscription map with ID as key
4. Immediately invoke callback with current snapshot: Immediately invoke the callback with currentSnapshot on subscribe. Subscriptions are safe if registered during a publish cycle; new subscribers see the next committed frame.
5. Return unsubscribe function that removes from map
6. Handle edge case of subscription during publish cycle

#### 2.4.2 Add Presence Subscription
1. Create subscribePresence method with similar pattern
2. Store presence callbacks in separate map
3. Throttle presence updates to 30Hz maximum: Throttle presence emissions to ≤ 30 Hz; interpolate cursors 1–2 frames; apply single-frame dead-reckoning on a miss
4. Implement interpolation for smooth cursor movement
5. Include dead-reckoning for missed frames

#### 2.4.3 Implement Stats Subscription
1. Add subscribeRoomStats for size monitoring
2. Initialize with null until first metadata received
3. Update when persist_ack arrives from server
4. Include bytes and capacity in stats object

#### 2.4.4 Add Minimal Render Cache (Boot Splash Only)
1. Create simple IndexedDB wrapper (NOT y-indexeddb provider)
2. Store last rendered canvas as ImageData/PNG
3. Key by roomId and validate with svKey
4. Load and display immediately on boot while Y.Doc initializes
5. This is purely cosmetic - not data persistence

## Phase 3: Basic Canvas Infrastructure

### 3.1 Set Up Canvas Element and Context

#### 3.1.1 Create Canvas Component Structure
1. Create React component wrapping HTML canvas element
2. Use ref to access canvas DOM element directly
3. Set up resize observer to track container dimensions
4. Configure device pixel ratio for sharp rendering
5. Set canvas width and height attributes based on container
6. Apply CSS for proper sizing and positioning

#### 3.1.2 Initialize 2D Rendering Context
1. Get 2D context with willReadFrequently set to false
2. Configure context with imageSmoothingEnabled for anti-aliasing
3. Set up default line cap and join styles
4. Create context state save/restore pattern for transforms
5. Implement clear method using clearRect

### 3.2 Implement Coordinate Transform System

#### 3.2.1 Define Transform State Management
1. Create view transform state with scale and pan properties
2. Initialize scale to 1 for 100% zoom
3. Set pan to {x: 0, y: 0} for centered view
4. Store transform in component state or context
5. Implement getter methods for current transform values

#### 3.2.2 Create Coordinate Conversion Functions
1. Implement worldToCanvas conversion method:
   - Apply scale multiplication to world coordinates
   - Add pan offset for viewport positioning
   - Return canvas pixel coordinates
2. Create canvasToWorld inverse transformation:
   - Subtract pan offset from canvas coordinates
   - Divide by scale to get world units
   - Handle edge cases for zero scale
3. Add screenToCanvas helper for DOM event coordinates
4. Implement bounds checking for valid coordinate ranges

### 3.3 Build Render Loop Foundation

#### 3.3.1 Set Up Animation Frame Loop
1. Create render function called via requestAnimationFrame
2. Subscribe to snapshot updates from RoomDocManager
3. Store latest snapshot in component state
4. Track frame timing for performance monitoring
5. Implement frame skipping if running behind

#### 3.3.2 Implement Dirty Rectangle Tracking
1. Create dirty region tracking system
2. Mark regions that need redrawing
3. Coalesce overlapping dirty rectangles
4. Clear only dirty regions before redraw
5. Skip rendering if no dirty regions exist
canvas.width = cssW * dpr; canvas.height = cssH * dpr; ctx.setTransform(dpr,0,0,dpr,0,0) to avoid fuzzy strokes.

#### 3.3.3 Create Render Pipeline Structure
1. Define render order: background, strokes, text, overlays
2. Create separate render methods for each layer
3. Implement culling to skip off-screen elements
4. Add render budgeting with 16ms frame target
5. Yield to browser between heavy operations
ctx.lineWidth = style.size * view.scale (since size is in world units) (will)

## Phase 4: Stroke Data Model & Rendering

### 4.1 Implement Stroke Rendering Pipeline

#### 4.1.1 Create Path Building from Points
1. Convert flat points array to coordinate pairs
2. Handle pressure values if present (every third value)
3. Build Path2D object for efficient rendering
4. Cache paths per stroke ID to avoid rebuilding
5. Invalidate cache when stroke data changes

#### 4.1.2 Implement Basic Stroke Drawing
1. Set stroke style from color property
2. Apply line width from size property
3. Configure global alpha for opacity
4. Use stroke method to draw path
5. Reset context state after drawing

### 4.2 Add Tool-Specific Rendering

#### 4.2.1 Implement Pen Tool Rendering
1. Use standard stroke rendering with full opacity
2. Apply round line caps for smooth appearance
3. Set round line joins for continuous curves
4. Handle single-point strokes as dots
5. Implement pressure variation if available

#### 4.2.2 Create Highlighter Rendering
1. Set opacity to 0.25 as default
2. Use square line caps for marker effect
3. Apply composite operation for transparency
4. Ensure proper layering under pen strokes
5. Handle overlap blending correctly

### 4.3 Optimize Rendering Performance

#### 4.3.1 Implement Level-of-Detail System
1. Check zoom level before rendering
2. Skip tiny strokes when zoomed out
3. Simplify complex paths at distance
4. Use lower quality for fast panning
5. Restore full quality when still

#### 4.3.2 Add Render Caching
1. Create offscreen canvas for static content
2. Render unchanged strokes to cache
3. Composite cache to main canvas
4. Invalidate cache on data changes
5. Limit cache memory usage

## Phase 5: Drawing Input System

### 5.1 Implement Pointer Event Handling

#### 5.1.1 Set Up Event Listeners
1. Add pointerdown listener to canvas element
2. Attach pointermove for drawing updates
3. Listen for pointerup to commit strokes
4. Handle pointercancel for interrupted gestures
5. Prevent default browser behaviors
Coalesce move events to the latest per frame and drop the stale ones when busy
canvas.setPointerCapture(e.pointerId) on pointerdown and release on up/cancel

#### 5.1.2 Capture Pointer State
1. Extract x, y coordinates from events
2. Convert screen to world coordinates
3. Capture pressure if available (0 to 1)
4. Store pointer ID for multi-touch
5. Track pointer type (mouse, pen, touch)

### 5.2 Build Preview Rendering System

#### 5.2.1 Create Local Preview State
1. Initialize array for preview points
2. Add points during pointermove
3. Store with world coordinates
4. Include pressure values if present
5. Clear on pointerup or cancel

#### 5.2.2 Implement Preview Drawing
1. Render preview on separate canvas layer
2. Draw with current tool settings
3. Apply 0.35 opacity for preview
4. Clear previous preview each frame
5. Skip preview if no active points

### 5.3 Implement Stroke Commit Logic

#### 5.3.1 Process Points on Pointer Up
1. Check minimum points threshold (at least 2)
2. Calculate bounding box from all points
3. Assign current scene from snapshot
4. Generate ULID for stroke ID, ensure stroke object includes userID
5. Capture current timestamp

#### 5.3.2 Apply Douglas-Peucker Simplification
1. Run simplification in world units
2. Use base tolerance: pen 0.8px, highlighter 0.5px (Do not simplify text/stamps; cap highlighter tolerance bumps at 1.5x)
3. Check resulting size under 128KB limit
4. If over, increase tolerance by 1.4x and retry once
5. Hard downsample to 10,000 points if still over

#### 5.3.3 Commit to Y.Doc
1. Create stroke object with all properties
2. Call mutate method on RoomDocManager
3. Append stroke to strokes array in transaction
4. Let manager handle snapshot publishing
5. Clear preview state after commit

## Phase 6: RBush Spatial Indexing

### 6.1 Integrate RBush Library

#### 6.1.1 Initialize Spatial Index
1. Import RBush library with TypeScript types
2. Create RBush instance in RoomDocManager
3. Configure with appropriate max entries per node
4. Set up index for 2D bounding boxes
5. Initialize as empty on manager creation

#### 6.1.2 Define Index Item Structure
1. Create interface for indexed stroke items
2. Include minX, minY, maxX, maxY from bbox
3. Add stroke ID for reference back to data
4. Include scene index for filtering
5. Store tool type for query optimization
(bboxes are persisted on stroke commit and never recomputed at render time)

### 6.2 Implement Index Maintenance

#### 6.2.1 Build Initial Index
1. Iterate through all strokes in snapshot
2. Convert each stroke to RBush item format
3. Bulk load items for efficiency
4. Only include strokes from current scene(either re-filter or rebuild, cheap if you cache per scene indices)
5. Store index in snapshot for queries

#### 6.2.2 Handle Incremental Updates
1. Track strokes added since last index
2. Insert new strokes individually
3. Remove deleted strokes from index
4. Rebuild if changes exceed threshold (256 items)
5. Monitor index performance metrics

### 6.3 Create Spatial Query System

#### 6.3.1 Implement Hit Testing
1. Create point-to-stroke hit test method
2. Convert point to search rectangle with tolerance
3. Query RBush for overlapping strokes
4. Perform precise hit test on candidates
5. Return closest stroke or null

#### 6.3.2 Add Area Selection Queries
1. Implement rectangle selection search
2. Query index for strokes in bounds
3. Filter results by current scene
4. Sort by z-order (array index)
5. Return array of selected stroke IDs

## Phase 7: WebSocket, Indexeddb, Persistence Infrastructure
**Note**: This phase adds BOTH offline persistence (y-indexeddb) and real-time sync (y-websocket). The y-indexeddb provider comes first to enable offline-first architecture. This is
different from the minimal render cache in Phase 2.4, which is just for boot splash UX.

### 7.1 Implement Offline Persistence with y-indexeddb
#### 7.1.1 Initialize IndexedDB Provider
1. Import y-indexeddb in RoomDocManager
2. Create provider with room-scoped database
3. Pass existing Y.Doc instance
4. Set up sync event handlers
5. Implement G_IDB_READY gate with 2s timeout

### 7.2 Set Up WebSocket Server
#### 7.2.1 Initialize Express Server
1. Create Express application instance
2. Configure CORS with origin allowlist
3. Set up body parser for JSON
4. Add compression middleware
5. Serve static files from public directory

#### 7.2.2 Integrate Y-WebSocket Server
2. Create WebSocket server on /ws path
3. Configure with room-based routing
4. Set 2MB frame size limit
5. Add connection tracking per room

### 7.3 Provider Initialization Order
1. Attach y-indexeddb first (offline-first)
2. Wait for IDB sync or timeout
3. Then attach y-websocket
4. Ensure proper gate sequencing

### 7.4 Implement Redis Persistence

#### 7.4.1 Set Up Redis Connection
1. Create Redis client with connection config
2. Enable AOF for durability
3. Configure reconnection backoff
4. Set up health check interval
5. Log connection state changes

#### 7.4.2 Create Persistence Adapter
1. Implement save method for Y.Doc
2. Convert document to update format
3. Compress with gzip level 4
4. Store with room-prefixed key
5. Set TTL to ROOM_TTL_DAYS (14 default)

#### 7.4.3 Handle Document Loading
1. Check Redis for existing room key
2. Decompress stored document
3. Apply updates to new Y.Doc
4. Return document or null if not found
5. Track load timing for metrics

### 7.5 Connect Client WebSocket Provider

#### 7.5.1 Initialize Y-WebSocket Provider
1. Import y-websocket in RoomDocManager
2. Create provider with room URL
3. Pass existing Y.Doc instance
4. Configure reconnection settings
5. Set up event listeners

#### 7.5.2 Handle Connection States
1. Listen for connection status events
2. Update UI connection indicator
3. Queue updates while disconnected
4. Sync on reconnection
5. Show appropriate user messages

## Phase 8: Awareness & Presence System

### 8.1 Implement Awareness Protocol

#### 8.1.1 Set Up Awareness State
1. Create awareness instance from Y.Doc
2. Define local user properties
3. Generate unique user ID per tab
4. Assign random color from palette
5. Set default name or initials

#### 8.1.2 Configure Awareness Updates
1. Track cursor position in world space
2. Update on pointermove with throttling
3. Include current tool and activity
4. Add sequence number for ordering
5. Set timestamp for each update

### 8.2 Build Presence Rendering

#### 8.2.1 Create Cursor Component
1. Render cursors for remote users
2. Position using world coordinates
3. Apply user color to cursor
4. Show name label on hover
5. Fade out stale cursors

#### 8.2.2 Implement Cursor Smoothing
1. Interpolate between cursor updates
2. Use last known velocity for prediction
3. Apply easing for natural movement
4. Handle missing updates gracefully
5. Remove cursors after timeout

### 8.3 Add User List Display

#### 8.3.1 Create User List Component
1. Subscribe to awareness updates
2. Display active users with colors
3. Show user count in header
4. Indicate drawing activity
5. Remove after inactivity timeout

## Phase 9: UI Components & Toolbar

### 9.1 Build Toolbar Structure

#### 9.1.1 Create Toolbar Container
1. Position toolbar on left side
2. Implement expand/collapse behavior
3. Add keyboard navigation support
4. Store expanded state locally
5. Apply responsive design for mobile

#### 9.1.2 Implement Tool Buttons
1. Create buttons for pen, highlighter, eraser, text, Stamp
2. Add active state styling
3. Implement tool switching logic
4. Show keyboard shortcuts in tooltips
5. Disable tools based on permissions

### 9.2 Add Tool Controls

#### 9.2.1 Create Size Slider
1. Add range input for stroke size
2. Show current value display
3. Store per-tool size settings
4. Apply min/max constraints
5. Update preview on change

#### 9.2.2 Implement Color Picker
1. Create color palette grid
2. Add custom color input
3. Store recent colors
4. Show current selection
5. Update tool color on selection

### 9.3 Persist Toolbar State

#### 9.3.1 Set Up Local Storage
1. Define toolbar state structure
2. Create versioned storage key
3. Save state on changes
4. Load state on initialization
5. Handle migration between versions

## Phase 10: Eraser & Clear Board

### 10.1 Implement Whole-Object Eraser

#### 10.1.1 Create Eraser Hit Detection
1. Use RBush for spatial queries
2. Find strokes under pointer
3. Highlight strokes on hover
4. Track strokes to delete
5. Show eraser cursor

#### 10.1.2 Execute Batch Deletion
1. Collect stroke IDs to remove
2. Call mutate with delete operation
3. Remove from strokes array in transaction
4. Update spatial index
5. Clear eraser preview

### 10.2 Build Clear Board Feature

#### 10.2.1 Implement Scene Tick Mechanism
1. Add scene tick to meta array
2. Increment current scene counter
3. Filter rendering by scene
4. Exclude from undo manager
5. Apply rate limiting

#### 10.2.2 Add Clear Board UI
1. Create clear board button
2. Show confirmation dialog
3. Display warning about permanence
4. Execute clear on confirmation
5. Show success notification

## Phase 11: Text & Stamps

### 11.1 Implement Text Input System

#### 11.1.1 Create Text Tool Mode
1. Switch to text cursor on selection
2. Show text input on click
3. Position at click location
4. Apply current text settings
5. Focus input automatically

#### 11.1.2 Handle Text Commit
1. Capture text content on blur/enter
2. Enforce 500 character limit
3. Create TextBlock object
4. Assign current scene
5. Commit via mutate method

### 11.2 Add Stamp Tools

#### 11.2.1 Define Stamp Shapes
1. Create stamp definitions (arrows, shapes)
2. Define as point arrays
3. Store in tool configuration
4. Scale based on size setting
5. Apply rotation if needed

#### 11.2.2 Implement Stamp Placement
1. Place stamp at click position
2. Convert to stroke format
3. Apply current color settings
4. Commit as regular stroke
5. Show preview before placement

## Phase 12: Undo/Redo System

### 12.1 Configure UndoManager

#### 12.1.1 Initialize Yjs UndoManager
1. Create UndoManager in RoomDocManager
2. Configure tracked types (strokes, texts)
3. Set up per-user origin tracking
4. Exclude scene ticks from scope
5. Set maximum undo stack size

#### 12.1.2 Wire Up Keyboard Shortcuts
1. Listen for Ctrl/Cmd+Z for undo
2. Add Ctrl/Cmd+Shift+Z for redo
3. Prevent default browser behavior
4. Check if operations available
5. Update UI button states

### 12.2 Implement Undo/Redo Operations

#### 12.2.1 Execute Undo Operation
1. Check if undo stack has items
2. Call undo with user origin
3. Let Yjs handle state reversal
4. Trigger snapshot update
5. Show operation feedback

## Phase 13: Room Lifecycle Management

### 13.1 Implement Room Creation

#### 13.1.1 Create Local Room
1. Generate local-prefixed ULID
2. Initialize Y.Doc with ID
3. Mark as provisional in storage
4. Add to My Rooms list
5. Enable offline editing

#### 13.1.2 Publish to Server
1. POST to /api/rooms endpoint
2. Receive server room ID
3. Create alias mapping
4. Connect WebSocket provider
5. Merge local changes

### 13.2 Handle Room Joining

#### 13.2.1 Implement Join Flow
1. Parse room ID from URL
2. Check for local alias
3. Fetch room metadata
4. Connect WebSocket
5. Load initial state

#### 13.2.2 Enforce Capacity Limits
1. Check room size from metadata
2. Show warning pill at 13MB
3. Block writes at 15MB
4. Display read-only banner
5. Allow view-only access

### 13.3 Manage TTL Extension

#### 13.3.1 Create Extension Mechanism
1. Add extend button in UI
2. Perform minimal write operation
3. Update TTL by configured days
4. Show new expiry date
5. Rate limit extensions

## Phase 14: Export & Minimap

### 14.1 Implement PNG Export

#### 14.1.1 Create Export Pipeline
1. Calculate bounds of all content
2. Create offscreen canvas
3. Apply white background
4. Render strokes and text
5. Exclude UI overlays

#### 14.1.2 Handle Export Options
1. Offer viewport or full board
2. Apply maximum dimension limit (8192px)
3. Add padding around content
4. Fall back to viewport if too large
5. Show progress indicator

### 14.2 Build Minimap Component

#### 14.2.1 Create Minimap Renderer
1. Render scaled version of board
2. Show viewport rectangle
3. Update on content changes
4. Optimize with debouncing
5. Hide when empty

#### 14.2.2 Add Navigation Features
1. Allow click to jump
2. Drag viewport rectangle
3. Show zoom level
4. Update smoothly
5. Collapse when not needed

## Phase 15: Code Execution System

### 15.1 Integrate Monaco Editor

#### 15.1.1 Set Up Monaco
1. Configure Monaco loader
2. Create editor instance
3. Set up syntax highlighting
4. Configure auto-completion
5. Add keyboard shortcuts

#### 15.1.2 Implement Editor UI
1. Create resizable panel
2. Add language selector
3. Show line numbers
4. Include run button
5. Display execution state

### 15.2 Build Execution Environment

#### 15.2.1 Create JavaScript Executor
1. Set up web worker for isolation
2. Implement 5-second timeout
3. Capture console output
4. Handle errors gracefully
5. Clean up after execution

#### 15.2.2 Add Python Support
1. Load Pyodide when needed
2. Create Python worker
3. Handle package imports
4. Capture print output
5. Apply same timeout rules

## Phase 16: Service Worker & PWA

### 16.1 Implement Service Worker

#### 16.1.1 Create Service Worker Registration
1. Register service worker file
2. Handle registration events
3. Show update prompts
4. Manage version transitions
5. Clean old caches

#### 16.1.2 Configure Caching Strategies
1. Cache app shell with cache-first
2. Pre-cache Monaco editor files
3. Never cache API or WebSocket paths
4. Set up runtime caches with limits
5. Handle quota exceeded errors

### 16.2 Enable PWA Features

#### 16.2.1 Create Web App Manifest
1. Define app name and description
2. Add icon sets with sizes
3. Configure display mode
4. Set theme colors
5. Define start URL

#### 16.2.2 Implement Install Flow
1. Listen for install prompt
2. Show custom install UI
3. Handle user choice
4. Track installation state
5. Update UI after install

## Phase 17: WebRTC & P2P (Optional Enhancement)

### 17.1 Add WebRTC Provider

#### 17.1.1 Initialize WebRTC
1. Import y-webrtc provider
2. Configure signaling servers
3. Set up ICE servers
4. Apply room-scoped password
5. Set max connections limit

#### 17.1.2 Implement Probe Mechanism
1. Measure WebSocket RTT
2. Establish WebRTC connection
3. Measure data channel RTT
4. Compare latencies
5. Keep if significant improvement

### 17.2 Handle Fallback Logic

#### 17.2.1 Monitor Connection Health
1. Track ICE connection state
2. Monitor peer count
3. Check CPU usage
4. Detect failed states
5. Fall back to WebSocket only

## Phase 18: Polish & Production Readiness

### 18.1 Performance Optimization

#### 18.1.1 Optimize Render Performance
1. Profile render bottlenecks
2. Implement aggressive culling
3. Add frame budgeting
4. Optimize path building
5. Reduce memory allocations

### 18.2 Error Handling & Recovery

#### 18.2.1 Implement Error Boundaries
1. Add React error boundaries
2. Create fallback UI
3. Log errors to Sentry
4. Provide recovery options
5. Preserve user data

### 18.3 Testing & Validation

#### 18.3.1 Complete E2E Test Suite
1. Test all user workflows
2. Verify capacity limits
3. Test offline scenarios
4. Validate export features
5. Check accessibility

Each phase builds upon the previous, minimizing the need for stubs and ensuring a working system at each stage. Follow the constraints in avlo.md strictly, particularly around Y.Doc access patterns, mutation wrappers, and the snapshot-based architecture.