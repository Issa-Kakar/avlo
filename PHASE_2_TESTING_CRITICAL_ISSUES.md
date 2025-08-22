# Critical Issues with Phase 2.4 & 2.5 Testing

**ORIGINAL PHASE 2 GUIDE**:
### 2.1 Define TypeScript Types and Interfaces
1. Create shared types file with all data models from Section 4:
   - StrokeId, TextId, SceneIdx type aliases
   - Stroke interface with all required fields
   - TextBlock interface
   - CodeCell and Output interfaces
   - Meta interface with scene_ticks array
2. Define awareness payload structure (ephemeral data)
3. Create device UI state interfaces for localStorage
4. Define command types for WriteQueue pattern
5. Create snapshot interface (immutable view structure)
6. Add validation helper types and guards

### 2.2 Implement RoomDocManager Foundation
1. Create RoomDocManager class skeleton with:
   - Private Y.Doc instance property
   - Private provider references (will be null initially)
   - Current snapshot property (never null - start with EmptySnapshot)
   - Subscription management maps
2. Implement constructor that:
   - Creates Y.Doc with guid matching roomId
   - Initializes EmptySnapshot synchronously
   - Sets up internal event emitters
3. Add destroy method that will handle cleanup (stub for now)
4. Implement subscription methods (return unsubscribe functions):
   - subscribeSnapshot
   - subscribePresence  
   - subscribeRoomStats
5. Create singleton registry to ensure one manager per room

### 2.3 Set Up Yjs Document Structure
1. Initialize Y.Map as document root in RoomDocManager
2. Create Y.Array for strokes with proper typing
3. Create Y.Array for texts
4. Create Y.Map for code cell
5. Create Y.Array for outputs with size enforcement
6. Create Y.Map for meta including scene_ticks array
7. Add helper methods to safely access these structures 2. **Set up proper getters** for Y structures
8. Important: Store arrays as plain number[], never Float32Array in Yjs

### 2.4 Implement Snapshot Publishing System
1. Create snapshot builder that:
   - Reads current Y.Doc state
   - Generates unique svKey from state vector
   - Creates frozen arrays (Object.freeze in development)
   - Builds immutable snapshot object
   - NOTE: `spatialIndex` field is set to `null` in Phase 2.4; it will be populated with RBush data in Phase 3.3
2. Set up requestAnimationFrame loop for publishing:
   - Maximum 60 FPS rate limiting
   - Batch multiple Y updates within single frame
   - Coalesce updates within 8-16ms windows
3. Implement dirty tracking to avoid unnecessary publishes
4. Add logic to detect tab visibility and reduce to 8 FPS when hidden
5. Ensure EmptySnapshot is published immediately on creation
6. Persist **last render Snapshot** in IndexedDB **keyed by Yjs state vector (svKey)**. On boot, if `svKey` matches, render that snapshot immediately while providers connect; otherwise skip.
Note: only add a tiny IndexedDB “render-snapshot cache”, not the full offline Yjs store. The full y-indexeddb provider (which persists the entire Y.Doc for offline use) doesn’t arrive until Phase 5.3. So you’re not blocked: 2.4’s cache is a minimal IDB key/value store used purely to hydrate the first paint while everything else spins up. Key: {roomId, svKey}; include a schema/version field so you can invalidate on shape changes. (Recommended.)
Payload: only the Snapshot fields—no typed arrays inside; typed arrays are built at render time. 
Write policy: write only when svKey changes (i.e., after a publish). (Recommended; matches rAF cadence.)
Read policy: on boot, compute current svKey; return only if equal. Otherwise return null. 
Size/TTL: cap the record size; keep one per room; clear on logout/workspace switch. (Recommended.)
Authority reminders: never use cached Snapshots to make business decisions; UI stats refresh from persist_ack after a real write.

### 2.5 Create WriteQueue and CommandBus
1. Implement WriteQueue class with:
   - Queue data structure with max 100 pending commands
   - Validation method checking room size, mobile status, frame size
   - Backpressure handling when queue exceeds limits
   - Idempotency tracking map
   - CRITICAL: Enforce dual budget constraints:
     * For `DrawStrokeCommit`: reject if estimated encoded update > 128KB (after simplification)
     * For all commands: reject if estimated encoded delta > 2MB (transport cap)
2. Create CommandBus that:
   - Consumes from WriteQueue
   - Wraps each command in single yjs.transact()
   - Applies commands to Y.Doc structures
   - Handles command-specific logic
3. Add command validation for each command type:
   - Size limits (MAX_POINTS_PER_STROKE = 10,000)
   - Content limits (code body ≤ 200KB)
   - Text length limits (500 chars)
4. Implement rate limiting for specific commands (ClearBoard: 1/15s)

**Deliverables:**
- Complete TypeScript type system
- Basic RoomDocManager with subscription system
- Yjs document structure initialized
- Snapshot publishing pipeline
- WriteQueue and CommandBus infrastructure

## Executive Summary

The current Phase 2.4 and 2.5 tests are **FALSE POSITIVES** that completely bypass the actual distributed systems challenges. They use `processCommandsImmediate()` which skips the RAF loop, timing, coalescing, and backpressure mechanisms.

## The Core Problem

### What the Tests Currently Do (WRONG)
```typescript
// This BYPASSES all timing logic
manager.write(cmd);
await manager.processCommandsImmediate(); // <-- Skips RAF, skips batching
expect(snapshot.strokes.length).toBe(1); // <-- False positive!
```

### What Actually Needs Testing
1. **RAF Loop**: Publishing at ≤60 FPS (16.67ms intervals)
2. **Batch Coalescing**: Updates within 8-32ms windows
3. **Adaptive Windows**: Expanding/contracting based on work time
4. **Hidden Tab**: Throttling to 8 FPS
5. **Backpressure**: Queue management at high water marks
6. **Scene Capture**: Causal consistency during concurrent operations
7. **Dual Size Budgets**: 128KB per-stroke AND 2MB per-frame
8. **Rate Limiting**: Under actual timing conditions

## False Positive Tests (Now Skipped)

### phase-2.4-snapshot-publishing.test.ts
- ❌ Uses `processCommandsImmediate()`
- ❌ Doesn't test RAF timing
- ❌ Doesn't test coalescing windows
- ❌ Doesn't test FPS constraints

### phase-2.5-integration.test.ts  
- ❌ Uses `processCommandsImmediate()`
- ❌ Doesn't test async command processing
- ❌ Doesn't test real backpressure
- ❌ Doesn't test batch window timing

## Real Tests (Properly Implemented)

### phase-2.4-raf-timing.test.ts ✅
- Mocks RAF with controlled timing
- Tests actual publish frequency
- Tests batch window coalescing
- Tests hidden tab throttling
- Tests adaptive windows
- Tests memory pressure

### phase-2.5-distributed-systems.test.ts ✅
- Tests dual size budgets (128KB + 2MB)
- Tests scene capture consistency
- Tests idempotency tracking
- Tests rate limiting
- Tests backpressure
- Tests mobile enforcement
- Tests room size transitions

### write-queue.test.ts ✅
- Tests validation logic
- Tests queue operations
- Tests idempotency
- Tests rate limiting

## The Distributed Systems Challenges

### 1. Timing is Everything
- Real systems have race conditions
- Commands arrive out of order
- Updates coalesce unpredictably
- Network delays affect consistency

### 2. Scene Capture (Critical)
```typescript
// User A starts drawing in Scene 0
pointerDown(); // scene = 0 captured
// User B clears board → Scene 1
clearBoard();
// User A completes stroke
pointerUp(); // MUST commit to Scene 0, not 1!
```

### 3. Backpressure Cascade
- Queue fills up → throttle awareness
- Publish takes too long → expand batch window
- Room hits 10MB → clear queue mid-batch
- Mobile detected → reject all writes

### 4. Memory Management
- Snapshots must be immutable
- Old snapshots must be GC-able
- No retained Y.Doc references
- Cleanup on destroy()

## What Needs to Be Done

### 1. Fix RoomDocManager Implementation
The current implementation might have issues with:
- RAF loop not starting correctly
- Batch window not adapting
- svKey not computed correctly
- Memory leaks from retained references

### 2. Run the Real Tests
```bash
# Run the proper RAF timing tests
npm test -- phase-2.4-raf-timing

# Run the distributed systems tests  
npm test -- phase-2.5-distributed-systems

# Run WriteQueue tests
npm test -- write-queue
```

### 3. Debug Failures
The real tests will likely fail because they test actual behavior:
- Timing precision issues
- Race conditions
- Memory leaks
- Incorrect scene handling

### 4. Remove processCommandsImmediate()
This test helper should be removed entirely. It creates false confidence.

## Red Flags in Implementation

1. **If RAF callbacks aren't accumulating** → Loop not starting
2. **If svKey changes without Y.Doc changes** → Encoding bug
3. **If publish happens too fast** → Interval check failing
4. **If coalescing doesn't work** → Batch window not applied
5. **If scene from future accepted** → Validation missing
6. **If mobile can write** → Detection failing
7. **If memory grows unbounded** → References retained

## Conclusion

The tests were giving false confidence. The new tests (`phase-2.4-raf-timing.test.ts` and `phase-2.5-distributed-systems.test.ts`) actually test the distributed systems challenges. These will likely expose real bugs in the implementation that need to be fixed.

**Next Step**: Run the real tests and fix the actual failures they reveal.