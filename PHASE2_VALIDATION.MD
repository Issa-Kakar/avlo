# Phase 2 Steps 2.1 & 2.2 Validation Guide

## Quick Validation Script

Run these checks after implementing steps 2.1 and 2.2 to ensure correctness.

## 1. Type System Validation

### Check 1: Compile Types Package
```bash
cd packages/shared
npm run build
```
**Expected:** No TypeScript errors, types are generated in `dist/`

### Check 2: Verify All Required Types
Ensure these files exist:
- `packages/shared/src/types/identifiers.ts`
- `packages/shared/src/types/room.ts`
- `packages/shared/src/types/awareness.ts`
- `packages/shared/src/types/commands.ts`
- `packages/shared/src/types/snapshot.ts`
- `packages/shared/src/types/device-state.ts`
- `packages/shared/src/types/validation.ts`

### Check 3: Verify Constants Match OVERVIEW.MD
```typescript
// These must match exactly:
MAX_POINTS_PER_STROKE = 10_000
MAX_TOTAL_STROKES = 5_000  
MAX_TEXT_LENGTH = 500
MAX_CODE_BODY_SIZE = 200 * 1024
MAX_OUTPUT_SIZE = 10 * 1024
MAX_OUTPUTS_COUNT = 10
MAX_TOTAL_OUTPUT_SIZE = 128 * 1024
MAX_FRAME_SIZE = 2 * 1024 * 1024
```

## 2. RoomDocManager Validation

### Check 4: Test Singleton Registry
Create a simple test file `test-singleton.ts`:
```typescript
import { RoomDocManagerRegistry } from './client/src/lib/room-doc-manager';

const manager1 = RoomDocManagerRegistry.get('room-123');
const manager2 = RoomDocManagerRegistry.get('room-123');

console.assert(manager1 === manager2, 'Singleton failed!');
console.log('✓ Singleton working');

const manager3 = RoomDocManagerRegistry.get('room-456');
console.assert(manager1 !== manager3, 'Different rooms should have different managers!');
console.log('✓ Multiple rooms working');
```

### Check 5: Verify EmptySnapshot Never Null
```typescript
import { RoomDocManagerRegistry } from './client/src/lib/room-doc-manager';

const manager = RoomDocManagerRegistry.get('test-room');
const snapshot = manager.currentSnapshot;

console.assert(snapshot !== null, 'Snapshot is null!');
console.assert(snapshot !== undefined, 'Snapshot is undefined!');
console.assert(snapshot.svKey === 'empty', 'Initial snapshot should have empty svKey');
console.assert(snapshot.scene === 0, 'Initial scene should be 0');
console.assert(snapshot.strokes.length === 0, 'Initial strokes should be empty');
console.log('✓ EmptySnapshot initialized correctly');
```

### Check 6: Test Y.Doc GUID
```typescript
// This test requires exposing ydoc temporarily or using a debugger
// The Y.Doc's guid MUST equal the roomId passed to the manager
const roomId = 'test-room-guid';
const manager = RoomDocManagerRegistry.get(roomId);
// In debugger: manager.ydoc.guid === roomId
console.log('✓ Y.Doc guid matches roomId');
```

### Check 7: Verify Subscriptions Work
```typescript
import { RoomDocManagerRegistry } from './client/src/lib/room-doc-manager';

const manager = RoomDocManagerRegistry.get('sub-test');
let callCount = 0;

const unsub = manager.subscribeSnapshot((snap) => {
  callCount++;
  console.log('Snapshot received:', snap.svKey);
});

// Should be called immediately with current snapshot
console.assert(callCount === 1, 'Subscription should call immediately');

// Trigger an update (will be connected to WriteQueue later)
manager.write({ type: 'ExtendTTL', idempotencyKey: 'test' });

// Cleanup
unsub();
console.log('✓ Subscriptions working');
```

### Check 8: Verify Snapshot Immutability (Dev Only)
```typescript
if (process.env.NODE_ENV === 'development') {
  const manager = RoomDocManagerRegistry.get('immutable-test');
  const snapshot = manager.currentSnapshot;
  
  try {
    (snapshot as any).scene = 999;
    console.error('✗ Snapshot is mutable!');
  } catch (e) {
    console.log('✓ Snapshot is immutable');
  }
  
  try {
    snapshot.strokes.push({} as any);
    console.error('✗ Snapshot arrays are mutable!');
  } catch (e) {
    console.log('✓ Snapshot arrays are immutable');
  }
}
```

## 3. Data Flow Validation

### Check 9: Verify No Direct Yjs Imports in UI
```bash
# Run from project root
grep -r "import.*from 'yjs'" client/src/components/ client/src/pages/
# Should return nothing

grep -r "import.*from 'y-" client/src/components/ client/src/pages/
# Should return nothing
```

### Check 10: ESLint Enforcement
```bash
cd client
npm run lint
```
Verify that `no-restricted-imports` rule is working:
- Try adding `import * as Y from 'yjs'` in a component file
- ESLint should error

## 4. Performance Validation

### Check 11: Batch Window Adaptation
```typescript
// Monitor console logs during heavy updates
// Should see batch window expanding under load:
// "Batch window: 8ms" -> "Batch window: 12ms" -> up to 32ms
// Then shrinking back when load decreases
```

### Check 12: Tab Visibility Handling
```typescript
// Open browser console and switch tabs
// Should see: "Tab visibility: hidden" and reduced publish rate
// Return to tab: "Tab visibility: visible" and normal rate
```

## 5. Critical Invariants Check

### Invariant 1: Arrays are number[], not Float32Array
```typescript
// In the Stroke interface, points MUST be number[]
// Check packages/shared/src/types/room.ts
interface Stroke {
  points: number[]; // ✓ Correct
  // points: Float32Array; // ✗ Wrong!
}
```

### Invariant 2: svKey Stability
```typescript
// svKey should only change when Y.Doc actually changes
// Multiple builds without changes should produce same svKey
const snapshot1 = manager.currentSnapshot;
setTimeout(() => {
  const snapshot2 = manager.currentSnapshot;
  console.assert(snapshot1.svKey === snapshot2.svKey, 'svKey changed without updates!');
}, 100);
```

### Invariant 3: Command Idempotency
```typescript
// Every command type must have idempotencyKey field
// Check all command interfaces in commands.ts
```

## 6. Integration Points Verification

### Check 13: Registry Cleanup
```typescript
const manager = RoomDocManagerRegistry.get('cleanup-test');
manager.destroy();
console.assert(!RoomDocManagerRegistry.has('cleanup-test'), 'Manager not removed from registry!');
console.log('✓ Cleanup working');
```

### Check 14: React Hooks
```typescript
// Test in a React component:
import { useSnapshot, usePresence } from '../hooks';

function TestComponent({ roomId }: { roomId: string }) {
  const snapshot = useSnapshot(roomId);
  const presence = usePresence(roomId);
  
  console.assert(snapshot !== null, 'useSnapshot returned null!');
  console.assert(presence !== null, 'usePresence returned null!');
  
  return <div>Test</div>;
}
```

## 7. Memory and Performance Checks

### Check 15: No Memory Leaks
```typescript
// Create and destroy multiple managers
for (let i = 0; i < 100; i++) {
  const manager = RoomDocManagerRegistry.get(`room-${i}`);
  manager.destroy();
}
// Check browser memory profiler - should not see retained Y.Docs
```

### Check 16: RAF Cleanup
```typescript
// Destroy a manager during active updates
// Should not see "callback after destroy" errors
const manager = RoomDocManagerRegistry.get('raf-test');
manager.write({ type: 'ExtendTTL', idempotencyKey: 'test' });
manager.destroy();
// No errors in console
```

## Summary Checklist

- [ ] All types compile without errors
- [ ] Constants match OVERVIEW.MD exactly
- [ ] Singleton registry works correctly
- [ ] EmptySnapshot is never null
- [ ] Y.Doc guid equals roomId
- [ ] Subscriptions call immediately and on updates
- [ ] Snapshots are immutable in development
- [ ] No direct Yjs imports in UI code
- [ ] ESLint no-restricted-imports working
- [ ] Batch window adapts to load
- [ ] Tab visibility affects publish rate
- [ ] Arrays stored as number[], not Float32Array
- [ ] svKey remains stable without changes
- [ ] All commands have idempotencyKey
- [ ] Manager cleanup removes from registry
- [ ] React hooks return non-null values
- [ ] No memory leaks on destroy
- [ ] RAF properly cleaned up

## Red Flags ⚠️

If you see any of these, STOP and fix immediately:

1. **Snapshot is null or undefined** - Critical violation
2. **Float32Array stored in Yjs** - Will cause serialization issues
3. **Multiple Y.Docs for same room** - Will cause sync conflicts
4. **Direct yjs imports in components** - Architecture violation
5. **Snapshot objects are mutable** - Will cause React render issues
6. **svKey changes without Y.Doc changes** - Performance issue
7. **Memory leaks after destroy** - Will crash browser eventually
8. **Missing idempotencyKey** - Will cause duplicate operations

## Success Criteria ✅

You can proceed to step 2.3 when:
- All checks pass
- No red flags present
- Code compiles without errors
- ESLint passes
- Basic unit tests pass
- Console shows expected lifecycle logs