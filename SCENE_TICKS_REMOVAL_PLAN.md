# AVLO CODEBASE CLEANUP & SCENE TICKS REMOVAL PLAN

## Executive Summary

This document outlines a comprehensive cleanup of the AVLO codebase, covering:
1. **Scene ticks system removal** (original plan)
2. **Code execution infrastructure removal** (Monaco/Pyodide - Phase 15, not implemented)
3. **Unused types and legacy patterns**
4. **Dead client-side code**
5. **Unused API endpoints and server code**

**Total estimated cleanup: ~2,500+ lines of code**

---

# PART A: SCENE TICKS REMOVAL (ORIGINAL PLAN)

## Summary
Scene ticks are currently used to implement "Clear Board" functionality by incrementing a scene index and filtering elements by scene. This will be replaced with direct deletion.

**Current:** Clear Board increments `scene_ticks[]` → `currentScene = length` → filter by `scene === currentScene`
**New:** Clear Board will directly delete all user's objects from Yjs arrays

### Type System Changes

**File: `/packages/shared/src/types/identifiers.ts`**
- ❌ DELETE: `export type SceneIdx = number;` (line 4)

**File: `/packages/shared/src/types/room.ts`**
- ❌ REMOVE: `scene: SceneIdx;` from `Stroke` interface (line 20)
- ❌ REMOVE: `scene: SceneIdx;` from `TextBlock` interface (line 41)
- ❌ REMOVE: `scene_ticks: number[];` from `Meta` interface (line 61)
- ❌ REMOVE: Import of `SceneIdx` (line 1)

**File: `/packages/shared/src/types/snapshot.ts`**
- ❌ REMOVE: `scene: SceneIdx;` from `Snapshot` interface (line 15)
- ❌ REMOVE: `scene: SceneIdx;` from `StrokeView` interface (line 39)
- ❌ REMOVE: `scene: SceneIdx;` from `TextView` interface (line 59)
- ❌ REMOVE: Import of `SceneIdx` (line 1)
- ✏️ UPDATE: `createEmptySnapshot()` - remove `scene: 0` (line 90)

**File: `/packages/shared/src/types/commands.ts`**
- ❌ REMOVE: `scene: SceneIdx;` from `AddStrokeCommand` (line 25)
- ❌ REMOVE: `scene: SceneIdx;` from `AddTextCommand` (line 47)
- ❌ REMOVE: Import of `SceneIdx` (line 1)

### RoomDocManager Modifications

**File: `/client/src/lib/room-doc-manager.ts`**

**Remove:**
- ❌ `type YSceneTicks = Y.Array<number>;` (~line 80)
- ❌ `private prevScene: number = 0;` (line 266)
- ❌ `getSceneTicks()` method (lines 387-392)
- ❌ `getCurrentScene()` method (lines 429-434)
- ❌ Scene ticks initialization in `initializeYjsStructures()` (lines 773-774)
- ❌ Scene ticks validation (lines 864, 867-868)
- ❌ Scene reading in hydration methods (lines 1531, 1553)
- ❌ Scene filtering in `composeSnapshotFromMaps()` (lines 1582-1586)
- ❌ Scene change detection in `publishSnapshot()` (lines 2077-2081)

### Clear Board Implementation Change

**File: `/client/src/hooks/useRoomIntegration.ts`**

Replace `useClearScene` hook with per-user deletion pattern (see original plan for implementation)

### Tool Modifications

**File: `/client/src/lib/tools/DrawingTool.ts`**
- ❌ REMOVE: Scene assignment (lines 410-416, 428, 574-575, 585)

**File: `/client/src/lib/tools/TextTool.ts`**
- ❌ REMOVE: Scene assignment (lines 307-308, 320)

### Rendering Layer Changes

**File: `/client/src/renderer/layers/strokes.ts`**
- ❌ DELETE: `lastScene` module variable and cache clear logic

**File: `/client/src/renderer/RenderLoop.ts`**
- ❌ DELETE: `lastRenderedScene` field and scene change detection

**File: `/client/src/canvas/Canvas.tsx`**
- ❌ REMOVE: Scene change detection (lines 217-222)

### Device UI Store Cleanup

**File: `/client/src/stores/device-ui-store.ts`**
- ❌ REMOVE: `lastSeenSceneByRoom` state (line 46)
- ❌ REMOVE: `updateLastSeenScene` action (line 68, lines 159-163)

### Test Updates

- ❌ DELETE: Scene-related tests in room-doc-manager.test.ts
- ❌ DELETE: Scene-related tests in DrawingTool.test.ts
- ❌ REMOVE: `scene: 0` from test generators

**Estimated removal: ~400 lines**

---

# PART B: CODE EXECUTION INFRASTRUCTURE REMOVAL

## Summary
Code execution (Monaco Editor + Pyodide) was planned for Phase 15 but never implemented. Remove all related infrastructure.

### Components to Remove

**File: `/client/src/pages/components/EditorPanel.tsx`**
- ❌ **DELETE ENTIRE FILE** (92 lines) - Dormant placeholder component

### RoomDocManager Code-Related Methods

**File: `/client/src/lib/room-doc-manager.ts`**

**Remove:**
- ❌ `getCode()` method (lines 412-418) - Never called
- ❌ `getOutputs()` method (lines 420-425) - Never called
- ❌ `addOutput()` method (lines 815-850) - Never called
- ❌ Code initialization in `initializeYjsStructures()` (lines 790-797)
- ❌ Outputs initialization (lines 799-802)
- ❌ Code validation in `isValidRootStructure()` (lines 870-874)

### Shared Type Definitions

**File: `/packages/shared/src/types/room.ts`**
- ❌ DELETE: `CodeCell` interface (lines 46-51)
- ❌ DELETE: `Output` interface (lines 53-57)
- ❌ DELETE: Constants (lines 73-76):
  - `MAX_CODE_BODY_SIZE`
  - `MAX_OUTPUT_SIZE`
  - `MAX_OUTPUTS_COUNT`
  - `MAX_TOTAL_OUTPUT_SIZE`

**File: `/packages/shared/src/types/commands.ts`**
- ❌ DELETE: `CodeUpdate` interface (lines 62-69)
- ❌ DELETE: `CodeRun` interface (lines 71-75)
- ❌ REMOVE from `Command` union type

### Configuration

**File: `/packages/shared/src/config.ts`**
- ❌ DELETE: Code execution config section (lines 145-159):
  - `MAX_CODE_BODY_BYTES`
  - `MAX_OUTPUT_BYTES_PER_RUN`
  - `MAX_OUTPUTS_COUNT`
  - `MAX_TOTAL_OUTPUT_BYTES`
  - `CODE_EXECUTION_TIMEOUT_MS`

### Device UI Store

**File: `/client/src/stores/device-ui-store.ts`**
- ❌ REMOVE: `editorCollapsed: boolean` (line 36)
- ❌ REMOVE: `toggleEditor()` action (line 67, line 157)

**Estimated removal: ~350 lines**

---

# PART C: DEAD CLIENT-SIDE CODE

## Summary
Completely unused files and exports that can be safely deleted.

### Delete Entire Files (Never Imported)

1. **`/client/src/lib/example-config-usage.ts`**
   - ❌ **DELETE ENTIRE FILE** (146 lines) - Documentation only, zero production usage

2. **`/client/src/lib/tools/tool-pattern-example.ts`**
   - ❌ **DELETE ENTIRE FILE** (193 lines) - Developer examples, never imported

3. **`/client/src/hooks/useDraggableFloat.ts`**
   - ❌ **DELETE ENTIRE FILE** (223 lines) - Unused draggable hook

4. **`/client/src/lib/geometry/fit-obb.ts`**
   - ❌ **DELETE ENTIRE FILE** (42 lines) - Oriented Bounding Box fitting, never used

### Remove Dead Exports

**File: `/client/src/pages/components/index.ts`**
- ❌ REMOVE: `export { ColorSizeDock } from './ColorSizeDock';` (line 4)
  - File doesn't exist, dead export

**File: `/client/src/lib/geometry/geometry-helpers.ts`**

Remove unused exports (never imported):
- ❌ `detectEdges()` (line 189)
- ❌ `detectEdgesAndCorners()` (line 235)
- ❌ `coverageAcrossDistinctSides()` (line 513)
- ❌ `aabbSideDist()` (line 581)
- ❌ `aabbSideCoverage()` (line 638)

**Estimated removal: ~800 lines**

---

# PART D: UNUSED SERVER/BACKEND CODE

## Summary
Unused API endpoints, WebSocket frames, and server infrastructure.

### API Endpoints to Remove

**File: `/server/src/routes/rooms.ts`**

1. **POST /api/rooms** (Create Room)
   - ❌ DELETE: Endpoint handler (lines 19-45)
   - Never called by client

2. **PUT /api/rooms/:id/rename** (Rename Room)
   - ❌ DELETE: Endpoint handler (lines 95-113)
   - Hook exists but no UI uses it

### Client API Methods

**File: `/client/src/lib/api-client.ts`**
- ❌ DELETE: `createRoom()` method (lines 58-67)
- ❌ DELETE: `renameRoom()` method (lines 69-74)

**File: `/client/src/hooks/use-room-metadata.ts`**
- ❌ DELETE: `useRenameRoom` hook (lines 37-46) or entire section

### WebSocket Control Frame Schemas

**File: `/packages/shared/src/schemas/index.ts`**

Remove unused frame definitions:
- ❌ DELETE: `persist_ack` schema (lines 14-19)
- ❌ DELETE: `capacity_update` schema (lines 26-31)
- ❌ DELETE: `error` schema (lines 20-25)
- ❌ DELETE: `WSControlFrameSchema` union (lines 13-32)
- ❌ DELETE: `WSControlFrame` type export (line 52)
- ❌ REMOVE: `clientCount` field from `RoomMetadataSchema` (line 47)

### Command Types

**File: `/packages/shared/src/types/commands.ts`**
- ❌ DELETE: `ExtendTTL` interface (lines 57-60)
  - TTL extends automatically on writes

### Dependencies

**File: `/package.json` (root) and `/server/package.json`**
- ❌ REMOVE: `y-leveldb` dependency from both files
  - Installed but never imported

### Dev Artifacts

- ❌ DELETE: `/server/public/test.html` - Likely dev artifact

**Estimated removal: ~500 lines**

---

# PART E: DATABASE SCHEMA CONSIDERATIONS

## Optional Cleanup (Requires Migration)

**File: `/server/prisma/schema.prisma`**

Consider removing:
- ⚠️ `title` field from `RoomMetadata` (line 12)
  - Always empty string, no UI to display or edit
  - Requires database migration

---

# IMPLEMENTATION STRATEGY

## Phase 1: Safe Deletions (Zero Risk)
**Time: 30 minutes**

1. Delete unused files:
   - example-config-usage.ts
   - tool-pattern-example.ts
   - useDraggableFloat.ts
   - fit-obb.ts
   - EditorPanel.tsx
   - test.html

2. Remove unused dependencies:
   - y-leveldb from package.json files

## Phase 2: Type System Cleanup
**Time: 1 hour**

1. Remove SceneIdx type and all scene fields
2. Remove CodeCell, Output, CodeUpdate, CodeRun types
3. Remove WebSocket control frame schemas
4. Remove ExtendTTL command type
5. Update config.ts to remove code execution constants

## Phase 3: Core Logic Updates
**Time: 1.5 hours**

1. Update RoomDocManager:
   - Remove scene-related methods
   - Remove code-related methods
   - Update initialization
   - Simplify snapshot composition

2. Update tools:
   - Remove scene assignment from DrawingTool
   - Remove scene assignment from TextTool

3. Implement new Clear Board logic:
   - Per-user deletion pattern
   - Update useClearScene hook

## Phase 4: API & Server Cleanup
**Time: 30 minutes**

1. Remove unused API endpoints
2. Remove corresponding client methods
3. Remove useRenameRoom hook

## Phase 5: Rendering & UI Updates
**Time: 30 minutes**

1. Remove scene change detection from:
   - RenderLoop
   - Canvas.tsx
   - strokes.ts

2. Update device-ui-store:
   - Remove lastSeenSceneByRoom
   - Remove editorCollapsed
   - Remove related actions

## Phase 6: Test Updates & Validation
**Time: 30 minutes**

1. Update/remove affected tests
2. Run TypeScript compiler
3. Run test suite
4. Manual testing of Clear Board

---

# IMPACT SUMMARY

## Benefits

### Immediate
- **~2,500 lines** of code removed
- Cleaner, more maintainable codebase
- Reduced bundle size
- Simplified state management
- Better Clear Board UX (per-user with undo)

### Performance
- No spatial index rebuilds on scene change
- Simpler snapshot composition
- Reduced memory usage
- Faster TypeScript compilation

### Future
- Easier migration to new Y.Map structure
- Clearer codebase for Y.Text/Y.XMLFragment integration
- Foundation for y-codemirror integration

## Risk Assessment

- **Zero risk** for unused file deletions
- **Low risk** for type removals (compile-time validation)
- **Medium risk** for Clear Board change (needs testing)
- **No production impact** (development only)

---

# VALIDATION CHECKLIST

After implementation:
- [ ] TypeScript compiles without errors
- [ ] All tests pass
- [ ] Clear Board works with per-user deletion
- [ ] Undo/Redo works correctly
- [ ] No references to removed types remain
- [ ] Bundle size reduced
- [ ] No performance regression
- [ ] Manual testing completed

---

# NEXT STEPS

1. Create feature branch: `feature/massive-cleanup`
2. Follow implementation phases in order
3. Commit after each phase for easy rollback
4. Run validation after each phase
5. Update CLAUDE.md to reflect new structure
6. Prepare for Y.Map/Y.Text migration

---

**Total estimated effort: 4-5 hours**
**Total lines to remove: ~2,500**
**Total files to delete: 7**
**Risk level: Low (development environment)**