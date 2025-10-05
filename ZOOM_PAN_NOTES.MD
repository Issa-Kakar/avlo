
### Key Features to Implement
1. **Wheel zoom-to-cursor**: Zoom anchored at cursor position with smooth animation
2. **MMB pan**: Ephermal pan gesture without changing active tool
6. **Pan tool**: Persistent pan mode selectable from toolbar
7. **Smooth animations**: Exponential approach for buttery-smooth zoom

### Architecture Summary
- **Transform Math**: `canvas = (world - pan) × scale` (pan is in world units)
- **DPR Handling**: Applied only in CanvasStage, transparent to transform logic
- **Event-driven Rendering**: Transform changes auto-invalidate render loops
- **Tool Architecture**: MMB pan is ephermal (not tool-based) to avoid teardown

### What We're Building

- **Wheel zoom-to-cursor**: Smooth zoom anchored at pointer position (~9% per tick)
- **MMB pan (transient)**: Middle-mouse drag pans without changing active tool
- **smooth animation**: Exponential approach for buttery zoom

## Cursor System Architecture

### Fundamental Cursor Invariants (CRITICAL)
**These rules are absolute and must never be violated:**

1. **Tool Cursor Persistence During Zoom**: When zooming (wheel/buttons), the active tool's cursor MUST remain visible:
   - Drawing tools (pen/highlighter): Crosshair stays visible
   - Eraser tool: Ring stays visible
   -**NO MID GESTURE TEARDOWN IF ZOOMING WHILE POINTER DOWN**

2. **Tool Cursor Suppression During MMB Pan**: When MMB panning (transient gesture), the tool cursor MUST be hidden:
   - All tool cursors disappear for the duration of the drag
   - On release, tool cursor returns immediately

3. **Pan Tool Is different then MBB**: When pan tool is selected from toolbar:
   - Shows open hand (pan-idle) when hovering
   - Shows closed hand (pan-active) when dragging
   - This is a persistent mode, not a ephermal gesture

Here’s the plan that’s been working reliably:

# 1) Fix the real foot-gun first

* Make `worldToClient` a **stable** callback (empty deps) that reads the **current** transform from a ref (`viewTransformRef.current`). Your “simple” doc calls this out as the smoking gun: `worldToClient` depended on `viewTransform`, so every pan/zoom recreated the function, which retriggered the “monster” effect, tore down listeners, nuked pointer capture, and killed in-flight gestures.  
* The concrete before/after for stabilizing `worldToClient` is already written; copy that exact change. 

# 2) Keep effects — but split them cleanly

Use **two effects**, not one “monster”:

* **Effect A (mount-once listeners):** depends only on `stageReady` (and canvas existence). Attach `pointerdown/move/up/cancel/lostpointercapture/leave`, `wheel`, and `auxclick` **once** with `{ passive:false }`. All handlers read live data **from refs** (transform, tool, setters, etc.), never from the effect closure. The “simple” plan shows the exact split and even the scaffolding.  
* **Effect B (tool lifecycle):** recreates only when tool/config actually change (`activeTool`, pen/eraser/text settings, etc.). Creates the tool, sets/clears the overlay preview provider, and sets the base OS cursor for that tool; nothing about DOM listeners lives here. 

Keep your **render-loop** `useLayoutEffect`s as-is (base + overlay) — they’re correct and separate from input.  
Also keep the **transform-change effect** that invalidates both loops; it’s the right place to cause a repaint tick when pan/zoom changes. 

# 3) Read live transform & setters from refs inside handlers

Event handlers must **not** close over `viewTransform`, `setScale`, or `setPan`. Store those setters in refs (`setScaleRef`, `setPanRef`), and update them in a layout effect; then handlers call the ref’d setters. Your “simple” checklist explicitly adds this step. 
Guides also emphasize: handlers should always pull `viewTransformRef.current` at use-time, not via deps.  

# 4) MMB pan = transient gesture (no tool switch)

* Check **MMB first** in `pointerdown`. If a tool gesture is already active (`toolRef.current.isActive()`), **ignore** MMB entirely (and `preventDefault()` to suppress OS autoscroll). Otherwise, start an **ephemeral pan**: capture the pointer, compute world-space pan deltas as `-dx/scale, -dy/scale`, and on release restore the cursor implied by the active tool. This pattern avoids Zustand churn and tool teardown.  
* Wheel zoom handler: also a **stable** function that reads the transform from the ref; attach it once. 

# 5) Cursors & overlay invalidation

* Let **OS cursors** do the heavy lifting. For the persistent **Pan tool**, idle is `grab`; dragging is `grabbing`. For **MMB pan override**, force a cursor override during the gesture, but don’t flip the active tool. set cursor override


# 6) What to absolutely **not** do

* Don’t put `viewTransform` in any handler or effect deps that own listeners; that’s what caused mid-gesture teardown before. 
* Don’t bounce Zustand `activeTool` just to enable MMB pan; treat MMB as an **ephemeral input mode**. (If you want a toolbar Pan tool, implement a tiny `PanTool` class and wire it only when selected.) 

---

#  (constraints we should keep)

* **Unified pointer handlers** in `Canvas.tsx` (`pointerdown/move/up/cancel/lostpointercapture/leave`) with `setPointerCapture` and release on end/cancel/lostcapture. Don’t break that pattern.   
* **Overlay invalidation on view changes**: when `pan/zoom` changes, you already call `overlayLoop.invalidateAll()` and poke the base loop. Keep leveraging this for pan; you don’t need a special overlay for panning. 
* **Single branch point to create a tool**; then route all events through a polymorphic surface (don’t branch in handlers). We’ll keep that. 
* **Zustand UI store** carries tools (including `pan` in the tool list) — but it’s device-local UI; we should avoid churning it during MMB. 
* **Transform math** for converting screen deltas to world deltas (for panning): `worldToCanvas`/`canvasToWorld`, with `scale` and `pan` defined. We’ll use `dxWorld = dxScreen / scale`. 

---
**Tool State Management:**
- DrawingTool: `state.isDrawing` tracks gesture
- EraserTool: `state.isErasing` tracks gesture
- TextTool: State machine (idle → placing → editing)

## Current State Analysis

### Canvas.tsx Architecture (current)

**File**: `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`

**Current Structure:**
```typescript
// Lines 1-174: Imports, setup, refs, snapshot subscription
const Canvas = React.forwardRef(() => {
  // Refs
  const baseStageRef, overlayStageRef, editorHostRef
  const toolRef, snapshotRef, viewTransformRef, canvasSizeRef
  const renderLoopRef, overlayLoopRef

  // Transform from context
  const { transform: viewTransform } = useViewTransform();

  // Store refs
  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform; // Keep ref updated
  }, [viewTransform]);

  // Coordinate helpers (PROBLEM: worldToClient has unstable deps)
  const screenToWorld = useCallback(..., []); // ✅ Stable
  const worldToClient = useCallback(..., [viewTransform]); // ❌ UNSTABLE!

  // Render loops initialization (lines 294-437)
  useLayoutEffect(() => { /* base render loop */ }, []);
  useLayoutEffect(() => { /* overlay render loop */ }, [roomDoc]);

  // THE MONSTER EFFECT (lines 443-692) - NEEDS SPLITTING
  useEffect(() => {
    // Tool creation based on activeTool
    // Event listeners (down, move, up, cancel, leave)
    // Cleanup
  }, [
    roomDoc, userId, activeTool, pen, highlighter, eraser, text,
    stageReady,
    screenToWorld,    // ✅ Stable
    worldToClient,    // ❌ UNSTABLE - recreated every pan/zoom!
  ]);

  // Transform change notifier (lines 695-706)
  useEffect(() => {
    // Invalidate loops on transform change
  }, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);
});
```

### The Root Cause of Previous Failure

**Lines 256-270** - The Smoking Gun:
```typescript
const worldToClient = useCallback(
  (worldX: number, worldY: number): [number, number] => {
    // ... implementation ...
  },
  [viewTransform], // ❌ THIS IS THE KILLER
);
```

**Impact Chain:**
1. User scrolls wheel → `viewTransform` updates (new object)
2. `worldToClient` function recreated (new reference)
3. Monster effect sees dependency change → **FULL TEARDOWN**:
   - Releases pointer capture (mid-gesture!)
   - Destroys active tool
   - Clears preview provider
   - Removes all event listeners
4. Effect re-runs, recreates everything
5. **But the gesture is already broken** (pointer capture lost, tool destroyed)

**FIX**: // keep viewTransformRef.current updated elsewhere
const worldToClient = useCallback((wx: number, wy: number): [number, number] => {
  const stage = baseStageRef.current;
  const vt = viewTransformRef.current; // read latest
  if (!stage || !vt) return [wx, wy];
  const [cx, cy] = vt.worldToCanvas(wx, wy);
  const rect = stage.getBounds();
  return [cx + rect.left, cy + rect.top];
}, []); // <-- [] no deps

Then remove worldToClient from Effect B’s deps so it stops tearing things down.
Patch:
Create Effect A (mount-once / input surface): attach pointerdown/move/up/cancel/lostpointercapture/leave and wheel with {passive:false}. Deps: [stageReady] only.

Keep Effect B (tool creation): instantiate tool, set preview provider, initial cursor. Deps: activeTool, tool config, etc. No input listeners here.

Remove pointer listener add/remove from Effect B (currently lines where you attach/remove them)



### ViewTransformContext (Currently Stable)

**File**: `/home/issak/dev/avlo/client/src/canvas/ViewTransformContext.tsx`

```typescript
interface ViewState {
  scale: number;  // 1.0 = 100% zoom
  pan: { x: number; y: number }; // World offset in WORLD UNITS
}

const ViewTransformContext = createContext<{
  viewState: ViewState;
  transform: ViewTransform;
  setScale: (scale: number) => void;      // ✅ Stable (useCallback with empty deps)
  setPan: (pan: Point) => void;           // ✅ Stable (useCallback with empty deps)
  resetView: () => void;
}>(...);

// Transform object (recreated on every state change - expected)
const transform = useMemo<ViewTransform>(
  () => ({
    worldToCanvas: (x, y) => [(x - pan.x) * scale, (y - pan.y) * scale],
    canvasToWorld: (x, y) => [x / scale + pan.x, y / scale + pan.y],
    scale,
    pan,
  }),
  [viewState.scale, viewState.pan]
);
```

**Key Facts:**
- `setScale` and `setPan` are stable (empty deps)
- `transform` object is **intentionally unstable** (recreated on state changes)
- Clamps are applied in setters (MIN_ZOOM=0.01, MAX_ZOOM=5.0, MAX_PAN_DISTANCE=1,000,000)

### Transform Utilities (Already Exists)

**File**: `/home/issak/dev/avlo/client/src/canvas/internal/transforms.ts`

```typescript
// Already implemented:
export function clampScale(scale: number): number;
export function calculateZoomTransform(
  currentScale: number,
  currentPan: Point,
  zoomFactor: number,
  zoomCenter: Point, // Canvas CSS pixels
): { scale: number; pan: Point };

export function getVisibleWorldBounds(...): Bounds;
export function applyViewTransform(ctx, scale, pan): void;
```

**Critical: Transform Math**
```
// Authoritative equations:
worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
canvasToWorld: [x / scale + pan.x, y / scale + pan.y]

// Context transform order (for rendering):
ctx.scale(scale, scale);
ctx.translate(-pan.x, -pan.y);
```

# Design goals

1. **Pan tool UX**

   * Idle cursor = **open hand (`grab`)**
   * Dragging = **closed hand (`grabbing`)**
   * Left-button drag moves the view.

2. **MMB “click to instantly pan gesture, cursor is closed hand”** (ephemeral)

   * Works from *any* tool when only **no other pointer is down**.
   * **Does not** change the active tool in Zustand.
   * Press MMB → capture, cursor shows **`grabbing`**, pan while held → release → snap the cursor back to whatever the base tool wants.

3. **No dimming/preview for pan**

   * Pan has **no overlay preview**; rely on the existing “view changed → overlay invalidates” hook.

4. **Don’t disrupt in-progress gestures**

   * If you’re erasing/drawing with the left button **down**, **ignore MMB** (and suppress browser auto-scroll).

---

# State you’ll add (all *local refs* in `Canvas.tsx`)

```ts
// Tracks a temporary “MMB pan” gesture without touching Zustand
const mmbPanRef = useRef<{
  active: boolean;
  pointerId: number | null;
  lastClient: { x: number; y: number } | null;
}>({ active: false, pointerId: null, lastClient: null });

// Soft cursor override (beats the base tool’s cursor when set)
const cursorOverrideRef = useRef<Cursor | null>(null);
// helper = 'none' | 'crosshair' | 'grab' | 'grabbing'
```

> Why **not** flip Zustand’s `activeTool` to `pan` on MMB down?
> Because your tool-creation effect branches on `activeTool`, recreates the tool, swaps the overlay preview provider, etc. That’s noisy and can tear during gestures. An **ephemeral override** in `Canvas.tsx` avoids that churn while keeping your “branch once” invariant.  

---

# Cursor policy (single function, layered priorities)

```ts
const applyCursor = useCallback(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas) return;

  // 1) Explicit override (MMB pan dragging, etc.)
  if (cursorOverrideRef.current) {
    canvas.style.cursor = cursorOverrideRef.current;
    return;
  }

  // 2) Tool-based default
  switch (activeTool) {
    case 'eraser':
      canvas.style.cursor = 'none';        // You already do this
      break;
    case 'pan':
      canvas.style.cursor = 'grab';        // open hand idle
      break;
    default:
      canvas.style.cursor = 'crosshair';
  }
}, [activeTool]);
```

* Call `applyCursor()` whenever the tool changes, on MMB down/up, and on pointer leave. (Your file currently sets the cursor in the tool-creation effect; swap that line for `applyCursor()` so the override path can win.) 

---

# Pan math (for both Pan tool and MMB)

On each move:

```ts
const view = viewTransformRef.current;     // you already keep this ref fresh
// Dragging the "paper" with the mouse means: mouse right → world moves right with you.
// Using your transform definitions, that’s:
setPan((p) => ({
  x: p.x - dxScreen / view.scale,
  y: p.y - dyScreen / view.scale,
}));
```

(You can wire this via your `ViewTransformProvider`’s setter. The direction matches the “grab paper” mental model with your `worldToCanvas = (x - pan.x) * scale` definition.) 

**Invalidation:** you already trigger both loops when the view changes; that keeps pan buttery:

* Base loop: poke with a tiny `invalidateCanvas({ x:0, y:0, width:1, height:1 })`
* Overlay loop: `invalidateAll()`
  (You do this in a `useEffect` that watches `viewTransform.scale|pan.x|pan.y`.) 

---

# Tool branching map (including MMB)

**At pointerdown:**

* `e.button === 1` (MMB)

  * If `toolRef.current?.isActive()` → **ignore** (left button already down), `e.preventDefault()` to suppress OS auto-scroll; **do not** capture.
  * Else → **start ephemeral MMB pan**:

    * `e.preventDefault()`
    * `canvas.setPointerCapture(e.pointerId)`
    * `mmbPanRef = { active:true, pointerId:e.pointerId, lastClient:{x:e.clientX,y:e.clientY} }`
    * `cursorOverrideRef.current = 'grabbing'`; `applyCursor()`
    * (No tool switch. No overlay preview change.)

* Else (not MMB)

  * If `activeTool === 'pan'` → left button **begins Pan tool** (see Pan tool class below)
  * Else → route to current tool (pen/highlighter/eraser/text) as you already do. 

**At pointermove:**

* If **MMB pan active** & `e.pointerId` matches:

  * Compute `dx/dy` from `lastClient`, update `lastClient`
  * Call `setPan` using formula above; optionally `overlayLoopRef.current?.invalidateAll()` (belt & braces)
  * `return` (don’t forward to tool)

* Else → your normal `tool.move(...)` for hover/preview (eraser hover, etc.). 

**At pointerup/cancel/lostpointercapture:**

* If **MMB pan active** & pointer matches:

  * `try releasePointerCapture(...)`
  * Clear `mmbPanRef`, `cursorOverrideRef.current = null`, `applyCursor()`
  * `return`

* Else → your normal `tool.end()/cancel()` flow.  

---

# Minimal code you’ll add to your existing handlers

> Keep your current unified handlers and just splice in these guarded branches.

```ts
const handlePointerDown = (e: PointerEvent) => {
  if (isMobile) return;

  // --- MMB EPHEMERAL PAN ---
  if (e.button === 1) {
    e.preventDefault(); // suppress OS autoscroll
    // If another gesture is active (left button), ignore MMB
    if (toolRef.current?.isActive()) return;

    const canvas = baseStageRef.current!.getCanvasElement();
    canvas.setPointerCapture(e.pointerId);

    mmbPanRef.current = {
      active: true,
      pointerId: e.pointerId,
      lastClient: { x: e.clientX, y: e.clientY },
    };

    cursorOverrideRef.current = 'grabbing';
    applyCursor();
    // No roomDoc activity change needed; we're navigating, not "drawing"
    return;
  }

  // --- Normal tools (including Pan tool with left button) ---
  if (!toolRef.current?.canBegin()) return;

  const world = screenToWorld(e.clientX, e.clientY);
  if (!world) return;

  e.preventDefault();
  baseStageRef.current!.getCanvasElement().setPointerCapture(e.pointerId);
  toolRef.current!.begin(e.pointerId, world[0], world[1]);
  roomDoc.updateActivity('drawing'); // your current pattern
};

const handlePointerMove = (e: PointerEvent) => {
  lastMouseClientRef.current = { x: e.clientX, y: e.clientY };

  // MMB pan in progress?
  if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
    const last = mmbPanRef.current.lastClient!;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    mmbPanRef.current.lastClient = { x: e.clientX, y: e.clientY };

    const view = viewTransformRef.current;
    setPan((p) => ({ x: p.x - dx / view.scale, y: p.y - dy / view.scale }));

    overlayLoopRef.current?.invalidateAll(); 
    return;
  }

  // Normal hover/previews
  if (!isMobile) {
    const world = screenToWorld(e.clientX, e.clientY);
    if (world) {
      roomDoc.updateCursor(world[0], world[1]);  // existing
      toolRef.current?.move(world[0], world[1]); // existing
    }
  }
};

const endMmbPanIfAny = (e: PointerEvent) => {
  if (!mmbPanRef.current.active || e.pointerId !== mmbPanRef.current.pointerId) return;

  try { baseStageRef.current!.getCanvasElement().releasePointerCapture(e.pointerId); } catch {}
  mmbPanRef.current = { active: false, pointerId: null, lastClient: null };
  cursorOverrideRef.current = null;
  applyCursor();
};

const handlePointerUp = (e: PointerEvent) => {
  if (endMmbPanIfAny(e)) return; // early exit if it was MMB pan
  if (!toolRef.current?.isActive() || e.pointerId !== toolRef.current.getPointerId()) return;

  try { baseStageRef.current!.getCanvasElement().releasePointerCapture(e.pointerId); } catch {}
  const world = screenToWorld(e.clientX, e.clientY);
  toolRef.current!.end(world?.[0], world?.[1]);
  roomDoc.updateActivity('idle');
};

const handlePointerCancel = (e: PointerEvent) => {
  endMmbPanIfAny(e);
  if (e.pointerId !== toolRef.current?.getPointerId()) return;
  try { baseStageRef.current!.getCanvasElement().releasePointerCapture(e.pointerId); } catch {}
  toolRef.current?.cancel();
  roomDoc.updateActivity('idle');
};

const handleLostPointerCapture = (e: PointerEvent) => {
  // end ephemeral MMB pan if this pointer owned it
  if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
    mmbPanRef.current = { active: false, pointerId: null, lastClient: null };
    cursorOverrideRef.current = null;
    applyCursor();
    return;
  }
  // existing tool case:
  if (e.pointerId === tool?.getPointerId()) tool?.cancel();
};


// Also call applyCursor() inside your tool-creation effect after creating the tool
// instead of directly setting canvas.style.cursor there.
```

> The rest of your listener setup (non-passive, capture, cleanup) stays the same. 

---

# Pan tool implementation (clean & tiny)

Make `PanTool` fit your `PointerTool` interface. It doesn’t emit previews; it just changes view.
// types
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;



```ts
class PanTool implements PointerTool {
  private pointerId: number | null = null;
  private lastClient: { x: number; y: number } | null = null;
  constructor(
    private getView: () => ViewTransform,
    private setPan: (p: (prev: {x:number;y:number}) => {x:number;y:number}) => void,
    private onInvalidateOverlay: () => void,
    private onCursor: (c: Cursor | null) => void, // to show grabbing during drag
  ) {}

  canBegin() { return this.pointerId === null; }
  begin(pointerId: number, _xWorld: number, _yWorld: number) {
    this.pointerId = pointerId;
    // We'll track in screen px for stable deltas
    this.onCursor('grabbing');
  }
  move(xWorld: number, yWorld: number) {
    // We'll feed dx/dy via Canvas handler (like MMB) OR store last screen point via a helper
    // If you prefer, keep a "seedFromClient(x, y)" that Canvas calls on pointermove.
  }
  end() {
    this.pointerId = null;
    this.lastClient = null;
    this.onCursor(null); // revert to grab
  }
  cancel() { this.end(); }
  isActive() { return this.pointerId !== null; }
  getPointerId() { return this.pointerId; }
  getPreview() { return null; }
  destroy() {}
}
```

**Wire it up** only when `activeTool === 'pan'` in your tool-creation effect (same pattern as eraser/pen) and set the idle cursor to `grab` via `applyCursor()`.  

> You **don’t** need to change the overlay provider (it can remain `null` for Pan). Overlay still renders presence; and your existing view-change effect guarantees the overlay loop is invalidated on pan/zoom.  

if (e.pointerId === tool?.getPointerId()) {
  tool.cancel();
  roomDoc.updateActivity('idle');
  if ('clearHover' in tool) (tool as any).clearHover?.();
}

---

# Branching trace (single-pointer truth table)

**Pointer already down?**

* Yes (left button drawing/erasing): **Ignore MMB** (don’t steal capture).
* No:

  * `MMB down` → start **ephemeral MMB pan** (capture, grabbing, don’t touch Zustand).
  * `Left down` with activeTool:

    * `pan` → start Pan tool (capture, grabbing).
    * else → start the tool (pen/eraser/text…).

**Pointermove**

* If MMB pan active (by id): translate view by `-dx/scale, -dy/scale` and invalidate overlay.
* Else: route to tool for hover/preview (eraser hover dimming still works). 

**Pointerup/cancel/lostcapture**

* If MMB pan active: release, clear override, restore base cursor.
* Else: typical tool end/cancel, release capture. 

---

* The OS cursor logic is centralized in `applyCursor()`, with a **high-priority override** for MMB and a base policy that matches each tool (eraser `none`, pan `grab`, other tools `crosshair`). 

---

# Small implementation notes / edge cases

* **Prevent OS autoscroll** (Windows) by `e.preventDefault()` on MMB `pointerdown` even if you ignore because a left-button gesture is active.

* idle **open-hand** while Pan tool is selected, just set `applyCursor()` accordingly; while *dragging*, set the cursor override to `grabbing` in `begin`/clear it in `end`.

---


# **“How do we hide the eraser’s fixed screen-space circle while I’m holding the middle mouse to pan, without changing the active tool?”**

**Answer:** Treat MMB as a **temporary input mode** in `Canvas.tsx`:

* Start an **ephemeral MMB pan** gesture when `e.button === 1`.
* Apply a **cursor override** (`'grabbing'`) during that gesture.
* Wrap your overlay **PreviewProvider** so that when an `suppressToolPreviewRef` flag is true, it returns **`null`**—that hides the eraser preview entirely (both the world-space dim and the screen-space circle).
* On MMB release, clear the flag and the cursor override.

This plugs straight into the architecture you already have:

* Overlay is fed by a `PreviewProvider` and draws the eraser in **two passes** (world-space dim + **screen-space** circle). If we return `null` during MMB, neither pass draws.   
* The eraser preview itself is defined with a **fixed-pixel radius** (`r_px`) and world-space center, which is why you’re seeing the “fixed screen space” effect. Suppressing the preview during MMB removes that.  
* Your transform math and two-canvas setup already separate world vs screen correctly; we’ll reuse that untouched.  

---

# Why this is the sane way (and matches your architecture)

* **Two-canvas model**: base (world) and overlay (previews/presence). Overlay always clears fully and then draws **previews** (world) and **presence** (screen). We simply **don’t provide a preview** during MMB, so nothing tool-specific shows up. Presence still renders. 
* **Preview contract**: `OverlayRenderLoop` pulls from a `PreviewProvider`. You already call `setPreviewProvider(...)` from `Canvas.tsx` when a tool is created. We’ll wrap that provider so we can **return `null`** while MMB is active. No changes to the loop are required.  
* **Eraser preview shape**: returned as `{ kind:'eraser', circle:{ cx,cy, r_px }, ... }`. That’s exactly the screen-space circle you’re trying to hide; returning `null` prevents **both** the world-space dim **and** the screen-space cursor circle. 
* **Pan math**: panning is just `pan.x -= dx / scale; pan.y -= dy / scale` using your authoritative transforms. No zoom gets touched. 

---

# Minimal, practical changes

## 1) Add three tiny refs to `Canvas.tsx`

```ts
// Tracks a temporary “MMB pan” gesture without touching Zustand
const mmbPanRef = useRef<{ active: boolean; pointerId: number | null; lastClient: { x:number; y:number } | null; }>({ active:false, pointerId:null, lastClient:null });

// Soft cursor override that beats the tool’s base cursor
const cursorOverrideRef = useRef<null | 'none' | 'crosshair' | 'grab' | 'grabbing'>(null);

// When true, the overlay must return no tool preview (hides eraser ring/dim)
const suppressToolPreviewRef = useRef(false);
```

(These are exactly the kind of local refs the prompt notes recommend; the cursor override layering is their suggested approach.) 

## 2) Centralize cursor policy

```ts
const applyCursor = useCallback(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas) return;

  if (cursorOverrideRef.current) {
    canvas.style.cursor = cursorOverrideRef.current; // e.g., 'grabbing' during MMB
    return;
  }

  switch (activeTool) {
    case 'eraser': canvas.style.cursor = 'none'; break;       // hide OS cursor; overlay draws ring
    case 'pan':    canvas.style.cursor = 'grab'; break;       // open hand idle
    default:       canvas.style.cursor = 'crosshair';
  }
}, [activeTool]);
```

Call `applyCursor()` whenever the tool changes **and** on MMB down/up. 

## 3) Wrap the overlay `PreviewProvider`

When you create the tool and call `overlayLoopRef.current?.setPreviewProvider(...)`, wrap it in a thin guard:

```ts
overlayLoopRef.current?.setPreviewProvider({
  getPreview: () => {
    if (suppressToolPreviewRef.current) return null;  // <-- hide while MMB pan
    return tool.getPreview();
  },
});
```

Because the overlay loop caches previews only when `getPreview()` returns a truthy object, and you’re **not** using `holdPreviewForOneFrame` here, returning `null` cleanly suppresses drawing during MMB. (The loop is designed for this.) 

## 4) Pointer handlers: add the MMB branches (no tool switch)

Splice these into your existing unified handlers (they already have capture discipline, awareness updates, etc.). The snippets below align with your file’s structure and event wiring. 

**pointerdown**

```ts
if (e.button === 1) {                  // --- MMB EPHEMERAL PAN ---
  e.preventDefault();                  // stop OS autoscroll (Windows)
  if (toolRef.current?.isActive()) return; // don’t steal capture mid-draw

  const canvas = baseStageRef.current!.getCanvasElement();
  canvas.setPointerCapture(e.pointerId);

  mmbPanRef.current = { active: true, pointerId: e.pointerId, lastClient: { x: e.clientX, y: e.clientY } };
  cursorOverrideRef.current = 'grabbing';
  suppressToolPreviewRef.current = true;      // <-- hide eraser overlay
  applyCursor();
  overlayLoopRef.current?.invalidateAll();    // redraw without preview
  return;
}

// ... otherwise, proceed with active tool begin() exactly as you do today:
const worldCoords = screenToWorld(e.clientX, e.clientY);
if (!worldCoords) return;
e.preventDefault();
canvas.setPointerCapture(e.pointerId);
toolRef.current!.begin(e.pointerId, worldCoords[0], worldCoords[1]);
roomDoc.updateActivity('drawing');
```

**pointermove**

```ts
// Track last mouse for other features
lastMouseClientRef.current = { x: e.clientX, y: e.clientY };

// If MMB pan is active, translate view in world units and stop.
if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
  const last = mmbPanRef.current.lastClient!;
  const dx = e.clientX - last.x, dy = e.clientY - last.y;
  mmbPanRef.current.lastClient = { x: e.clientX, y: e.clientY };

  const view = viewTransformRef.current;                      // always fresh
  setPan((p) => ({ x: p.x - dx / view.scale, y: p.y - dy / view.scale })); // just pan
  overlayLoopRef.current?.invalidateAll();                    // optional; your view-change effect also repaints
  return;
}

// else: your normal tool hover/preview path (already in file)
const world = screenToWorld(e.clientX, e.clientY);
if (world) {
  roomDoc.updateCursor(world[0], world[1]);
  toolRef.current?.move(world[0], world[1]);
}
```

**pointerup / cancel / lostpointercapture**

```ts
if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
  try { baseStageRef.current!.getCanvasElement().releasePointerCapture(e.pointerId); } catch {}
  mmbPanRef.current = { active:false, pointerId:null, lastClient:null };
  cursorOverrideRef.current = null;               // lift override
  suppressToolPreviewRef.current = false;         // show tool overlay again
  applyCursor();
  overlayLoopRef.current?.invalidateAll();        // redraw with preview restored
  return;
}

// else: your normal tool end/cancel path…
```

Those branches follow exactly the “branching trace” you wrote up (MMB is ignored if a left-button gesture is active; otherwise it starts an ephemeral pan; moves translate `pan` by `-dx/scale, -dy/scale`; release restores state).   

---

# Cursor + overlay policy (to end the crosshair confusion)

1. **One source of “crosshair”:**

   * For pen/highlighter/text → use **OS cursor** via CSS (`'crosshair'`).
   * For eraser → **hide OS cursor** (`'none'`) and render the **overlay ring** (fixed px).
   * For pan → **OS cursor** `grab`/`grabbing`.
     This keeps “OS vs CSS vs overlay” clean, and matches your current eraser and pan intentions.  

2. **MMB override wins:**
   While MMB is held:

   * Apply **OS `'grabbing'`** via `cursorOverrideRef`.
   * **Suppress** the tool preview (so no eraser ring, no dimming) via `suppressToolPreviewRef`.
   * Presence continues to render (overlay still draws presence as a second pass). 

---

# Why your current eraser shows “fixed screen space” (and why this fix works)

* The eraser preview returns `{ circle: { r_px: number } }`, and `OverlayRenderLoop` draws that circle after setting **only the DPR transform** (no world transform). That makes it a **fixed-pixel screen-space cursor**, by design. Suppressing the `PreviewProvider` while MMB is active guarantees it won’t render during pan.  

---

# Why I’m confident this fits your code today

* You already initialize the **overlay loop**, pass `getSnapshot()`, and wire a polymorphic **PreviewProvider** from the active tool. We’re just adding a wrapper that can return `null`.  
* Your eraser’s preview union and overlay two-pass drawing flow is already in place—no additional rendering layers are needed.  

# **WHEEL**
// in a mount-once effect (see #2)
canvas.addEventListener('wheel', handleWheel, { passive: false });

// cleanup
canvas.removeEventListener('wheel', handleWheel);

const handleWheel = (e: WheelEvent) => {
    e.preventDefault();

    // Block wheel during MMB pan to avoid scale conflicts
    if (panGesture) return;

    // OPTIONAL: Block wheel during active tool gesture
    // const tool = toolRef.current;
    // if (tool?.isActive()) return;

    const rect = canvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Normalize wheel delta to standard "steps"
    let deltaY = e.deltaY;
    if (e.deltaMode === 1) deltaY *= 40;
    else if (e.deltaMode === 2) deltaY *= 800;
    const steps = deltaY / 120;

    // Calculate zoom factor (~9% per step)
    const ZOOM_STEP = Math.log(1.09);
    const factor = Math.exp(-steps * ZOOM_STEP);

    // Read LATEST transform from ref
    const v = viewTransformRef.current;
    if (!v) return;

    const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
      v.scale,
      v.pan,
      factor,
      { x: canvasX, y: canvasY }
    );
**SOLUTION**: Store setters in refs too!

```typescript
// Add near line 168:
const setScaleRef = useRef<(scale: number) => void>();
const setPanRef = useRef<(pan: Point) => void>();

// After getting context (line 135):
const { transform: viewTransform, setScale, setPan } = useViewTransform();

// Update refs in layout effect:
useLayoutEffect(() => {
  viewTransformRef.current = viewTransform;
  setScaleRef.current = setScale;
  setPanRef.current = setPan;
}, [viewTransform, setScale, setPan]);

// In handlers, use:
setScaleRef.current?.(targetScale);
setPanRef.current?.(targetPan);
```

**Goal**: Add buttery-smooth zoom with exponential approach.

**File**: `client/src/canvas/animation/ZoomAnimator.ts` (NEW)

```typescript
import { clampScale } from '../canvas/internal/transforms';

export class ZoomAnimator {
  private active = false;
  private rafId: number | null = null;
  private targetScale = 1;
  private targetPan = { x: 0, y: 0 };
  private lastTime = 0;

  constructor(
    private getView: () => { scale: number; pan: { x: number; y: number } },
    private setScale: (scale: number) => void,
    private setPan: (pan: { x: number; y: number }) => void,
  ) {}

  to(targetScale: number, targetPan: { x: number; y: number }) {
    this.targetScale = clampScale(targetScale);
    this.targetPan = targetPan;

    if (!this.active) {
      this.active = true;
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const v = this.getView();

    // Exponential approach
    const ZOOM_DAMPING = 18; // ~120ms half-life
    const alpha = 1 - Math.exp(-ZOOM_DAMPING * dt);

    const scale = v.scale + (this.targetScale - v.scale) * alpha;
    const pan = {
      x: v.pan.x + (this.targetPan.x - v.pan.x) * alpha,
      y: v.pan.y + (this.targetPan.y - v.pan.y) * alpha,
    };

    this.setScale(scale);
    this.setPan(pan);

    // Check convergence
    const scaleClose = Math.abs(scale - this.targetScale) / this.targetScale < 0.001;
    const panClose = Math.hypot(pan.x - this.targetPan.x, pan.y - this.targetPan.y) < 0.01;

    if (!scaleClose || !panClose) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.setScale(this.targetScale);
      this.setPan(this.targetPan);
      this.active = false;
      this.rafId = null;
    }
  };

  destroy() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.active = false;
  }
}


**Integration** in Canvas.tsx:

```typescript
// Add ref
const zoomAnimatorRef = useRef<ZoomAnimator | null>(null);

// Initialize in useEffect
useEffect(() => {
  zoomAnimatorRef.current = new ZoomAnimator(
    () => viewTransformRef.current,
    (s) => setScaleRef.current?.(s),
    (p) => setPanRef.current?.(p),
  );

  return () => {
    zoomAnimatorRef.current?.destroy();
  };
}, []);

// Use in wheel handler and zoom buttons:
const { scale: targetScale, pan: targetPan } = calculateZoomTransform(...);
zoomAnimatorRef.current?.to(targetScale, targetPan);
```

---

Create Zoom Helper Functions
**NEW FILE: `client/src/canvas/internal/zoom-helpers.ts`**
```typescript
import type { Snapshot } from '@avlo/shared';
import { clampScale } from './transforms';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function getContentBounds(snapshot: Snapshot): Bounds | null {
  if (snapshot.strokes.length === 0 && snapshot.texts.length === 0) {
    const meta = snapshot.meta as any;
    if (meta?.canvas) {
      return {
        minX: 0,
        minY: 0,
        maxX: meta.canvas.baseW,
        maxY: meta.canvas.baseH
      };
    }
    return null;
  }

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const stroke of snapshot.strokes) {
    minX = Math.min(minX, stroke.bbox[0]);
    minY = Math.min(minY, stroke.bbox[1]);
    maxX = Math.max(maxX, stroke.bbox[2]);
    maxY = Math.max(maxY, stroke.bbox[3]);
  }

  for (const text of snapshot.texts) {
    minX = Math.min(minX, text.x);
    minY = Math.min(minY, text.y);
    maxX = Math.max(maxX, text.x + text.w);
    maxY = Math.max(maxY, text.y + text.h);
  }

  return { minX, minY, maxX, maxY };
}

export function fitToContent(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  padding: number = 64
): { scale: number; pan: { x: number; y: number } } {
  const contentWidth = bounds.maxX - bounds.minX + padding * 2;
  const contentHeight = bounds.maxY - bounds.minY + padding * 2;

  const scaleX = viewportWidth / contentWidth;
  const scaleY = viewportHeight / contentHeight;
  const scale = clampScale(Math.min(scaleX, scaleY));

  const worldCenterX = (bounds.minX + bounds.maxX) / 2;
  const worldCenterY = (bounds.minY + bounds.maxY) / 2;

  const canvasCenterX = viewportWidth / 2;
  const canvasCenterY = viewportHeight / 2;

  const pan = {
    x: worldCenterX - canvasCenterX / scale,
    y: worldCenterY - canvasCenterY / scale
  };

  return { scale, pan };
}
```

#### 3.2 Create Zoom Controls Hook
**NEW FILE: `client/src/hooks/use-zoom-controls.ts`**
```typescript
import { useCallback } from 'react';
import { useViewTransform } from '@/canvas/ViewTransformContext';
import { calculateZoomTransform } from '@/canvas/internal/transforms';
import { getContentBounds, fitToContent } from '@/canvas/internal/zoom-helpers';
import type { IRoomDocManager } from '@avlo/shared';

export function useZoomControls(
  roomDoc: IRoomDocManager | null,
  canvasElement: HTMLCanvasElement | null
) {
  const { setScale, setPan, viewState } = useViewTransform();

  const zoomToViewportCenter = useCallback((factor: number) => {
    if (!canvasElement) return;

    const rect = canvasElement.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const { scale, pan } = calculateZoomTransform(
      viewState.scale,
      viewState.pan,
      factor,
      { x: centerX, y: centerY }
    );

    setScale(scale);
    setPan(pan);
  }, [canvasElement, viewState, setScale, setPan]);

  const fitToViewport = useCallback(() => {
    if (!canvasElement || !roomDoc) return;

    const snapshot = roomDoc.currentSnapshot;
    const bounds = getContentBounds(snapshot);

    if (!bounds) {
      setScale(1);
      setPan({ x: 0, y: 0 });
      return;
    }

    const rect = canvasElement.getBoundingClientRect();
    const { scale, pan } = fitToContent(bounds, rect.width, rect.height);

    setScale(scale);
    setPan(pan);
  }, [canvasElement, roomDoc, setScale, setPan]);

  return { zoomToViewportCenter, fitToViewport };
}
```

#### 3.3 Add Zoom API to Canvas
**MODIFY: `client/src/canvas/Canvas.tsx`**

Add imports:
```typescript
import { getContentBounds, fitToContent } from './internal/zoom-helpers';
import { useZoomControls } from '@/hooks/use-zoom-controls';
```

Add after the coordinate conversion functions (around line 270):

```typescript
// Zoom API for UI controls (viewport-centered)
// NOTE: No dependencies - read from refs to avoid stale closures
const zoomToViewportCenter = useCallback((factor: number) => {
  const stage = baseStageRef.current;
  if (!stage) return;

  const rect = stage.getBounds();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  // Read LATEST transform from ref
  const v = viewTransformRef.current!;
  const { scale: newScale, pan: newPan } = calculateZoomTransform(
    v.scale,
    v.pan,
    factor,
    { x: centerX, y: centerY }
  );

  // If using animator (Phase 7), call zoomAnimator.to(newScale, newPan)
  // Otherwise apply directly:
  setScale(newScale);
  setPan(newPan);
}, []); // Empty deps - uses refs

// Export via imperative handle or context
React.useImperativeHandle(ref, () => ({
  zoomToViewportCenter,
  // ... other methods
}), [zoomToViewportCenter]);
```
Imperative handle still depends on the unstable worldToClient

What I see now: you export worldToClient from useImperativeHandle and list it in the deps; if worldToClient remains unstable, the handle identity churns. 

Canvas.tsx

 

Canvas.tsx

Notes gap: you don’t show the matching handle-deps fix after stabilizing worldToClient.

Patch (missing in notes): stabilize worldToClient per earlier, then change:

React.useImperativeHandle(ref, () => ({ screenToWorld: ..., worldToClient, ... }), [screenToWorld /* no worldToClient here if stable */]);
#### 3.2 Pass Zoom API to ZoomControls

Create a ZoomApiContext or pass via props:

```typescript
// In Canvas.tsx render
<ZoomApiContext.Provider value={{ zoomToViewportCenter }}>
  <ZoomControls />
</ZoomApiContext.Provider>
```

#### 3.3 Update ZoomControls to Use API

In ZoomControls.tsx:


#### 7.2 Integrate ZoomAnimator in Canvas
**MODIFY: `client/src/canvas/Canvas.tsx`**

Add import at top:
```typescript
import { ZoomAnimator } from './animation/ZoomAnimator';
```

Add after pan gesture ref (around line 165):
```typescript
const zoomAnimatorRef = useRef<ZoomAnimator | null>(null);
```

Initialize on mount (add to existing useEffect or create new one):
```typescript
useEffect(() => {
  zoomAnimatorRef.current = new ZoomAnimator(
    () => ({ scale: viewTransform.scale, pan: viewTransform.pan }),
    setScale,
    setPan
  );

  return () => {
    zoomAnimatorRef.current?.destroy();
  };
}, [setScale, setPan]);
```

#### 7.3 Update Handlers to Use Animation

Update the wheel handler to use the animator:

```typescript
// In handleWheel, replace direct setScale/setPan with:
const v = viewTransformRef.current!;
const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
  v.scale,
  v.pan,
  factor,
  { x: canvasX, y: canvasY }
);

// Animate to target
zoomAnimatorRef.current?.to(targetScale, targetPan);
```

Similarly, update zoom buttons and fit-to-content:

```typescript
// In zoomToViewportCenter:
const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
  v.scale,
  v.pan,
  factor,
  { x: centerX, y: centerY }
);
zoomAnimatorRef.current?.to(targetScale, targetPan);

// In fitToViewport:
const { scale, pan } = fitToContent(bounds, rect.width, rect.height);
zoomAnimatorRef.current?.to(scale, pan);
```

### Expected Behavior
- Wheel zoom smoothly animates over ~120-150ms
- Multiple wheel events coalesce (retarget during animation)
- Cursor stays perfectly locked to world point during animation
- No drift or wobble

SetScale/setPan in scope, but Canvas.tsx currently doesn’t pull them in

What I see now: Canvas.tsx only destructures transform: viewTransform from the context. 

Canvas.tsx

Your notes: later steps rely on calling setScale/setPan (or their refs) from inside handlers, but you never explicitly list the required change to the destructure in this file.

Why it matters: your handlers (wheel, MMB pan) can’t commit view changes without the setters.

Patch (missing in notes):

// at top
const { transform: viewTransform, setScale, setPan } = useViewTransform();
// (optional) setScaleRef/setPanRef pattern if you want absolutely stable references

What I see now: pointer listeners are already { passive:false } (good), but since you’ll add wheel, your notes should call out { passive:false } explicitly for wheel to guarantee preventDefault() is honored.

10) One more correctness nit: handleLostPointerCapture should mirror pointerup/cancel for tools

What I see now: on lost-capture you only tool?.cancel(); you don’t restore activity state or clear hover. 
Why it matters: activity can remain “drawing” if you don’t mirror the idle transition on unexpected loss.

Patch (missing in notes):

if (e.pointerId === tool?.getPointerId()) {
  tool.cancel();
  roomDoc.updateActivity('idle');
  if ('clearHover' in tool) (tool as any).clearHover?.();
}
wheel must be non-passive and normalized.
Your pointer listeners are correctly marked { passive:false }, but because there is no wheel listener, that detail isn’t in place for wheel. When you add it, remember: { passive:false }, normalize deltaMode (lines/px/page), and coalesce continuous trackpad events. (You already plan normalization in notes, but the Canvas plumbing still lacks the listener.)
Pinch-to-zoom path (ctrl+wheel) handling is absent.
On many platforms trackpad pinch comes through as wheel with ctrlKey===true; the wiring should still go through the same calculateZoomTransform path (often with a different step sensitivity). There’s no special-case or scaling path for that in Canvas.