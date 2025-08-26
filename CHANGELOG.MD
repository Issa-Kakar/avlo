# CHANGELOG

## [Phase 2 Refactoring] - 2025-01-25

### Fixed Snapshot Implementation ✅
- **Fixed scene assignment comments**: Changed from "captured at pointer-down" to "assigned at commit time using currentScene"
- **Fixed spatialIndex type**: Changed from `RBushIndexView` to `null` for Phase 2 (RBush is Phase 6)
- **Fixed room size limits**: Updated from 10MB to 15MB per OVERVIEW.MD spec (13MB warning, 15MB read-only)
- **Fixed config values**: Updated ROOM_SIZE_WARNING_BYTES to 13MB and ROOM_SIZE_READONLY_BYTES to 15MB
- **Fixed createEmptySnapshot**: Set spatialIndex to null instead of `{ _tree: null }`
- **Used config constants**: Replaced hardcoded values with ROOM_CONFIG constants

### Completed (Steps 1-10)

#### Step 1: Dependencies ✅
- Installed missing packages: `zustand@^5.0.0`, `@tanstack/react-query@^5.0.0`, `zod@^4`
- Added for proper state management and boundary validation

#### Step 2: Build Artifacts Cleanup ✅  
- Removed all `.js` files from source directories
- Updated `.gitignore` to prevent future JS artifacts in src

#### Step 3: Simplified Write Pattern ✅
- **Removed** over-engineered components:
  - `WriteQueue` (248 lines) - replaced with simple mutate()
  - `CommandBus` (344 lines) - unnecessary complexity
  - `SceneCapture` pattern - incorrect distributed systems design
- **Implemented** simple `mutate(fn)` pattern:
  - Direct `yjs.transact()` wrapper with minimal guards
  - Guards: read-only (≥15MB), mobile view-only, frame size (2MB)
  - No queuing, no complex validation chains

#### Step 4: Simplified Publishing ✅
- **Removed** timer-based batch system with complex scheduling
- **Implemented** simple RAF loop:
  - Publishes when `isDirty` OR `presenceDirty`
  - No timers, just event-driven RAF
  - Clean separation of Y.Doc changes and presence updates

#### Step 5: Fixed Scene Assignment ✅
- **Removed** incorrect scene capture at pointer-down pattern
- **Implemented** correct pattern: scene assigned at commit time using `currentScene`
- Deleted wrong example file `tool-base-example.ts`
- Created correct example in `tool-pattern-example.ts`
- Ensures causal consistency in distributed system

#### Step 6: Moved RoomStats to Shared Package ✅
- Created `/packages/shared/src/types/room-stats.ts`
- Exported from shared package index
- Updated RoomDocManager to import from `@avlo/shared`
- Proper cross-workspace type sharing

#### Step 7: Presence Features Implementation ✅
- **Fixed `buildPresenceView()`**: Returns properly typed `PresenceView` with correct user structure
- **Added throttle utility**: Simple throttling function for rate limiting
- **Created `updatePresence()`**: Method to update presence and mark `presenceDirty` flag
- **Initialized throttled presence**: Set up 33ms (30Hz) throttled presence updates in constructor
- **Proper cleanup**: Clear throttled reference in destroy() method

#### Step 8: ESLint UI Isolation ✅
- **Already implemented** in `eslint.config.js`
- Blocks direct imports of `yjs`, `y-websocket`, `y-indexeddb`, `y-webrtc` in UI components
- Allows these imports only in `/client/src/lib/` and `/client/src/collaboration/` (infrastructure)
- Enforces all UI access through RoomDocManager public API
- Clear error messages guide developers to use proper hooks

### Step 9: Zustand store added✅

### Step 10: Zod Added✅

#### Step 11: Handle persist_ack for Authoritative Size ✅
- **Already implemented**: `handlePersistAck()` method exists at line 871
- Updates `roomStats` with authoritative size from server
- Notifies subscribers when size changes
- Warns when room becomes read-only (≥15MB)
- Ready for WebSocket control frame integration in Phase 7

#### Step 12: Clean Up Constructor and Destroy ✅
- **Simplified constructor**:
  - Removed unnecessary complexity (validation, IDB cache, visibility handling)
  - Clean initialization of Y.Doc, helpers, and state
  - Proper order: Y.Doc → init structures → observers → throttled presence → RAF loop
- **Cleaned up destroy method**:
  - Uses native `cancelAnimationFrame` instead of frame abstraction
  - Proper cleanup order: flag → RAF → observers → subscribers → Y.Doc → references
  - Clears `_currentSnapshot` and `roomStats` references
- **Removed unnecessary code**:
  - Deleted IndexedDB cache methods (belong to later phases)
  - Removed visibility handling (not needed for MVP)
  - Simplified RAF loop to use native browser APIs

### Architecture Improvements
- Fixed presence building structure (ready for Phase 8 awareness integration)  
- Added `handlePersistAck()` method for authoritative size updates from server
- Maintained clean Y.Doc reference rules (no cached references)
- Proper separation of concerns: UI state (Zustand), server state (TanStack Query), doc state (Yjs)
- ESLint enforcement ensures UI components never directly access Yjs

### Result
Transformed enterprise-scale system (1000+ LOC) into simple, spec-compliant implementation (~500 LOC) appropriate for 15-user collaborative whiteboard.