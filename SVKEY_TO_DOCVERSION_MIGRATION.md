# svKey to docVersion Migration Instructions

## Executive Summary

**Problem**: `svKey` encoding is causing significant overhead on 1.2MB+ documents despite not being used for any critical logic. It performs expensive `Y.encodeStateVector()` on every snapshot build (60+ FPS), creating performance bottlenecks.

**Solution**:

1. Replace `svKey` with a simple `docVersion` counter that increments on every Y.Doc update (O(1) operation vs expensive state vector encoding)
2. **Remove the entire render cache implementation** - it's deprecated, disabled in production, and dead code

**Impact**:

- 35 total references to svKey across codebase
- 3 render cache methods to remove from RoomDocManager
- 1 render-cache.ts file to delete entirely
- Test updates across multiple files

## Migration Strategy

### Phase 1: Add docVersion System (Parallel Implementation)

#### 1.1 Update RoomDocManagerImpl Fields

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`

**Add new fields** (around line 165, after existing fields):

```typescript
// Add these NEW fields (don't remove svKey yet)
private docVersion = 0;          // Increments on every Y.Doc update
private sawAnyDocUpdate = false; // Tracks if we've seen any doc updates
```

#### 1.2 Update handleYDocUpdate Method

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`
**Location**: Lines 1203-1222

**Current code**:

```typescript
private handleYDocUpdate = (update: Uint8Array, origin: unknown): void => {
  // Y.Doc updated
  // Just mark dirty - RAF will handle publishing
  this.publishState.isDirty = true;

  // Store update for metrics (keep ring buffer, it's useful)
  if (this.publishState.pendingUpdates) {
    this.publishState.pendingUpdates.push({
      update,
      origin,
      time: this.clock.now(),
    });
  }

  // Update size estimate (keep this, it's needed for guards)
  const deltaBytes = update.byteLength;
  this.sizeEstimator.observeDelta(deltaBytes);

  // RAF loop will handle publishing
};
```

**Replace with**:

```typescript
private handleYDocUpdate = (update: Uint8Array, origin: unknown): void => {
  // Increment docVersion on ANY Y.Doc change
  this.docVersion = (this.docVersion + 1) >>> 0; // Use unsigned 32-bit int
  this.sawAnyDocUpdate = true; // We've now seen real doc data

  // Y.Doc updated
  // Just mark dirty - RAF will handle publishing
  this.publishState.isDirty = true;

  // Store update for metrics (keep ring buffer, it's useful)
  if (this.publishState.pendingUpdates) {
    this.publishState.pendingUpdates.push({
      update,
      origin,
      time: this.clock.now(),
    });
  }

  // Update size estimate (keep this, it's needed for guards)
  const deltaBytes = update.byteLength;
  this.sizeEstimator.observeDelta(deltaBytes);

  // RAF loop will handle publishing
};
```

### Phase 2: Update Type Definitions

#### 2.1 Update Snapshot Interface

**File**: `/home/issak/dev/avlo/packages/shared/src/types/snapshot.ts`
**Location**: Lines 6-7

**Current**:

```typescript
export interface Snapshot {
  svKey: string; // base64 of Yjs state vector - keys IDB render snapshot
```

**Replace with**:

```typescript
export interface Snapshot {
  svKey?: string; // DEPRECATED: Remove after migration complete
  docVersion: number; // Incremental version, replaces svKey
```

#### 2.2 Update createEmptySnapshot Function

**File**: `/home/issak/dev/avlo/packages/shared/src/types/snapshot.ts`
**Location**: Lines 75-90

**Current svKey line**:

```typescript
svKey: 'empty',
```

**Replace with**:

```typescript
svKey: '', // DEPRECATED
docVersion: 0, // Empty snapshot has version 0
```

### Phase 3: Remove svKey Computation

#### 3.1 Update buildSnapshot Method

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`
**Location**: Lines 1605-1715

**Remove these lines** (1609-1614):

```typescript
// Get current state vector for svKey
const stateVector = Y.encodeStateVector(this.ydoc);
// CRITICAL: Use safe encoding to avoid stack overflow on large state vectors
// Create a hash-like key from first 100 bytes + length for uniqueness

const svKey = this.createSafeStateVectorKey(stateVector);
```

**Replace svKey in snapshot creation** (line 1688):

```typescript
const snapshot: Snapshot = {
  svKey: '', // DEPRECATED - will be removed completely in Phase 5
  docVersion: this.docVersion, // NEW: Use docVersion instead
  scene: currentScene,
  // ... rest unchanged
```

**Replace G_FIRST_SNAPSHOT gate logic** (lines 1699-1707):

```typescript
// OLD CODE TO REMOVE:
// if (snapshot.svKey !== this.publishState.lastSvKey) {
//   if (!this.gates.firstSnapshot && snapshot.svKey !== '') {
//     this.openGate('firstSnapshot');
//   }
// }

// NEW CODE:
// Open G_FIRST_SNAPSHOT when we've seen any doc updates
if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
  this.openGate('firstSnapshot');
}
```

#### 3.2 Remove createSafeStateVectorKey Method

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`
**Location**: Lines 1120-1136

**Delete entire method**:

```typescript
private createSafeStateVectorKey(stateVector: Uint8Array): string {
  // DELETE ALL THIS CODE
}
```

#### 3.3 Remove lastSvKey Tracking

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`

**Remove from publishState initialization** (line 190):

```typescript
lastSvKey: '', // DELETE THIS LINE
```

**Remove from reset in constructor** (line 283):

```typescript
lastSvKey: '', // DELETE THIS LINE
```

**Remove from publishSnapshot** (line 1584):

```typescript
this.publishState.lastSvKey = newSnapshot.svKey; // DELETE THIS LINE
```

### Phase 4: Update Canvas Component

#### 4.1 Update Initial Render Trigger

**File**: `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`
**Location**: Lines 249-255

**Current code**:

```typescript
if (snapshotRef.current.svKey !== createEmptySnapshot().svKey) {
  initialRenderTimeout = setTimeout(() => {
    if (renderLoopRef.current === renderLoop) {
      renderLoop.invalidateAll('content-change');
    }
  }, 0);
}
```

**Replace with**:

```typescript
// Use gate status instead of svKey comparison
const gateStatus = roomDoc.getGateStatus();
if (gateStatus.firstSnapshot) {
  initialRenderTimeout = setTimeout(() => {
    if (renderLoopRef.current === renderLoop) {
      renderLoop.invalidateAll('content-change');
    }
  }, 0);
}
```

### Phase 5: Remove Render Cache Completely

**Rationale**: The render cache is deprecated, disabled in production (MVP pivot), and represents dead code. Instead of migrating it to use docVersion, we'll remove it entirely.

#### 5.1 Delete Render Cache File

**File**: `/home/issak/dev/avlo/client/src/lib/render-cache.ts`
**Action**: **DELETE ENTIRE FILE** (287 lines)

#### 5.2 Remove RoomDocManager Interface Methods

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`
**Location**: Lines 106-109

**Delete these lines from IRoomDocManager interface**:

```typescript
// Phase 2.4.4: Render cache for boot splash (cosmetic only)
storeRenderCache(canvas: HTMLCanvasElement): Promise<void>;
showBootSplash(targetElement: HTMLElement): Promise<(() => void) | null>;
clearRenderCache(): Promise<void>;
```

#### 5.3 Remove Import and Export

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`

**Delete line 51**:

```typescript
import { renderCache } from './render-cache';
```

**Delete line 1971**:

```typescript
export { renderCache } from './render-cache';
```

#### 5.4 Remove Initialization

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`
**Location**: Line 305

**Delete**:

```typescript
renderCache.init();
```

#### 5.5 Remove Method Implementations

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`
**Location**: Lines 1750-1809

**Delete entire methods**:

```typescript
async storeRenderCache(canvas: HTMLCanvasElement): Promise<void> { ... }
async showBootSplash(targetElement: HTMLElement): Promise<(() => void) | null> { ... }
async clearRenderCache(): Promise<void> { ... }
```

### Phase 6: Update Tests

#### 6.1 Update RoomDocManager Tests

**File**: `/home/issak/dev/avlo/client/src/lib/__tests__/room-doc-manager.test.ts`

**Lines to update**:

- Line 115: Change assertion to check `docVersion` instead of `svKey`
- Lines 258-290: Replace "generates unique svKey from state vector" test with "increments docVersion on updates"
- **Lines 922-924**: Remove render cache method existence checks
- **Lines 932-935**: Remove render cache method call tests
- **Lines 940-965**: Remove entire "uses svKey from snapshot for render cache key" test

**Example test update**:

```typescript
// OLD TEST
it('generates unique svKey from state vector', async () => {
  const { manager } = createTestManager(testRoomId);
  const snapshot1 = await waitForSnapshot(manager);
  expect(snapshot1.svKey).toBe('empty');
  // ... mutation ...
  const snapshot2 = await waitForSnapshot(manager);
  expect(snapshot2.svKey).not.toBe('empty');
});

// NEW TEST
it('increments docVersion on updates', async () => {
  const { manager } = createTestManager(testRoomId);
  const snapshot1 = await waitForSnapshot(manager);
  expect(snapshot1.docVersion).toBe(0); // Empty snapshot
  // ... mutation ...
  const snapshot2 = await waitForSnapshot(manager);
  expect(snapshot2.docVersion).toBeGreaterThan(0);
});
```

#### 6.2 Delete Render Cache Test Files

**Files to DELETE**:

- `/home/issak/dev/avlo/client/src/lib/__tests__/render-cache.test.ts`
- `/home/issak/dev/avlo/client/src/lib/__tests__/render-cache.test.js` (compiled version)

#### 6.3 Update Snapshot Tests

**File**: `/home/issak/dev/avlo/packages/shared/src/types/__tests__/snapshot.test.ts`
**Location**: Line 16

**Current**:

```typescript
expect(snapshot.svKey).toBe('empty');
```

**Replace with**:

```typescript
expect(snapshot.docVersion).toBe(0);
```

#### 6.4 Update Mock Data

**File**: `/home/issak/dev/avlo/client/src/renderer/__tests__/layers/strokes.test.ts`
**Location**: Line 69

**Current**:

```typescript
svKey: 'test-key',
```

**Replace with**:

```typescript
docVersion: 1,
```

### Phase 7: Final Cleanup

#### 7.1 Remove svKey from Snapshot Interface Completely

**File**: `/home/issak/dev/avlo/packages/shared/src/types/snapshot.ts`

**Remove the deprecated field**:

```typescript
export interface Snapshot {
  // svKey?: string; // REMOVE THIS LINE COMPLETELY
  docVersion: number;
  // ... rest unchanged
}
```

#### 7.2 Remove svKey from buildSnapshot

**File**: `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`

**Remove from snapshot creation**:

```typescript
const snapshot: Snapshot = {
  // svKey: '', // REMOVE THIS LINE
  docVersion: this.docVersion,
  // ... rest unchanged
```

## Verification Checklist

After completing the migration, verify:

### Functional Tests

- [ ] Cold boot: Empty snapshot renders with `docVersion: 0`
- [ ] G_FIRST_SNAPSHOT opens after first Y.Doc update
- [ ] Local edits increment docVersion and trigger renders
- [ ] IDB hydration increments docVersion
- [ ] WebSocket sync increments docVersion
- [ ] Presence-only updates do NOT increment docVersion
- [ ] Canvas initial render trigger works correctly

### Render Cache Removal

- [ ] `render-cache.ts` file deleted
- [ ] No imports of `./render-cache` remain
- [ ] RoomDocManager interface has no cache methods
- [ ] Tests no longer reference render cache methods
- [ ] No `renderCache` references in production code
- [ ] StrokeRenderCache still works (different cache!)

### Edge Cases

- [ ] docVersion wraparound handled (32-bit unsigned)
- [ ] Multiple providers don't double-increment
- [ ] TTL extend increments docVersion (acceptable)
- [ ] Tests pass with new assertions

## Important: Do NOT Remove Stroke Cache

**CRITICAL**: The **StrokeRenderCache** in `/client/src/renderer/stroke-builder/stroke-cache.ts` is a **completely different cache** that is **actively used** for rendering performance. This in-memory cache for stroke Path2D objects must be preserved. Only the IndexedDB-based render cache (`render-cache.ts`) should be removed.

## Benefits

1. **Performance**: Eliminates expensive state vector encoding (O(n) → O(1))
2. **Memory**: No large temporary allocations for state vectors
3. **Simplicity**: Integer counter vs complex byte array processing
4. **Reliability**: No truncation issues or potential hash collisions
5. **Cleaner Code**: Removes ~400 lines of dead code (render cache + tests)
6. **Future-Ready**: Enables efficient presence/world separation for dual canvas

## Rollback Plan

If issues arise, the migration can be rolled back by:

1. Restoring svKey computation in buildSnapshot
2. Restoring lastSvKey tracking
3. Reverting gate logic to svKey comparison
4. Updating tests back to svKey assertions

However, since we're keeping docVersion alongside svKey initially, the system can run with both until fully validated.

## Notes

- The `>>> 0` operation ensures docVersion stays as unsigned 32-bit integer
- At 60 FPS continuous updates, overflow would take 828 days
- All Y.Doc updates flow through single handleYDocUpdate method
- Presence updates do NOT modify Y.Doc, so docVersion unchanged
- The sawAnyDocUpdate flag ensures correct G_FIRST_SNAPSHOT timing
