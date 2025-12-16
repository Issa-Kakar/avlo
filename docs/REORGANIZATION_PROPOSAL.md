# Codebase Reorganization Proposal (v2)

**Prerequisite:** Remove all legacy code identified in conversation (commands.ts, room.ts, validation.ts, schemas/, server configs, code cell stuff, TTL/extend, room stats from snapshot meta, cursor trails, write queue, PWA/SW, postgresql/redis configs, size limits, etc.)

---

## The Core Question: What Should the Third Workspace Be?

After investigating the entire codebase, **`@avlo/shared` doesn't make sense** - there's no traditional backend to share with. The serverless worker has its own package, and the client is self-contained.

### Recommendation: `@avlo/core` - Pure Domain Logic

A third workspace is valuable if it contains **pure, dependency-free domain logic** that could theoretically be used by: **FUTURE CLOUDFLARE WORKERS AND CLOUDFLARE AI** MAINLY
- The client canvas runtime
- Future CLI tools
- Future testing utilities
- Future server-side rendering (if needed)

**What belongs in `@avlo/core`:**
1. **Type definitions** - All shared interfaces and types
2. **Pure geometry** - Math that doesn't touch DOM/React/Yjs (includes hit-test primitives)
3. **Constants** - All magic numbers in one place
4. **Spatial indexing** - RBush wrapper (already there)
5. **BBox computation** - Pure functions (already there)

**What does NOT belong:**
- React components or hooks
- Yjs-specific code (observers, mutations)
- DOM manipulation
- State management (Zustand)
- Side effects of any kind

---

## Proposed Structure

### `packages/core/` (renamed from `packages/shared/`)

```
packages/core/
├── src/
│   ├── index.ts                    # Barrel export
│   │
│   ├── types/
│   │   ├── index.ts                # Re-export all types
│   │   ├── geometry.ts             # WorldBounds, BBox, Vec2, Point, Bounds (~50 lines)
│   │   ├── objects.ts              # ObjectKind, ObjectHandle, IndexEntry (~50 lines)
│   │   ├── snapshot.ts             # Snapshot, ViewTransform, SnapshotMeta (~60 lines)
│   │   ├── awareness.ts            # Awareness, PresenceView, TimestampedPoint (~40 lines)
│   │   ├── identifiers.ts          # RoomId, UserId, StrokeId, TextId (~10 lines)
│   │   ├── spatial.ts              # RBush IndexEntry, SpatialQuery types (~30 lines)
│   │   └── yjs.ts                  # Y.Doc structure types, ObjectKind unions (~40 lines)
│   │
│   ├── math/                       # RENAMED from geometry/ - pure mathematical functions
│   │   ├── index.ts                # Barrel export
│   │   ├── bbox.ts                 # computeBBoxFor, bboxEquals, bboxToBounds (~100 lines)
│   │   ├── hit-test.ts             # All hit test primitives (~300 lines)
│   │   ├── intersections.ts        # boundsIntersect, rect/circle/segment (~150 lines)
│   │   ├── transforms.ts           # calculateZoomTransform, clampScale, transformBounds (~80 lines)
│   │   └── simplification.ts       # RDP algorithm - pure stroke simplification (~100 lines)
│   │
│   ├── spatial/
│   │   └── object-spatial-index.ts # RBush wrapper (~50 lines)
│   │
│   └── constants/
│       ├── index.ts                # Barrel export
│       ├── performance.ts          # MIN_ZOOM, MAX_ZOOM, MAX_PAN, etc. (~30 lines)
│       ├── canvas.ts               # MAX_CANVAS_DIMENSION, GRID_SPACING (~20 lines)
│       ├── stroke.ts               # PEN_TOLERANCE, HIGHLIGHTER_TOLERANCE (~20 lines)
│       └── recognition.ts          # CIRCLE_MIN_COVERAGE, RECT thresholds (~50 lines)
│
├── package.json                    # name: "@avlo/core"
└── tsconfig.json
```

**Total: ~1,100 lines** (down from ~1,400, after legacy removal)

**Key changes:**
1. Rename `@avlo/shared` → `@avlo/core`
2. Rename `geometry/` → `math/` (more accurate for pure mathematical functions)
3. Move all constants from `config.ts` into categorized files
4. Consolidate WorldBounds/WorldRect into `types/geometry.ts` (THE ONE SOURCE)
5. Move hit-test primitives FROM client TO core (shared by SelectTool + EraserTool)
6. Move `simplification.ts` (RDP algorithm) TO core/math/ (pure math)
7. Move pure transform functions (`calculateZoomTransform`, `boundsIntersect`, `clampScale`) TO core/math/
8. Add `types/spatial.ts` for RBush types (server may use spatial indexing later)
9. Add `types/yjs.ts` for Y.Doc structure types (shared with future AI workers)
10. Delete legacy files (commands, validation, room, schemas)

**Future considerations for core/types/:**
- Stroke data types, renderer/drawing types, viewport types
- Tool types (HandleId, etc.) for worker communication
- Store state shapes if workers need them for AI features

---

### `client/src/` Reorganization

**NOTE:** Consider renaming `client/` in the future - this is a serverless app, so "client" is misleading. The `client/` folder IS the entire app beyond the worker. Possible names: `app/`, `web/`, or keep as-is for monorepo convention.

Current state has several problems:
- `lib/` is a dumping ground (2,075-line room-doc-manager, scattered utilities)
- `pages/` vs `components/` split is confusing
- No dedicated `types/` directory
- Single-file directories (input/, utils/, internal/) - **NO single-file folders allowed**
- canvas/ folder name doesn't reflect it being pure runtime code

**Proposed structure:**

```
client/src/
├── main.tsx                        # Entry point
├── App.tsx                         # Root component
│
├── types/                          # NEW: Client-specific types
│   ├── index.ts                    # Re-exports (also re-export @avlo/core types)
│   ├── tools.ts                    # PreviewData, PointerTool, HandleId (~150 lines)
│   ├── stores.ts                   # Store state/action interfaces (~100 lines)
│   └── renderer.ts                 # FrameStats, ViewportInfo, etc. (~80 lines)
│
├── runtime/                        # RENAMED from canvas/, Canvas.tsx moved to ui/
│   ├── CanvasRuntime.ts            # Central orchestrator (~280 lines)
│   ├── SurfaceManager.ts           # DOM refs + resize/DPR observation (~170 lines)
│   ├── InputManager.ts             # Dumb DOM event forwarder (~70 lines)
│   ├── room-runtime.ts             # Module-level room context (~107 lines)
│   ├── room-doc-manager.ts         # Y.Doc lifecycle, providers, spatial index (~2,075 lines, KEEP SINGLE FILE)
│   └── invalidation-helpers.ts     # Setter/getter for render loop invalidation (~68 lines)
│   # NOTE: internal/transforms.ts DELETED - pure functions moved to @avlo/core/math/
│   #       applyViewTransform() inlined in renderer (only DOM-touching function)
│
├── stores/                         # KEEP: Already well-organized
│   ├── camera-store.ts             # Camera state, coordinate transforms (~350 lines)
│   ├── device-ui-store.ts          # Toolbar state + USER IDENTITY (merged) (~450 lines)
│   └── selection-store.ts          # Selection IDs, transform state (~165 lines)
│
├── tools/                          # MOVE from lib/tools/, add tool-registry
│   ├── index.ts                    # Barrel export
│   ├── tool-registry.ts            # MOVED from canvas/ - tool singletons + lookup (~107 lines)
│   ├── types.ts                    # PointerTool interface, preview types (~183 lines)
│   ├── SelectTool.ts               # Includes scale-transform logic inline (~1,300 lines)
│   ├── DrawingTool.ts              # (~666 lines)
│   ├── EraserTool.ts               # (~390 lines)
│   ├── TextTool.ts                 # (~363 lines, placeholder)
│   ├── PanTool.ts                  # (~108 lines)
│   └── shape-recognizer/           # RENAMED from lib/geometry/, recognition-specific
│       ├── index.ts                # Barrel export
│       ├── recognize-stroke.ts     # Main entry (~200 lines)
│       ├── score.ts                # Scoring functions (~100 lines)
│       ├── params.ts               # Thresholds (~50 lines)
│       ├── geometry-helpers.ts     # PCA, corner/edge detection (~400 lines)
│       ├── fit-circle.ts           # (~80 lines)
│       ├── fit-aabb.ts             # (~47 lines)
│       ├── fit-obb.ts              # (~80 lines)
│       └── HoldDetector.ts         # MOVED from lib/input/ - hold detection for recognition (~60 lines)
│   # NOTE: simplification.ts MOVED to @avlo/core/math/ (pure RDP algorithm)
│
├── renderer/                       # KEEP with additions
│   ├── RenderLoop.ts               # Base canvas 60 FPS loop (~528 lines)
│   ├── OverlayRenderLoop.ts        # Preview + presence rendering (~404 lines)
│   ├── DirtyRectTracker.ts         # Dirty rect accumulation (~267 lines)
│   ├── object-cache.ts             # Path2D cache by object ID (~200 lines)
│   ├── ZoomAnimator.ts             # MOVED from canvas/animation/ (~100 lines)
│   └── layers/
│       ├── objects.ts              # Object rendering dispatch (~763 lines)
│       ├── presence.ts             # Presence cursors (~355 lines)
│       ├── stroke-preview.ts       # Drawing preview
│       ├── shape-preview.ts        # Perfect shape preview
│       └── eraser-dim.ts           # Eraser dimming (~77 lines)
│
├── hooks/                          # CONSOLIDATE
│   ├── index.ts                    # Barrel export
│   ├── use-room-doc.ts             # Gets RoomDocManager from registry (~53 lines)
│   ├── use-snapshot.ts             # Subscribe to room snapshots (~40 lines)
│   ├── use-room-metadata.ts        # (~46 lines)
│   ├── use-connection-gates.ts     # (~70 lines)
│   ├── use-presence.ts             # (~23 lines)
│   ├── use-undo-redo.ts            # (~24 lines)
│   └── use-keyboard-shortcuts.ts   # (~106 lines)
│   # DELETED: use-room-snapshot.ts (duplicate), useDraggableFloat.ts (unused)
│
├── ui/                             # MERGE: pages/ + components/ + Canvas.tsx
│   ├── Canvas.tsx                  # MOVED from canvas/ - thin React wrapper (~95 lines)
│   ├── RoomPage.tsx                # Main page (~180 lines, remove ErrorBoundary usage)
│   ├── Toast.tsx                   # (~72 lines)
│   ├── ZoomControls.tsx            # (~70 lines)
│   ├── UsersModal.tsx              # (~193 lines)
│   ├── UserAvatarCluster.tsx       # (~69 lines)
│   ├── ToolPanel.tsx               # Toolbar + inspector (~516 lines)
│   └── RoomPage.css                # Styles
│   # DELETED: ErrorBoundary.tsx (remove usage from RoomPage)
│
├── lib/                            # MINIMAL - only shared utilities
│   ├── api-client.ts               # (~57 lines)
│   ├── config-schema.ts            # (~34 lines)
│   ├── room-doc-registry-context.tsx  # React context for registry (~65 lines)
│   ├── ring-buffer.ts              # (~99 lines) KEEP FOR NOW - used by room-doc-manager
│   ├── timing-abstractions.ts      # (~192 lines) KEEP FOR NOW - used by room-doc-manager
│   └── utils/
│       └── color.ts                # (~36 lines)
│   # DELETED: user-identity.ts, user-profile-manager.ts (merged into device-ui-store)
│   # NOTE: ring-buffer.ts, timing-abstractions.ts will be removed after
│   #       room-doc-manager refactor to use lodash throttle + zustand
│
└── api/                            # API client stuff (optional rename from lib/)
    ├── client.ts
    └── config-schema.ts
```

---

## Key Architectural Decisions

### 1. Canvas.tsx → ui/, canvas/ → runtime/

**Investigation confirmed SAFE:**
- Canvas.tsx only imports from hooks and runtime (no circular deps)
- React layout effects run in order within same component
- Initialization order preserved:
  1. `useRoomDoc(roomId)` runs → gets roomDoc from registry
  2. useLayoutEffect #1: `setActiveRoom({ roomId, roomDoc })`
  3. useLayoutEffect #2: `new CanvasRuntime().start()`
- Moving files doesn't change initialization

### 2. RoomDocManager → runtime/

**Investigation confirmed SAFE:**
- `room-runtime.ts` only has TYPE-ONLY import: `import type { IRoomDocManager }`
- No circular dependency at runtime
- Makes `room-runtime.ts` import simpler (same folder)
- Conceptually correct: room-doc-manager IS part of the room runtime

### 3. tool-registry.ts → tools/

**SAFE:** Clean encapsulation - it instantiates tools, belongs with them.

### 4. shape-recognizer/ inside tools/

**Rationale:** Only DrawingTool uses shape recognition. Encapsulates the feature.
- Includes HoldDetector (hold detection triggers recognition)
- Does NOT include simplification (that's pure math, goes to core)

### 5. Pure functions → @avlo/core/math/

**Rationale:**
- `hit-test-primitives`: Used by BOTH SelectTool AND EraserTool
- `simplification.ts`: Pure RDP algorithm, could be used by workers/tests
- `transforms.ts` pure functions: `calculateZoomTransform`, `boundsIntersect`, `clampScale`, etc.
- Only `applyViewTransform()` stays client-side (inlined in renderer) - it touches ctx

### 6. No single-file folders

**Rule:** Every folder must have 2+ files. Delete `canvas/internal/` after moving pure functions to core.

### 7. User Profile → device-ui-store

**Rationale:**
- Zustand persist can handle localStorage sync
- userId generation is synchronous (ulid)
- Reduces file count, single source of truth for user state

### 8. Keep RoomDocManager as single file

**Rationale:**
- Future refactor with lodash throttle + zustand vanilla stores will reduce complexity
- Decomposition adds indirection without benefit until that refactor
- Mark as "future decomposition candidate"

---

## Migration Priority

### Phase 1: Delete Legacy (Do First)
1. Delete `packages/shared/src/schemas/`
2. Delete `packages/shared/src/types/room.ts`
3. Delete `packages/shared/src/types/commands.ts`
4. Delete `packages/shared/src/types/validation.ts`
5. Delete `client/src/renderer/stroke-builder/path-builder.ts`
6. Delete `client/src/renderer/stroke-builder/index.ts`
7. Delete `client/src/renderer/layers/presence-cursors.ts.backup`
8. Delete `client/src/hooks/use-room-snapshot.ts` (duplicate)
9. Delete `client/src/hooks/useDraggableFloat.ts` (unused)
10. Delete `client/src/components/ErrorBoundary.tsx` + remove usage from RoomPage
11. Clean unused configs from `config.ts`

### Phase 2: Rename Package
1. Rename `packages/shared/` → `packages/core/`
2. Update all imports from `@avlo/shared` → `@avlo/core`
3. Update tsconfig paths, package.json

### Phase 3: Type Consolidation
1. Create `client/src/types/` directory
2. Move client-specific types there
3. Create single `WorldBounds` source in `@avlo/core/types/geometry.ts`
4. Update all duplicate locations to import from core

### Phase 4: Move Pure Functions to Core
1. Move hit-test primitives to `@avlo/core/math/`
2. Move `simplification.ts` (RDP algorithm) to `@avlo/core/math/`
3. Move pure transform functions to `@avlo/core/math/transforms.ts`:
   - `calculateZoomTransform`, `clampScale`, `boundsIntersect`
   - `transformBounds`, `isInViewport`, `getVisibleWorldBounds`
4. Inline `applyViewTransform()` in renderer (only DOM-touching function)
5. Delete `canvas/internal/` folder entirely (no single-file folders)
6. Split `config.ts` into categorized constant files

### Phase 5: Client Runtime Reorganization
1. Move `Canvas.tsx` → `ui/Canvas.tsx`
2. Rename `canvas/` → `runtime/`
3. Move `room-doc-manager.ts` → `runtime/room-doc-manager.ts`
4. Update `room-doc-registry-context.tsx` import path
5. Move `ZoomAnimator.ts` → `renderer/ZoomAnimator.ts`
6. Delete `canvas/animation/` folder
7. Update imports to use `@avlo/core/math/` for transform functions

### Phase 6: Tools Reorganization
1. Move `tool-registry.ts` → `tools/tool-registry.ts`
2. Move `lib/tools/` → `tools/` (merge with existing)
3. Move `lib/input/HoldDetector.ts` → `tools/shape-recognizer/HoldDetector.ts`
4. Move `lib/geometry/*.ts` → `tools/shape-recognizer/` (recognition files only)
5. Inline `scale-transform.ts` into `SelectTool.ts` (single use)
6. Update DrawingTool to import simplification from `@avlo/core/math/`
7. Update all tool imports

### Phase 7: User Profile Merge
1. Move `generateUserProfile()` logic into `device-ui-store.ts`
2. Add userId, name, color to persisted state
3. Update RoomDocManager, DrawingTool, TextTool to use store
4. Delete `user-identity.ts`, `user-profile-manager.ts`

### Phase 8: UI Consolidation
1. Move `pages/RoomPage.tsx` → `ui/RoomPage.tsx`
2. Move `pages/components/*.tsx` → `ui/`
3. Delete `pages/`, `components/` folders
4. Update import paths

---

## Files to Delete (Summary)

| File | Reason |
|------|--------|
| `packages/shared/src/schemas/index.ts` | Server-only, Zod schemas |
| `packages/shared/src/types/room.ts` | Legacy document structure |
| `packages/shared/src/types/commands.ts` | Server command dispatch |
| `packages/shared/src/types/validation.ts` | Server input validation |
| `packages/shared/src/test-utils/generators.ts` | Dormant test utilities |
| `client/src/canvas/internal/transforms.ts` | Pure functions moved to @avlo/core/math/ |
| `client/src/canvas/internal/` (folder) | No single-file folders allowed |
| `client/src/lib/tools/simplification.ts` | Moved to @avlo/core/math/ |
| `client/src/renderer/stroke-builder/path-builder.ts` | Marked for removal |
| `client/src/renderer/stroke-builder/index.ts` | Near-empty barrel |
| `client/src/renderer/layers/presence-cursors.ts.backup` | Stale backup |
| `client/src/hooks/use-room-snapshot.ts` | Duplicate of use-snapshot |
| `client/src/hooks/useDraggableFloat.ts` | Unused |
| `client/src/components/ErrorBoundary.tsx` | Remove + update RoomPage |
| `client/src/lib/user-identity.ts` | Merged into device-ui-store |
| `client/src/lib/user-profile-manager.ts` | Merged into device-ui-store |
| `client/src/lib/geometry/scale-transform.ts` | Inlined into SelectTool |
| `client/src/lib/input/` (folder) | HoldDetector moved to shape-recognizer/ |

---

## Files to Keep (Pending Future Refactor)

| File | Reason | Remove After |
|------|--------|--------------|
| `client/src/lib/ring-buffer.ts` | Used by room-doc-manager | lodash/zustand refactor |
| `client/src/lib/timing-abstractions.ts` | Used by room-doc-manager | lodash/zustand refactor |

---

## Duplicate Consolidations

| Duplicate | Locations | Consolidate To |
|-----------|-----------|----------------|
| `WorldRect` / `WorldBounds` | 7 places | `@avlo/core/types/geometry.ts` |
| `GateStatus` | 2 places | `@avlo/core/types/snapshot.ts` |
| `Pt` (timestamped point) | 2 places | `@avlo/core/types/awareness.ts` |
| `RoomStats` | 2 places | Keep in `@avlo/core` only |
| `user-identity` / `user-profile-manager` | 2 files | `device-ui-store.ts` |

---

## What NOT to Change

1. **stores/** - Clean separation, appropriate sizes
2. **Core rendering pipeline** - RenderLoop, OverlayRenderLoop work well
3. **Tool singleton pattern** - Zero-arg constructors, module-level instances
4. **room-doc-manager.ts decomposition** - Wait for lodash/zustand refactor

---

## Expected Results

**Before:**
- 2 workspaces with confused "shared" naming
- `canvas/` folder contains React wrapper + runtime code
- `lib/` is a dumping ground
- Scattered user identity code
- 7 duplicate WorldRect definitions

**After:**
- 2 workspaces with clear purposes (`core` = pure domain, `client` = React app)
- `runtime/` folder is pure imperative runtime code
- `ui/` folder has all React components including Canvas.tsx
- `tools/` folder is self-contained with shape-recognizer inside
- User identity in device-ui-store (single source of truth)
- 1 WorldRect source of truth in @avlo/core

---

## Open Questions (Resolved)

1. ~~Move shape recognition params to @avlo/core?~~ → Keep in `tools/shape-recognizer/params.ts`
2. ~~Keep fitting algorithms in client or move to core?~~ → Keep in `tools/shape-recognizer/`
3. ~~How much to decompose SelectTool?~~ → Keep as-is, inline scale-transform
4. ~~Create `@avlo/core` or keep flat in client?~~ → Create `@avlo/core` for pure functions
5. ~~Where does shape-recognizer go?~~ → `tools/shape-recognizer/` (only DrawingTool uses it)
6. ~~Can RoomDocManager go in runtime/?~~ → Yes, SAFE (type-only imports)
7. ~~Where does simplification.ts go?~~ → `@avlo/core/math/` (pure RDP, reusable)
8. ~~Where does HoldDetector go?~~ → `tools/shape-recognizer/` (recognition-specific)
9. ~~What about transforms.ts?~~ → Pure functions to `@avlo/core/math/`, `applyViewTransform()` inlined in renderer
10. ~~Rename geometry/ to math/?~~ → Yes, `@avlo/core/math/` is more accurate

---

## Recommended Approach

Start with **Phase 1-2** (legacy deletion, package rename) since those are low-risk and high-value. Then **Phase 5-6** (runtime + tools reorganization) to establish the new structure. The user profile merge (Phase 7) and UI consolidation (Phase 8) can happen last.
