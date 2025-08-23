# Fix 1 Implementation Summary: Batch-Timer-Driven, One-Shot RAF Model

## Overview
Successfully implemented the batch-timer-driven, one-shot requestAnimationFrame model as specified in PHASE2_FIXES.md. This eliminates dual timing mechanisms and prevents self-rescheduling loops.

## Key Implementation Details

### 1. Core Architecture
```
Batch Timer (20ms interval) → Check for work → Schedule ONE rAF → maybePublish() → publish or return
                          ↑                                                              |
                          └──────────────── Next tick ──────────────────────────────────┘
```

### 2. Critical Invariants Enforced

1. **Single Timer Source**: Only the batch timer (`onBatchTimerTick`) can schedule rAF
2. **One-Shot rAF**: At most one rAF pending at any time (`scheduledRaf ∈ {-1, ID}`)
3. **No Self-Rescheduling**: `maybePublish()` is pure w.r.t. scheduling - it either publishes or returns, NEVER schedules
4. **Always-Publish Strategy**: When rAF fires and there's work, always publish (simpler than quiet-time gating)

### 3. Key Components Modified

#### publishState Structure
```typescript
private publishState = {
  isDirty: false,
  lastYUpdateAt: 0,
  lastPublishTime: 0,
  publishWorkMs: 0,
  isHidden: false,
  batchWindow: 20, // Fixed 20ms interval
  pendingUpdates: [], // Ring buffer behavior (max 100)
  lastSvKey: '',
  batchTimerInterval: null, // Continuous timer (not one-shot)
  scheduledRaf: -1,
  forcePublishRequested: false, // For ClearBoard/visibility
}
```

#### Batch Timer (Lines 489-496)
- Runs continuously every 20ms
- Single source of timer creation for publishing

#### onBatchTimerTick (Lines 498-517)
- **ONLY** place that schedules rAF
- Checks `hasWork = isDirty || forcePublishRequested`
- Only schedules if `scheduledRaf === -1`
- Clears `scheduledRaf` BEFORE calling `maybePublish()` (critical for exception safety)

#### handleYDocUpdate (Lines 532-567)
- Only marks `isDirty = true`
- Records `lastYUpdateAt`
- **NO** timer or rAF scheduling
- Implements ring buffer trimming (max 100 entries)

#### maybePublish (Lines 572-606)
- Pure function - no side effects on scheduling
- If no work: returns immediately
- If work exists: publishes snapshot
- **NO** self-rescheduling under any condition
- Implements "Always-Publish on rAF" strategy

#### Visibility Handling (Lines 608-630)
- Sets `forcePublishRequested = true` when tab becomes visible
- No direct timer/rAF scheduling

#### ClearBoard Integration (Lines 917-924)
- Sets `forcePublishRequested = true` after ClearBoard
- Ensures immediate visibility of board clear

#### Test Helper (Lines 420-440)
- `processCommandsImmediate()` no longer bypasses pipeline
- Simulates batch timer → rAF → publish flow synchronously

### 4. What Was Removed

1. **Self-rescheduling in maybePublish**: All `requestAnimationFrame` calls removed
2. **One-shot batch timer**: Replaced with continuous interval
3. **Quiet-time gating**: Simplified to "Always-Publish on rAF"
4. **FPS limiting logic**: Removed complex timing calculations
5. **Direct publishSnapshot calls**: Test helper now goes through pipeline

### 5. Simplifications Made

1. **Fixed batch window**: 20ms (adaptive window disabled for simplicity)
2. **Always-Publish strategy**: Simpler than quiet-time, more predictable
3. **No FPS limiting**: Let browser handle frame pacing naturally
4. **Simple ring buffer**: Array with slice(-100) instead of complex class

## Testing Requirements

### Unit Tests Needed

1. **One-Shot rAF Invariant**
   - Verify only batch timer schedules rAF
   - Verify at most one rAF pending
   - Verify no self-rescheduling from maybePublish

2. **Batch Timer Behavior**
   - Runs every 20ms
   - Only schedules rAF when work exists
   - Doesn't schedule if rAF already pending

3. **Publishing Flow**
   - Updates mark dirty but don't schedule
   - Batch timer picks up dirty flag
   - rAF fires and publishes once

4. **Edge Cases**
   - Exception in maybePublish doesn't break one-shot invariant
   - ClearBoard triggers immediate publish
   - Visibility change triggers immediate publish
   - Ring buffer caps at 100 entries

### Integration Tests Needed

1. **End-to-end flow**: Command → dirty → batch tick → rAF → publish
2. **Multiple updates coalesce**: Many updates in 20ms → one publish
3. **No bypass paths**: processCommandsImmediate uses normal pipeline

### Test Infrastructure Needed

For deterministic testing, the next session should implement:

1. **Clock abstraction**: Injectable clock for `performance.now()`
2. **FrameScheduler abstraction**: Injectable rAF for controlled frame advancement
3. **Test utilities**: `TestClock`, `TestFrameScheduler` as per spec

## Known Limitations

1. **Adaptive batch window disabled**: Would need timer restart logic
2. **No proper ring buffer class**: Using array with slice for simplicity
3. **No Clock/FrameScheduler abstractions yet**: Needed for deterministic tests
4. **Fix 2 not implemented**: Gzip size estimation may hang in Node tests

## Next Steps for Testing

1. Create Clock and FrameScheduler interfaces
2. Implement TestClock and TestFrameScheduler
3. Write unit tests verifying all invariants
4. Write integration tests for the complete flow
5. Consider implementing Fix 2 (gzip) if Node tests hang

## Validation Checklist

✅ Batch timer is the ONLY source of rAF scheduling
✅ No self-rescheduling in maybePublish()
✅ At most one rAF pending at any time
✅ scheduledRaf cleared BEFORE maybePublish() call
✅ Test helper doesn't bypass pipeline
✅ Ring buffer prevents unbounded growth
✅ ClearBoard triggers immediate publish
✅ Visibility change triggers immediate publish
✅ All timer/rAF scheduling removed from handleYDocUpdate

## Code Quality

- Clear invariant documentation in comments
- Consistent naming and structure
- No hidden control flow paths
- Single responsibility per function
- Testable design (though abstractions needed)

This implementation successfully enforces the batch-timer-driven, one-shot rAF model as specified in PHASE2_FIXES.md, eliminating the dual timing mechanisms and self-rescheduling bugs.