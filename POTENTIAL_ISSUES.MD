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

#### 2.4.4 Add Minimal Render Cache (Boot Splash Only)  #SKIP TESTS FOR THIS PHASE
1. Create simple IndexedDB wrapper (NOT y-indexeddb provider)
2. Store last rendered canvas as ImageData/PNG
3. Key by roomId and validate with svKey
4. Load and display immediately on boot while Y.Doc initializes
5. This is purely cosmetic - not data persistence

COMPREHENSIVE AUDIT FINDINGS

  After a thorough review of the Phase 2 implementation, I found the codebase
   to be generally well-implemented with proper patterns. However, I've 
  identified several areas that need attention:

  CRITICAL ISSUES
Deep Analysis Complete: Memory Leak Confirmed

  After thoroughly investigating the registry and hook implementation, I can
  definitively confirm there IS a memory leak. Here's the complete picture:

  The Architecture

  The registry implements a singleton-per-room pattern - each room ID gets
  exactly one manager instance that can be shared by multiple components.
  This is a good design for avoiding duplicate Y.Docs and ensuring
  consistency.

  The Problem

  The comment in useRoomDoc that says "The registry maintains reference 
  counting internally" is FALSE.

  Looking at the registry implementation (lines 894-977):
  - It's just a simple Map<RoomId, IRoomDocManager>
  - NO reference counting exists - searched for refcount, reference count,
  WeakMap, etc.
  - NO automatic cleanup - remove() is never called in production code (only
  in tests)
  - NO usage tracking - registry doesn't know if anyone is using a manager

  What Happens When User Switches Rooms

  When navigating from room1 → room2 → room3:

  1. room1 manager remains in registry with:
    - Full Y.Doc in memory (can be up to 15MB per spec)
    - RAF loop running 60 times/second (checking isDirty flag)
    - Y.Doc update observer attached
    - 0 subscribers but doesn't know it should cleanup
  2. room2 manager - same story after navigating away
  3. room3 manager - active with subscribers

  The Impact

  For abandoned managers (no subscribers):
  - RAF loop: Runs 60x/sec but only checks if (isDirty || presenceDirty) -
  minimal CPU but still registered callbacks
  - Memory: Full Y.Doc preserved (up to 15MB each per your spec)
  - Observers: Y.Doc update listener remains attached

  After visiting 10 rooms: 10 Y.Docs + 10 RAF loops
  After visiting 100 rooms: 100 Y.Docs + 100 RAF loops (potentially 1.5GB!)

  Why This Matters

  While the RAF loops do minimal work when idle (just checking boolean
  flags), the memory impact is significant:
  - Each Y.Doc holds the complete room data
  - No garbage collection possible - strong references in registry Map
  - Unbounded growth - no max size, no LRU, no timeouts

  The Misleading Comment

  The comment stating "registry maintains reference counting internally"
  appears to be:
  - Aspirational (planned but not implemented)
  - Or copied from another codebase
  - Or simply incorrect documentation

  Verdict

  This IS a memory leak that needs fixing. The architecture is sound
  (singleton pattern is good), but needs one of:
  1. Reference counting - track active users per manager
  2. Explicit cleanup - call registry.remove() on navigation
  3. LRU cache - limit max managers with eviction
  4. Timeout cleanup - remove after period of inactivity

  The good news: The destroy() method properly cleans everything up when
  called. You just need a mechanism to trigger it.

  1. useRoomDoc Hook - Potential Memory Leak: The hook doesn't properly 
  handle cleanup when roomId changes. A new manager is created but the old 
  one is never explicitly cleaned up.
  2. RoomDocManagerRegistry - No Reference Counting: The registry doesn't 
  track how many components are using each manager, so managers are never 
  automatically cleaned up when no longer needed.
  3. RenderCache - Missing Error Recovery: The render cache's cleanup 
  operation doesn't wait for promises, potentially leaving orphaned IndexedDB
   entries.

  MEDIUM ISSUES

  1. Size Estimator - Incomplete Frame Size Check: The frame size guard only 
  checks if the entire document exceeds 2MB, not the actual delta that would 
  be sent.


│ │ Phase 2 Implementation Audit - Comprehensive Findings              
│ │ Overall 

destroy() does comprehensive cleanup:
  1. Stops RAF loop
  2. Removes Y.Doc observers
  3. Clears all subscriber sets
  4. Destroys the Y.Doc itself
  5. Clears references

  But destroy() is NEVER called automatically. It's only called by 
  registry.remove(), which itself is never called in production code.

  The registry is crystal clear:
  - Just a Map<RoomId, IRoomDocManager>
  - No reference counting
  - No tracking of usage
  - No automatic cleanup
  - Only manual remove() and destroyAll()

  The comment in useRoomDoc that says "The registry maintains reference 
  counting internally" is completely false. There is NO reference counting.

  Now let me be absolutely certain about the memory leak by considering all 
  angles:

  1. Is this intentional caching?
    - Maybe, but without limits it's a leak
    - No LRU, no max size, no timeouts
  2. Will it be cleaned up elsewhere?
    - Searched entire codebase
    - registry.remove() only called in tests
    - No navigation handlers call it
  3. Is the impact significant?
    - Y.Doc can be up to 15MB each (per spec)
    - RAF loops consume browser resources
    - With 10 rooms: potentially 150MB + 10 RAF loops
    - With 100 rooms: potentially 1.5GB + 100 RAF loops
  4. What keeps running?
    - RAF loop checking flags 60x/second
    - Y.Doc observer listening (but no updates)
    - All internal state preserved


Assessment                                                         

│ │ The Phase 2 implementation is generally well-architected and follows the   │ │
│ │ design patterns correctly. The code properly implements the RoomDocManager │ │
│ │  model, snapshot publishing system, and subscription management. However,  │ │
│ │ I've identified several issues that should be addressed.                   │ │

│ │ CRITICAL ISSUES FOUND                                                      │ │

│ │ 1. Memory Leak in useRoomDoc Hook (client/src/hooks/use-room-doc.ts)       │ │

│ │ - Problem: When roomId changes, a new manager is fetched but the old one   │ │
│ │ is never cleaned up                                                        │ │
│ │ - Impact: Managers accumulate in memory, Y.Doc observers remain attached   │ │
│ │ - Fix: Track previous manager and call registry.remove() when roomId       │ │
│ │ changes                                                                    │ 
│ │ 2. Registry Lacks Reference Counting                                       │ │
│ │ (client/src/lib/room-doc-manager.ts:894-961)                               │ │

│ │ - Problem: Registry never automatically removes managers when components   │ │
│ │ unmount                                                                    │ │
│ │ - Impact: Managers persist indefinitely until manual cleanup               │ │
│ │ - Fix: Implement reference counting or weak references for automatic       │ │
│ │ cleanup                                                                    │ 
│ │ 3. RenderCache Async Cleanup Issue                                         │ │
│ │ (client/src/lib/render-cache.ts:243-266)                                   │ │

│ │ - Problem: cleanupOldEntries() doesn't await transaction completion        │ │
│ │ - Impact: Could leave orphaned IndexedDB entries if cleanup fails          │ │
│ │ - Fix: Properly await IndexedDB transaction completion                     │ │

│ │ MEDIUM SEVERITY ISSUES                                                     │ │

│ │ 4. Incomplete Frame Size Guard                                             │ │
│ │ (client/src/lib/room-doc-manager.ts:473-488)                               │ │

│ │ - Problem: Only blocks if entire doc > 2MB, not the actual delta being     │ │
│ │ sent                                                                       │ │
│ │ - Impact: Large operations (>2MB) could still fail at transport layer      │ │
│ │ - Fix: Need delta size estimation (planned for Phase 3+)                   │ │
                                                                     │ │
│ │ 5. Missing Snapshot Publishing Backpressure                                │ │
│ │ (client/src/lib/room-doc-manager.ts:625-659)                               │ │

│ │ - Problem: RAF loop continues even if subscribers are slow                 │ │
│ │ - Impact: Could cause memory buildup with slow subscribers                 │ │
│ │ - Fix: Skip frames or throttle when subscribers lag                        │ │

│ │ 6. Unnecessary Re-renders in Hooks (client/src/hooks/use-room-snapshot.ts) │ │

│ │ - Problem: Creates new state on every snapshot even if meaningfully        │ │
│ │ unchanged                                                                 
│ │ - Impact: Performance degradation with frequent updates                    │ │
│ │ - Fix: Add shallow comparison or memoization                               │ │

│ │ LOW SEVERITY ISSUES                                                        │ │

│ │ 8. Performance Optimizations                                               │ │

│ │ - createSafeStateVectorKey builds strings inefficiently in loop            │ │
│ │ - Consider using Uint8Array methods instead                                │ │
                                                           │ │
│ │ 9. Error Handling                                                          │ │

│ │ propagation                                                                │ │
│ │ - Consider error boundaries for critical paths                             │ │
│ 
│ │ POSITIVE FINDINGS ✓                                                    
│ │ - Proper Y.Doc encapsulation: No Y references leak to UI                   │ │
│ │ - Correct event cleanup: handleYDocUpdate arrow function pattern works     │ │
│ │ correctly                                                                  
│ │ - Good destroyed flag handling: RAF loop properly checks destroyed state   │ │
│ │ - Immutable snapshots: Properly frozen in development                      │ │
│ │ - Throttling implemented: Presence updates correctly throttled to 30Hz     │ │
│ │ - Size estimation working: RollingGzipEstimator properly tracks document   │ │
│ │ size                           

Add shallow equality checks in snapshot subscription, and add integration tests for manager lifecycle and cleanup.

checklist (so you can sanity-check your code)

 there is exactly one RoomDocManager per roomId in a tab

 hooks acquire on mount/room-change and release on unmount

 when refcount hits 0, registry calls mgr.destroy() and removes it

 manager’s destroy() is idempotent and unsubscribes observers, disconnects providers, and stops the rAF loop

 (optional) idle eviction (5–30 s) if users bounce between rooms a lot

 (nice to have) when there are no subscribers, the manager pauses any extra work that isn’t needed (e.g., disable the rAF until someone subscribes again)