# Two-Canvas Rendering Issues Analysis

## Executive Summary

After implementing the two-canvas architecture, several visual artifacts appeared:
1. Visible dirty rectangles during preview drawing
2. Highlighter strokes becoming progressively darker
3. Strange darkening interactions between pen and highlighter in dense areas

Root cause: **Incomplete refactor** with lingering preview code in base canvas, missing composite operation resets, and redundant dirty rect calculations.

## Issues Identified

### ✅ Issue 1: Preview Provider Still Present in Base RenderLoop

**Status**: Confirmed issue

Despite commenting out preview drawing in RenderLoop.ts (lines 364-365), the preview provider infrastructure remains:
- Line 61: `private previewProvider: PreviewProvider | null = null`
- Lines 71-77: `setPreviewProvider()` method still exists
- Line 126: Preview provider cleared on stop

**Impact**: Preview provider mechanism may still trigger dirty rect invalidations on base canvas even though drawing is commented out.

**Solution**: Remove ALL preview-related code from RenderLoop.ts, not just comment out the drawing.

---

### ✅ Issue 2: Missing Composite Operation Reset in Overlay Canvas

**Status**: Confirmed issue

OverlayRenderLoop.ts performs a full clear (line 120) but never explicitly resets `globalCompositeOperation` to `source-over`. Canvas contexts can retain state between frames.

**Impact**:
- If any operation changes composite mode, subsequent frames use wrong blending
- Highlighter strokes (opacity 0.25) accumulate incorrectly, appearing darker
- Progressive darkening in areas with multiple overlapping strokes

**Solution**: Add explicit `ctx.globalCompositeOperation = 'source-over'` after clear in overlay loop.

---

### ✅ Issue 3: Double Inflation of Stroke Bounds

**Status**: Confirmed redundancy

The stroke bounds are being inflated TWICE:
1. `Canvas.tsx` diffBounds(): Inflates by actual `stroke.style.size` (lines 65, 78)
2. `DirtyRectTracker` invalidateCanvasPixels(): Inflates by `MAX_WORLD_LINE_WIDTH` constant (line 101)

**Impact**:
- Dirty rectangles are larger than necessary
- More area cleared/redrawn than needed
- Visual artifacts at rectangle edges

**Solution**: Remove inflation from diffBounds since DirtyRectTracker already handles it.

---

### ✅ Issue 4: Redundant Viewport Area Calculations

**Status**: Confirmed redundancy

Canvas.tsx performs its own "should we do full clear?" check (lines 237-249):
- Calculates if > 50% of viewport would be invalidated
- Checks if > 20 dirty rects

But DirtyRectTracker ALREADY has this logic:
- `checkPromotion()` promotes to full clear if area > 33% (MAX_AREA_RATIO)
- Also checks MAX_RECT_COUNT

**Impact**:
- Duplicate calculations on every frame
- Inconsistent thresholds (50% vs 33%)
- Canvas.tsx bypasses DirtyRectTracker's optimized coalescing

**Solution**: Remove viewport calculations from Canvas.tsx; let DirtyRectTracker handle all promotion logic.

---

### ❌ Non-Issue: DocVersion Check Works Correctly

**Status**: Working as intended

Initially suspected that diffBounds was called on presence-only updates, but the code is correct:
- Lines 229-258: Only runs diffBounds when `docVersion !== lastDocVersion`
- Lines 260-261: Presence-only updates skip straight to overlay update

This is working correctly and not causing issues.

---

## Why Highlighters Get Darker

The darkening effect is caused by a combination of factors:

1. **Accumulation without proper clear**: When using dirty rects, overlapping areas get redrawn without full clear
2. **Missing composite reset**: If composite operation isn't reset to 'source-over', alpha accumulates incorrectly
3. **Double inflation**: Larger dirty rects cause more overlap between "independent" stroke areas
4. **Preview on wrong canvas**: Preview changes trigger base canvas dirty rects, causing unnecessary redraws

When a highlighter stroke (0.25 opacity) gets redrawn multiple times due to dirty rect overlaps, the alpha values accumulate:
- First draw: 0.25 opacity
- Second draw over same area: Results in darker appearance
- Third draw: Even darker

This is especially visible in dense areas where many strokes overlap.

## Recommended Fixes

### 1. Clean up RenderLoop.ts
```typescript
// Remove these lines entirely:
// - Line 61: private previewProvider declaration
// - Lines 71-77: setPreviewProvider method
// - Line 126: preview provider cleanup
// - Any other preview-related code
```

### 2. Fix OverlayRenderLoop.ts
```typescript
private frame() {
    // ... existing code ...

    // Always full clear overlay (cheap for preview + presence)
    stage.clear();

    // CRITICAL: Reset composite operation after clear
    stage.withContext((ctx) => {
        ctx.globalCompositeOperation = 'source-over';
    });

    // ... rest of frame logic ...
}
```

### 3. Remove double inflation in Canvas.tsx
```typescript
// In diffBounds(), remove inflateWorld calls:
if (!prevStroke || !bboxEquals(prevStroke.bbox, stroke.bbox)) {
    // Don't inflate here - DirtyRectTracker will handle it
    dirty.push({
        minX: stroke.bbox[0],
        minY: stroke.bbox[1],
        maxX: stroke.bbox[2],
        maxY: stroke.bbox[3]
    });
}
```

### 4. Simplify Canvas.tsx invalidation logic
```typescript
// Replace lines 233-256 with:
const changedBounds = diffBounds(prevSnapshot, newSnapshot, viewTransformRef.current.scale);
for (const bounds of changedBounds) {
    renderLoopRef.current.invalidateWorld(bounds);
}
// Let DirtyRectTracker handle promotion to full clear
```

## Performance Impact

These fixes will:
- Eliminate visual artifacts and darkening issues
- Reduce unnecessary calculations
- Make dirty rect sizing more accurate
- Improve overall rendering performance

The redundant calculations were causing:
- ~2x bbox inflation (unnecessary clear area)
- Duplicate viewport area calculations per frame
- Extra coordinate transformations

Removing these redundancies should noticeably improve performance, especially with many strokes.