# CHANGELOG

## [Phase 2 Refactoring] - 2025-01-25

### Completed (Steps 1-6)

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

### Architecture Improvements
- Fixed presence building structure (ready for Phase 8 awareness integration)  
- Added `handlePersistAck()` method for authoritative size updates from server
- Maintained clean Y.Doc reference rules (no cached references)
- Proper separation of concerns: UI state (Zustand), server state (TanStack Query), doc state (Yjs)

### Result
Transformed enterprise-scale system (1000+ LOC) into simple, spec-compliant implementation (~500 LOC) appropriate for 15-user collaborative whiteboard.