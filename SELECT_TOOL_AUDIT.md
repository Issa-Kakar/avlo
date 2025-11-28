# SelectTool Comprehensive Audit

**Branch:** `feature/select-tool`
**Audit Date:** 2025-01-27
**Status:** Two critical issues requiring fixes

---

## Table of Contents

1. [Current Architecture Overview](#1-current-architecture-overview)
2. [Issue #1: Gap Click State Machine Bug](#2-issue-1-gap-click-state-machine-bug)
3. [Issue #2: Candidate Selection Priority Bug](#3-issue-2-candidate-selection-priority-bug)
4. [Implementation Plan](#4-implementation-plan)

---

## 1. Current Architecture Overview

### 1.1 File Structure

| File | Purpose |
|------|---------|
| `client/src/lib/tools/SelectTool.ts` | Main tool implementation with state machine |
| `client/src/stores/selection-store.ts` | Zustand store for selection state (non-persisted) |
| `client/src/lib/tools/types.ts` | Type definitions including `SelectionPreview`, `HandleId` |
| `client/src/renderer/layers/objects.ts` | Renders objects with transform preview |
| `client/src/renderer/OverlayRenderLoop.ts` | Renders selection UI (bounds, handles, marquee) |
| `client/src/canvas/Canvas.tsx` | Tool integration and event handling |

### 1.2 State Machine Phases

Current phases in `SelectTool.ts`:

```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';
```

**Current Flow:**
```
pointerdown → phase = 'pendingClick'
             ↓
pointermove (dist > 4px) → branch based on:
    ├── activeHandle !== null → phase = 'scale'
    ├── hitAtDown !== null    → phase = 'translate'
    └── else                  → phase = 'marquee'  ← BUG: Always marquees on empty space even if    inside selected reigon
             ↓
pointerup → commit/finalize based on phase
```

### 1.3 Selection Store State

```typescript
interface SelectionState {
  selectedIds: string[];
  mode: 'none' | 'single' | 'multi';
  transform: TransformState;  // { kind: 'none' | 'translate' | 'scale', ... }
  marquee: MarqueeState;      // { active, anchor, current }
}
```

### 1.4 Hit Testing Architecture

Current `hitTestObjects()` returns a single `HitCandidate`:

```typescript
interface HitCandidate {
  id: string;
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  distance: number;
  insideInterior: boolean;
  area: number;
  isFilled: boolean;
}
```

**Current Priority Logic in `pickBestCandidate()`:**
1. Separate interior vs edge hits → prefer interior if any exist
2. Sort by kind priority: text=0, stroke/connector=1, shape=2
3. Smaller area wins (for nested shapes)
4. Tie-break by ULID (topmost/newest)

---

## 2. Issue #1: Gap Click State Machine Bug

### 2.1 Problem Description

**Current Broken Behavior:**
- Pointer down inside selection bounds but NOT on an object → immediately starts marquee on drag
- No way to drag-translate by clicking the "gap" inside selection bounds
- Gap click DOES deselect currently (via marquee clearing selection or `clearSelection()` on quick tap) - this is correct and should be preserved
- **The specific bug:** Gap DRAG starts marquee instead of translate

**Expected Behavior:**
- Clicking inside selection bounds (on gap) should allow:
  - **Quick tap (<180ms, <4px):** Deselect (clear selection) - KEEP THIS
  - **Drag (>4px OR >180ms):** Translate the entire selection - FIX THIS
- Marquee should NEVER start from inside selection bounds

**Why the time window matters for gap:**
- Without it, we can't distinguish "user wants to deselect" from "user wants to drag"
- Quick tap = intentional deselect
- Longer hold OR movement = drag intent (should translate, not deselect)

### 2.2 Root Cause Analysis

**Location:** `SelectTool.ts`, `begin()` and `move()` methods

**The Bug:** In `begin()`:
```typescript
begin(pointerId, worldX, worldY) {
  // 1. Check handles (OK)
  // 2. Check object hit (OK)
  this.hitAtDown = this.hitTestObjects(worldX, worldY);

  // 3. Always set pendingClick - NO CHECK FOR SELECTION BOUNDS
  this.phase = 'pendingClick';
}
```

Then in `move()`:
```typescript
case 'pendingClick': {
  if (dist > MOVE_THRESHOLD_PX) {
    if (this.activeHandle) { /* scale */ }
    else if (this.hitAtDown) { /* translate */ }
    else {
      // BUG: No check if we're inside selection bounds!
      // Always starts marquee on any empty space drag
      this.phase = 'marquee';
      useSelectionStore.getState().beginMarquee(this.downWorld!);
    }
  }
}
```

**Missing Check:** The code never asks "Is this pointer down inside the current selection bounds?"

### 2.3 Required Fix

**Add `DownTarget` Classification:**

```typescript
type DownTarget =
  | 'none'
  | 'handle'              // Clicked resize handle
  | 'objectInSelection'   // Clicked object that IS selected
  | 'objectOutsideSelection'  // Clicked object that is NOT selected
  | 'selectionGap'        // Empty space INSIDE selection bounds
  | 'background';         // Empty space OUTSIDE selection bounds
```

**New Fields:**
```typescript
private downTarget: DownTarget = 'none';
private downTimeMs: number = 0;
```

**Revised `begin()` Logic:**
```typescript
begin(pointerId, worldX, worldY) {
  this.downTimeMs = performance.now();
  this.downTarget = 'none';

  const store = useSelectionStore.getState();

  // 1. Check handles first (requires selection)
  if (store.selectedIds.length > 0) {
    const handleHit = this.hitTestHandle(worldX, worldY);
    if (handleHit) {
      this.activeHandle = handleHit;
      this.downTarget = 'handle';
      this.phase = 'pendingClick';
      return;
    }
  }

  // 2. Check object hit
  const hit = this.hitTestObjects(worldX, worldY);
  this.hitAtDown = hit;

  if (hit) {
    const isSelected = store.selectedIds.includes(hit.id);
    this.downTarget = isSelected ? 'objectInSelection' : 'objectOutsideSelection';
    this.phase = 'pendingClick';
    return;
  }

  // 3. No object hit - check if inside selection bounds
  const selectionBounds = this.computeSelectionBounds();
  if (selectionBounds && this.pointInWorldRect(worldX, worldY, selectionBounds)) {
    this.downTarget = 'selectionGap';
  } else {
    this.downTarget = 'background';
  }

  this.phase = 'pendingClick';
}
```

**Revised `move()` pendingClick Logic:**
```typescript
case 'pendingClick': {
  const elapsed = performance.now() - this.downTimeMs;
  const passMove = dist > MOVE_THRESHOLD_PX;
  const passTime = elapsed >= CLICK_WINDOW_MS;  // ~180ms

  switch (this.downTarget) {
    case 'handle': {
      if (!passMove) break;
      this.phase = 'scale';
      // ... begin scale
      break;
    }

    case 'objectOutsideSelection': {
      if (!passMove) break;
      // Select this object, then translate
      store.setSelection([this.hitAtDown!.id]);
      this.phase = 'translate';
      // ... begin translate
      break;
    }

    case 'objectInSelection': {
      if (!passMove) break;
      // Keep selection as-is, translate group
      this.phase = 'translate';
      // ... begin translate
      break;
    }

    case 'selectionGap': {
      // NEVER marquee from inside selection!
      if (!passMove && !passTime) break;
      // Drag intent → translate selection
      this.phase = 'translate';
      // ... begin translate
      break;
    }

    case 'background': {
      if (!passMove && !passTime) break;
      // Empty background drag → marquee
      this.phase = 'marquee';
      store.beginMarquee(this.downWorld!);
      break;
    }
  }
  break;
}
```

**Revised `end()` pendingClick Logic:**
```typescript
case 'pendingClick': {
  // Recompute distance and elapsed for gap logic
  let dist = 0;
  let elapsed = performance.now() - this.downTimeMs;
  if (this.downScreen && worldX !== undefined && worldY !== undefined) {
    const view = this.getView();
    const [screenX, screenY] = view.worldToCanvas(worldX, worldY);
    const dx = screenX - this.downScreen[0];
    const dy = screenY - this.downScreen[1];
    dist = Math.sqrt(dx * dx + dy * dy);
  }

  switch (this.downTarget) {
    case 'handle':
      // Clicked handle but didn't drag → no-op
      break;

    case 'objectOutsideSelection':
      // Click → select that object
      store.setSelection([this.hitAtDown!.id]);
      break;

    case 'objectInSelection':
      // Click on already-selected object → "drill down" if multi-select
      if (store.selectedIds.length > 1) {
        store.setSelection([this.hitAtDown!.id]);
      }
      break;

    case 'selectionGap':
      // Quick tap in gap → deselect (PRESERVE current behavior)
      // Long hold or slight movement in gap → keep selection (user was trying to drag)
      if (elapsed < CLICK_WINDOW_MS && dist <= MOVE_THRESHOLD_PX) {
        store.clearSelection();
      }
      // Else: do nothing, selection stays - user held but didn't drag enough
      break;

    case 'background':
    default:
      // Click on background → deselect (PRESERVE current behavior)
      store.clearSelection();
      break;
  }
  break;
}
```

### 2.4 Time Window Usage

The `CLICK_WINDOW_MS` (~180ms) is needed for **ambiguous empty-space clicks only**:

| DownTarget | Uses Time Window? | Reason |
|------------|-------------------|--------|
| `handle` | No | Distance only (4px) |
| `objectOutsideSelection` | No | Distance only |
| `objectInSelection` | No | Distance only |
| `selectionGap` | **Yes** | Distinguish "quick tap deselect" vs "drag intent" |
| `background` | **Yes** | Distinguish "quick tap deselect" vs "marquee intent" |

- either way the `background` marquee intent will deselect immediatley anyway, so not a big difference anyway.
---

## 3. Issue #2: Candidate Selection Priority Bug

### 3.1 Problem Description

**Current Broken Behavior:**
- Shapes ALWAYS win over strokes, even when strokes are visually on top (higher ULID)
- Clicking on a stroke that's drawn ON TOP of a shape → selects the shape underneath!
- This happens because `insideInterior` filtering removes strokes from consideration
- Strokes never have `insideInterior = true`, but shapes do
- The code prefers interior hits, so shapes with interior clicks always beat strokes
- Unfilled shapes allow interior selection, blocking marquee within them

**Expected Behavior:**
- Selection should respect **visual z-order** (what you SEE is what you click)
- Topmost VISIBLE element at cursor should win
- A stroke on top of a shape → clicking the stroke should select the stroke
- A shape on top of a stroke → clicking the shape should select the shape
- Unfilled shape interiors are "transparent" for selection (pass-through to elements behind)
- Special handling for unfilled shapes: traverse down until paint is found

### 3.2 Root Cause Analysis

**Location:** `SelectTool.ts`, `pickBestCandidate()` method

**Current (Wrong) Algorithm:**
```typescript
private pickBestCandidate(candidates: HitCandidate[]): HitCandidate {
  // 1. Separate interior vs edge hits - prefer interior
  const interiorHits = candidates.filter(c => c.insideInterior);
  const pool = interiorHits.length > 0 ? interiorHits : candidates;

  // 2. Sort by kind priority (IGNORES Z-ORDER!)
  pool.sort((a, b) => {
    const kindPriority = (c: HitCandidate) =>
      c.kind === 'text' ? 0 :
      (c.kind === 'stroke' || c.kind === 'connector') ? 1 : 2;

    const kindDiff = kindPriority(a) - kindPriority(b);
    if (kindDiff !== 0) return kindDiff;

    // 3. Smaller area wins
    if (a.area !== b.area) return a.area - b.area;

    // 4. Topmost by ULID (ONLY AS TIE-BREAKER!)
    return b.id.localeCompare(a.id);
  });

  return pool[0];
}
```

**Problems:**
1. **Interior filtering removes strokes entirely:** Strokes NEVER have `insideInterior = true` (they're lines, not regions), but shapes do. When any shape interior hit exists, strokes are filtered OUT.
2. **Z-order is only a tie-breaker:** ULID comparison is the LAST step, not the first. Interior filtering and kind priority override visual z-order.
3. **Result:** Click on a stroke that's on top of a shape → shape's interior hit exists → strokes removed from pool → shape wins. This is completely backwards from visual expectations.

### 3.3 Visual Model

The key insight is distinguishing between:

1. **Frame Interior (Transparent):** Unfilled shape's interior - NOT painted pixels
2. **Paint (Opaque):** Actual drawn pixels
   - Strokes/connectors (always paint)
   - Text (always paint)
   - Shape borders (unfilled shape's stroke line)
   - Filled shape interior (opaque fill)

### 3.4 Required Fix: New `pickBestCandidate()` Algorithm

**Approach:** Scan from topmost (highest ULID) to bottommost, respecting occlusion:

```typescript
private pickBestCandidate(candidates: HitCandidate[]): HitCandidate {
  if (candidates.length === 1) return candidates[0];

  // Sort by Z: ULID descending = newest/topmost first
  const sorted = [...candidates].sort((a, b) =>
    a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  );

  type PaintClass = 'ink' | 'fill';

  // Unfilled shape interior = transparent logical region (not paint)
  const isFrameInterior = (c: HitCandidate): boolean =>
    c.kind === 'shape' && !c.isFilled && c.insideInterior;

  // Everything else that actually paints pixels at this point
  const classifyPaint = (c: HitCandidate): PaintClass | null => {
    if (c.kind === 'stroke' || c.kind === 'connector' || c.kind === 'text') {
      return 'ink';
    }

    if (c.kind === 'shape') {
      if (c.isFilled) {
        return 'fill';  // Filled shape interior or border
      }
      if (!c.isFilled && !c.insideInterior) {
        return 'ink';   // Unfilled shape BORDER (outline stroke)
      }
      return null;      // Unfilled shape interior = transparent
    }

    return 'ink';  // Fallback: treat as paint
  };

  let bestFrame: HitCandidate | null = null;   // Smallest unfilled interior
  let firstPaint: HitCandidate | null = null;  // First visible paint in Z
  let firstPaintClass: PaintClass | null = null;

  // Scan from topmost to bottommost, respecting occlusion
  for (const c of sorted) {
    if (isFrameInterior(c)) {
      // Transparent frame region: remember smallest, keep scanning
      if (!bestFrame || c.area < bestFrame.area) {
        bestFrame = c;
      }
      continue;  // Don't stop - look for paint underneath
    }

    const paintClass = classifyPaint(c);
    if (paintClass !== null) {
      // Found first painted thing - this occludes everything below
      firstPaint = c;
      firstPaintClass = paintClass;
      break;  // Stop scanning
    }
  }

  // Case 1: Only frame interiors, no paint at this pixel
  if (!firstPaint && bestFrame) {
    return bestFrame;  // Return smallest frame (most nested)
  }

  // Case 2: No paint and no frames (shouldn't happen)
  if (!firstPaint) {
    return sorted[0];  // Fallback to topmost
  }

  // Case 3: First painted thing is ink (stroke/text/connector/border)
  // Ink ALWAYS beats frames
  if (firstPaintClass === 'ink') {
    return firstPaint;
  }

  // Case 4: First painted thing is a filled shape interior
  if (!bestFrame) {
    return firstPaint;  // No frames to compare with
  }

  // Case 5: Both filled shape and frame(s) contain the cursor
  // "More enclosed" = smaller region wins
  if (bestFrame.area < firstPaint.area) return bestFrame;
  if (firstPaint.area < bestFrame.area) return firstPaint;

  // Equal areas: tie-break by Z (sorted is topmost-first)
  const idxPaint = sorted.indexOf(firstPaint);
  const idxFrame = sorted.indexOf(bestFrame);
  return idxPaint <= idxFrame ? firstPaint : bestFrame;
}
```

### 3.5 Visual Scenarios

**Scenario 1: Stroke on top of filled shape (THE BUG)**
```
Current (BROKEN):
  Z order: stroke (top, higher ULID), filled shape (bottom)
  Click on stroke location →
    - stroke hit: insideInterior = false
    - shape hit: insideInterior = true
    - interior filter: pool = [shape] (stroke removed!)
    - shape wins (WRONG!)

Fixed:
  Z order: stroke (top), filled shape (bottom)
  Click on stroke → stroke is ink, topmost → stroke wins ✓
```

**Scenario 2: Small (unfilled shape) inside big filled shape**
```
Z order: small unfilled frame (top), big filled card (bottom)
Click inside small frame →
  - small frame is transparent (keep scanning)
  - hit big card's fill (firstPaint)
  - compare areas: small frame < big card → small frame wins
```

**Scenario 3: Nested unfilled frames only**
```
Z order: big frame, medium frame, small frame (all unfilled)
Click inside all → traverse down, update bestFrame to smallest
No paint found → return smallest frame
```

**Scenario 4: Stroke under unfilled frame**
```
Z order: unfilled frame (top), stroke (bottom)
Click at stroke location inside frame →
  - frame is transparent (bestFrame = frame)
  - stroke is ink → ink wins over frame
  - return stroke
```

**Scenario 5: Filled shape on top of stroke**
```
Z order: filled shape (top, higher ULID), stroke (bottom)
Click on shape interior →
  - shape is topmost and is fill paint → stop scanning
  - return shape ✓
```

### 3.6 Interaction with EraserTool Comparison

**Key Difference:** EraserTool uses STRICT fill-awareness:
- Unfilled shapes: ONLY hit near stroke (interior is empty)
- Filled shapes: Hit anywhere inside

**SelectTool is DIFFERENT:**
- Unfilled shapes: Interior IS clickable (to select the frame)
- But unfilled interior doesn't OCCLUDE - we keep scanning for paint
- The `isFilled` flag affects PRIORITY, not hit testing

This is why SelectTool doesn't copy EraserTool's hit testing directly - the selection model is fundamentally different.

---

## 4. Implementation Plan

### 4.1 Changes Required

**File: `SelectTool.ts`**

1. **Add new types and constants:**
   ```typescript
   const CLICK_WINDOW_MS = 180;

   type DownTarget =
     | 'none'
     | 'handle'
     | 'objectInSelection'
     | 'objectOutsideSelection'
     | 'selectionGap'
     | 'background';
   ```

2. **Add new fields:**
   ```typescript
   private downTarget: DownTarget = 'none';
   private downTimeMs: number = 0;
   ```

3. **Update `resetState()`:**
   ```typescript
   private resetState(): void {
     // ... existing resets ...
     this.downTarget = 'none';
     this.downTimeMs = 0;
   }
   ```

4. **Rewrite `begin()` with target classification** (see section 2.3)

5. **Rewrite `move()` pendingClick case with target-aware branching** (see section 2.3)

6. **Rewrite `end()` pendingClick case with target-aware finalization** (see section 2.3)

7. **Replace `pickBestCandidate()` entirely** (see section 3.4)

8. **Add helper `pointInWorldRect()`:** (already exists, verify it's correct)
   ```typescript
   private pointInWorldRect(px: number, py: number, rect: WorldRect): boolean {
     return px >= rect.minX && px <= rect.maxX && py >= rect.minY && py <= rect.maxY;
   }
   ```

### 4.2 No Changes Required

- `selection-store.ts` - Store API is sufficient
- `types.ts` - Types are sufficient
- `Canvas.tsx` - Integration is correct
- `objects.ts` - Transform rendering is correct
- `OverlayRenderLoop.ts` - Selection UI rendering is correct

### 4.3 Testing Checklist

**Gap Click Tests:**
- [ ] Quick tap (<180ms) inside selection gap → should deselect (PRESERVE)
- [ ] Long press (>180ms) inside selection gap then release → should keep selection
- [ ] Drag (>4px) from inside selection gap → should translate selection (FIX)
- [ ] Long press then drag from gap → should translate selection
- [ ] Click outside selection bounds → should deselect
- [ ] Marquee from outside selection → should work
- [ ] Marquee from inside selection → should NEVER work

**Priority Tests:**
- [ ] Click on stroke visually on top of filled shape → stroke wins
- [ ] Click on filled shape visually on top of stroke → shape wins
- [ ] Click inside unfilled frame with stroke underneath → stroke wins
- [ ] Click inside unfilled frame with filled shape underneath → smaller wins
- [ ] Click in nested unfilled frames (no paint) → smallest frame wins
- [ ] Click on shape border (not filled interior) → border hit counts as ink

**Regression Tests:**
- [ ] Single-click selects topmost visible object
- [ ] Marquee selection still works from background
- [ ] Translate transforms work
- [ ] Scale transforms work
- [ ] Handles respond correctly
- [ ] Selection persists through toolbar changes

---

## Summary

### Issue #1 Fix (Gap Click)
- Add `DownTarget` classification in `begin()`
- Check if click is inside selection bounds BEFORE deciding marquee vs translate
- **Preserve:** Quick tap in gap deselects (current behavior is correct)
- **Fix:** Gap drag should translate, not start marquee
- Use time window (`CLICK_WINDOW_MS`) for `selectionGap` to distinguish quick-tap-deselect vs drag-intent
- Never allow marquee from inside selection bounds

### Issue #2 Fix (Priority)
- Replace `pickBestCandidate()` with Z-order aware algorithm
- Scan from topmost (highest ULID) to bottommost, stopping at first paint
- **The key bug:** Current code filters strokes out when any shape interior hit exists
- **The fix:** Z-order is PRIMARY, not a tie-breaker. Topmost paint wins.
- Unfilled shape interiors are transparent (don't stop scanning)
- Ink (stroke/text/connector/border) always beats frame interiors
- Filled shapes vs frames: smaller area wins (more enclosed)

Both fixes are localized to `SelectTool.ts` and don't require changes to other files.
