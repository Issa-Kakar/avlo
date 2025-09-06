# Scene Clear Fix Test Guide

## What We Fixed

1. **RenderLoop.ts**: Added `lastRenderedScene` tracking to detect scene changes and force full canvas clear
2. **Canvas.tsx**: Removed svKey-based invalidation logic (Phase 6 spec violation) - now always invalidates on snapshot update
3. **types.ts**: Added 'scene-change' and 'snapshot-update' invalidation reasons

## Testing Procedure

### Quick Test
1. Open localhost:3000 in two incognito tabs
2. Draw some strokes
3. Click "Clear Board"
4. **Expected**: Canvas immediately shows blank (no ghost strokes)
5. Draw new strokes
6. **Expected**: Normal drawing (no eraser effect)

### Regression Test (Chaotic Refresh)
1. Draw strokes
2. Clear board
3. Refresh browser
4. Draw more strokes  
5. Clear board
6. Repeat chaotically (refresh between clears, after clears, randomly)
7. **Expected**: Clear always works immediately, never see old strokes

### Console Verification
When you click "Clear Board", you should see in console:
```
[RenderLoop] Scene changed from X to Y - forcing full clear
```

## Key Changes

### Before Fix
- Scene changes only cleared stroke cache, not canvas pixels
- Old pixels remained visible creating "eraser effect"
- svKey was incorrectly used to gate rendering

### After Fix
- Scene changes trigger full canvas clear via `invalidateAll('scene-change')`
- Canvas always shows correct scene immediately
- Snapshot updates always trigger invalidation (Phase 6 compliant)

## How It Works

1. User clicks "Clear Board" → scene tick appended
2. RoomDocManager builds new snapshot with incremented scene
3. Canvas receives snapshot and calls `invalidateAll('snapshot-update')`
4. RenderLoop detects `snapshot.scene !== lastRenderedScene`
5. RenderLoop calls `invalidateAll('scene-change')` forcing full clear
6. Canvas cleared completely before drawing new (empty) scene

## What To Watch For

- No ghost strokes after clear
- No eraser effect when drawing after clear
- Clear works consistently even after multiple refreshes
- Console logs scene changes with full clear message