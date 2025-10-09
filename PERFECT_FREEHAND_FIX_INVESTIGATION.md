# Perfect Freehand Preview-Commit Mismatch Investigation Report

## Executive Summary

The Perfect Freehand implementation has a critical mismatch between preview and committed rendering, particularly visible at sharp corners where the stroke "chips" or loses area after commit. The root cause is a combination of data transformations and simplification that occurs between preview and final render.

## Root Cause Analysis

### 1. Data Flow Discrepancy

**Preview Path:**
```
User draws → pointsPF tuples [[x,y],...] → getStroke(tuples, {last: false}) → render
```

**Commit Path:**
```
User draws → points flat [x,y,...] → Douglas-Peucker simplification → commit to Y.Doc
→ snapshot → flatToPairs conversion → getStroke(converted, {last: true}) → render
```

### 2. Critical Issues Identified

#### Issue 1: Douglas-Peucker Simplification (PRIMARY CULPRIT)
- **Location:** `/client/src/lib/tools/DrawingTool.ts:383`
- **Problem:** Simplification removes points at corners, changing "weight distribution"
- **Impact:** Sharp corners lose area, curves become less smooth
- **Evidence:**
  ```typescript
  // Line 383 in DrawingTool.ts
  const { points: simplified } = simplifyStroke(this.state.points, this.state.config.tool);
  ```

#### Issue 2: Data Type Conversion
- **Location:** `/client/src/renderer/stroke-builder/path-builder.ts:114`
- **Problem:** Converting flat→tuples creates new arrays with potential precision differences
- **Impact:** Small numerical differences magnified at corners
- **Evidence:**
  ```typescript
  // Line 114 in path-builder.ts
  const outline = getStroke(flatToPairs(stroke.points), {
    ...PF_OPTIONS_BASE,
    size,
    last: true, // Different from preview!
  });
  ```

#### Issue 3: Last Flag Mismatch
- **Preview:** Uses `last: false` (line 22 in preview.ts)
- **Base Canvas:** Uses `last: true` (line 117 in path-builder.ts)
- **Impact:** Different outline computation for the final point

#### Issue 4: Missing Canonical Data
- **Problem:** Not storing PF-native tuples, forcing reconstruction
- **Impact:** Cannot guarantee identical input between preview and commit

### 3. Why Corners Magnify the Issue

Perfect Freehand calculates outline by offsetting perpendicular to the stroke direction. At corners:
- Small changes in input points drastically change normal vectors
- Removed points (via simplification) change corner angle calculation
- The outline "cuts the corner" more aggressively with fewer points

## Current Implementation State

### What's Implemented
✅ `kind: 'freehand' | 'shape'` field in Stroke and StrokeView types
✅ DrawingTool maintains dual arrays (points flat, pointsPF tuples)
✅ Preview uses PF-native tuples directly
✅ Renderer branches on `kind` field
✅ PF config with consistent options

### What's Missing
❌ `pointsTuples` field not stored in Y.Doc
❌ Simplification still runs for freehand strokes
❌ No reuse of canonical tuples between preview and base
❌ No final outline computation for held frame
❌ Canvas invalidation doesn't handle style-only changes

## Proposed Solution

### Phase 1: Disable Simplification for Freehand (IMMEDIATE FIX)

**File:** `/client/src/lib/tools/DrawingTool.ts`

**Change commitStroke method (around line 383):**
```typescript
// BEFORE:
const { points: simplified } = simplifyStroke(this.state.points, this.state.config.tool);

// AFTER:
const isFreehand = this.state.config.tool === 'pen' || this.state.config.tool === 'highlighter';
const simplified = isFreehand
  ? this.state.points.slice() // No simplification for freehand
  : simplifyStroke(this.state.points, this.state.config.tool).points;
```

### Phase 2: Store Canonical Tuples

**Files to modify:**
1. `/packages/shared/src/types/room.ts` - Add `pointsTuples?: [number, number][]`
2. `/packages/shared/src/types/snapshot.ts` - Add `pointsTuples?: [number, number][] | null`
3. `/client/src/lib/tools/DrawingTool.ts` - Store both arrays in commit
4. `/client/src/lib/room-doc-manager.ts` - Pass through pointsTuples in snapshot
5. `/client/src/renderer/stroke-builder/path-builder.ts` - Prefer pointsTuples over conversion

### Phase 3: Align Preview Final Frame

**Compute final outline once with last:true and reuse:**
1. On pointer-up, compute final outline with canonical tuples
2. Pass this to overlay for held frame
3. Base canvas uses same tuples, produces identical result

### Phase 4: Fix Canvas Invalidation

**File:** `/client/src/canvas/Canvas.tsx`

Add style change detection and selective cache eviction to handle color/opacity changes without rebuilding geometry.

## Implementation Priority

1. **CRITICAL - Disable simplification** (1 hour)
   - Immediate fix for corner chipping
   - Single file change
   - Low risk

2. **HIGH - Store canonical tuples** (2-3 hours)
   - Permanent fix for data consistency
   - Multiple files but straightforward
   - Backward compatible

3. **MEDIUM - Align preview final frame** (1-2 hours)
   - Eliminates flicker on commit
   - Requires preview/overlay coordination

4. **LOW - Canvas invalidation** (1 hour)
   - Performance optimization
   - Not affecting visual quality

## Testing Checklist

### Visual Quality
- [ ] Sharp corners retain their shape after commit
- [ ] No "chipping" at acute angles
- [ ] Preview matches committed stroke exactly
- [ ] No flicker on pointer-up

### Performance
- [ ] No lag during continuous drawing
- [ ] Cache hit rate remains high
- [ ] Memory usage stays reasonable

### Edge Cases
- [ ] Very long strokes (10,000+ points)
- [ ] Rapid drawing with many corners
- [ ] Different zoom levels
- [ ] Mobile devices (view-only)

## Risk Assessment

### Risks
- **Storage increase:** ~2x for freehand strokes (storing tuples + flat)
- **Network bandwidth:** Larger updates without simplification
- **Memory usage:** More points in memory

### Mitigations
- Keep simplification for export/network optimization
- Implement progressive simplification for very long strokes
- Monitor metrics and adjust thresholds

## Rollback Plan

If issues arise:
1. Re-enable simplification (single flag change)
2. Remove pointsTuples from new strokes (backward compatible)
3. Force cache clear to rebuild all geometry

## Conclusion

The mismatch stems from well-intentioned optimizations (simplification, data conversion) that inadvertently change the stroke geometry between preview and commit. The solution preserves the exact input data throughout the pipeline, ensuring pixel-perfect consistency while maintaining backward compatibility.

## Next Steps

1. Implement Phase 1 immediately (disable simplification)
2. Test corner retention thoroughly
3. Implement Phase 2-4 based on results
4. Monitor performance metrics
5. Consider export-time simplification if needed

---

*Investigation completed: [timestamp]*
*Ready for implementation*