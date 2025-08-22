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

### Issues
- Integration tests hanging - needs investigation
  - Likely related to async command processing or cleanup timing
  - May need to adjust setTimeout delays in tests
  - CommandBus scheduling might need refinement

### TODO
- Fix hanging integration tests 
- Add more comprehensive scene capture testing
- Verify memory cleanup in destroy() methods
- Add performance benchmarks for command throughput
- Test backpressure handling under load
- Validate adaptive batch window behavior

### Enhanced
- Phase 2.5 Preparation: Production ULID implementation
  - Installed official ulid package (v3.0.1) for production-quality unique ID generation
  - Critical for distributed systems causal consistency and scene capture
  - Ensures lexicographically sortable, collision-resistant identifiers
  - 128-bit UUID compatibility with 1.21e+24 unique IDs per millisecond