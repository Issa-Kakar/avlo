# Legacy Room Metadata & Size Guards - COMPLETE REMOVAL PLAN

## Executive Summary

This document provides explicit, step-by-step instructions for **completely removing** all legacy room metadata, TTL, size guards, gzip estimation, SnapshotMeta, RoomStats, and related code from the previous Redis/PostgreSQL architecture.

**Philosophy:** R2 will handle size measurement in the future. Read-only state will be stored in Y.Doc by the owner. No client-side size guards needed. Remove ALL bloat.

---

## Part 1: Files to DELETE Entirely

### 1.1 `client/src/lib/api-client.ts` - DELETE
**Lines:** 58
**Reason:** Stubbed legacy API client, unused.
```bash
rm client/src/lib/api-client.ts
```

---

### 1.2 `client/src/lib/config-schema.ts` - DELETE
**Lines:** 35
**Reason:** Legacy env config (VITE_API_BASE, VITE_ROOM_TTL_DAYS, VITE_PARTY_HOST). VITE_PARTY_HOST is redundant with window.location.host.
```bash
rm client/src/lib/config-schema.ts
```

---

### 1.3 `client/src/hooks/use-room-metadata.ts` - DELETE
**Lines:** 46
**Reason:** Dead TanStack Query hook for HTTP API metadata. Not imported anywhere.
```bash
rm client/src/hooks/use-room-metadata.ts
```

---

### 1.4 `client/src/hooks/use-room-stats.ts` - DELETE
**Lines:** 29
**Reason:** Dead hook for room stats subscription. Not imported in UI.
```bash
rm client/src/hooks/use-room-stats.ts
```

---

### 1.5 `packages/shared/src/schemas/index.ts` - DELETE
**Lines:** 54
**Reason:** Entirely legacy schemas (EnvSchema, WSControlFrameSchema, CreateRoomSchema, RoomMetadataSchema). None used.
```bash
rm packages/shared/src/schemas/index.ts
```

---

### 1.6 `client/src/lib/size-estimator.ts` - DELETE
**Lines:** 271
**Reason:** Gzip estimation for legacy size guards. Not needed - R2 will measure size.
```bash
rm client/src/lib/size-estimator.ts
```

---

### 1.7 `client/src/lib/__tests__/size-estimator.test.ts` - DELETE
**Lines:** 35
**Reason:** Tests for deleted file.
```bash
rm client/src/lib/__tests__/size-estimator.test.ts
```

---

### 1.8 `packages/shared/src/types/room-stats.ts` - DELETE
**Lines:** 8
**Reason:** RoomStats type no longer needed.
```bash
rm packages/shared/src/types/room-stats.ts
```

---

## Part 2: Files to MODIFY

### 2.1 `packages/shared/src/index.ts` - Remove Exports

**Remove these lines:**
```typescript
// DELETE:
export * from './schemas';

// DELETE from type re-exports:
export * from './types/room-stats';
```

**Also remove from config exports:**
```typescript
// DELETE these exports:
export {
  ROOM_CONFIG,        // DELETE ENTIRE EXPORT
  isRoomReadOnly,     // DELETE
  isRoomSizeWarning,  // DELETE
  getRoomSizePercentage, // DELETE
} from './config';
```

**KEEP these config exports:**
```typescript
export {
  STROKE_CONFIG,
  TEXT_CONFIG,
  WEBRTC_CONFIG,
  AWARENESS_CONFIG,
  BACKOFF_CONFIG,
  PERFORMANCE_CONFIG,
  CANVAS_STYLE_CONFIG,
  DEBUG_CONFIG,
  calculateAwarenessInterval,
  applyJitter,
} from './config';
```

---

### 2.2 `packages/shared/src/config.ts` - MAJOR CLEANUP

#### DELETE ENTIRE `ROOM_CONFIG` SECTION (lines ~52-70):
```typescript
// DELETE ENTIRELY:
export const ROOM_CONFIG = {
  ROOM_TTL_DAYS: getEnvNumber('ROOM_TTL_DAYS', 14),
  ROOM_SIZE_WARNING_BYTES: getEnvNumber('ROOM_SIZE_WARNING_BYTES', 13 * 1024 * 1024),
  ROOM_SIZE_READONLY_BYTES: getEnvNumber('ROOM_SIZE_READONLY_BYTES', 15 * 1024 * 1024),
  MAX_CLIENTS_PER_ROOM: getEnvNumber('MAX_CLIENTS_PER_ROOM', 105),
  MAX_CONCURRENT_PER_IP: getEnvNumber('MAX_CONCURRENT_PER_IP', 8),
  MAX_INBOUND_FRAME_BYTES: getEnvNumber('MAX_INBOUND_FRAME_BYTES', 2 * 1024 * 1024),
  GZIP_LEVEL: getEnvNumber('GZIP_LEVEL', 4),
} as const;
```

#### DELETE ENTIRE `SERVER_CONFIG` SECTION (lines ~357-374):
```typescript
// DELETE ENTIRELY:
export const SERVER_CONFIG = {
  PORT: getEnvNumber('PORT', 3001),
  NODE_ENV: getEnvString('NODE_ENV', 'development'),
  DATABASE_URL: getEnvString('DATABASE_URL', ''),
  REDIS_URL: getEnvString('REDIS_URL', ''),
  PG_POOL_MIN: getEnvNumber('PG_POOL_MIN', 10),
  PG_POOL_MAX: getEnvNumber('PG_POOL_MAX', 20),
  SENTRY_DSN: getEnvString('SENTRY_DSN', ''),
  ALLOWED_ORIGINS: getEnvString('ALLOWED_ORIGINS', 'http://localhost:3000').split(','),
} as const;
```

#### DELETE ENTIRE `PROTOCOL_CONFIG` SECTION:
```typescript
// DELETE ENTIRELY:
export const PROTOCOL_CONFIG = {
  WS_PROTOCOL_VERSION: getEnvNumber('WS_PROTOCOL_VERSION', 1),
  AWARENESS_VERSION: getEnvNumber('AWARENESS_VERSION', 1),
} as const;
```

#### DELETE FROM `BACKOFF_CONFIG`:
```typescript
// REMOVE this line from BACKOFF_CONFIG:
TTL_EXTEND_COOLDOWN_MS: getEnvNumber('TTL_EXTEND_COOLDOWN_MS', 10 * 60 * 1000),
```

#### DELETE UTILITY FUNCTIONS:
```typescript
// DELETE THESE FUNCTIONS:
export function isRoomSizeWarning(sizeBytes: number): boolean { ... }
export function isRoomReadOnly(sizeBytes: number | undefined): boolean { ... }
export function getRoomSizePercentage(sizeBytes: number): number { ... }
```

#### DELETE TYPE EXPORTS:
```typescript
// DELETE:
export type RoomConfig = typeof ROOM_CONFIG;
export type ServerConfig = typeof SERVER_CONFIG;
export type ProtocolConfig = typeof PROTOCOL_CONFIG;
```

#### DELETE FROM DEFAULT EXPORT:
```typescript
// REMOVE from default export object:
ROOM: ROOM_CONFIG,
SERVER: SERVER_CONFIG,
PROTOCOL: PROTOCOL_CONFIG,
isRoomSizeWarning,
isRoomReadOnly,
getRoomSizePercentage,
```

#### DELETE FROM FREEZE BLOCK:
```typescript
// REMOVE from freeze block:
Object.freeze(ROOM_CONFIG);
Object.freeze(SERVER_CONFIG);
Object.freeze(PROTOCOL_CONFIG);
```

---

### 2.3 `packages/shared/src/types/snapshot.ts` - Remove SnapshotMeta

**Before:**
```typescript
import { PresenceView } from './awareness';
import { ROOM_CONFIG } from '../config';
import { ObjectHandle, DirtyPatch } from './objects';

export interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;
  spatialIndex: ObjectSpatialIndex | null;
  presence: PresenceView;
  view: ViewTransform;
  meta: SnapshotMeta;  // DELETE
  createdAt: number;
  dirtyPatch?: DirtyPatch | null;
}

export interface SnapshotMeta {  // DELETE ENTIRE INTERFACE
  bytes?: number;
  cap: number;
  readOnly: boolean;
  expiresAt?: number;
}

export function createEmptySnapshot(): Snapshot {
  ...
  meta: {  // DELETE meta property
    cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
    readOnly: false,
  },
  ...
}
```

**After:**
```typescript
import { PresenceView } from './awareness';
import { ObjectHandle, DirtyPatch } from './objects';

// Forward declare the ObjectSpatialIndex interface
export interface ObjectSpatialIndex {
  insert(id: string, bbox: [number, number, number, number], kind: string): void;
  update(id: string, oldBBox: [number, number, number, number], newBBox: [number, number, number, number], kind: string): void;
  remove(id: string, bbox: [number, number, number, number]): void;
  query(bounds: { minX: number; minY: number; maxX: number; maxY: number }): any[];
  bulkLoad(handles: ObjectHandle[]): void;
  clear(): void;
}

// Immutable snapshot - NEVER null
export interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;
  spatialIndex: ObjectSpatialIndex | null;
  presence: PresenceView;
  view: ViewTransform;
  createdAt: number;
  dirtyPatch?: DirtyPatch | null;
}

// View transform for coordinate conversion
export interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number;
  pan: { x: number; y: number };
}

// Empty snapshot constant shape
export function createEmptySnapshot(): Snapshot {
  const emptyMap = new Map<string, ObjectHandle>();

  const snapshot: Snapshot = {
    docVersion: 0,
    objectsById: emptyMap,
    presence: {
      users: new Map(),
      localUserId: '',
    },
    spatialIndex: null,
    view: {
      worldToCanvas: (x: number, y: number): [number, number] => [x, y],
      canvasToWorld: (x: number, y: number): [number, number] => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 },
    },
    createdAt: Date.now(),
    dirtyPatch: null,
  };

  return snapshot;
}
```

---

### 2.4 `packages/shared/src/types/commands.ts` - Remove ExtendTTL

**Remove from Command union:**
```typescript
// BEFORE:
export type Command =
  | DrawStrokeCommit
  | EraseObjects
  | AddText
  | ClearBoard
  | ExtendTTL      // DELETE
  | CodeUpdate
  | CodeRun;

// AFTER:
export type Command =
  | DrawStrokeCommit
  | EraseObjects
  | AddText
  | ClearBoard
  | CodeUpdate
  | CodeRun;
```

**Delete ExtendTTL interface (lines 53-57):**
```typescript
// DELETE ENTIRELY:
export interface ExtendTTL {
  type: 'ExtendTTL';
  idempotencyKey: string;
}
```

---

### 2.5 `client/src/lib/room-doc-manager.ts` - MAJOR CLEANUP

This is the biggest change. Remove all size guards, RoomStats, SnapshotMeta, sizeEstimator, extendTTL, handlePersistAck.

#### 2.5.1 Remove Imports

**Delete these imports:**
```typescript
// DELETE line 14:
import { clientConfig } from './config-schema';

// DELETE line 15:
import { RollingGzipEstimator, GzipImpl } from './size-estimator';

// DELETE from @avlo/shared imports (lines 10-13):
ROOM_CONFIG,  // DELETE

// DELETE from type imports (lines 19-27):
SnapshotMeta,  // DELETE
RoomStats,     // DELETE
```

#### 2.5.2 Remove from IRoomDocManager Interface

**Delete these methods from interface (lines ~51-91):**
```typescript
// DELETE:
subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub;
extendTTL(): void;
setRoomStats(stats: RoomStats | null): void;
```

#### 2.5.3 Remove from RoomDocManagerOptions

**Delete (line ~99):**
```typescript
// DELETE:
gzipImpl?: GzipImpl;
```

#### 2.5.4 Remove Private Fields

**Delete these fields from class (lines ~146-183):**
```typescript
// DELETE:
private statsSubscribers = new Set<(s: RoomStats | null) => void>();
private roomStats: RoomStats | null = null;
private sizeEstimator: RollingGzipEstimator;
```

#### 2.5.5 Remove Constructor Initialization

**Delete from constructor (line ~276):**
```typescript
// DELETE:
this.sizeEstimator = new RollingGzipEstimator();
```

#### 2.5.6 Remove subscribeRoomStats Method (lines ~772-788)

**Delete entire method:**
```typescript
// DELETE ENTIRE METHOD:
subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub {
  if (this.destroyed) {
    return () => {};
  }
  this.statsSubscribers.add(cb);
  const stats = this._currentSnapshot.meta.bytes
    ? { bytes: this._currentSnapshot.meta.bytes, cap: this._currentSnapshot.meta.cap }
    : null;
  cb(stats);
  return () => {
    this.statsSubscribers.delete(cb);
  };
}
```

#### 2.5.7 Simplify mutate() Method (lines ~820-871)

**Before:**
```typescript
mutate(fn: (ydoc: Y.Doc) => void): void {
  if (this.destroyed) { ... }

  // 1. Check room read-only (≥15MB)
  if (this.roomStats && this.roomStats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    console.warn('[RoomDocManager] Room is read-only (size limit exceeded)');
    return;
  }

  // 2. Check mobile view-only
  if (this.isMobileDevice()) {
    console.warn('[RoomDocManager] Mobile devices are view-only');
    return;
  }

  // 3. Frame size check - Delta-based estimation
  let updateSize = 0;
  const updateHandler = (update: Uint8Array) => {
    updateSize = update.byteLength;
  };

  this.ydoc.on('update', updateHandler);

  try {
    this.ydoc.transact(() => {
      fn(this.ydoc);
    }, this.userId);

    if (updateSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
      // deprecated, no guard here anymore
    }
  } finally {
    this.ydoc.off('update', updateHandler);
  }

  this.publishState.isDirty = true;
}
```

**After (simplified):**
```typescript
mutate(fn: (ydoc: Y.Doc) => void): void {
  if (this.destroyed) return;

  // Mobile devices are view-only (keep this guard for now)
  if (this.isMobileDevice()) {
    console.warn('[RoomDocManager] Mobile devices are view-only');
    return;
  }

  // Execute transaction with user origin for undo/redo
  this.ydoc.transact(() => {
    fn(this.ydoc);
  }, this.userId);

  this.publishState.isDirty = true;
}
```

#### 2.5.8 Remove extendTTL Method (lines ~941-952)

**Delete entire method:**
```typescript
// DELETE ENTIRE METHOD:
extendTTL(): void {
  if (this.destroyed) return;
  this.mutate((_ydoc) => {
    const meta = this.getMeta();
    meta.set('lastExtendedAt', Date.now());
  });
}
```

#### 2.5.9 Remove from destroy() Method

**Delete these lines from destroy() (lines ~1083-1105):**
```typescript
// DELETE:
this.statsSubscribers.clear();
this.roomStats = null;
```

#### 2.5.10 Remove sizeEstimator.observeDelta from handleYDocUpdate

**Line ~1407:**
```typescript
// DELETE these lines:
const deltaBytes = update.byteLength;
this.sizeEstimator.observeDelta(deltaBytes);
```

#### 2.5.11 Update WebSocket Host Initialization (line ~1469)

**Before:**
```typescript
const host = clientConfig.VITE_PARTY_HOST || window.location.host;
```

**After:**
```typescript
const host = window.location.host;
```

#### 2.5.12 Remove updateRoomStats and setRoomStats Methods (lines ~1750-1766)

**Delete both methods:**
```typescript
// DELETE ENTIRE METHOD:
private updateRoomStats(stats: RoomStats | null): void {
  this.roomStats = stats;
  this.statsSubscribers.forEach((cb) => cb(stats));
  if (stats && stats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    console.warn('[RoomDocManager] Room size approaching read-only threshold');
  }
}

// DELETE ENTIRE METHOD:
public setRoomStats(stats: RoomStats | null): void {
  if (this.destroyed) return;
  this.updateRoomStats(stats);
}
```

#### 2.5.13 Simplify buildSnapshot (lines ~1800-1840)

**Remove all meta-related code:**

**Before:**
```typescript
private buildSnapshot(): Snapshot {
  ...
  const metaData: SnapshotMeta = {
    cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
    readOnly: this.roomStats?.bytes
      ? this.roomStats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES
      : false,
    bytes: this.roomStats?.bytes,
    expiresAt: this.roomStats?.expiresAt,
  };

  const snap: Snapshot = {
    docVersion: this.docVersion,
    objectsById: this.objectsById,
    spatialIndex: this.spatialIndex,
    presence,
    view: getViewTransform(),
    meta: metaData,
    createdAt: this.clock.now(),
    dirtyPatch,
  };
  ...
}
```

**After:**
```typescript
private buildSnapshot(): Snapshot {
  ...
  const snap: Snapshot = {
    docVersion: this.docVersion,
    objectsById: this.objectsById,
    spatialIndex: this.spatialIndex,
    presence,
    view: getViewTransform(),
    createdAt: this.clock.now(),
    dirtyPatch,
  };
  ...
}
```

#### 2.5.14 Remove handlePersistAck Method (lines ~1849-1867)

**Delete entire method:**
```typescript
// DELETE ENTIRE METHOD:
handlePersistAck(ack: { sizeBytes: number; timestamp: string }): void {
  const oldStats = this.roomStats;
  this.roomStats = {
    bytes: ack.sizeBytes,
    cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
  };
  if (oldStats?.bytes !== ack.sizeBytes) {
    this.statsSubscribers.forEach((cb) => cb(this.roomStats));
  }
  if (ack.sizeBytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    console.warn('[RoomDocManager] Room size at or above read-only threshold');
  }
}
```

---

### 2.6 `client/src/lib/__tests__/test-helpers.ts` - Remove Legacy Helpers

**Delete simulatePersistAck function (lines 175-188):**
```typescript
// DELETE:
export function simulatePersistAck(...) { ... }
```

**Delete RoomStats from imports (line 21):**
```typescript
// REMOVE RoomStats from this import:
import type { RoomId, Snapshot, PresenceView, RoomStats } from '@avlo/shared';
// BECOMES:
import type { RoomId, Snapshot, PresenceView } from '@avlo/shared';
```

**Delete from verifyCleanup function (line 219):**
```typescript
// DELETE:
const statsUnsub = manager.subscribeRoomStats(() => {});
...
statsUnsub();
```

---

### 2.7 `client/src/lib/__tests__/phase6-teardown.test.ts` - Update Tests

**Remove subscribeRoomStats call (line ~98):**
```typescript
// DELETE:
const unsubStats = manager.subscribeRoomStats(() => {
```

---

### 2.8 `packages/shared/src/__tests__/config.test.ts` - Remove ROOM_CONFIG Tests

**Delete entire "Config Values" describe block testing ROOM_CONFIG (lines ~13-27):**
```typescript
// DELETE tests for ROOM_CONFIG.ROOM_TTL_DAYS, MAX_CLIENTS_PER_ROOM, etc.
```

**Delete isRoomReadOnly and isRoomWarning tests (lines ~39-65):**
```typescript
// DELETE entire describe blocks for these functions
```

---

### 2.9 `client/src/main.tsx` - Remove TanStack Query

**Before:**
```typescript
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </BrowserRouter>,
);
```

**After:**
```typescript
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
```

---

### 2.10 `client/package.json` - Remove Dependencies

**Remove:**
```json
"@tanstack/react-query": "^5.85.5",
```

---

### 2.11 Environment Files - Clean Up

#### `.env.example` - Remove all legacy vars:
- All ROOM_TTL_DAYS, ROOM_SIZE_*, MAX_CLIENTS_*, MAX_CONCURRENT_*, MAX_INBOUND_FRAME_*, GZIP_*
- All DATABASE_URL, REDIS_URL, PG_POOL_*
- All TTL_EXTEND_COOLDOWN_*

#### `client/.env.example` - Remove:
- VITE_API_BASE
- VITE_ROOM_TTL_DAYS

---

## Part 3: Execution Order

Execute in this EXACT order to avoid broken imports:

### Phase A: Pre-work (Updates before deletions)

1. **Update `packages/shared/src/types/snapshot.ts`**
   - Remove SnapshotMeta interface
   - Remove meta field from Snapshot interface
   - Remove ROOM_CONFIG import
   - Update createEmptySnapshot()

2. **Update `packages/shared/src/index.ts`**
   - Remove `export * from './schemas';`
   - Remove `export * from './types/room-stats';`
   - Remove ROOM_CONFIG and utility function exports

3. **Update `packages/shared/src/config.ts`**
   - Delete ROOM_CONFIG section
   - Delete SERVER_CONFIG section
   - Delete PROTOCOL_CONFIG section
   - Delete utility functions
   - Delete type exports
   - Update default export
   - Update freeze block

4. **Update `packages/shared/src/types/commands.ts`**
   - Remove ExtendTTL from union and interface

5. **Update `client/src/lib/room-doc-manager.ts`**
   - Remove all imports for config-schema, size-estimator, ROOM_CONFIG, SnapshotMeta, RoomStats
   - Remove interface methods
   - Remove private fields
   - Remove methods (subscribeRoomStats, extendTTL, setRoomStats, updateRoomStats, handlePersistAck)
   - Simplify mutate() and buildSnapshot()
   - Update WebSocket host

6. **Update test files**
   - `client/src/lib/__tests__/test-helpers.ts`
   - `client/src/lib/__tests__/phase6-teardown.test.ts`
   - `packages/shared/src/__tests__/config.test.ts`

7. **Update `client/src/main.tsx`**
   - Remove TanStack Query

8. **Update `client/package.json`**
   - Remove @tanstack/react-query

### Phase B: Delete Files

9. `rm client/src/lib/api-client.ts`
10. `rm client/src/lib/config-schema.ts`
11. `rm client/src/hooks/use-room-metadata.ts`
12. `rm client/src/hooks/use-room-stats.ts`
13. `rm packages/shared/src/schemas/index.ts`
14. `rm client/src/lib/size-estimator.ts`
15. `rm client/src/lib/__tests__/size-estimator.test.ts`
16. `rm packages/shared/src/types/room-stats.ts`

### Phase C: Clean Up

17. Update `.env.example` files
18. Run `npm install` to update package-lock.json
19. Run `npm run typecheck` from root
20. Fix any remaining type errors

---

## Part 4: Summary

### Files DELETED (8 files, ~536 lines):
| File | Lines |
|------|-------|
| `client/src/lib/api-client.ts` | 58 |
| `client/src/lib/config-schema.ts` | 35 |
| `client/src/hooks/use-room-metadata.ts` | 46 |
| `client/src/hooks/use-room-stats.ts` | 29 |
| `packages/shared/src/schemas/index.ts` | 54 |
| `client/src/lib/size-estimator.ts` | 271 |
| `client/src/lib/__tests__/size-estimator.test.ts` | 35 |
| `packages/shared/src/types/room-stats.ts` | 8 |

### Code REMOVED from existing files (~300+ lines):
- ROOM_CONFIG, SERVER_CONFIG, PROTOCOL_CONFIG from config.ts
- SnapshotMeta from snapshot.ts
- ExtendTTL from commands.ts
- Size guards, RoomStats infrastructure, sizeEstimator from room-doc-manager.ts
- TanStack Query from main.tsx
- Legacy tests

### Dependencies REMOVED:
- `@tanstack/react-query`

---

## Part 5: Verification

```bash
# 1. Type check
npm run typecheck

# 2. Search for orphaned references
grep -r "ROOM_CONFIG" client/src/ packages/shared/src/
grep -r "SnapshotMeta" client/src/ packages/shared/src/
grep -r "RoomStats" client/src/ packages/shared/src/
grep -r "size-estimator" client/src/
grep -r "api-client" client/src/
grep -r "config-schema" client/src/
grep -r "@tanstack" client/src/
grep -r "extendTTL" client/src/
grep -r "handlePersistAck" client/src/

# 3. Build
cd client && npm run build

# 4. Start and test manually
npm run dev
```

---

## Part 6: What We're KEEPING

### Actively Used Config:
- `STROKE_CONFIG` - simplification tolerances
- `TEXT_CONFIG` - text limits
- `WEBRTC_CONFIG` / `AWARENESS_CONFIG` - presence
- `BACKOFF_CONFIG` (minus TTL_EXTEND_COOLDOWN_MS)
- `PERFORMANCE_CONFIG` - zoom limits, FPS, etc.
- `CANVAS_STYLE_CONFIG` - grid styling
- `DEBUG_CONFIG` - debug flags
- `calculateAwarenessInterval`, `applyJitter` utilities

### Keeping in room-doc-manager:
- Mobile device check in mutate() (optional, can remove later)
- All Y.Doc, presence, awareness functionality
- Undo/redo
- Gates infrastructure

---

*Document created for aggressive cleanup of legacy serverless migration artifacts*
