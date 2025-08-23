# Changelog

## [Unreleased]

### Added
RAF Publishing Fix Complete ✅

  Successfully fixed the critical dual publishing path violation in the Avlo Phase 2 implementation. The
  distributed systems issue that was causing race conditions and breaking the "≤1 publish per rAF" guarantee
  has been resolved.

  Key Changes Implemented:

  1. Eliminated Dual Publishing Path
    - Removed perpetual RAF loop from startPublishLoop()
    - Batch timer now schedules ONE requestAnimationFrame instead of publishing directly
    - All publishing consolidated into single maybePublish() method
  2. Correct Single-Path Flow
  Y.Doc Update → Mark dirty + timestamp → Start/reuse batch timer (8-16ms)
       ↓
  Timer expires → Schedule exactly ONE rAF
       ↓
  rAF fires → maybePublish() checks conditions → Publish ONCE
  3. Adaptive Batch Window
    - Consolidated in one place (adaptBatchWindow())
    - Adapts based on actual publish cost (not command processing)
    - Ranges: 8-16ms normal, 24-32ms under pressure
  4. Visibility Handling
    - Implemented "visible kick" - immediate publish when tab becomes visible with pending changes
    - Proper FPS throttling: 60 FPS visible, 8 FPS hidden
  5. Clean Architecture
    - Removed all test environment conditionals
    - Consistent use of performance.now() for timing
    - Removed duplicate batch adaptation from CommandBus
    - Proper cleanup in destroy() method

  The implementation now matches the Phase 2 specification exactly, providing deterministic, testable snapshot
   publishing that's essential for the distributed collaborative whiteboard system.
