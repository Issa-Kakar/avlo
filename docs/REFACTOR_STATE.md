# Canvas Runtime Refactor - State & Progress

**Branch:** `refactor/canvas-runtime-phase1`
**Last Update:** EraserTool + TextTool zero-arg refactor complete

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

---

## Next: PanTool Zero-Arg

**Current constructor:**
```typescript
tool = new PanTool(
  () => overlayLoopRef.current?.invalidateAll(),
  applyCursor,
  (cursor: string | null) => { cursorOverrideRef.current = cursor; },
);
```

**Target:**
```typescript
new PanTool()
```

**Changes needed in `client/src/lib/tools/PanTool.ts`:**
1. Remove `onInvalidateOverlay` callback → use `invalidateOverlay()` import
2. Remove `applyCursor` callback → use `applyCursor()` from cursor-manager
3. Remove `setCursorOverride` callback → use `setCursorOverride()` from cursor-manager
4. Constructor becomes zero-arg

**Dependency:** Requires wiring cursor-manager.ts in Canvas.tsx first (Phase 4).

---

## Next: SelectTool Zero-Arg

**Current constructor:**
```typescript
tool = new SelectTool(roomDoc, {
  invalidateWorld: (bounds) => renderLoopRef.current?.invalidateWorld(bounds),
  invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
  applyCursor,
  setCursorOverride: (cursor: string | null) => { cursorOverrideRef.current = cursor; },
});
```

**Target:**
```typescript
new SelectTool()
```

**Changes needed in `client/src/lib/tools/SelectTool.ts`:**
1. Remove `room: IRoomDocManager` param → use `getActiveRoomDoc()`
2. Remove `invalidateWorld` callback → use `invalidateWorld()` from invalidation-helpers
3. Remove `invalidateOverlay` callback → use `invalidateOverlay()` from invalidation-helpers
4. Remove `applyCursor` callback → use `applyCursor()` from cursor-manager
5. Remove `setCursorOverride` callback → use `setCursorOverride()` from cursor-manager

**Dependency:** Requires wiring cursor-manager.ts in Canvas.tsx first (Phase 4).

---

## Future Phases

### Phase 2: Remaining Tools

| Tool | Constructor Args | Status |
|------|-----------------|--------|
| `DrawingTool` | Zero-arg | ✅ Complete |
| `EraserTool` | Zero-arg | ✅ Complete |
| `TextTool` | Zero-arg | ✅ Complete |
| `PanTool` | `(onInvalidateOverlay, applyCursor, setCursorOverride)` | Needs cursor-manager |
| `SelectTool` | `(room, opts)` | Needs cursor-manager |

### Phase 3: CanvasRuntime Class

Consolidate into single imperative runtime:
- Owns RenderLoop + OverlayRenderLoop
- Owns ZoomAnimator
- Owns tool singleton registry
- Handles pointer event dispatch
- Canvas.tsx becomes thin React wrapper

### Phase 4: Wire cursor-manager.ts

Replace Canvas.tsx's `applyCursor` callback and `cursorOverrideRef` with imports from cursor-manager.ts.

**Required for:** PanTool and SelectTool zero-arg conversion.

---

## Files Modified This Session

```
client/src/canvas/Canvas.tsx            - Zero-arg EraserTool + TextTool construction
client/src/lib/tools/EraserTool.ts      - Zero-arg constructor refactor
client/src/lib/tools/TextTool.ts        - Zero-arg constructor refactor
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
│  DrawingTool ✅    EraserTool ✅    TextTool ✅                  │
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
