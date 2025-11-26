# Select Tool Implementation Current Planning(subject to changes)


## Part 1: Current Architecture Analysis

### 1.1 Tool Lifecycle (Canvas.tsx:200-350)

Tools are currently managed as React refs inside Canvas.tsx:

```typescript
const toolRef = useRef<DrawingTool | EraserTool | TextTool | PanTool | null>(null);

useEffect(() => {
  // Recreate tool when activeTool or settings change
  if (toolRef.current) {
    toolRef.current.destroy();
  }

  switch (activeTool) {
    case 'pen':
    case 'highlighter':
      toolRef.current = new DrawingTool(roomDoc, settings, ...);
      break;
    // ... etc
  }
}, [activeTool, settings.color, settings.size, ...]);
```

**Problems for SelectTool:**
- Tools are destroyed on any settings change
- SelectTool needs to persist selection across setting changes (to apply those settings to selection!)
- No mechanism for tools to trigger tool switches

### 1.2 Render Pipeline (RenderLoop.ts, layers/objects.ts)

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

## Part 2: Design Goals & Constraints

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
3. (Preferred) work with existing dirty rect optimization
4. Undo/redo must work correctly for transforms 
5. Precise hit testing, object geometry aware 


## Part 3: Proposed Architecture

### 3.1 Selection State Store (NEW) ROUGH SKETCH

Create a **separate transient Zustand store** for selection state:

```typescript
// client/src/stores/selection-store.ts

// interface SelectionState {
// ......
```

**Why separate store?**
- Selection is transient (not persisted to localStorage)
- Decoupled from device-ui-store lifecycle
- Clear separation of concerns
- Can be subscribed to by multiple systems

### SelectTool Needs Planning

```typescript
// client/src/lib/tools/SelectTool.ts

export class SelectTool implements PointerTool {

  // so on, more details below
```

### Post-Commit Tool Switching
- I think its best if we just import the device-ui-store and setActiveTool can be called straight up after commit right?

### 3.3 Modified Render Pipeline

The key change: `drawObjects()` checks selection store for active transforms:

```typescript
// layers/objects.ts (modified)

export function drawObjects(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
  selectionState?: SelectionState  // NEW parameter
): void {
  // ... existing spatial query and sorting ...

  for (const entry of sortedCandidates) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    // Check if this object is being transformed
    const isTransforming = selectionState?.transform &&
                          selectionState.selectedIds.has(entry.id);

    if (isTransforming) {
      // Draw with transform applied
      drawObjectWithTransform(ctx, handle, selectionState.transform);
    } else {
      drawObject(ctx, handle);
    }
  }
}

function drawObjectWithTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: TransformState
): void {
  ctx.save();

  // Apply transform offset
  if (transform.type === 'translate') {
    ctx.translate(transform.dx, transform.dy);
  }
  // etc....

  // Draw using existing logic
  drawObject(ctx, handle);

  ctx.restore();
}
```
**Note**: In future we can do perhaps a zero origin path 2d cache for shapes for reuse during translation. For now we'll focus on iteration.

## **CRITICAL SECTION: Planning more: Design and Implementation Specifics and Questions**
- We have a ton of ways we can setup the Toolbar, Selection Tool, Zustand stores, and Canvas.tsx. We need to figure out the best way possible.

- Here's the nuance: When a tools dependencies are its settings, that means updates obviously will force a change. However, the select tool shouldn't have any settings. It is seperate in that sense, the only tool that needs special handling of "changes" is the select tool.

- The Toolbar, when selecting an object, needs to be context aware. Meaning it'll reconcile object types and their settings, and be reflective of the state, i.e. if differing sizes and colors not show the selected settings, and for specific things like future arrow-head types only popping up when a connector is one of the selected, etc. 
    - We will decide if a contextual menu with select is perhaps a better option
    - The Toolbar is tricky: you'll need to update those specific objects based on what was selected, but at the same time, persist the settings for the future for all objects, mapping out the change to both. 
    - Therefore, when doing a settings change: I don't know the best route. Do we do an updateConfig at all? it should be fine right? (text will be handled differently of course). I actually think the best path is to store all tool settings in Ref, since settings are frozen on pointer down anyway. I think this is clean. The tool switching effect should still depend on ActiveToolof course though. The ONLY case where settings changes need special handling is:
    `activeTool === select && selectedIds.size > 0`. That's it, every other case is just update the store, and tool picks it up on the next gesture. EraserTool, PanTool have no settings, and connectorTool in the future will share similar patterns to drawingTool.I'll talk more in depth about Text-Tool later.

- We need a method for the Tools: they must be able to switch tools themselves. Because: i want to auto switch tools after a shape commit in drawingTool, or future connectors, and TextTool Placement(more on textool later). so we need the device-ui-store to either add a new method or if already existing, find a way to pass it to the tools
    - This means we also need a way for the toolbar itself to be aware of this. I don't know what is best regarding that: is a subscription the best? or does that bleed too much side effects, and its better to just have a seperate method that is better. not sure.
    - We will have the tools add the selected ID to the transient state, and after commit, switch the tool. The canvas.tsx will switch to the select tool and select tool will have the selectedID in its state, we'll do a lookup and render the selection box. This means most likely that when the UI decides to switch to the selectTool, we'll see if there is any IDs in state yet, because if so we can keep the inspector open(since the settings will hide during idle select until selected)

- also: we'll decide whether an inspector menu pattern is easier as well, which is what we have for the base toolbar, or: we can do a specific contextual menu. This will be a mounted overlay, in screen space, that would hide during active transform, wait until settled, and reappear, also with a quick hit test to see whether there's more space to put on the bottom or top of the objects. It could do something like "filter objects" based on kind, so we would never allow global tool swaps like a size change reflecting for text and for a stroke perhaps. The contextual logic on what to show in the inspector would be easier. the select tool can directly talk to it and drive its mounting. however: i don't know the quirks, and whether or not its actually more complex or not if we were to do that. Let me know

**Hit testing**:
- This is going to be really complicated. So, for reference we already have a perfect hit testing algorithm in the eraser tool. the rounded diamond by deafult, and ellipses, needed special handling beyond frame AABB check of course, it needs to be geometry aware. 
- Fills are also critical(see more below). However, its not like a fill should never be selected if empty. We'll keep it simple in most cases except for the edge case listed later(see below). It should be most of the time: when hit testing on initial pointer down, if there is no other object under your pointer when selecting inside of a filled OR non filled shape, the same logic applies: You don't need to select a shape that is non-fill just by the border, you can click anywhere within it. you can drag it instantly. If there are other objects within that non-filled shape, it doesn't matter as long as we do the precise hit test, we'll know exactly if it intersects directly under the cursor or not, and if no, thenThis does mean "no marquee selection within shapes" but its fine. 

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
    - We will have four handles and the corners for uniform scale. we can also do something where the corners scale non uniform so you could go in any direction, but we would probably need a shift key aware that locks the transform as uniform. If its easy then we'll do it, otherwise i don't care to be honest.
    - The same transformation for marquee goes for a single object of course, same translation behaviour, same scale behaviour, **BUT EACH OBJECT WILL HAVE DIFFERENT TYPES OF SCALING. TEXT IN THE FUTURE WILL BEHAVE DIFFERENTLY, AND CONNECTORS WE WILL FIGURE THAT OUT. FOR NOW, WE'RE JUST DOING SHAPES/STROKES SINCE THAT'S ALL WE HAVE**
    
    - **ALSO: CRITICAL NOTE I FORGOT TO PUT ABOVE: WHEN ACTIVELY DRAGGING WITH A TRANSLATION STATE, SHOULD WE RENDER THE SELECTION BOX?? MY IDEA IS THAT WE DON'T DRAW THE BOX DURING TRANSLATION, EITHER WAY ON POINTER UP THE SELECTED IDs STAY SELECTED WHEN THE STATE MACHINE RESETS AFTER COMMIT**

- okay this is getting too tiring. I'll be a bit more vague now that you get the picture
- On pointer up, see the state and commit the transform if there was any. if there wasn't then no op obviously. if you were actively drawing a marquee, we now end the marquee drawing and proceed with the selection state. we keep IDs selected until Blur or esc, but, **we need to make sure the blur isn't affected by the toolbar. it should be fine, but double check. if we have a selected state and the toolbar's color inspector is clicked, that shouldn't count as a "blur" event, that is critical.



### Future Text Tool Behavior

**The Vision:** Text tool is just for placement. Actual editing happens in select mode with Y.Quill.

**Flow:**
```
TextTool.begin() → place marker → switch to select mode
                                        ↓
SelectTool detects text object selected → mount Y.Quill DOM overlay
                                        ↓
User types in Y.Quill (collaborative editing)
                                        ↓
Click elsewhere or Escape → unmount Y.Quill, keep text object
```
So text settings can "update config" in a sense.


A) **What I will IGNORE from your current code and WHY**

1. **“Tool = settings + dependencies” effect in `Canvas`**
   Right now tools are *recreated* whenever drawing settings change because the big `useEffect` depends on `drawingSettings`, `highlighterOpacity`, etc. That design makes a proper SelectTool basically impossible (selection must survive inspector tweaks). I’m throwing that out: tool lifetimes should be keyed **only** by `activeTool`, not by inspector state.

2. **Select-specific state shoved into `device-ui-store`**
   The `select: { enabled: boolean }` in `device-ui-store` is not where selection lives. Selection is transient, session-local, and orthogonal to “what tool is active”. It gets its own non‑persisted store and its own invariants. The device UI store will only care about **which tool** and **what default style** future objects should use.

3. **“Settings passed into constructors” as the main config mechanism**
   `DrawingTool` / `EraserTool` currently receive concrete settings in their constructor. That forces you to re‑instantiate tools whenever settings change. For all pointer tools (including Select) I’ll treat settings as something you **read on `pointerdown` and freeze**, not as constructor dependencies.

4. **Overlay preview as the only way to show interaction state**
   For Eraser, the overlay preview is the main visible artifact. For Select, that won’t be enough: transforms must be WYSIWYG on the base canvas. I’m not going to reuse “overlay-only preview” as the core primitive; instead, overlay will only own *UI chrome* (marquee box, handles, etc.), while the **actual transform** is driven through the base renderer.

5. **Select tool pretending to have settings via the Inspector**
   The current inspector shows size/fill/colors when `activeTool === 'select'`, but it’s wired the same way as “draw tool settings”. I’m discarding that mental model. In select mode the inspector is **not configuring a tool**; it’s issuing “style commands” to selected objects *and* updating global defaults.

6. **Tool‑driven selection state only (no shared store)**
   Any idea where SelectTool keeps all selection state inside its class and no one else can see it is dead on arrival. Canvas, toolbar, and future context menus all need to observe and act on selection. Selection must be a **first‑class store**, not an internal detail of any one tool.

7. **“Select is special so it can skip pointer tool interface”**
   You floated the idea that Select might need a different interface. I’m not taking that path. It fits the PointerTool contract just fine; the issues you’re hitting are lifecycle/config problems, not an interface mismatch.

---

B) **Clean‑room plan**

High level:

* A **transient selection store** (Zustand) is the single source of truth for what’s selected and what transform is in progress.
* The **SelectTool** is “just” a pointer tool that manipulates that store and commits transforms into Yjs.
* **Canvas / RenderLoop** read the selection store to render WYSIWYG transforms on the base canvas.
* The **toolbar inspector** becomes context aware: in select mode it issues “style mutations on selected objects” while still updating global defaults, without recreating any tools.

I’ll break this into pieces.

---

### B1. Selection store (new Zustand store)

**File:** `selection-store.ts` (non‑persisted)

```ts
export type SelectionMode =
  | 'idle'
  | 'single'
  | 'multi'
  | 'marquee'
  | 'transform-translate'
  | 'transform-scale';

export type HandleId = 'inside' | 'nw' | 'ne' | 'se' | 'sw';

export interface TransformState {
  kind: 'translate' | 'scale';
  origin: [number, number];                 // world origin for transform
  initialBounds: [number, number, number, number]; // [x, y, w, h] before transform
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  handle: HandleId | null;
}

export interface SelectionState {
  selectedIds: Set<string>;
  mode: SelectionMode;
  bounds: [number, number, number, number] | null;   // union bbox in world
  marqueeRect: { x1: number; y1: number; x2: number; y2: number } | null;
  transform: TransformState | null;
  pointerId: number | null;
  activeHandle: HandleId | null;
}

export interface SelectionActions {
  setSelection: (ids: string[], bounds: [number, number, number, number] | null) => void;
  clearSelection: () => void;

  // from tools / canvas
  beginMarquee: (pointerId: number, worldAnchor: [number, number]) => void;
  updateMarquee: (worldPoint: [number, number], ids: string[], bounds: [number, number, number, number] | null) => void;
  endMarquee: () => void;

  beginTransform: (
    pointerId: number,
    kind: 'translate' | 'scale',
    handle: HandleId,
    origin: [number, number],
    bounds: [number, number, number, number],
  ) => void;
  updateTransform: (worldPoint: [number, number]) => void; // dx/dy or scaleX/scaleY updated in store
  endTransform: () => void;

  // used by non-select tools after commit
  selectNewObjects: (ids: string[], bounds: [number, number, number, number]) => void;
}

export type SelectionStore = SelectionState & SelectionActions;
```

Create it with `create<SelectionStore>()` and **do not persist** it.

**Invariants:**

* `selectedIds.size === 0` ⇒ `mode === 'idle' | 'marquee'`.
* `transform !== null` ⇒ `mode` is one of the `transform-*` modes.
* `bounds` always describes the **pre‑transform** union bbox of `selectedIds`.
* `marqueeRect` is **world-space**, updated as you drag; we render it in screen space via `view.worldToCanvas`.

Everyone reads selection only through:

```ts
export const useSelectionStore = create<SelectionStore>(/* ... */);

const selectedIds = useSelectionStore(s => s.selectedIds);
```

For tools, you use the non‑hook API:

```ts
import { useSelectionStore } from '@/stores/selection-store';

const selection = useSelectionStore.getState();
useSelectionStore.getState().setSelection([...ids], bounds);
```

---

### B2. SelectTool design & state machine

**Interface:** it stays a `PointerTool`:

```ts
export class SelectTool implements PointerTool {
  constructor(
    room: IRoomDocManager,
    userId: string,
    opts: {
      onInvalidateWorld: (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => void;
      onInvalidateOverlay: () => void;
      getView: () => ViewTransform;
    }
  ) { /* ... */ }
}
```

It maintains *only pointer/gesture-local* state; all durable selection info is in the selection store.

#### Internal phases

Think in terms of these high‑level phases:

* `Idle` – pointer up, selection may or may not exist.
* `HitTestDown` – pointer just went down, we haven’t decided if this is a click, drag, or marquee.
* `MarqueeDrag` – dragging a marquee rect.
* `TransformTranslate` – dragging inside selection.
* `TransformScale` – dragging one of the corner handles.

A concrete sketch:

```ts
type Phase =
  | { kind: 'idle' }
  | { kind: 'hit-test'; pointerId: number; downWorld: [number, number]; lastWorld: [number, number]; targetId: string | null }
  | { kind: 'marquee'; pointerId: number; anchorWorld: [number, number]; lastWorld: [number, number] }
  | { kind: 'transform'; pointerId: number; handle: HandleId; downWorld: [number, number]; lastWorld: [number, number] };

private phase: Phase = { kind: 'idle' };
private initialPerObject: Map<string, any>; // snapshot of frames / points at transform begin
```

#### `begin(pointerId, wx, wy)`

1. Hit test at `(wx, wy)` against `snapshot.spatialIndex`.
2. If candidates exist → **single selection path**.
3. If none → **marquee path**.

**Hit test details:**

* Use RBush query around `(wx, wy)` with a small world radius derived from ~4 px: `radiusWorld = 4 / view.scale`.
* For each candidate, dispatch by `kind`:

  * **shape**: reuse the same geometry tests as Eraser, but treat “inside rect/ellipse/diamond” as a hit even if `fillColor` is missing.
  * **stroke / connector**: nearest point-to-segment distance, threshold tied to width + a couple px.
  * **text**: pointer inside its `frame` rect.

**Priority rule (simplified but visually sane):**

* Filter to “hit” candidates (see above).
* Group by `kind`:

  * Prefer **text** > **shape** > **stroke/connector** – text is usually what people intend    if present; shapes usually feel more like “containers” than strokes.
* Within a group:

  * For shapes: prefer smallest area of `frame` (nested shapes win).
  * For strokes/connectors: smallest hit distance.
* If tie: newest object wins (ULID lexicographically max).

If you get a `targetId`:

* If it’s already in `selectedIds` and the point is **inside the current selection bounds**, treat this as a potential transform (drag).
* Otherwise, set selection to this one id and recompute bounds.

Start in phase `{ kind: 'hit-test', ... }` and defer committing “transform mode” until the pointer actually moves beyond a small threshold (e.g. 3 px in screen space).

If you get **no hit**:

* Call `selectionStore.clearSelection()`.
* Enter phase `{ kind: 'marquee', pointerId, anchorWorld: [wx, wy], lastWorld: [wx, wy] }`.
* `selectionStore.beginMarquee(pointerId, [wx, wy])`.

#### `move(wx, wy)`

Branch on `phase.kind`:

1. **hit-test**:

   * Compute distance from `downWorld` to current `(wx, wy)` in *screen space*: use `getView().worldToCanvas`.
   * If below threshold → do nothing (this is a click‑ish gesture).
   * If above threshold:

     * If `targetId` is non‑null:

       * We are starting a **translate transform**:

         * Snapshot the current selection’s per‑object geometry into `initialPerObject` (frames, points, etc.).
         * Ensure `selectedIds` contains `targetId` (add if necessary and recompute bounds).
         * Determine transform origin for translation: center of selection bounds is fine.
         * Call `selectionStore.beginTransform(pointerId, 'translate', 'inside', origin, bounds)`.
         * Switch to `phase.kind = 'transform'`.
         * Call `onInvalidateWorld` with union of old and new bounds, and `onInvalidateOverlay()`.
     * If `targetId` is null:

       * This should never happen (we wouldn’t be in hit‑test) – treat as marquee fallback.

2. **marquee**:

   * Update `lastWorld`.
   * Compute marquee rect from `anchorWorld` to `lastWorld`.
   * Use RBush to find candidates whose **bbox center** is inside that rect (keeps behavior consistent and cheap).
   * Compute union bounds of those ids.
   * `selectionStore.updateMarquee([ids], bounds)` to keep overlay in sync.
   * `onInvalidateOverlay()` only. Base canvas doesn’t need anything yet because the objects don’t move.

3. **transform**:

   * Update `selectionStore.transform`:

     * For `translate`: compute `dx`, `dy` in world space: `dx = wx - downWorld[0]`, etc.
     * For `scale`: compute scale factors relative to transform origin and handle. (First version: uniform scale from center or from opposite corner, no need for crazy constraints yet.)
   * Compute union of old and new bounds and call `onInvalidateWorld(union)`.
   * `onInvalidateOverlay()` for handles/selection box.

#### `end(wx?, wy?)`

* If in `marquee`:

  * Final marquee rect; recompute ids+bounds;
  * `selectionStore.endMarquee()` (mode becomes `single` or `multi` depending on set size).
  * No Yjs writes.

* If in `hit-test` (never exceeded move threshold):

  * Treat this as a **plain selection click**.
  * If `targetId` is non‑null: `selectionStore.setSelection([targetId], boundsFor(targetId))`.
  * If `targetId` is null: `selectionStore.clearSelection()`.
  * No Yjs writes.

* If in `transform`:

  * Read `selectionStore.transform` and `initialPerObject`.
  * Compute new geometry per object:

    * **translate**: `frame.x += dx`, `frame.y += dy`; all points get `[x+dx,y+dy]`.
    * **scale**: scale around `origin` per axis; shapes scale their frame; strokes/connectors scale their points relative to origin.
  * Perform a single `room.mutate(ydoc => { ... })` that writes back new frames/points.
  * Clear `transform` in store and go back to `mode: 'single' | 'multi'`.
  * Do **not** clear selection.

`cancel()` behaves like `end()` but does **not** commit transforms; it just discards `transform` and reverts to previous selection.

---

### B3. Render pipeline integration (WYSIWYG transforms)

Goal: during drag, objects stay on the **base canvas** and move in place; overlay only draws selection chrome.

**Changes:**

1. **RenderLoop** gets a `getSelectionState` hook:

```ts
renderLoop.start({
  stageRef,
  getView: () => viewTransformRef.current,
  getSnapshot: () => snapshotRef.current,
  getViewport: () => /* existing */,
  getGates: () => roomDoc.getGateStatus(),
  getSelectionState: () => useSelectionStore.getState(), // NEW
  // ...
});
```

2. `drawObjects` gets a `selection` parameter:

```ts
export function drawObjects(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
  selection?: SelectionState
) {
  const transform = selection?.transform;
  const selectedIds = selection?.selectedIds ?? new Set<string>();

  // existing RBush query + ULID sort...

  for (const entry of sortedCandidates) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    const isSelected = selectedIds.has(entry.id);

    if (transform && isSelected && (transform.kind === 'translate' || transform.kind === 'scale')) {
      ctx.save();
      applySelectionTransform(ctx, transform);
      drawObject(ctx, handle);
      ctx.restore();
    } else {
      drawObject(ctx, handle);
    }
  }
}
```

`applySelectionTransform`:

* For **translate**: simple `ctx.translate(dx, dy)` in world units (remember base canvas already has world‑space transform applied).
* For **scale**:

```ts
const [x, y, w, h] = transform.initialBounds;
const [ox, oy] =
  transform.handle === 'inside'
    ? [x + w / 2, y + h / 2]
    : handleCornerToPoint(transform.handle, x, y, w, h);

ctx.translate(ox, oy);
ctx.scale(transform.scaleX, transform.scaleY);
ctx.translate(-ox, -oy);
```

All selected objects share the same transform; that’s fine for standard box scaling.

> Important: because you’re drawing under a clipped dirty rect, you must ensure `onInvalidateWorld` from SelectTool uses a rect that covers both old and new positions (union). The DirtyRectTracker will handle coalescing.

---

### B4. Overlay: selection boxes, handles, marquee

Overlay render loop already has a preview provider pipeline. For SelectTool we use a **selection preview**, but unlike Eraser, we’re okay with returning a preview even when the tool isn’t “active” – selection UI is persistent.

Define a new preview type:

```ts
export interface SelectionPreview {
  kind: 'selection';
  // world-space
  selectionBounds: [number, number, number, number] | null;
  marqueeRect: { x1: number; y1: number; x2: number; y2: number } | null;
  handles: { id: HandleId; x: number; y: number }[];
}
```

`SelectTool.getPreview()` implementation:

* Reads `selection = useSelectionStore.getState()`.
* If `selection.mode === 'idle' && !selection.marqueeRect` → return `null`.
* Else:

  * `selectionBounds` is `selection.bounds` *with transform applied* if `selection.transform` exists.
  * `handles` are the corners of `selectionBounds`.
  * `marqueeRect` is `selection.marqueeRect`.

Overlay renderer adds a `case 'selection'` branch to draw:

* A faint marquee rect (fill) when `marqueeRect` exists.
* A strong selection bbox + four handles when `selectionBounds` is non‑null.

Because preview is provided by the active tool, selection chrome only appears when `activeTool === 'select'`. That matches your “draw → auto switch to select → adjustments” flow.

---

### B5. Toolbar semantics in select mode

Key rule:

> **When `activeTool === 'select'` and `selectedIds.size > 0`, inspector actions mutate the selection; otherwise they only change future defaults.**

Concretely:

* Add a small **selection style command module**:

```ts
// selection-style-commands.ts
export function applyStyleToSelection(
  room: IRoomDocManager,
  changes: { size?: number; color?: string; opacity?: number; fill?: boolean }
) {
  const { selectedIds } = useSelectionStore.getState();
  if (!selectedIds.size) return;

  room.mutate(ydoc => {
    const root = ydoc.getMap('root');
    const objects = root.get('objects') as Y.Map<Y.Map<any>>;

    for (const id of selectedIds) {
      const y = objects.get(id);
      if (!y) continue;

      const kind = y.get('kind') as string;

      // strokes & connectors: width/color/opacity
      if (changes.size != null && (kind === 'stroke' || kind === 'connector')) {
        y.set('width', changes.size);
      }
      if (changes.color != null && (kind === 'stroke' || kind === 'connector' || kind === 'shape' || kind === 'text')) {
        y.set('color', changes.color);
      }
      if (changes.opacity != null && (kind === 'stroke' || kind === 'connector' || kind === 'shape' || kind === 'text')) {
        y.set('opacity', changes.opacity);
      }

      // shapes: fill toggle
      if (changes.fill != null && kind === 'shape') {
        if (changes.fill) {
          // fillColor: derived from stroke color or existing fill
          const strokeColor = changes.color ?? y.get('color');
          y.set('fillColor', computeFillColor(strokeColor));
        } else {
          y.delete('fillColor');
        }
      }
    }
  });
}
```

* In `ToolPanel`, wrap inspector handlers:

  * For size change:

    ```ts
    const { selectedIds } = useSelectionStore();
    const isSelectionActive = activeTool === 'select' && selectedIds.size > 0;

    const handleSizeChange = (size: number) => {
      // always update defaults
      if (activeTool === 'text') setTextSize(size as TextSizePreset);
      else if (activeTool === 'eraser') setEraserSize(size as SizePreset);
      else setDrawingSize(size as SizePreset);

      if (isSelectionActive) {
        applyStyleToSelection(roomDoc, { size });
      }
    };
    ```

  * For color:

    ```ts
    const handleColorChange = (color: string) => {
      setDrawingColor(color);
      if (isSelectionActive) {
        applyStyleToSelection(roomDoc, { color });
      }
    };
    ```

  * For fill toggle:

    ```ts
    const handleFillToggle = () => {
      const next = !drawingSettings.fill;
      setFillEnabled(next);
      if (isSelectionActive) {
        applyStyleToSelection(roomDoc, { fill: next });
      }
    };
    ```

This satisfies:

* SelectTool has **zero settings**; it doesn’t care about inspector.
* Inspector still persists settings for future tools.
* When a selection is active, inspector also acts as “style editor” for selected objects.

---

### B6. Tool switching (auto‑select after commit)

Non‑select tools must be able to:

1. Add new IDs to the selection store.
2. Switch `activeTool` to `'select'`.

Pattern:

* In `DrawingTool.commit()` (after you compute the new ULID):

```ts
const id = newId; // ULID created for stroke/shape
const bbox = computeBBoxFor(kind, yMap); // or from local geometry

useSelectionStore.getState().selectNewObjects([id], bbox);
useDeviceUIStore.getState().setActiveTool('select');
```

`selectNewObjects` is just `setSelection` plus setting `mode` to `'single'`.

The next render tick:

* Canvas sees `activeTool` change from e.g. `'shape'` → `'select'` and instantiates `SelectTool`.
* Selection store already contains the new ID and bounds, so `SelectTool.getPreview()` immediately shows selection chrome on that new object.

Timing concern (“do we select before or after switching tools?”): we do **select first, then switch tools**. That way SelectTool never starts with an empty store.

---

### B7. Does SelectTool follow the pointer tool interface?

Yes, cleanly:

* `canBegin()` – returns false if already tracking a pointer.
* `begin()` – enters `hit-test` or `marquee`.
* `move()` – drives marquee or transform + invalidations.
* `end()` – resolves to click selection, marquee selection, or transform commit.
* `cancel()` – drops marquee or transform.
* `getPreview()` – returns `SelectionPreview` built from selection store.
* `onViewChange()` – recomputes transforms like Eraser does if view changes mid‑gesture (mainly to adjust hit testing and call `onInvalidateOverlay()`).

No bespoke special casing required; the interface is fine once tool lifecycle isn’t tied to inspector settings.

---

C) **Why this plan is robust**

1. **Selection becomes a first‑class concept instead of a side effect of tools.**
   Right now selection is “whatever the tool remembers”. Moving it into a dedicated store gives you:

   * Shared visibility for Canvas, toolbar, future context menus.
   * Single place to centralize selection semantics (clear rules for `mode`, `bounds`, `transform`).
   * Easier debugging: you can literally log the store and understand state.

2. **Decoupling tools from inspector settings fixes the biggest footgun.**
   Tying tool instantiation to drawing settings is what’s making Select impossible: every color/size tweak is a soft reset. Moving to a `getCurrentToolSettings()`‑on‑`pointerdown` model means:

   * SelectTool never gets recreated by inspector tweaks.
   * Drawing tools always capture the settings that existed at gesture start (which is what you want anyway).
   * You can add more inspector controls later with zero impact on tool lifecycle.

3. **WYSIWYG transforms live in the right layer.**
   The base renderer already owns the dirty‑rect pipeline and spatial index. Making it aware of the selection transform:

   * Keeps you within the same performance model (RBush query + partial clears).
   * Avoids “double drawing” the objects on overlay.
   * Lets transforms compose naturally with everything else (zoom/pan, presence, etc.).

4. **SelectTool remains small and composable.**
   It doesn’t own state that other systems need:

   * Only pointer phases and a per‑gesture geometry snapshot.
   * Everything else flows through `selection-store` and `room.mutate`.
     That keeps SelectTool closer in complexity to EraserTool, and pushes cross‑cutting concerns into shared modules.

5. **Toolbar behavior is finally coherent.**
   The rule “in select mode, inspector edits the selection; otherwise it edits defaults” is:

   * Easy to explain to users.
   * Easy to implement (one `isSelectionActive` flag).
   * Scales to fancier features (e.g. arrowheads for connectors) without turning `device-ui-store` into a dumping ground for per‑kind state.

6. **Tool‑driven auto‑selection becomes a trivial pattern.**
   By giving tools permission to:

   * Write to `selection-store`.
   * Call `setActiveTool('select')`.
     You get the “draw → commit → auto select” flows you want for free (shapes, connectors, text placement) without special plumbing in Canvas.

7. **Future extensions slot in naturally.**

   * **Text editing in select mode:** selection store already knows when a text object is selected; a small `useEffect` can mount/unmount the text editor DOM overlay based on `(activeTool === 'select' && selectedIds contains text)`.
   * **Contextual bubble toolbar:** subscribe to selection store, compute anchor from `bounds`, and render a React portal into `editorHostRef`. The core selection/transform logic doesn’t change.

Overall: this is a high‑ceiling change that fixes the nasty lifecycle coupling *once*, instead of layering hacks (“don’t recreate tool if activeTool === 'select' && ...”) that will bite you again when you add more tools.

---

D) **Integration DELTAS (file‑by‑file)**

> I’ll keep this high‑level but explicit enough that you can implement without ambiguity.

1. **New file: `selection-store.ts`**

   * Add the `SelectionState` / `SelectionActions` definitions from B1.
   * Create a non‑persisted Zustand store: `export const useSelectionStore = create<SelectionStore>(...)`.
   * Make sure `selectedIds` is always a `Set<string>` internally; when exposing to React components, you can still select `.selectedIds` and treat it as read‑only. 

2. **Canvas: tool lifecycle + selection feed into RenderLoop**

   In `Canvas.tsx`: 

   * Extend the `PointerTool` union to include `SelectTool`.

   * Add a new branch in the “create appropriate tool based on activeTool” block:

     ```ts
     } else if (activeTool === 'select') {
       tool = new SelectTool(
         roomDoc,
         userId,
         {
           onInvalidateWorld: (bounds) => renderLoopRef.current?.invalidateWorld(bounds),
           onInvalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
           getView: () => viewTransformRef.current,
         }
       );
     }
     ```

   * Change how you read the UI store:

     * Replace the big destructuring `const { activeTool, drawingSettings, ... } = useDeviceUIStore();` with small selectors:

       ```ts
       const activeTool = useDeviceUIStore(s => s.activeTool);
       const shapeVariant = useDeviceUIStore(s => s.shapeVariant);
       const textSize = useDeviceUIStore(s => s.textSize);
       const highlighterOpacity = useDeviceUIStore(s => s.highlighterOpacity);
       const eraserSize = useDeviceUIStore(s => s.eraserSize);
       ```

     * Remove `drawingSettings` from the tool‑creation effect dependencies.

     * Inside the effect, when constructing `DrawingTool` / `TextTool`, **do not** pass frozen settings; instead pass a getter:

       ```ts
       const getCurrentToolSettings = () => useDeviceUIStore.getState().getCurrentToolSettings();

       tool = new DrawingTool(
         roomDoc,
         () => getCurrentToolSettings(),
         activeTool,
         userId,
         // ...existing callbacks
       );
       ```

       `DrawingTool`’s constructor changes from `(room, settings, toolKind, ...)` to `(room, getSettings, toolKind, ...)` and reads `getSettings()` in `begin()`.

   * When starting `RenderLoop`, pass `getSelectionState` through options and into `drawObjects` as in B3.

3. **RenderLoop / objects layer: selection‑aware drawing**

   In your base renderer layer where `drawObjects` lives, add the `selection` parameter and implement `applySelectionTransform` as described in B3. Call it with the `SelectionState` retrieved via the new `getSelectionState` hook in `RenderLoop.tick()`. 

4. **SelectTool implementation**

   New file `SelectTool.ts` alongside `DrawingTool` / `EraserTool`:

   * Use `EraserTool` as a template for:

     * Accessing `room.currentSnapshot`.
     * Using RBush (`snapshot.spatialIndex`) for hit candidates.
     * Reusing shape hit tests (diamond/ellipse/rect) – ideally refactor these into a shared `geometry-hit-test.ts` module that both Eraser and Select import.

   * Implement the pointer phase logic and `getPreview()` exactly along the plan in B2/B4.

   * For invalidation, call:

     * `onInvalidateOverlay()` whenever `selectionStore` state changes in a way that affects overlay.
     * `onInvalidateWorld(bounds)` when transform is in progress, with bounds = union(old, new).

5. **OverlayRenderLoop: handle `SelectionPreview`**

   * Extend the overlay preview union type to include `SelectionPreview`. 
   * In the overlay draw routine, add a new branch:

     * Convert `selectionBounds` / `marqueeRect` from world to canvas coords with `view.worldToCanvas`.
     * Draw marquee rect first if present (low‑alpha fill).
     * Draw selection bbox + handles (stroke + small squares).
---