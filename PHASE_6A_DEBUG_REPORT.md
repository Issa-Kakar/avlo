# Phase 6A Debug Report: svKey Truncation Issue

## Executive Summary

After implementing Phase 6A (IndexedDB persistence), strokes and clears stopped rendering in real-time but would appear after page refresh. Root cause: The svKey deduplication optimization uses only the first 100 bytes of the state vector for comparison, missing local client updates that occur beyond byte 100 in large state vectors.

**Important**: Phase 6A implementation (IndexedDB provider) is correct. The bug is in the pre-existing svKey dedupe logic from Phase 2.

## The Issue Observed

### Symptoms
1. Drawing strokes → No visual update
2. Clear board → No visual update  
3. Refresh page → All strokes and clears suddenly appear correctly
4. Disabling svKey optimization → Strokes render normally again

### Testing Environment
- App.tsx test file with drawing pipeline
- IndexedDB provider attached (Phase 6A implementation)
- Room ID: `test-room-001`
- State vector size after IDB load: ~107KB (1319 bytes encoded)

## Debugging Process

### Phase 1: Initial Hypothesis (Incorrect)
From NEW_PROMPT.MD, suspected premature `lastSvKey` update inside `buildSnapshot()`:
- Theory: lastSvKey updated before publish decision → dedupe always says "no change"
- **Finding: This was NOT the issue** - current code doesn't update lastSvKey in buildSnapshot

### Phase 2: Strategic Logging Added

Added debug logs at critical points:

```typescript
// 1. Y.Doc updates
[DEBUG Y.Doc] Update received! Origin=... Size=...

// 2. RAF loop
[DEBUG RAF] Pre-build: isDirty=... lastSvKey=...
[DEBUG RAF] Post-build: newSvKey=... lastSvKey=...  
[DEBUG RAF] Will publish? ... (svKeyChanged=... presenceDirty=...)

// 3. buildSnapshot
[DEBUG buildSnapshot] Before check: snapshot.svKey=... lastSvKey=...
[DEBUG buildSnapshot] After gate check, lastSvKey still=...

// 4. publishSnapshot
[DEBUG publishSnapshot] Publishing! svKey=... subscribers=... strokes=...

// 5. mutate
[DEBUG mutate] Starting mutation...
[DEBUG mutate] Mutation completed. Update size=...
```

### Phase 3: Root Cause Discovery

Console logs revealed the smoking gun:

```
Initial IDB sync: svKey= wgHa0KH/Dw... (publishes once)
After stroke 1:   svKey= wgHa0KH/Dw... (SAME - no publish!)
After stroke 2:   svKey= wgHa0KH/Dw... (SAME - no publish!)
After clear:      svKey= wgHa0KH/Dw... (SAME - no publish!)
```

**The svKey never changes despite Y.Doc updates!**

### Phase 4: Detailed svKey Analysis

Enhanced logging to examine state vector:

```typescript
[DEBUG svKey] State vector length: 1319 bytes
[DEBUG svKey] Full vector hash: 2092060682 → 2007472041 → 1922883400 (CHANGES!)
[DEBUG svKey] Using first 100 bytes for key (out of 1319)
[DEBUG svKey] First 20 bytes: de 01 da d0 a1 ff 0f... (STAYS SAME)
[DEBUG svKey] Last 20 bytes: 0b 94 8d d0 19 12 82... (STAYS SAME)
[DEBUG svKey] Generated key: 3gHa0KH/Dwu9qrz6Dw7Y... (NEVER CHANGES)
```

## Root Cause: Truncation Blind Spot

The `createSafeStateVectorKey` function:
1. Takes only first 100 bytes of state vector
2. Adds length (doesn't change for clock updates)
3. Adds checksum of last 4 bytes (also doesn't change enough)

With a 1319-byte state vector from IndexedDB containing many historical clients:
- **Local client's entry is beyond byte 100**
- Local edits only update clock for local client
- Those bytes are never seen by the truncated key
- svKey stays identical → dedupe blocks all publishes

## Why Refresh "Fixes" It

On refresh:
1. IDB replays updates from different client/session IDs
2. These affect bytes within the first 100
3. svKey changes from empty → IDB state
4. One publish occurs → content renders

## The Solution: Remove svKey Dedupe

### Why It's Safe to Remove

1. **Minimal Performance Impact**
   - Publishing is local-only (no network)
   - Already building snapshot when dirty
   - Just adds ~180 function calls/sec (60 fps × 3 subscribers)
   - Painting dominates CPU, not dispatch

2. **Active Drawing Already Publishes Every Frame**
   - With 1-20 users drawing, doc is dirty every frame anyway
   - Dedupe saves nothing in active collaboration

3. **Simpler & More Reliable**
   - Removes a complex optimization that can suppress real updates
   - No risk of missing changes due to truncation issues


### What We're Removing
- The svKey comparison that gates publishing


### Changes Required

#### 6. DO NOT CHANGE firstSnapshot gate logic
The firstSnapshot gate opening logic in buildSnapshot (lines 953-967) should remain:
```typescript
// This stays AS-IS - it's not related to the dedupe issue
if (snapshot.svKey !== this.publishState.lastSvKey) {
  if (!this.gates.firstSnapshot && snapshot.svKey !== '') {
    this.openGate('firstSnapshot');
    console.debug('[RoomDocManager] First doc-derived snapshot published');
  }
}
```
This gate logic is about detecting the first non-empty snapshot, NOT about deduplication.
After removing lastSvKey from publishState, this comparison will always be true (comparing to undefined),
which is fine - the gate only opens once anyway due to the `!this.gates.firstSnapshot` check.

#### 7. Clean up debug logs (optional)
Remove all the `[DEBUG ...]` console.log statements we added.

## Test After Fix

1. Draw strokes → Should render immediately
2. Clear board → Should clear immediately
3. No refresh needed
4. Performance should be identical

## Lessons Learned

1. **Truncation for "safety" can break correctness** - The 100-byte limit was meant to avoid stack overflow but created a blind spot
2. **Full hash would have been better** - Hash entire vector, then truncate hash if needed
3. **Premature optimization** - svKey dedupe added complexity for negligible performance gain
4. **Debug systematically** - Strategic logging at each decision point revealed the issue

## References
- Original issue report: Strokes not rendering after Phase 6A
- NEW_PROMPT.MD: Initial (incorrect) hypothesis about premature lastSvKey update
- console_log.md: First evidence of svKey not changing
- update.md: Final proof with full hash comparison