# Phase 2.4 & 2.5 Validation Checklist

## Quick Reference: Critical Invariants

### ⚠️ NEVER VIOLATE THESE
1. **Snapshot is NEVER null** - EmptySnapshot exists from instant 0
2. **No cached Y references** - All access via helper methods
3. **One transaction per command** - Atomic execution only
4. **svKey changes only on Y.Doc update** - Stable when unchanged
5. **Arrays stored as number[]** - Float32Array at render only

### 🔴 Red Flags (Implementation Errors)
- `this.yStrokes = ...` ❌ (cached reference)
- `snapshot = null` ❌ (null snapshot)
- Multiple `ydoc.transact()` for one command ❌
- `points: new Float32Array(...)` in Yjs ❌
- Observer that doesn't cleanup ❌
- Publishing faster than 60 FPS ❌

### ✅ Green Flags (Correct Implementation)
- `this.getStrokes()` ✓ (helper method)
- `createEmptySnapshot()` in constructor ✓
- Single `ydoc.transact(() => {...})` ✓
- `points: number[]` in Yjs ✓
- All observers removed in destroy() ✓
- RAF-based publishing ≤60 FPS ✓

---

## Phase 2.4: Snapshot Publishing Validation

### Core Functionality Tests

```bash
# Run these tests after implementation
npm test -- snapshot-publishing
```

#### Test 1: EmptySnapshot Initialization
```typescript
// Verify immediately after construction
const manager = new RoomDocManager('test-room');
assert(manager.currentSnapshot !== null);
assert(manager.currentSnapshot.svKey === 'empty');
```

#### Test 2: Publishing Rate Control
```typescript
// Track publish times
const publishTimes: number[] = [];
manager.subscribeSnapshot(() => {
  publishTimes.push(performance.now());
});

// Trigger rapid updates
for (let i = 0; i < 100; i++) {
  manager.write(createTestCommand());
}

// Verify ≤60 FPS (≥16.67ms between publishes)
for (let i = 1; i < publishTimes.length; i++) {
  const interval = publishTimes[i] - publishTimes[i-1];
  assert(interval >= 16.5); // Allow small tolerance
}
```

#### Test 3: Batch Window Adaptation
```typescript
// Simulate slow publish work
let slowWork = false;
const originalBuildSnapshot = manager.buildSnapshot;
manager.buildSnapshot = function() {
  if (slowWork) {
    // Simulate 10ms of work
    const start = performance.now();
    while (performance.now() - start < 10) { /* busy wait */ }
  }
  return originalBuildSnapshot.call(this);
};

// Enable slow work and verify window expands
slowWork = true;
// ... trigger updates and verify batch window increases
```

#### Test 4: Hidden Tab Optimization
```typescript
// Mock document.hidden
Object.defineProperty(document, 'hidden', {
  value: true,
  writable: true
});

// Verify publishing rate drops to ~8 FPS
const hiddenPublishTimes: number[] = [];
// ... collect times and verify ≥125ms intervals
```

#### Test 5: IndexedDB Cache
```typescript
// Build snapshot with specific content
const snapshot1 = manager.buildSnapshot();

// Destroy and recreate manager
manager.destroy();
const manager2 = new RoomDocManager('test-room');

// If svKey matches, cached snapshot should load
if (snapshot1.svKey === manager2.currentSnapshot.svKey) {
  assert.deepEqual(manager2.currentSnapshot.strokes, snapshot1.strokes);
}
```

### Memory Leak Detection

```typescript
// Monitor memory usage
const initialMemory = performance.memory.usedJSHeapSize;

// Create and destroy many managers
for (let i = 0; i < 100; i++) {
  const m = new RoomDocManager(`room-${i}`);
  // Add some data
  for (let j = 0; j < 10; j++) {
    m.write(createTestCommand());
  }
  m.destroy();
}

// Force GC if available
if (global.gc) global.gc();

// Check memory didn't grow significantly
const finalMemory = performance.memory.usedJSHeapSize;
const growth = finalMemory - initialMemory;
assert(growth < 10 * 1024 * 1024); // Less than 10MB growth
```

---

## Phase 2.5: WriteQueue & CommandBus Validation

### WriteQueue Validation Tests

#### Test 1: Mobile Blocking
```typescript
const queue = new WriteQueue({
  maxPending: 100,
  isMobile: true,
  getCurrentSize: () => 0
});

const result = queue.validate(createDrawCommand());
assert(result.valid === false);
assert(result.reason === 'view_only');
```

#### Test 2: Size Limit Enforcement
```typescript
const queue = new WriteQueue({
  maxPending: 100,
  isMobile: false,
  getCurrentSize: () => 11 * 1024 * 1024 // 11MB
});

const result = queue.validate(createDrawCommand());
assert(result.valid === false);
assert(result.reason === 'read_only');
```

#### Test 3: Idempotency
```typescript
const cmd = createDrawCommand();
queue.enqueue(cmd);
const result = queue.enqueue(cmd); // Same command
assert(result === false); // Rejected as duplicate
```

#### Test 4: Rate Limiting
```typescript
const clearCmd1: ClearBoard = {
  type: 'ClearBoard',
  idempotencyKey: 'clear_1'
};

const clearCmd2: ClearBoard = {
  type: 'ClearBoard',
  idempotencyKey: 'clear_2'
};

queue.enqueue(clearCmd1); // Success
const result = queue.enqueue(clearCmd2); // Too soon
assert(result === false); // Rate limited

// Wait 15 seconds
await sleep(15000);
const result2 = queue.enqueue(clearCmd2);
assert(result2 === true); // Now allowed
```

#### Test 5: Command-Specific Validation
```typescript
// Test stroke point limit
const hugeStroke: DrawStrokeCommit = {
  type: 'DrawStrokeCommit',
  id: 'stroke_1',
  points: new Array(25000).fill(0), // 12,500 points (exceeds 10,000)
  // ... other fields
};

const result = queue.validate(hugeStroke);
assert(result.valid === false);
assert(result.reason === 'invalid_data');
```

### CommandBus Validation Tests

#### Test 1: Single Transaction Execution
```typescript
let transactionCount = 0;
const originalTransact = ydoc.transact;
ydoc.transact = function(fn, origin) {
  transactionCount++;
  return originalTransact.call(this, fn, origin);
};

commandBus.executeCommand(createDrawCommand());
assert(transactionCount === 1); // Exactly one transaction
```

#### Test 2: Command Application
```typescript
// Test stroke addition
const strokeCmd = createDrawCommand();
commandBus.executeCommand(strokeCmd);

const strokes = manager.getStrokes().toArray();
assert(strokes.length === 1);
assert(strokes[0].id === strokeCmd.id);
assert(strokes[0].points === strokeCmd.points); // Same array reference
```

#### Test 3: Budget Enforcement
```typescript
// Add many commands
for (let i = 0; i < 100; i++) {
  queue.enqueue(createDrawCommand());
}

const startTime = performance.now();
await commandBus.processBatch();
const elapsed = performance.now() - startTime;

// Should yield after ~8ms
assert(elapsed < 10); // Didn't process all 100
assert(queue.size() > 0); // Some commands remain
```

#### Test 4: Scene Assignment
```typescript
// Clear board increments scene
const clearCmd: ClearBoard = {
  type: 'ClearBoard',
  idempotencyKey: 'clear_1'
};

const sceneBefore = manager.getCurrentScene();
commandBus.executeCommand(clearCmd);
const sceneAfter = manager.getCurrentScene();

assert(sceneAfter === sceneBefore + 1);

// New strokes get current scene
const strokeCmd = createDrawCommand();
commandBus.executeCommand(strokeCmd);

const stroke = manager.getStrokes().toArray().find(s => s.id === strokeCmd.id);
assert(stroke.scene === sceneAfter);
```

---

## Integration Test Script

```typescript
// Full integration test
async function validatePhase2Integration() {
  console.log('Starting Phase 2.4-2.5 Integration Test...');
  
  // 1. Create manager (Phase 2.1-2.3)
  const manager = RoomDocManagerRegistry.get('test-room');
  assert(manager.currentSnapshot !== null, '✓ EmptySnapshot exists');
  
  // 2. Subscribe to snapshots (Phase 2.4)
  let snapshotCount = 0;
  let lastSnapshot: Snapshot | null = null;
  
  manager.subscribeSnapshot((snap) => {
    snapshotCount++;
    lastSnapshot = snap;
  });
  
  // 3. Write commands (Phase 2.5)
  const strokeCmd: DrawStrokeCommit = {
    type: 'DrawStrokeCommit',
    id: 'stroke_test_1',
    tool: 'pen',
    color: '#000000',
    size: 2,
    opacity: 1,
    points: [0, 0, 10, 10, 20, 20],
    bbox: [0, 0, 20, 20],
    startedAt: Date.now(),
    finishedAt: Date.now(),
    scene: 0
  };
  
  manager.write(strokeCmd);
  
  // 4. Wait for snapshot publish
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // 5. Verify integration
  assert(snapshotCount > 1, '✓ Snapshot published');
  assert(lastSnapshot?.strokes.length === 1, '✓ Stroke in snapshot');
  assert(lastSnapshot?.strokes[0].id === strokeCmd.id, '✓ Correct stroke');
  assert(lastSnapshot?.svKey !== 'empty', '✓ svKey updated');
  
  // 6. Test rate limiting
  const clearCmd: ClearBoard = {
    type: 'ClearBoard',
    idempotencyKey: 'clear_test_1'
  };
  
  manager.write(clearCmd);
  await new Promise(resolve => setTimeout(resolve, 50));
  
  const sceneBefore = lastSnapshot?.scene;
  
  // Try another clear immediately (should be rate limited)
  const clearCmd2: ClearBoard = {
    type: 'ClearBoard',
    idempotencyKey: 'clear_test_2'
  };
  
  manager.write(clearCmd2);
  await new Promise(resolve => setTimeout(resolve, 50));
  
  assert(lastSnapshot?.scene === sceneBefore, '✓ Rate limit enforced');
  
  // 7. Clean up
  manager.destroy();
  assert(!RoomDocManagerRegistry.has('test-room'), '✓ Cleanup complete');
  
  console.log('✅ All integration tests passed!');
}

// Run the test
validatePhase2Integration().catch(console.error);
```

---

## Performance Benchmarks

### Expected Performance Metrics

| Metric | Target | Acceptable | Red Flag |
|--------|--------|------------|----------|
| Snapshot publish rate | 60 FPS | 30-60 FPS | <30 FPS |
| Batch window (normal) | 16ms | 8-32ms | >32ms |
| Command latency (p95) | <50ms | <100ms | >125ms |
| Memory per manager | <5MB | <10MB | >20MB |
| IDB cache write | <10ms | <50ms | >100ms |
| Write validation | <1ms | <5ms | >10ms |

### Benchmark Script

```typescript
async function runPerformanceBenchmark() {
  const results = {
    publishRate: 0,
    commandLatency: [] as number[],
    memoryUsage: 0,
    cacheWriteTime: 0,
  };
  
  // Test publish rate
  const manager = new RoomDocManager('bench-room');
  let publishCount = 0;
  
  manager.subscribeSnapshot(() => publishCount++);
  
  // Generate load
  const startTime = performance.now();
  for (let i = 0; i < 1000; i++) {
    manager.write(createDrawCommand());
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  // Wait for publishing to complete
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const elapsed = performance.now() - startTime;
  results.publishRate = (publishCount / elapsed) * 1000;
  
  // Memory usage
  if (performance.memory) {
    results.memoryUsage = performance.memory.usedJSHeapSize;
  }
  
  console.table(results);
  
  // Verify targets
  assert(results.publishRate >= 30, 'Publish rate too low');
  assert(results.memoryUsage < 20 * 1024 * 1024, 'Memory usage too high');
  
  manager.destroy();
}
```

---

## Common Issues & Solutions

### Issue: Snapshot publishes too frequently
**Symptom**: More than 60 publishes per second
**Solution**: Check RAF loop has proper timing guard

### Issue: Commands not executing
**Symptom**: Write() called but state doesn't change
**Solution**: 
1. Check WriteQueue validation isn't rejecting
2. Verify CommandBus is started
3. Check transaction isn't throwing

### Issue: Memory leak
**Symptom**: Memory grows unbounded
**Solution**:
1. Verify destroy() removes all observers
2. Check RAF loop is cancelled
3. Ensure IDB connections closed

### Issue: svKey changes without updates
**Symptom**: svKey different but no actual changes
**Solution**: Only compute svKey after actual Y.Doc updates

### Issue: Mobile writes not blocked
**Symptom**: Mobile devices can write
**Solution**: Verify detectMobile() logic covers all cases

---

## Sign-off Criteria

Before marking Phase 2.4-2.5 as complete:

### Phase 2.4 ✓
- [ ] Snapshot never null
- [ ] Publishing ≤60 FPS
- [ ] Batch window adapts 8-32ms  
- [ ] Hidden tab reduces to 8 FPS
- [ ] IDB cache works
- [ ] svKey stable when unchanged
- [ ] Memory stable (no leaks)
- [ ] All observers cleaned up

### Phase 2.5 ✓
- [ ] Mobile writes blocked
- [ ] Size limits enforced
- [ ] Idempotency works
- [ ] Rate limits applied
- [ ] Commands execute atomically
- [ ] Queue handles backpressure
- [ ] All command types work
- [ ] Cleanup prevents leaks

### Integration ✓
- [ ] End-to-end flow works
- [ ] Performance targets met
- [ ] No console errors
- [ ] Tests pass
- [ ] Memory profiled
- [ ] Benchmarks acceptable

---

## Quick Debug Commands

```bash
# Run specific test suites
npm test -- snapshot
npm test -- write-queue
npm test -- command-bus

# Memory profiling
npm run test:memory

# Performance benchmark
npm run benchmark:phase2

# Full validation
npm run validate:phase2
```

---

## Phase 2 Completion Confirmation

```
✅ Phase 2.1: TypeScript types defined
✅ Phase 2.2: RoomDocManager foundation  
✅ Phase 2.3: Y.Doc structure initialized
⬜ Phase 2.4: Snapshot publishing system
⬜ Phase 2.5: WriteQueue and CommandBus

When 2.4 and 2.5 are checked, Phase 2 is COMPLETE!
```