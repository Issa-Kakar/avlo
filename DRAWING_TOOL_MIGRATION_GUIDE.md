# Drawing Tool Y.Map Migration Guide

## Executive Summary

This document provides a comprehensive guide for migrating the DrawingTool and shape system to fully align with the Y.Map architecture. The migration addresses points storage, bbox calculations, preview-commit consistency, field naming standardization, and rounded rectangle support.

## Critical Issues Identified

### 1. Points Storage Inconsistency
**Problem**: DrawingTool maintains dual storage patterns - flat arrays (`points: number[]`) and tuple arrays (`pointsPF: [number, number][]`). The Y.Map migration expects tuples throughout.

**Current State**:
- `state.points`: Flat array for legacy compatibility
- `state.pointsPF`: Tuple array for Perfect Freehand
- Commit uses tuples but calculateBBox expects flat arrays

**Solution**:
- Eliminate flat arrays entirely
- Use tuple arrays (`[number, number][]`) as the single source of truth
- Update calculateBBox to accept tuples or remove it entirely

### 2. BBox vs Frame Model
**Problem**: DrawingTool calculates bbox manually then converts to frame, but shapes should derive frame directly from geometry.

**Current State**:
```typescript
// Line 534: Shape commit
const bbox = calculateBBox(points, 0);  // Width=0 for shapes?
// Line 558: Convert bbox to frame
shapeMap.set('frame', bbox ? [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]] : [0, 0, 0, 0]);
```

**Solution**:
- Calculate frame directly from shape geometry
- Remove calculateBBox for shapes entirely
- Use computeBBoxFor() from shared/utils/bbox.ts for derived bbox

### 3. Preview-Commit WYSIWYG Mismatch
**Problem**: Preview shapes appear slightly smaller than committed shapes.

**Root Cause Analysis**:
- Preview (perfect-shape-preview.ts): Renders with `ctx.stroke()` using lineWidth
- Committed (object-cache.ts): Creates Path2D from frame, rendered with stroke
- Ellipse center calculation differences between preview and cache

**Solution**:
- Ensure identical geometry calculations between preview and commit
- Account for stroke width inflation consistently
- Verify frame derivation matches across all code paths

### 4. Field Naming Inconsistency
**Problem**: Renderer uses `strokeWidth`/`strokeColor` while migration spec requires `width`/`color`.

**Current State**:
- DrawingTool commits: `strokeColor`, `strokeWidth`
- Renderer reads: `strokeColor`, `strokeWidth`
- Migration spec: Should be `color`, `width`

**Solution**:
- Rename all shape fields to `color` and `width`
- Keep `fillColor` as optional (auto-derive lighter shade when not specified)
- Update renderer and DrawingTool consistently

### 5. Shape Type Standardization
**Problem**: Confusing mapping between snap kinds and shape types.

**Current Mapping**:
- `snap.kind='box'` → `shapeType='rect'`
- `snap.kind='circle'` → `shapeType='ellipse'`
- `snap.kind='rect'` → `shapeType='roundedRect'`
- `snap.kind='ellipseRect'` → `shapeType='ellipse'`

**Solution**:
- Create explicit mapping function
- Standardize on renderer-compatible names
- Remove manual `this.shapeType` assignments

### 6. Rounded Rectangle Support
**Problem**: Default rectangles should be rounded but preview doesn't render them.

**Missing Implementation**:
- perfect-shape-preview.ts lacks rounded rectangle rendering
- object-cache.ts has support but uses hardcoded radius

**Solution**:
- Add rounded rectangle preview rendering
- Use consistent corner radius (20 WU or 10% of min dimension)
- Make 'rect' snap kind produce roundedRect by default

### 7. Stroke Width Inflation in BBox
**Problem**: BBox calculation for shapes doesn't account for stroke width properly.

**Current State** (shared/utils/bbox.ts):
```typescript
case 'shape':
case 'text': {
  const frame = (yMap.get('frame') as [number, number, number, number]) ?? [0, 0, 0, 0];
  return [frame[0], frame[1], frame[0] + frame[2], frame[1] + frame[3]];
}
```

**Solution**:
- Add stroke width inflation for shapes
- Account for strokeWidth/2 padding around frame

## Implementation Plan

### Phase 1: Points Storage Migration
1. **Update DrawingTool state**:
   - Remove `points: number[]` field
   - Rename `pointsPF` to `points: [number, number][]`
   - Update all references

2. **Update calculateBBox**:
   - Accept tuple arrays instead of flat arrays
   - Or remove entirely in favor of frame-based calculations

### Phase 2: Frame Calculation
1. **Create frame calculation functions**:
```typescript
function calculateFrameFromGeometry(
  snapKind: string,
  anchors: any,
  cursor: [number, number]
): [number, number, number, number] {
  // Direct frame calculation without intermediate bbox
}
```

2. **Remove bbox calculation for shapes**:
   - Calculate frame directly in commitPerfectShapeFromPreview
   - Remove calculateBBox calls for shapes

### Phase 3: Field Naming
1. **Update DrawingTool commits**:
   - Change `strokeColor` → `color`
   - Change `strokeWidth` → `width`

2. **Update renderer (objects.ts)**:
   - Change field reads to `color` and `width`
   - Keep backward compatibility during migration

3. **Update object-cache.ts**:
   - Use new field names

### Phase 4: Preview WYSIWYG Fix
1. **Align geometry calculations**:
   - Ensure ellipse center calculation matches
   - Verify rectangle corner calculations
   - Account for stroke width consistently

2. **Add rounded rectangle preview**:
```typescript
// In perfect-shape-preview.ts
if (anchors.kind === 'rect') {
  const { A } = anchors;
  const C = cursor;
  const minX = Math.min(A[0], C[0]);
  const minY = Math.min(A[1], C[1]);
  const width = Math.abs(C[0] - A[0]);
  const height = Math.abs(C[1] - A[1]);
  const radius = Math.min(20, width * 0.1, height * 0.1);

  // Draw rounded rectangle with same method as object-cache
  drawRoundedRect(ctx, minX, minY, width, height, radius);
}
```

### Phase 5: Shape Type Mapping
1. **Create mapping utility**:
```typescript
function getShapeTypeFromSnapKind(snapKind: string): string {
  const mapping = {
    'box': 'rect',           // Hold-detected box → sharp rect
    'circle': 'ellipse',     // Hold-detected circle → ellipse
    'rect': 'roundedRect',   // Tool rect → rounded rect
    'ellipseRect': 'ellipse' // Tool ellipse → ellipse
  };
  return mapping[snapKind] ?? snapKind;
}
```

### Phase 6: BBox Width Inflation
1. **Update computeBBoxFor in shared/utils/bbox.ts**:
```typescript
case 'shape': {
  const frame = (yMap.get('frame') as [number, number, number, number]) ?? [0, 0, 0, 0];
  const strokeWidth = (yMap.get('width') as number) ?? 1;
  const padding = strokeWidth * 0.5 + 1;

  return [
    frame[0] - padding,
    frame[1] - padding,
    frame[0] + frame[2] + padding,
    frame[1] + frame[3] + padding
  ];
}
```

## Testing Checklist

### Points Storage
- [ ] Strokes commit with tuple arrays
- [ ] Preview uses tuple arrays
- [ ] No flat array conversions remain

### Frame Calculation
- [ ] Shapes store correct frame in Y.Map
- [ ] Frame matches visual bounds
- [ ] No bbox intermediate calculation for shapes

### Field Naming
- [ ] Shapes use `color` and `width` fields
- [ ] Renderer reads correct fields
- [ ] Cache builds paths with correct fields

### Preview WYSIWYG
- [ ] Rectangle preview matches committed size exactly
- [ ] Ellipse preview matches committed size exactly
- [ ] Rounded rectangles render correctly in preview
- [ ] Stroke width inflation consistent

### Shape Types
- [ ] Correct shapeType stored for each snap kind
- [ ] Renderer handles all shape types
- [ ] No manual shapeType assignments

### BBox Calculation
- [ ] Shape bbox includes stroke width inflation
- [ ] Dirty rect invalidation works correctly
- [ ] Spatial index queries return correct results

## Migration Risks

### Backward Compatibility
- Existing shapes in Y.Doc use old field names
- Need migration for `strokeColor` → `color`, `strokeWidth` → `width`

### Cache Invalidation
- Changing bbox calculation affects cache eviction
- May need to force full cache clear after migration

### Coordinate Space
- Ensure all calculations remain in world space
- Verify DPR handling not mixed into calculations

## Code Changes Required

### Files to Modify
1. `/client/src/lib/tools/DrawingTool.ts`
   - Remove flat array storage
   - Fix frame calculation
   - Update field names
   - Add shape type mapping

2. `/client/src/renderer/layers/perfect-shape-preview.ts`
   - Add rounded rectangle support
   - Ensure WYSIWYG geometry

3. `/client/src/renderer/layers/objects.ts`
   - Update field names to `color`/`width`

4. `/client/src/renderer/object-cache.ts`
   - Update field names
   - Verify shape geometry

5. `/packages/shared/src/utils/bbox.ts`
   - Add stroke width inflation for shapes

6. `/client/src/lib/tools/simplification.ts`
   - Update calculateBBox to accept tuples
   - Or remove if not needed

## Performance Considerations

### Memory
- Tuple arrays use same memory as flat arrays
- No performance impact from migration

### Cache
- Shape geometry cached by ID
- Width changes should trigger eviction for shapes too

### Rendering
- Path2D construction unchanged
- Preview rendering remains lightweight

## Rollback Plan

If issues arise:
1. Revert field name changes (easiest)
2. Keep dual array storage temporarily
3. Use feature flag for new behavior

## Success Metrics

- Zero preview-commit visual differences
- All shapes render correctly
- No regression in performance
- Clean codebase without workarounds