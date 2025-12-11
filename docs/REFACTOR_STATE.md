# Canvas Runtime Refactor - State & Progress

**Branch:** `refactor/canvas-runtime-phase1`
**Last Commit:** `ced7560` - refactor: Phase 1 canvas runtime modules + zero-arg DrawingTool

---

## Goal

Decouple tools, render loops, and Canvas.tsx from React lifecycle by:
1. Creating module-level runtime infrastructure
2. Making tools zero-arg constructable (singleton-ready)
3. Eventually consolidating into a single `CanvasRuntime.ts` class

---

## Completed

### Phase 1: Runtime Modules (Foundation)

Created 4 new modules in `client/src/canvas/`:

| Module | Purpose | Status |
|--------|---------|--------|
| `room-runtime.ts` | `getActiveRoomDoc()` for imperative room access | ✅ Wired in Canvas.tsx |
| `invalidation-helpers.ts` | `invalidateOverlay()` / `invalidateWorld()` | ✅ Wired in Canvas.tsx |
| `cursor-manager.ts` | `applyCursor()` / `setCursorOverride()` | ⚠️ Created, not yet wired |
| `editor-host-registry.ts` | `getEditorHost()` for TextTool DOM | ✅ Wired in Canvas.tsx |

### Phase 1.5: DrawingTool Zero-Arg

**Before:**
```typescript
new DrawingTool(roomDoc, toolType, userId, onInvalidate, requestOverlay, { forceSnapKind })
```

**After:**
```typescript
new DrawingTool()
```

**How it reads dependencies at runtime:**
- `activeTool` → `useDeviceUIStore.getState().activeTool` at `begin()`
- `shapeVariant` → `useDeviceUIStore.getState().shapeVariant` at `begin()`
- `settings` → `useDeviceUIStore.getState().drawingSettings` at `begin()`
- `roomDoc` → `getActiveRoomDoc()` at `commit*()` time
- `userId` → `userProfileManager.getIdentity().userId` at `commit*()` time
- `invalidation` → `invalidateOverlay()` import

**Frozen per-gesture:**
- `frozenToolType: 'pen' | 'highlighter'`
- `frozenForceSnapKind: ForcedSnapKind | null`
- Settings (size, color, opacity)

---

## Next: EraserTool Zero-Arg

**Current constructor:**
```typescript
// In Canvas.tsx line ~389
tool = new EraserTool(
  roomDoc,
  () => overlayLoopRef.current?.invalidateAll(),
);
```

**Target:**
```typescript
new EraserTool()
```

**Changes needed in `client/src/lib/tools/EraserTool.ts`:**
1. Remove `room: IRoomDocManager` param → use `getActiveRoomDoc()` at delete time
2. Remove `onInvalidate` callback → use `invalidateOverlay()` import
3. Constructor becomes zero-arg

**Verification:**
- Eraser uses fixed 10px radius (no settings to freeze)
- Deletes objects on pointer-up via `roomDoc.mutate()`

---

## Next: TextTool Zero-Arg

**Current constructor:**
```typescript
// In Canvas.tsx line ~433
tool = new TextTool(
  roomDoc,
  textSettings,
  userId,
  { getEditorHost: () => editorHostRef.current },
  () => overlayLoopRef.current?.invalidateAll(),
);
```

**Target:**
```typescript
new TextTool()
```

**Changes needed in `client/src/lib/tools/TextTool.ts`:**
1. Remove `room: IRoomDocManager` param → use `getActiveRoomDoc()`
2. Remove `textSettings` param → read from `useDeviceUIStore.getState()` at begin()
3. Remove `userId` param → use `userProfileManager.getIdentity().userId`
4. Remove `canvasHandle.getEditorHost` → use `getEditorHost()` from editor-host-registry
5. Remove `onInvalidate` callback → use `invalidateOverlay()`

**Note:** TextTool is marked as PLACEHOLDER in CLAUDE.md - will be completely replaced. May want to do minimal refactor or skip until replacement.

---

## Future Phases

### Phase 2: Remaining Tools

| Tool | Constructor Args | Priority |
|------|-----------------|----------|
| `EraserTool` | `(room, onInvalidate)` | **Next** |
| `TextTool` | `(room, config, userId, canvasHandle, onInvalidate)` | Low (placeholder) |
| `PanTool` | `(onInvalidateOverlay, applyCursor, setCursorOverride)` | Medium |
| `SelectTool` | `(room, opts)` | Medium |

### Phase 3: CanvasRuntime Class

Consolidate into single imperative runtime:
- Owns RenderLoop + OverlayRenderLoop
- Owns ZoomAnimator
- Owns tool singleton registry
- Handles pointer event dispatch
- Canvas.tsx becomes thin React wrapper

### Phase 4: Wire cursor-manager.ts

Replace Canvas.tsx's `applyCursor` callback and `cursorOverrideRef` with imports from cursor-manager.ts.

---

## Files Modified This Session

```
client/src/canvas/Canvas.tsx          - Wired Phase 1 modules, simplified DrawingTool creation
client/src/canvas/cursor-manager.ts   - NEW: Centralized cursor control
client/src/canvas/editor-host-registry.ts - NEW: DOM overlay host registry
client/src/canvas/invalidation-helpers.ts - NEW: Global invalidation functions
client/src/canvas/room-runtime.ts     - NEW: Active room context module
client/src/lib/tools/DrawingTool.ts   - Zero-arg constructor refactor
client/src/lib/tools/SelectTool.ts    - Minor cleanup
docs/REFACTOR_PHASE_1_ROOM_RUNTIME.md - Phase 1 design doc
docs/REFACTOR_STATE.md                - THIS FILE
```

---

## Quick Resume Commands

```bash
# Check current state
git log --oneline -3
git status

# Run typecheck (from repo root)
npm run typecheck

# Key files to read for context
cat docs/REFACTOR_STATE.md
cat docs/REFACTOR_PHASE_1_ROOM_RUNTIME.md
```

---

## Architecture Reference

```
┌─────────────────────────────────────────────────────────────────┐
│                     Module-Level Singletons                      │
│  room-runtime.ts     cursor-manager.ts    invalidation-helpers  │
│  editor-host-registry.ts    camera-store.ts    device-ui-store  │
│  userProfileManager                                              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Tools (Zero-Arg Ready)                        │
│  DrawingTool ✅    EraserTool ⏳    TextTool ⏳                  │
│  PanTool ⏳        SelectTool ⏳                                 │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Canvas.tsx (React Wrapper)                       │
│  - Mounts/unmounts runtime modules                              │
│  - Creates tools (will become singleton registry)               │
│  - Dispatches pointer events to tools                           │
└─────────────────────────────────────────────────────────────────┘
```
