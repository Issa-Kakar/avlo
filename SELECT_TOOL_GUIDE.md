# SelectTool Implementation Plan

**Branch:** `feature/select-tool`
**Phase:** Core Selection + Transform (no toolbar integration)


## Part 1: Current Architecture Analysis

### Render Pipeline (RenderLoop.ts, layers/objects.ts)

```typescript
// layers/objects.ts:49-68
for (const entry of sortedCandidates) {
  const handle = objectsById.get(entry.id);
  // LOD check
  if (shouldSkipLOD(handle.bbox, viewTransform)) continue;
  drawObject(ctx, handle);  // Reads from handle.y (Y.Map)
}
```

**Key Insight:** The renderer reads directly from Y.Map via `handle.y.get('frame')`, `handle.y.get('color')`, etc. For geomtry changes during transform preview drag, we need to intercept this read and substitute pending transform values.


### 1.4 Dirty Rect Flow

```
Canvas.tsx subscribes → snapshot.dirtyPatch → { rects, evictIds }
                      ↓
           renderLoop.invalidateWorld(bounds)
                      ↓
           DirtyRectTracker accumulates
                      ↓
           getClearInstructions() → clip region for drawObjects()
```

SelectTool transforms need to inject into this flow.

---

### Design Goals & Constraints

### Primary Goals
1. **WYSIWYG Transform Preview**: Objects stay on base canvas during transform, not overlay
2. **Toolbar Integration**: Settings changes apply to selected objects, and persists tool settings change for the objects
3. **Post-Commit Selection**: Shapes/strokes auto-select after commit
4. **Marquee Selection**: Multi-select via drag rectangle
5. **Rapid Iteration**
6. **Context aware toolbar**: The inspector menu, or, a mini bubble toolbar after selecting

### Constraints
1. Objects MUST render on base canvas (overlay has higher z-index)
2. Selection UI (box, handles) can go to overlay
3. work with existing dirty rect optimization
4. Precise hit testing, object geometry aware 

**- This is the behaviour i want(in general)**
First phase
- Pointer down to start select. Hit testing can be done on first pointer down only(not hover/idle). It also needs to be precise. If there is no candidates directly under your cursor on pointer down, start marquee selection state, not single. If, on initial pointer down, there is a candidate at your cursor, and there's multiple: always sort by ID to get the topmost candidate, BUT: THIS IS WHERE FILL MATTERS. IF SELECTING AN OBJECT WITHOUT FILL, WITH OVERLAPPING ANOTHER OBJECT THAT IS INSIDE OF IT AT YOUR EXACT CURSOR POSITION(BOTH INTERSECT PRECISELY), AND THE OBJECT WITHOUT FILL WAS CREATED AFTER, THEN WE SHOULDN'T SELECT THE TOPMOST IN THAT CASE BECAUSE IT WOULD BE VISUALLY WRONG. SO WE WILL UTILIZE THE ERASER TOOLS HIT TESTING LOGIC IN THAT REGARD TO ENSURE WE ARE AWARE OF THAT FILL.
 - HOWEVER, THEN YOU START THINKING: IF THERE'S CANDIDATES THAT ARE BOTH NON FILLED SHAPES, TWO OF THEM? In this case, the precision still applies, whichever the cursor "lies in" for the shape will always win. BUT THEN WHAT IF ONE OBJECT IS FILL AND THE OTHER IS NO FILL(BOTH SHAPES)? : well, i think the precise hit test will cover that. Im getting a headache even thinking about this. but this should be just enough. Point is: we do a precise hit test if there's multiple candidates, that is fill aware. aka: we care about fills for multiple candidates after single  selection yields multiple candidates. the initial pointer down will always be precise initially, and with multiple candidates, be ultra ultra precise with preference to overall visual feel: multiple strokes will tiebreak with z (ulid), if a shapes and strokes in the pointer down, or in general whenever shapes are involved: become fill aware no matter what. then go off everything, etc. distance, see what is most precise. if a filled shape over stroke, then select the shape. if stroke over filled or non filled shape, then select the stroke. if non-filled shape over stroke, select the stroke. not sure how the edges of the shape should work though at that point i don't even care what happens this is making my brain hurt. if no filled shapes for both, see which is more precise with the distance or whatever not sure, it needs to be visually consistent. 
 **Honestly, this is too hard for me to reason about. Don't treat this as canon, but use your own brain on what makes the most sense visually. Override if there's issues, no clue on this tbh**

- So, to recap: On the first part of the state machine, we'll first obviously see if we switched from a tool for the IDs and whether we instantly go to single selected state or not(actually wait, can't we set the state within the selectool state machine perhaps from the DrawingTool? not sure). We'll also be keeping the objects selected after a commit with the selectTool, so we'll know if theres selected IDs throughout the lifecycle of continuous pointer ups and pointer downs.
On initial pointer down-> Precise hit test-> if no candidate, its marquee, if clicking on a candidate: run the check above, if its 1 candidate then you know what is selected already, so now you know to switch the mode to single and draw selection box. The first pointer down is critical: there will never be a marquee selection if your initial pointer down is on a canddiate precisely. and the oppisite applies somewhat: although the single vs marquee selection transform behaviour overall is the same, the rendering is different for the selection boxes and whatnot, so they shouldn't be mixed.

- If marquee selection-> you render the preview in the overlay for marquee selection box behaviour vs if single, you render the selected objects selection box. all done within the first pointer down. Invalidate overlay on every move for either. Not base yet though of course.

- Now the next part: what do we do on pointerMove? Well, since we know from pointerdown exactly what we are dealing with selection wise, we don't need any "double click to select, once to select, another to move", it should also be able to click and drag an object in one fluid motion, since we know what we are dealing with, its simple.
    - If marquee actively drawing: update the hit test reigon, the marquee selection box should work just as similar to the rectangle tool, it needs to draw it in that shape of the rectangle, where the first pointer down is the "anchor" point, and the cursor, wherever you move it, will draw that AABB rectangle. literally the same logic as the rectangle tool but with sharp edges, and be a low opacity super see through fill: not sure if the color should be grey or blue for the area reigon, because it depends: when we move cursor and are in marquee selection, we take the cursor, and hit test with the updated AABB(not overlay yet since we need to see to highlight selected within) we see with a precise geometry hit test with the exact way we render the overlay AABB marquee reigon, AND IT SHOULD BE IN **Screen space** just like the eraser tool's logic. This needs to be perfect WYSIWYG that way. if we hit or not, we update the overlay. If we hit, we should draw the selection box over the marquee reigon. but if there's multiple candidates selected: then the overall selection of the marquee reigon that encompasses all objects selected, draws the box over that, but im unsure if we should draw the selection boxes of each candidate individually as well or instead just stroke the outline blue, i think its easier for selection boxes, but i like the outline idea slightly more, but truthfully doesn't matter so whichever is easier. but we have to differentiate the "already selected AABB union" vs the "actively drawing marquee reigon" In this state clearly, that's why im unsure if we do grey for the actively drawing AABB rect reigon because there's a difference if that makes sense. so do whatever you think is best.
    
    - If single select it easy, you just start the transform and update the selection state store, and invalidate the base renderLoop. we should probably have is dragging or is actively transforming, and also isResizing vs translating, clear, so the base renderer knows exactly what to draw. since you can't do both: if you drag a handle, thats resize, if you click within the selected reigon, you start the translation transform. remember: **we do not commit until pointer up, and if there is a transform applied. so clicking once doesn't commit to the doc. and no commits while you are transforming state**. there's many phases to this complex state machine this is annoying to think about.
    - We will have four handles and the corners for scale. we can also do something where the corners scale uniform, but we would probably need a shift key aware that locks the transform as uniform. If its easy then we'll do it
    - The same transformation for marquee goes for a single object of course, same translation behaviour, same scale behaviour, **BUT EACH OBJECT WILL HAVE DIFFERENT TYPES OF SCALING. TEXT IN THE FUTURE WILL BEHAVE DIFFERENTLY, AND CONNECTORS WE WILL FIGURE THAT OUT. FOR NOW, WE'RE JUST DOING SHAPES/STROKES SINCE THAT'S ALL WE HAVE**

- okay this is getting too tiring. I'll be a bit more vague now that you get the picture
- On pointer up, see the state and commit the transform if there was any. if there wasn't then no op obviously. if you were actively drawing a marquee, we now end the marquee drawing and proceed with the selection state. we keep IDs selected until Blur or esc, but, **we need to make sure the blur isn't affected by the toolbar. it should be fine, but double check. if we have a selected state and the toolbar's color inspector is clicked, that shouldn't count as a "blur" event, that is critical.
---

## Overview

Implement a SelectTool with:
- Geometry-aware, fill-aware hit testing (reuse EraserTool patterns)
- Single-click selection and marquee multi-selection
- Translate and scale transforms with WYSIWYG preview
- Selection store (transient Zustand, non-persisted)
- Base canvas transform rendering (via selection store import in objects.ts)
- Overlay canvas for selection UI (boxes, handles, marquee)

---

## Files to Create

### 1. `client/src/stores/selection-store.ts`

Transient Zustand store (NOT persisted) for selection state.

```typescript
import { create } from 'zustand';

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type TransformKind = 'none' | 'translate' | 'scale';

export interface TranslateTransform {
  kind: 'translate';
  dx: number;
  dy: number;
  originBounds: WorldRect;
}

export interface ScaleTransform {
  kind: 'scale';
  origin: [number, number];
  scaleX: number;
  scaleY: number;
  originBounds: WorldRect;
}

export type TransformState = { kind: 'none' } | TranslateTransform | ScaleTransform;

export interface MarqueeState {
  active: boolean;
  anchor: [number, number] | null;
  current: [number, number] | null;
}

export interface SelectionState {
  selectedIds: string[];
  mode: 'none' | 'single' | 'multi';
  transform: TransformState;
  marquee: MarqueeState;
}

export interface SelectionActions {
  setSelection: (ids: string[]) => void;
  clearSelection: () => void;

  beginTranslate: (originBounds: WorldRect) => void;
  updateTranslate: (dx: number, dy: number) => void;
  beginScale: (originBounds: WorldRect, origin: [number, number]) => void;
  updateScale: (scaleX: number, scaleY: number) => void;
  endTransform: () => void;
  cancelTransform: () => void;

  beginMarquee: (anchor: [number, number]) => void;
  updateMarquee: (current: [number, number]) => void;
  endMarquee: () => void;
  cancelMarquee: () => void;
}

export type SelectionStore = SelectionState & SelectionActions;

export const useSelectionStore = create<SelectionStore>((set) => ({
  // Initial state
  selectedIds: [],
  mode: 'none',
  transform: { kind: 'none' },
  marquee: { active: false, anchor: null, current: null },

  // Actions - implement all methods
  setSelection: (ids) => set({
    selectedIds: ids,
    mode: ids.length === 0 ? 'none' : ids.length === 1 ? 'single' : 'multi',
    transform: { kind: 'none' },
    marquee: { active: false, anchor: null, current: null },
  }),

  clearSelection: () => set({
    selectedIds: [],
    mode: 'none',
    transform: { kind: 'none' },
    marquee: { active: false, anchor: null, current: null },
  }),

  beginTranslate: (originBounds) => set({
    transform: { kind: 'translate', dx: 0, dy: 0, originBounds },
  }),

  updateTranslate: (dx, dy) => set((state) => {
    if (state.transform.kind !== 'translate') return state;
    return { transform: { ...state.transform, dx, dy } };
  }),

  beginScale: (originBounds, origin) => set({
    transform: { kind: 'scale', origin, scaleX: 1, scaleY: 1, originBounds },
  }),

  updateScale: (scaleX, scaleY) => set((state) => {
    if (state.transform.kind !== 'scale') return state;
    return { transform: { ...state.transform, scaleX, scaleY } };
  }),

  endTransform: () => set({ transform: { kind: 'none' } }),
  cancelTransform: () => set({ transform: { kind: 'none' } }),

  beginMarquee: (anchor) => set({
    marquee: { active: true, anchor, current: anchor },
  }),

  updateMarquee: (current) => set((state) => {
    if (!state.marquee.active || !state.marquee.anchor) return state;
    return { marquee: { ...state.marquee, current } };
  }),

  endMarquee: () => set((state) => ({
    marquee: { ...state.marquee, active: false },
  })),

  cancelMarquee: () => set({
    marquee: { active: false, anchor: null, current: null },
  }),
}));
```

---

### 2. `client/src/lib/tools/SelectTool.ts`

Full SelectTool implementation with state machine.

**Implements PointerTool Interface:**
```typescript
interface PointerTool {
  canBegin(): boolean;
  begin(pointerId: number, worldX: number, worldY: number): void;
  move(worldX: number, worldY: number): void;
  end(worldX?: number, worldY?: number): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  destroy(): void;
  onViewChange?(): void;  // Optional: re-validate selection bounds
}
```

**State Machine Phases:**
- `idle` - No active gesture
- `pendingClick` - Pointer down, waiting to determine if click or drag
- `marquee` - Dragging marquee selection box
- `translate` - Dragging selection to translate
- `scale` - Dragging handle to scale

**Key Implementation Details:**

```typescript
import type { IRoomDocManager } from '../room-doc-manager';
import type { ViewTransform } from '@avlo/shared';
import { useSelectionStore, WorldRect } from '@/stores/selection-store';
import * as Y from 'yjs';

type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';
type HandleId = 'nw' | 'ne' | 'se' | 'sw';

const HIT_RADIUS_PX = 6;  // Screen-space hit test radius
const MOVE_THRESHOLD_PX = 4;  // Threshold to distinguish click from drag

interface HitCandidate {
  id: string;
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  distance: number;
  insideInterior: boolean;
  area: number;
  isFilled: boolean;
}

interface SelectToolOpts {
  invalidateWorld: (bounds: WorldRect) => void;
  invalidateOverlay: () => void;
  getView: () => ViewTransform;
}

export class SelectTool {
  private room: IRoomDocManager;
  private invalidateWorld: SelectToolOpts['invalidateWorld'];
  private invalidateOverlay: () => void;
  private getView: () => ViewTransform;

  private phase: Phase = 'idle';
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private lastWorld: [number, number] | null = null;
  private hitAtDown: HitCandidate | null = null;
  private activeHandle: HandleId | null = null;

  // Track previous preview bounds for incremental dirty rect invalidation
  private prevPreviewBounds: WorldRect | null = null;

  constructor(room: IRoomDocManager, opts: SelectToolOpts) {
    this.room = room;
    this.invalidateWorld = opts.invalidateWorld;
    this.invalidateOverlay = opts.invalidateOverlay;
    this.getView = opts.getView;
  }

  // ... implement all PointerTool methods
}
```

**Hit-Testing (Reuse EraserTool Patterns):**
- Copy and adapt: `strokeHitTest`, `diamondHitTest`, `ellipseHitTest`, `rectHitTest`
- Copy utilities: `pointToSegmentDistance`, `circleRectIntersect`, `pointInDiamond`

**Selection Priority (Multiple Candidates):**
1. Prefer objects where cursor is **inside interior**
2. Among interior hits: prefer **text > stroke/connector > shape**
3. Among shapes: prefer **smaller area** (nested shapes win)
4. Tie-breaker: **topmost by ULID** (lexicographically max)

**Fill-Aware Selection:**
- For unfilled shapes: still allow selection by clicking inside (unlike eraser)
- BUT when choosing between overlapping objects:
  - If cursor is inside a filled shape AND also on a stroke: prefer the stroke
  - If cursor is inside an unfilled shape AND another object is precisely at cursor: prefer the other object

**Dirty Rect Invalidation Pattern:**
```typescript
// Track previous bounds for incremental invalidation
private prevPreviewBounds: WorldRect | null = null;

private invalidateTransformPreview(currentBounds: WorldRect): void {
  if (this.prevPreviewBounds) {
    // Union previous and current for minimal dirty rect
    const dirty = this.unionBounds(this.prevPreviewBounds, currentBounds);
    this.invalidateWorld(dirty);
  } else {
    this.invalidateWorld(currentBounds);
  }
  this.prevPreviewBounds = currentBounds;
}
```

---

### 3. `client/src/lib/tools/types.ts` (MODIFY)

Add SelectionPreview to the PreviewData union:

```typescript
export interface SelectionPreview {
  kind: 'selection';
  // Selection bounds in world coords (with transform applied for preview)
  selectionBounds: WorldRect | null;
  // Marquee rect in world coords (anchor to current point)
  marqueeRect: WorldRect | null;
  // Handle positions for resize (world coords)
  handles: { id: HandleId; x: number; y: number }[] | null;
  // Whether currently transforming (to hide handles during drag)
  isTransforming: boolean;
  bbox: null;  // Always null for overlay previews
}

// Update union
export type PreviewData = StrokePreview | EraserPreview | TextPreview | PerfectShapePreview | SelectionPreview;
```

---

### 4. `client/src/renderer/layers/objects.ts` (MODIFY)

Import selection store directly and apply transforms during render:

```typescript
import { useSelectionStore } from '@/stores/selection-store';

export function drawObjects(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Read selection state directly from store
  const selection = useSelectionStore.getState();
  const selectedSet = new Set(selection.selectedIds);
  const transform = selection.transform;

  // ... existing spatial query and sorting ...

  for (const entry of sortedCandidates) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    if (shouldSkipLOD(handle.bbox, viewTransform)) continue;

    const isSelected = selectedSet.has(handle.id);
    const needsTransform = transform.kind !== 'none' && isSelected;

    if (needsTransform) {
      ctx.save();
      applySelectionTransform(ctx, transform);
      drawObject(ctx, handle);
      ctx.restore();
    } else {
      drawObject(ctx, handle);
    }
  }
}

function applySelectionTransform(ctx: CanvasRenderingContext2D, transform: TransformState): void {
  if (transform.kind === 'translate') {
    ctx.translate(transform.dx, transform.dy);
  } else if (transform.kind === 'scale') {
    const [ox, oy] = transform.origin;
    ctx.translate(ox, oy);
    ctx.scale(transform.scaleX, transform.scaleY);
    ctx.translate(-ox, -oy);
  }
}
```

---

### 5. `client/src/renderer/OverlayRenderLoop.ts` (MODIFY)

Add selection preview rendering case:

```typescript
} else if (previewToDraw?.kind === 'selection') {
  // Selection UI (world space for box, screen space for handles)
  ctx.save();
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);

  // Draw marquee box if active (low-alpha fill + dashed stroke)
  if (previewToDraw.marqueeRect) {
    const { minX, minY, maxX, maxY } = previewToDraw.marqueeRect;
    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';  // Light blue
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
    ctx.lineWidth = 1 / view.scale;
    ctx.setLineDash([4 / view.scale, 4 / view.scale]);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.setLineDash([]);
  }

  // Draw selection bounds (solid blue stroke, no handles during drag)
  if (previewToDraw.selectionBounds && !previewToDraw.isTransforming) {
    const { minX, minY, maxX, maxY } = previewToDraw.selectionBounds;
    ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
    ctx.lineWidth = 1.5 / view.scale;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

    // Draw corner handles
    if (previewToDraw.handles) {
      const handleSize = 8 / view.scale;
      ctx.fillStyle = 'white';
      ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
      ctx.lineWidth = 1 / view.scale;

      for (const handle of previewToDraw.handles) {
        ctx.fillRect(
          handle.x - handleSize / 2,
          handle.y - handleSize / 2,
          handleSize,
          handleSize
        );
        ctx.strokeRect(
          handle.x - handleSize / 2,
          handle.y - handleSize / 2,
          handleSize,
          handleSize
        );
      }
    }
  }

  ctx.restore();
}
```

---

### 6. `client/src/canvas/Canvas.tsx` (MODIFY)

**Add SelectTool imports and branch:**

```typescript
import { SelectTool } from '@/lib/tools/SelectTool';
import { useSelectionStore } from '@/stores/selection-store';

// Update PointerTool union (line ~22)
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool | SelectTool;
```

**Add SelectTool creation branch (in tool effect, around line 500):**

```typescript
} else if (activeTool === 'select') {
  tool = new SelectTool(roomDoc, {
    invalidateWorld: (bounds) => renderLoopRef.current?.invalidateWorld(bounds),
    invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
    getView: () => viewTransformRef.current,
  });
}
```

**Add cursor for select tool (in applyCursor function):**

```typescript
// In the cursor logic, add case for 'select'
case 'select':
  cursorStyle = 'default';  // Default arrow cursor
  break;
```

**Add cleanup effect for selection store:**

```typescript
// Clear selection when Canvas unmounts (room change)
useEffect(() => {
  return () => {
    useSelectionStore.getState().clearSelection();
  };
}, []);
```

---

## Implementation Order

### Step 1: Selection Store
1. Create `selection-store.ts` with all state and actions
2. Export types: `WorldRect`, `TransformState`, `SelectionState`, etc.

### Step 2: Preview Types
1. Add `SelectionPreview` interface to `types.ts`
2. Update `PreviewData` union

### Step 3: SelectTool Core
1. Create `SelectTool.ts` skeleton (constructor, empty methods)
2. Implement `canBegin()`, `isActive()`, `getPointerId()`, `destroy()`
3. Add state machine phases type

### Step 4: Hit Testing
1. Copy geometry utilities from EraserTool:
   - `pointToSegmentDistance`
   - `circleRectIntersect`
   - `pointInDiamond`
   - `strokeHitTest`
   - `diamondHitTest`
   - `ellipseHitTest`
   - `rectHitTest`
2. Implement `hitTestObjects()` with priority logic
3. Implement `hitTestHandle()` for resize handles

### Step 5: Selection State Machine
1. Implement `begin()`:
   - Check for handle hit → scale mode
   - Check for object hit → set selection OR translate mode
   - No hit → marquee mode
2. Implement `move()`:
   - pendingClick → determine if drag threshold exceeded
   - marquee → update marquee rect, query objects
   - translate → update dx/dy, invalidate dirty rects
   - scale → compute scale factors, invalidate
3. Implement `end()`:
   - pendingClick → finalize as click (select single object)
   - marquee → finalize selection from marquee query
   - translate/scale → commit to Y.Doc
4. Implement `cancel()`:
   - Reset all state, cancel transform

### Step 6: Transform Commit
1. Implement `commitTranslate()`:
   - For strokes/connectors: offset all points
   - For shapes/text: offset frame x,y
2. Implement `commitScale()`:
   - For strokes/connectors: scale points around origin (NOT width)
   - For shapes/text: scale frame position and dimensions around origin (NOT stroke width)
   - Width/fontSize stays unchanged

### Step 6.5: Shift Key Support for Uniform Scale
1. Track `shiftKey` state in SelectTool
2. Pass keyboard event state to `computeScaleFactors()`
3. When Shift held: `sy = sx` for uniform scaling

### Step 7: Bounds Helpers
1. `computeSelectionBounds()` - union bbox of selected IDs
2. `translateBounds()` - offset a WorldRect
3. `scaleBounds()` - scale a WorldRect around origin
4. `unionBounds()` - union two WorldRects
5. `computeHandles()` - return four corner positions

### Step 8: Preview
1. Implement `getPreview()`:
   - Return `SelectionPreview` with current bounds, marquee, handles
   - Apply current transform to bounds for preview

### Step 9: objects.ts Integration
1. Import `useSelectionStore`
2. Add transform application to `drawObjects()`
3. Test WYSIWYG transform preview

### Step 10: OverlayRenderLoop Integration
1. Add `'selection'` case to preview dispatch
2. Render marquee box (dashed, filled)
3. Render selection bounds (solid stroke)
4. Render handles (filled squares with stroke)

### Step 11: Canvas.tsx Integration
1. Add imports
2. Add SelectTool creation branch
3. Add cursor case
4. Add cleanup effect
5. Update PointerTool type union

### Step 12: Testing & Polish
1. Test single-click selection
2. Test marquee selection
3. Test translate (click-drag on selected)
4. Test scale (drag handles)
5. Test undo/redo
6. Test selection across different object types
7. Verify dirty rect performance

---

## Design Decisions

### Scale Transform Behavior
- **Non-uniform by default**: Dragging corners allows independent X/Y scaling
- **Shift key for uniform**: Hold Shift to maintain aspect ratio (like Figma)
- Requires tracking `shiftKey` state in SelectTool during scale

### Stroke Width on Scale
- **Keep width fixed**: Only geometry (points/frame) changes during scale
- Stroke width stays the same for both strokes and shapes
- This means scaled objects retain their visual stroke weight

### Hit Testing Code
- **Copy utilities into SelectTool**: Faster to implement, simpler
- Can refactor to shared module later if needed
- Copy: `pointToSegmentDistance`, `circleRectIntersect`, `pointInDiamond`, `strokeHitTest`, `diamondHitTest`, `ellipseHitTest`, `rectHitTest`

---

## Critical Implementation Details

### Hit Testing Priority
When multiple candidates are under the cursor:
```
1. Filter to actual hits (geometry test passes)
2. Separate into "inside interior" vs "near edge"
3. If any "inside interior" hits exist, use only those
4. Sort by: kind priority > distance > area > ULID
   - Kind priority: text=0, stroke/connector=1, shape=2
   - Smaller area wins for shapes (nested wins)
   - Higher ULID wins (topmost/newest)
```

### Marquee Selection
- Draw in world space but compute in screen space for WYSIWYG
- Query spatial index with AABB from anchor to current
- Select objects whose bbox center is inside marquee (simple and intuitive)

### Transform Preview (No Selection Box During Drag)
Per user preference: do NOT draw selection box during translation drag.
- `isTransforming` flag in SelectionPreview controls this
- Set `isTransforming = true` during translate/scale phases
- Overlay skips box/handles when `isTransforming = true`

### Dirty Rect Pattern
```typescript
// First move: invalidate origin
this.prevPreviewBounds = originBounds;
this.invalidateWorld(originBounds);

// Subsequent moves: invalidate union(prev, current)
const currentBounds = this.computeTransformedBounds();
const dirty = this.unionBounds(this.prevPreviewBounds, currentBounds);
this.invalidateWorld(dirty);
this.prevPreviewBounds = currentBounds;

// On end: clear prevPreviewBounds
this.prevPreviewBounds = null;
```

### Cursor Styles
- Idle with no selection: `'default'`

- Hovering over corner handle: `'nwse-resize'` / `'nesw-resize'`
- side handle: EW
- During translate: `'default'`
- During scale: appropriate resize cursor

### Shift Key for Uniform Scale
Canvas.tsx already receives keyboard events. Two options:
1. **Simple**: Check `event.shiftKey` in pointerMove and pass to SelectTool
2. **Robust**: Add global keydown/keyup listener in SelectTool

For simplicity, use option 1:
```typescript
// In Canvas.tsx handlePointerMove:
if (activeToolRef.current === 'select') {
  tool.move(worldX, worldY, e.shiftKey);
}

// In SelectTool.move():
move(worldX: number, worldY: number, shiftKey: boolean = false): void {
  this.shiftKey = shiftKey;
  // ... use this.shiftKey in scale factor computation
}
```

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `client/src/stores/selection-store.ts` | CREATE | Transient selection state |
| `client/src/lib/tools/SelectTool.ts` | CREATE | Main tool implementation |
| `client/src/lib/tools/types.ts` | MODIFY | Add SelectionPreview |
| `client/src/renderer/layers/objects.ts` | MODIFY | Apply transform during render |
| `client/src/renderer/OverlayRenderLoop.ts` | MODIFY | Render selection UI |
| `client/src/canvas/Canvas.tsx` | MODIFY | Wire up SelectTool |

---

## Testing Checklist

- [ ] Single-click selects topmost object at cursor
- [ ] Click on empty space clears selection
- [ ] Marquee drag selects multiple objects
- [ ] Drag inside selection translates objects
- [ ] Drag corner handle scales objects uniformly
- [ ] Selection persists after settings changes in toolbar
- [ ] Undo/redo works for transforms
- [ ] Objects render correctly during transform preview
- [ ] Selection clears on room change
- [ ] Hit testing is geometry-aware (shapes, strokes)
- [ ] Hit testing is fill-aware for overlapping objects
- [ ] Dirty rects are minimal (no full clears during drag)

---

## Out of Scope (Future Phases)

These features are NOT included in this phase:

1. **Toolbar Integration** - Inspector applying styles to selection
2. **Auto-select after commit** - DrawingTool switching to select after shape commit
3. **Text editing in select mode** - Mounting Y.Quill for text objects
4. **Contextual menu** - Floating toolbar near selection
5. **Rotation transform** - Only translate and scale for now
6. **Multi-touch gestures** - Desktop only for now
7. **Keyboard shortcuts** - Delete selected, arrow key nudge, etc.
8. **Copy/paste** - Clipboard operations

These will be implemented in subsequent phases once core selection works.
