# SCENE TICKS COMPLETE REMOVAL PLAN

## Executive Summary
Scene ticks are currently used to implement "Clear Board" functionality by incrementing a scene index and filtering elements by scene. This document outlines the complete removal of this system in favor of direct deletion.

**Current Architecture:** Clear Board increments `scene_ticks[]` → `currentScene = length` → filter elements by `scene === currentScene`
**New Architecture:** Clear Board will directly delete all user's objects from Yjs arrays

---

## 1. TYPE SYSTEM CHANGES

### Remove Type Definitions
**File: `/home/issak/dev/avlo/packages/shared/src/types/identifiers.ts`**
- ❌ DELETE: `export type SceneIdx = number;` (line 4)

**File: `/home/issak/dev/avlo/packages/shared/src/types/room.ts`**
- ❌ REMOVE: `scene: SceneIdx;` from `Stroke` interface (line 20)
- ❌ REMOVE: `scene: SceneIdx;` from `TextBlock` interface (line 41)
- ❌ REMOVE: `scene_ticks: number[];` from `Meta` interface (line 61)
- ❌ REMOVE: Import of `SceneIdx` (line 1)

**File: `/home/issak/dev/avlo/packages/shared/src/types/snapshot.ts`**
- ❌ REMOVE: `scene: SceneIdx;` from `Snapshot` interface (line 15)
- ❌ REMOVE: `scene: SceneIdx;` from `StrokeView` interface (line 39)
- ❌ REMOVE: `scene: SceneIdx;` from `TextView` interface (line 59)
- ❌ REMOVE: Import of `SceneIdx` (line 1)
- ✏️ UPDATE: `createEmptySnapshot()` - remove `scene: 0` (line 90)

**File: `/home/issak/dev/avlo/packages/shared/src/types/commands.ts`**
- ❌ REMOVE: `scene: SceneIdx;` from `AddStrokeCommand` (line 25)
- ❌ REMOVE: `scene: SceneIdx;` from `AddTextCommand` (line 47)
- ❌ REMOVE: Import of `SceneIdx` (line 1)
- ❌ REMOVE: Comments about scene assignment (lines 25, 47)

---

## 2. ROOM DOC MANAGER MODIFICATIONS

**File: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`**

### Remove Scene State & Methods
- ❌ DELETE: `type YSceneTicks = Y.Array<number>;` (~line 80)
- ❌ DELETE: `private prevScene: number = 0;` (line 266)
- ❌ DELETE: `getSceneTicks()` method (lines 387-392)
- ❌ DELETE: `getCurrentScene()` method (lines 429-434)

### Update Initialization
**In `initializeYjsStructures()`:**
- ❌ REMOVE: Scene ticks initialization (lines 773-774)
```typescript
// DELETE THESE LINES:
const sceneTicks = new Y.Array<number>();
meta.set('scene_ticks', sceneTicks);
```

### Update Structure Validation
- ❌ REMOVE: Scene ticks validation (lines 864, 867-868)

### Simplify Snapshot Composition
**In `hydrateStrokeFromY()` and `hydrateTextFromY()`:**
- ❌ REMOVE: Reading `scene` field (lines 1531, 1553)

**In `composeSnapshotFromMaps()`:**
- ❌ REMOVE: `getCurrentScene()` call (line 1582)
- ❌ REMOVE: Scene filtering logic (lines 1585-1586)
- ✏️ CHANGE TO:
```typescript
const visibleStrokes = Array.from(this.strokesById.values());
const visibleTexts = Array.from(this.textsById.values());
```
- ❌ REMOVE: `scene: currentScene` from snapshot (line 1600)

### Remove Scene Change Detection
**In `publishSnapshot()`:**
- ❌ REMOVE: Scene change detection for spatial rebuild (lines 2077-2081)
```typescript
// DELETE THIS ENTIRE BLOCK:
const currentScene = this.getCurrentScene();
if (this.prevScene !== currentScene) {
  this.needsSpatialRebuild = true;
  this.prevScene = currentScene;
}
```

---

## 3. CLEAR BOARD IMPLEMENTATION CHANGE

### New Clear Board Logic
**File: `/home/issak/dev/avlo/client/src/hooks/useRoomIntegration.ts`**

Stub: `useClearScene` hook (lines 21-49). Remove it but do not implement the clear board delete yet because we are migrating everything to using a Y.map in the future. So it will be pointless to implement it now. so just remove the scene ticks and stub it.

**UPDATE UI Components:**
- `/home/issak/dev/avlo/client/src/pages/components/Header.tsx` - No changes needed (uses hook)
- `/home/issak/dev/avlo/client/src/pages/RoomPage.tsx` - No changes needed (uses hook)

---

## 4. TOOL MODIFICATIONS

### Remove Scene Assignment from Tools

**File: `/home/issak/dev/avlo/client/src/lib/tools/DrawingTool.ts`**
- ❌ REMOVE: Scene tick access and currentScene computation (lines 410-416)
- ❌ REMOVE: `scene: currentScene` from stroke object (line 428)
- ❌ REMOVE: Scene computation for perfect shapes (lines 574-575)
- ❌ REMOVE: `scene: currentScene` from shape stroke (line 585)

**File: `/home/issak/dev/avlo/client/src/lib/tools/TextTool.ts`**
- ❌ REMOVE: Scene tick access (lines 307-308)
- ❌ REMOVE: `scene: currentScene` from text block (line 320)


---

## 5. RENDERING LAYER CHANGES

### Remove Scene Change Detection

**File: `/home/issak/dev/avlo/client/src/renderer/layers/strokes.ts`**
- ❌ DELETE: `lastScene` module variable (lines 8-9)
- ❌ REMOVE: Scene change cache clear logic (lines 31-35)
- ❌ REMOVE: `lastScene` reset in `clearStrokeCache()` (line 239)

**File: `/home/issak/dev/avlo/client/src/renderer/RenderLoop.ts`**
- ❌ DELETE: `lastRenderedScene` field (line 64)
- ❌ REMOVE: `lastRenderedScene` reset (line 120)
- ❌ REMOVE: Scene change detection block (lines 255-260)

**File: `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`**
- ❌ REMOVE: Scene change detection (lines 217-222)
- ✏️ SIMPLIFY: Just check for snapshot changes without scene comparison

---

## 6. DEVICE UI STORE CLEANUP

**File: `/home/issak/dev/avlo/client/src/stores/device-ui-store.ts`**
- ❌ REMOVE: `lastSeenSceneByRoom` state (line 46)
- ❌ REMOVE: `updateLastSeenScene` action (line 68, lines 159-163)
- ❌ REMOVE: Related comments about ghost preview (line 45)

---

## 7. TEST UPDATES

### Core Tests
**File: `/home/issak/dev/avlo/client/src/lib/__tests__/room-doc-manager.test.ts`**
- ❌ DELETE: "initializes meta with scene_ticks array" test (lines 88-105)
- ❌ DELETE: "filters strokes by current scene" test (lines 189-256)
- ❌ REMOVE: Scene assertions from other tests (line 116)

**File: `/home/issak/dev/avlo/client/src/lib/tools/__tests__/DrawingTool.test.ts`**
- ❌ REMOVE: Scene tick simulation (lines 202-207)
- ❌ DELETE: "should handle missing scene_ticks gracefully" test (lines 432-440)

**File: `/home/issak/dev/avlo/packages/shared/src/test-utils/generators.ts`**
- ❌ REMOVE: `scene: 0` from test generators (line 28)


---

## 8. DEV HARNESS UPDATE

**File: `/home/issak/dev/avlo/client/src/App.tsx`**
- ✏️ UPDATE: `handleClearCanvas()` to use deletion pattern (lines 24-40)
- ❌ REMOVE: Scene display from debug UI (line 64)

---


### Performance Benefits
- **Fewer rebuilds**: No spatial index rebuild on scene change
- **Simpler snapshots**: No filtering overhead
- **Reduced memory**: No scene_ticks array growth

### Future Benefits
- **Easier migration**: Simpler structure for upcoming Y.Map refactor
- **Clearer semantics**: Delete means delete, not "hidden by scene"
- **Better collaboration**: Users can clear their own work without affecting others

---

### Risk: Breaking Existing Rooms
**Mitigation**: This is development only, no production data

---

## 12. VALIDATION CHECKLIST

After implementation:
- [ ] TypeScript compiles without errors
- [ ] Clear board deletes only current user's objects
- [ ] Undo restores deleted objects
- [ ] No references to `scene` or `scene_ticks` remain
- [ ] Rendering works without scene filtering
- [ ] Tests pass with new implementation
- [ ] No performance regression

---
 