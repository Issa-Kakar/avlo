# Legacy Metadata Cleanup - Changelog

**Date:** 2025-12-14
**Branch:** `cleanup/legacy-renderer-cleanup`
**Status:** PARTIALLY COMPLETE - Next agent to finish

---

## Summary

Removed legacy room metadata, size guards, TTL management, and related infrastructure from the previous Redis/PostgreSQL architecture. The app now uses a simpler model where R2 will handle size measurement in the future.

---

## Completed Changes

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
- `isMobileDevice()` (user explicitly requested removal)
- `updateRoomStats()`
- `setRoomStats()`
- `handlePersistAck()`

#### Methods Simplified:
- **`mutate()`:** Removed size guards, mobile check, temporary update observer for delta measurement. Now just executes transaction directly.
- **`buildSnapshot()`:** Removed `SnapshotMeta` creation and `meta` property from snapshot
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

## Critical Y.Doc Event Handling Analysis

**Key concern addressed:** The user wanted to ensure the Y.Doc update handling remained intact.

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
1. **Temporary update observer in `mutate()`** - This was ONLY for size measurement. The permanent `handleYDocUpdate` observer (set up in `setupObservers()`) handles all the important stuff.
2. **`sizeEstimator.observeDelta()`** - Size tracking no longer needed

### Why this is safe:
The permanent observer (`handleYDocUpdate`) is registered in `setupObservers()` during construction. When `mutate()` calls `ydoc.transact()`, the permanent observer fires and:
- Increments `docVersion`
- Sets `publishState.isDirty = true`
- Triggers the RAF loop to publish snapshots

The temporary observer was purely for measuring delta size for guards that are now removed.

---

## Remaining Work for Next Agent

### Files to DELETE (8 files):
```bash
rm client/src/lib/api-client.ts
rm client/src/lib/config-schema.ts
rm client/src/hooks/use-room-metadata.ts
rm client/src/hooks/use-room-stats.ts
rm packages/shared/src/schemas/index.ts
rm client/src/lib/size-estimator.ts
rm client/src/lib/__tests__/size-estimator.test.ts
rm packages/shared/src/types/room-stats.ts
```

### Files to UPDATE:

1. **`client/src/main.tsx`** - Remove TanStack Query:
```tsx
// BEFORE:
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const queryClient = new QueryClient({...});
<QueryClientProvider client={queryClient}>
  <App />
</QueryClientProvider>

// AFTER:
<BrowserRouter>
  <App />
</BrowserRouter>
```

2. **`client/package.json`** - Remove dependency:
```json
// REMOVE:
"@tanstack/react-query": "^5.85.5",
```

### Post-Cleanup:
```bash
# Run from root
npm install
npm run typecheck
```

---

## User Notes

- **Tests:** User plans to delete all test files from codebase. Manual localhost testing is more effective for this app. Real tests will be created once app is finished.
- **Mobile check:** Explicitly requested to be removed (no more view-only mode for mobile devices)
- **Philosophy:** R2 will handle size measurement in future. No client-side size guards needed.

---

## Files Modified (Summary)

| File | Action |
|------|--------|
| `packages/shared/src/types/snapshot.ts` | Modified - removed SnapshotMeta |
| `packages/shared/src/config.ts` | Modified - removed ROOM_CONFIG, SERVER_CONFIG, PROTOCOL_CONFIG |
| `packages/shared/src/types/commands.ts` | Modified - removed ExtendTTL |
| `packages/shared/src/index.ts` | Modified - removed legacy exports |
| `client/src/lib/room-doc-manager.ts` | Modified - major cleanup |
| `client/src/lib/__tests__/test-helpers.ts` | Modified - removed RoomStats |
| `client/src/lib/__tests__/phase6-teardown.test.ts` | Modified - removed legacy calls |
| `packages/shared/src/__tests__/config.test.ts` | Modified - removed legacy tests |

---

## Verification Commands

After next agent completes:
```bash
# Type check
npm run typecheck

# Search for orphaned references
grep -r "ROOM_CONFIG" client/src/ packages/shared/src/
grep -r "SnapshotMeta" client/src/ packages/shared/src/
grep -r "RoomStats" client/src/ packages/shared/src/
grep -r "size-estimator" client/src/
grep -r "api-client" client/src/
grep -r "config-schema" client/src/
grep -r "@tanstack" client/src/
grep -r "extendTTL" client/src/
grep -r "handlePersistAck" client/src/
grep -r "isMobileDevice" client/src/
```
