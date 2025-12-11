# Canvas Runtime Refactor - State & Progress

**Branch:** `refactor/canvas-runtime-phase1`
**Last Update:** All tools now zero-arg (PanTool + SelectTool complete)

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
| `cursor-manager.ts` | `applyCursor()` / `setCursorOverride()` | ✅ Wired in Canvas.tsx |
| `editor-host-registry.ts` | `getEditorHost()` for TextTool DOM | ✅ Wired in Canvas.tsx |

### Phase 1.1: CanvasStage Canvas Registration Fix ✅

**Problem:** Both base and overlay canvases called `setCanvasElement()`. Overlay (with `pointer-events: none`) won, breaking cursor-manager.

**Solution:** Added `registerAsPointerTarget` prop to CanvasStage. Only base canvas registers.

### Phase 1.5: DrawingTool Zero-Arg ✅

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

### Phase 1.5: EraserTool Zero-Arg ✅

**Before:**
```typescript
new EraserTool(roomDoc, () => overlayLoopRef.current?.invalidateAll())
```

**After:**
```typescript
new EraserTool()
```

**How it reads dependencies at runtime:**
- `roomDoc` → `getActiveRoomDoc()` at `updateHitTest()` and `commitErase()` time
- `scale` → `useCameraStore.getState().scale` for radius conversion
- `invalidation` → `invalidateOverlay()` import

**No settings to freeze** - eraser uses fixed 10px radius.

### Phase 1.5: TextTool Zero-Arg ✅

**Before:**
```typescript
new TextTool(roomDoc, textSettings, userId, { getEditorHost }, onInvalidate)
```

**After:**
```typescript
new TextTool()
```

**How it reads dependencies at runtime:**
- `textSettings` → `useDeviceUIStore.getState()` for textSize and color at `begin()`
- `roomDoc` → `getActiveRoomDoc()` at `commitTextCore()` and for activity updates
- `userId` → `userProfileManager.getIdentity().userId` at `commitTextCore()`
- `editorHost` → `getEditorHost()` import
- `invalidation` → `invalidateOverlay()` import

**Frozen per-gesture:**
- `config: { size, color }` - captured at begin() time

**Note:** TextTool is marked as PLACEHOLDER in CLAUDE.md - will be completely replaced.
The select tool will automatically switch after placing initial text block.

### Phase 1.5: PanTool Zero-Arg ✅

**Before:**
```typescript
tool = new PanTool(
  () => overlayLoopRef.current?.invalidateAll(),
  applyCursor,
  (cursor: string | null) => { cursorOverrideRef.current = cursor; },
);
```

**After:**
```typescript
new PanTool()
```

**How it reads dependencies at runtime:**
- `scale/pan` → `useCameraStore.getState()` for viewport panning
- `cursor` → `setCursorOverride()` from cursor-manager (internally calls applyCursor)
- `invalidation` → `invalidateOverlay()` from invalidation-helpers

### Phase 1.5: SelectTool Zero-Arg ✅

**Before:**
```typescript
tool = new SelectTool(roomDoc, {
  invalidateWorld: (bounds) => renderLoopRef.current?.invalidateWorld(bounds),
  invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
  applyCursor,
  setCursorOverride: (cursor: string | null) => { cursorOverrideRef.current = cursor; },
});
```

**After:**
```typescript
new SelectTool()
```

**How it reads dependencies at runtime:**
- `roomDoc` → `getActiveRoomDoc()` for snapshot and mutations
- `invalidateWorld` → `invalidateWorld()` from invalidation-helpers
- `invalidateOverlay` → `invalidateOverlay()` from invalidation-helpers
- `cursor` → `applyCursor()` / `setCursorOverride()` from cursor-manager

---

## Canvas.tsx Cleanup Done

**Removed from Canvas.tsx:**
- `cursorOverrideRef` - now using cursor-manager.ts
- Local `applyCursor` useCallback - now imported from cursor-manager.ts
- Callback-based tool construction - all tools now zero-arg

**Still in Canvas.tsx (for future phases):**
- `mmbPanRef` - MMB pan state (will be unified with PanTool when tools become singletons)
- `suppressToolPreviewRef` - Preview suppression during MMB pan
- `activeToolRef` - Tool type mirror for stable closures
- `lastMouseClientRef` - Mouse position for eraser seeding

---

## Next: Tool Registry / CanvasRuntime

Now that all tools are zero-arg, the next phase can proceed:

### Option A: Tool Registry Module (User preference)

Create `client/src/canvas/tool-registry.ts`:
- Self-constructing tools on module load
- Export singleton instances
- MMB pan can directly call `panTool.begin()`

### Option B: CanvasRuntime Class

Create `client/src/canvas/CanvasRuntime.ts`:
- Owns tool singletons
- Owns RenderLoop + OverlayRenderLoop
- Owns ZoomAnimator
- Handles pointer event dispatch
- Canvas.tsx becomes thin React wrapper

**After tool registry/runtime:**
- Remove `mmbPanRef` from Canvas.tsx
- Unify MMB pan with PanTool singleton
- Remove duplicate pan math

---

## All Tools Status

| Tool | Constructor Args | Status |
|------|-----------------|--------|
| `DrawingTool` | Zero-arg | ✅ Complete |
| `EraserTool` | Zero-arg | ✅ Complete |
| `TextTool` | Zero-arg | ✅ Complete |
| `PanTool` | Zero-arg | ✅ Complete |
| `SelectTool` | Zero-arg | ✅ Complete |

---

## Files Modified This Session

```
client/src/canvas/CanvasStage.tsx       - Added registerAsPointerTarget prop
client/src/canvas/Canvas.tsx            - Wired cursor-manager, zero-arg all tools
client/src/lib/tools/PanTool.ts         - Zero-arg constructor refactor
client/src/lib/tools/SelectTool.ts      - Zero-arg constructor refactor
docs/REFACTOR_STATE.md                  - THIS FILE (updated)
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
cat docs/REFACTOR_PAN_CURSOR_SYSTEM.md
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
│                    Tools (ALL Zero-Arg Now!)                     │
│  DrawingTool ✅    EraserTool ✅    TextTool ✅                  │
│  PanTool ✅        SelectTool ✅                                 │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Canvas.tsx (React Wrapper)                       │
│  - Mounts/unmounts runtime modules                              │
│  - Creates tools (will become singleton registry)               │
│  - Dispatches pointer events to tools                           │
│  - MMB pan (to be unified with PanTool singleton)               │
└─────────────────────────────────────────────────────────────────┘
```
