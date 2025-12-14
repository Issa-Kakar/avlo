# Legacy Metadata Cleanup - Changelog

**Date:** 2025-12-14
**Branch:** `cleanup/legacy-renderer-cleanup`
**Status:** COMPLETE

---

## Summary

Removed legacy room metadata, size guards, TTL management, TanStack Query, and related infrastructure from the previous Redis/PostgreSQL architecture. The app now uses a simpler model where R2 will handle size measurement in the future.

---

## Phase 1: Shared Package & RoomDocManager Cleanup (Previous Agent)

### 1. `packages/shared/src/types/snapshot.ts`
- **Removed:** `SnapshotMeta` interface
- **Removed:** `meta` field from `Snapshot` interface
- **Removed:** `ROOM_CONFIG` import
- **Updated:** `createEmptySnapshot()` to not include meta

### 2. `packages/shared/src/config.ts`
- **Removed:** `ROOM_CONFIG` section (TTL, size limits, capacity limits, frame limits, gzip)
- **Removed:** `SERVER_CONFIG` section (PORT, DATABASE_URL, REDIS_URL, PG_POOL, etc.)
- **Removed:** `PROTOCOL_CONFIG` section
- **Removed:** `TTL_EXTEND_COOLDOWN_MS` from `BACKOFF_CONFIG`
- **Removed:** Utility functions: `isRoomSizeWarning()`, `isRoomReadOnly()`, `getRoomSizePercentage()`
- **Removed:** Type exports: `RoomConfig`, `ServerConfig`, `ProtocolConfig`
- **Updated:** Default export and freeze block

### 3. `packages/shared/src/types/commands.ts`
- **Removed:** `ExtendTTL` from Command union type
- **Removed:** `ExtendTTL` interface definition

### 4. `packages/shared/src/index.ts`
- **Removed:** `export * from './schemas';`
- **Removed:** `export * from './types/room-stats';`
- **Removed:** `ROOM_CONFIG`, `SERVER_CONFIG`, `PROTOCOL_CONFIG` exports
- **Removed:** `isRoomReadOnly`, `isRoomSizeWarning`, `getRoomSizePercentage` exports
- **Added:** `AWARENESS_CONFIG`, `CANVAS_STYLE_CONFIG` exports (were missing)

### 5. `client/src/lib/room-doc-manager.ts` (MAJOR)

#### Imports Removed:
- `ROOM_CONFIG` from `@avlo/shared`
- `clientConfig` from `./config-schema`
- `RollingGzipEstimator`, `GzipImpl` from `./size-estimator`
- `SnapshotMeta`, `RoomStats` type imports

#### Interface Changes:
- **Removed from `IRoomDocManager`:**
  - `subscribeRoomStats()`
  - `extendTTL()`
  - `setRoomStats()`
- **Removed from `RoomDocManagerOptions`:**
  - `gzipImpl?: GzipImpl`

#### Private Fields Removed:
- `statsSubscribers`
- `roomStats`
- `sizeEstimator`

#### Methods Removed:
- `subscribeRoomStats()`
- `extendTTL()`
- `isMobileDevice()` (mobile view-only pattern removed)
- `updateRoomStats()`
- `setRoomStats()`
- `handlePersistAck()`

#### Methods Simplified:
- **`mutate()`:** Removed size guards, mobile check, temporary update observer for delta measurement. Now just executes transaction directly.
- **`buildSnapshot()`:** Removed `SnapshotMeta` creation and `meta` property from snapshot; now uses `getMeta()` accessor
- **`handleYDocUpdate()`:** Removed `sizeEstimator.observeDelta()` call
- **`initializeWebSocketProvider()`:** Changed from `clientConfig.VITE_PARTY_HOST || window.location.host` to just `window.location.host`
- **`destroy()`:** Removed `statsSubscribers.clear()` and `roomStats = null`

### 6. Test Files Updated
- **`client/src/lib/__tests__/test-helpers.ts`:**
  - Removed `RoomStats` import
  - Removed `simulatePersistAck()` function
  - Updated `verifyCleanup()` to remove `subscribeRoomStats` call

- **`client/src/lib/__tests__/phase6-teardown.test.ts`:**
  - Removed `extendTTL()` call
  - Removed `subscribeRoomStats()` call

- **`packages/shared/src/__tests__/config.test.ts`:**
  - Removed ROOM_CONFIG tests
  - Removed `isRoomReadOnly` and `isRoomWarning` tests

---

## Phase 2: File Deletions & Dependency Removal (Current Session)

### Files DELETED (8 files, ~536 lines removed):

| File | Lines | Reason |
|------|-------|--------|
| `client/src/lib/api-client.ts` | 58 | Stubbed legacy API client, unused |
| `client/src/lib/config-schema.ts` | 35 | Legacy env config (VITE_API_BASE, VITE_ROOM_TTL_DAYS, VITE_PARTY_HOST) |
| `client/src/hooks/use-room-metadata.ts` | 46 | Dead TanStack Query hook for HTTP API metadata |
| `client/src/hooks/use-room-stats.ts` | 29 | Dead hook for room stats subscription |
| `packages/shared/src/schemas/index.ts` | 54 | Entirely legacy schemas (EnvSchema, WSControlFrameSchema, etc.) |
| `client/src/lib/size-estimator.ts` | 271 | Gzip estimation for legacy size guards |
| `client/src/lib/__tests__/size-estimator.test.ts` | 35 | Tests for deleted file |
| `packages/shared/src/types/room-stats.ts` | 8 | RoomStats type no longer needed |

**Also deleted:** Empty `packages/shared/src/schemas/` directory

### Files MODIFIED:

#### `client/src/main.tsx`
**Before:**
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const queryClient = new QueryClient({...});
<BrowserRouter>
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
</BrowserRouter>
```
**After:**
```tsx
<BrowserRouter>
  <App />
</BrowserRouter>
```

#### `client/package.json`
- **Removed:** `"@tanstack/react-query": "^5.85.5"` dependency
- Result: 21 packages removed from node_modules

#### `client/src/lib/room-doc-manager.ts`
- **Restored:** `getMeta()` private accessor (returns `YMeta | undefined`, doesn't throw)
- **Updated:** `buildSnapshot()` now uses `this.getMeta()` instead of direct `root.get('meta')` access
- **Kept:** `YMeta` type alias for future use (owner ID, read-only state)

#### `client/src/hooks/use-room-doc.ts`
- **Updated:** Removed stale `useRoomStats` from JSDoc comment

---

## Critical Y.Doc Event Handling Analysis

**Key concern addressed:** Ensuring Y.Doc update handling remained intact.

### What was KEPT (essential):
1. **`setupObservers()`** - Sets up `this.ydoc.on('update', this.handleYDocUpdate)` - CRITICAL
2. **`handleYDocUpdate`** (arrow function property):
   - Increments `this.docVersion` - CRITICAL
   - Sets `this.sawAnyDocUpdate = true` - CRITICAL
   - Sets `this.publishState.isDirty = true` - CRITICAL
   - Stores update in ring buffer for metrics - kept for future use
3. **`setupObjectsObserver()`** - Deep observer on objects Y.Map - CRITICAL
4. **`publishState.isDirty` tracking** - drives the RAF publish loop

### What was REMOVED (safe):
1. **Temporary update observer in `mutate()`** - Was ONLY for size measurement
2. **`sizeEstimator.observeDelta()`** - Size tracking no longer needed

### Why this is safe:
The permanent observer (`handleYDocUpdate`) is registered in `setupObservers()` during construction. When `mutate()` calls `ydoc.transact()`, the permanent observer fires and handles all critical state updates.

---

## Design Decisions

### Kept for Future Use:
- **`YMeta` type alias** - Will store room owner (userId) and read-only state
- **`getMeta()` accessor** - Encapsulated access pattern like `getObjects()`
- **Mobile FPS throttling** - Camera store/render loop mobile detection for performance (NOT the removed "view-only" pattern)

### Removed Patterns:
- **Mobile view-only** - Was blocking mobile users from drawing
- **Client-side size guards** - R2 will handle size measurement
- **TTL management** - No longer needed with new architecture
- **TanStack Query** - Was only used for dead HTTP API hooks

---

## Verification Results

All checks passed:

```bash
npm run typecheck  # PASS - all workspaces

# Orphaned reference checks - all clean:
grep -r "ROOM_CONFIG" client/src/ packages/shared/src/     # No matches
grep -r "SnapshotMeta" client/src/ packages/shared/src/    # No matches
grep -r "RoomStats" client/src/ packages/shared/src/       # No matches (only docs)
grep -r "size-estimator" client/src/                       # No matches (only docs)
grep -r "api-client" client/src/                           # No matches
grep -r "config-schema" client/src/                        # No matches
grep -r "@tanstack" client/src/                            # No matches
grep -r "extendTTL" client/src/                            # No matches
grep -r "handlePersistAck" client/src/                     # No matches
```

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Files deleted | 8 |
| Lines removed (deleted files) | ~536 |
| Lines removed (modifications) | ~300+ |
| Dependencies removed | 1 (@tanstack/react-query) |
| Packages removed from node_modules | 21 |

---

## What Remains in RoomDocManager

The following are **actively used** and should NOT be removed:

- Y.Doc lifecycle (ydoc, providers, observers)
- Snapshot publishing (60 FPS RAF loop)
- Spatial index management
- Presence/awareness system
- Undo/redo (UndoManager)
- Gates infrastructure (idbReady, wsConnected, wsSynced, etc.)
- Object hydration (two-epoch model)
- Dirty rect tracking

---

*Cleanup completed 2025-12-14*
