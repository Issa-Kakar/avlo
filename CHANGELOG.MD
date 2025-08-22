# Changelog

## [Unreleased]

### Added
- Phase 2.5: WriteQueue and CommandBus implementation ✅
  - Created WriteQueue class with comprehensive validation pipeline
    - Mobile device detection and view-only enforcement
    - Room size limits (10MB read-only threshold)
    - Idempotency tracking via command keys
    - Rate limiting for ClearBoard (15s) and ExtendTTL (10min)
    - Command-specific validation (stroke size, text length, code size)
    - Scene validation to prevent future scenes and ensure causal consistency
  - Created CommandBus class for atomic command execution
    - Single Y.Doc transaction per command with userId origin
    - Adaptive batch window (8-32ms) based on processing time
    - Budget-based processing (8ms) with yielding to prevent blocking
    - Scene consistency assertions in development mode
    - Support for all command types: DrawStrokeCommit, EraseObjects, AddText, ClearBoard, ExtendTTL, CodeUpdate, CodeRun
  - Integrated WriteQueue and CommandBus with RoomDocManager
    - setupWritePipeline() method initializes both components
    - write() method now enqueues commands for processing
    - extendTTL() uses the write pipeline with proper rate limiting
    - Proper cleanup in destroy() method
  - Added comprehensive test suites
    - WriteQueue validation tests (11 tests passing)
    - Phase 2.5 integration tests (partial - some hanging)

### Enhanced
- Phase 2.4: Snapshot Publishing System implementation ✅
  - RAF-based publish loop with adaptive batching (8-32ms windows)
  - Y.Doc observer setup for state change detection  
  - IndexedDB cache for render snapshots
  - Visibility handling (60 FPS active, 8 FPS hidden)
  - Memory-safe state vector encoding to prevent stack overflow
  - Step D: Visibility handling with document.hidden detection
  - Step E: Snapshot building and publishing with svKey change detection
  - Step F: IndexedDB snapshot cache for fast initial paint
  - Fixed type mismatch in roomStats.expiresAt field

### Issues (UNRESOLVED)
- Phase 2.4/2.5 Integration tests still failing
  - WriteQueue validation works correctly (11/11 tests pass)
  - CommandBus processes commands but timing with fake timers is broken
  - RAF-based snapshot publishing doesn't trigger properly in test environment
  - Commands are enqueued but don't make it to snapshots in tests
  - Test failures:
    - DrawStrokeCommit: snapshot.strokes.length remains 0 (expected 1)
    - AddText: snapshot.texts.length remains 0 (expected 1)  
    - ClearBoard: scene doesn't increment from 0 to 1
    - Scene capture: causal consistency test fails

### Attempted Fixes (FAILED)
- Tried removing async/await from CommandBus - made it worse
- Added trigger() method to force processing - didn't help
- Changed to vi.runAllTimers() - caused infinite loop/hang
- Changed to vi.advanceTimersByTime(100) - still doesn't process
- The core issue: setTimeout-based CommandBus and RAF-based publishing don't work with vitest fake timers

### What Actually Works
- WriteQueue validation and rate limiting (Phase 2.5 core logic)
- Command enqueueing and idempotency
- Mobile detection and view-only enforcement
- Room size limit detection
- Scene validation logic

### Root Cause
- The architecture uses setTimeout for CommandBus batching and requestAnimationFrame for snapshot publishing
- Both are incompatible with vitest's fake timer system
- Need either:
  1. Synchronous test mode for CommandBus/snapshot publishing
  2. Different testing approach without fake timers
  3. Refactor to make the system more testable

### Enhanced
- Phase 2.5 Preparation: Production ULID implementation
  - Installed official ulid package (v3.0.1) for production-quality unique ID generation
  - Critical for distributed systems causal consistency and scene capture
  - Ensures lexicographically sortable, collision-resistant identifiers
  - 128-bit UUID compatibility with 1.21e+24 unique IDs per millisecond