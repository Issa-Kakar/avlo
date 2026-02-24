- Goal: we are making a context menu, this toolbar will be used for selection. this will be reused, the current text context menu is just a placeholder. we will be using react for this menu but the actual container itself will be outside of react. react is meant only to display the content inside of it, handling the buttons and icons and clean lifecycle and button state management and drop downs etc.
- This will also be using floating ui dom for the context menu positioning. the current logic is flawed for positioning and we can render it better to actually exclude the toolbar placed at the top, and avoid the zoom controls on the bottom left.

- The placement: we are going to be using react portal. the current setup has an "app-container" in the root with overflow hidden, and same with a workspace, this is what we want to escape as well. the ui in general should not be overflow hidden but this will be changed at another time to restructure the setup.
- The div will be placed as a persistent portal target in the html code. Inside the body and inside the root, a sibling to the app container, we will place the portal target. we'll have it called overlay-root div id. this will be inside the root because its nicer for allowing the room doc manager registry context to be accessed if we ever need it.
- This persistent div will be grouping all overlay portals essentially, although i might make another div for tooltips as well that is seperate we'll see. 
- Inside of Canvas.tsx, we will have the canvas call "document.getElementByID" to grab the div that is inside the root that is the portal target. 
- There will actually be a second persistent div: context menu. this div is exactly what floating ui dom will be using and positioning. this lives underneath the overlay root, the overlay root is just a grouping node so multiple menus can be siblings. the div id that canvas will be grabbing is the "context-menu-toolbar". the overlay root will allow multiple menus to be siblings. so the future right click menu where it will show paste and copy and delete and send to back/front etc. will be able to live as a sibling
- and the right click menu will be placed above the toolbar and zoom controls UI, which is why its important we setup the div structure for portaling now, and also setup tooltips properly, even changing the tooltips of the toolbar currently and whatnot(not the focus right now though).
- Now: in Canvas.tsx we can pass the contextMenu div to canvas runtime. Inside of the JSX in the return as well, we will return the "contextMenutoolbar && createPortal" and render the react component portal straight into the context menu toolbar div.
- NOW: The contextual toolbar will have the assignments on app start, it will have an initial value of "position fixed". And this is the confusing part so pay attention: the react component that renders the CONTENT inside the toolbar, is going to render null when the menu is not active. otherwise, it'll render the components. CRITICAL: We are going to have an imperative class, this class will be responsible for managing the dom overlay container showing and hiding and subscribing to camera and computing its position etc. the "menu manager class". but: the react side will manage itself fine. the way we will have it is subscribing to a simple "show menu and hide menu" selector. this will be a new selector we'll discuss more in depth.
- AS FOR THE IMPERATIVE CLASS: we will be using floating ui dom. this is the flow: when the menu is not active, 

## `display: none` for inactive is fine

 Here's what actually happens when you activate:

```
1. el.style.display = ''           ← synchronous DOM write
2. await computePosition(...)      ← internally calls getBoundingClientRect synchronously
3. .then(({x, y}) => apply)        ← resolves as microtask, still before paint
4. browser paints                  ← first paint already has correct position
```

The browser does a reflow when floating-ui reads layout properties — this happens regardless of whether the element just went from `display: none` to visible, or was just mounted by React. There is no extra cost. Your intuition about the microtask timing is correct: everything from step 1 through 3 completes before the browser paints. Zero FOUC risk.

## The actual comparison

**Your approach (persistent container + display:none):**

- Class gets the element once, holds it forever
- Activate: remove `display: none`, call `computePosition`, animate in
- Deactivate: set `display: none`
- During camera changes: `opacity: 0` (not `display: none`, element stays measurable)
- React conditionally renders _content_ inside the container for subscription cleanup

**My approach (React mount/unmount):**

- Class receives element via ref callback on every activate cycle, loses it on every deactivate
- Activate: React mounts div → ref fires → `computePosition` → fade in
- Deactivate: React unmounts div → ref fires with null → cleanup
- During camera changes: `opacity: 0`
- React conditionally renders the entire floating div

**What's actually different:** Ref management. Everything else is mechanically identical. Both call `computePosition` at the same time. Both use opacity for camera-change hiding. Both have React conditionally rendering content.

With persistent container, the class holds one stable reference. No null checks on every cycle, no re-registration. With mount/unmount, every activation is: ref callback fires → null check → store reference → position. Every deactivation is: ref callback fires with null → null out reference → cleanup. It's more code for zero benefit.

The counter-argument would be "a fresh element has no stale state." But stale `left`/`top` on a `display: none` element have no effect — `computePosition` overwrites them before the element becomes visible. This is a non-issue.

**Verdict: persistent container with `display: none` is simpler.** Less code, stable reference, same correctness.

## Pointer events during camera hiding

This is the one concern that applies equally to both approaches. When the menu is active but hidden during a camera change (`opacity: 0`), the fixed-position element is still intercepting pointer events on the canvas beneath it. You need `pointer-events: none` during that state.

The cleanest way to handle both opacity and pointer-events without inline style assignments scattered through the class:

```css
/* index.css */
.context-menu-floating {
  position: fixed;
  width: max-content;
  top: 0;
  left: 0;
  z-index: 1000;
  display: none;
  opacity: 0;
  pointer-events: none;
}

.context-menu-floating[data-visible] {
  opacity: 1;
  pointer-events: auto;
  transition: opacity 150ms ease;
}
```

The transition is only defined in the `[data-visible]` state. Removing the attribute causes instant snap to `opacity: 0` (no transition in the base rule). Adding the attribute fades in. This means:

- Camera change hide: remove attribute → instant invisible + non-interactive
- Camera settle show: add attribute → fade in + interactive
- Deactivate: `display: none` (attribute state irrelevant)

The class:

```typescript
// Show after computePosition
this.floatingEl.dataset.visible = '';

// Hide during camera change (instant, measurable, non-interactive)  
delete this.floatingEl.dataset.visible;

// Deactivate (takes element out of layout entirely)
this.floatingEl.style.display = 'none';

// Activate (brings element back, still invisible until data-visible is set)
this.floatingEl.style.display = '';
```

No inline opacity assignments. No inline transition manipulation. No inline pointer-events. One data attribute and one display toggle. CSS handles the rest.

## The component tree

Canvas.tsx always renders the portal with the container:

```tsx
function Canvas() {
  return (
    <>
      <div ref={containerRef} className="canvas-container">
        <canvas ref={baseRef} />
        <canvas ref={overlayRef} />
        <div ref={editorHostRef} />
      </div>
      {createPortal(
        <div id="context-menu-floating" className="context-menu-floating">
          <ContextMenu/>
        </div>,
        document.getElementById('context-menu-portal')!
      )}
    </>
  );
}
```

`useLayoutEffect` passes the floating div to the controller once:

```tsx
useLayoutEffect(() => {
  const el = document.getElementById('context-menu-floating');
  contextMenuController.init(el);
  return () => contextMenuController.destroy();
}, []);
```

The conditional lives inside `ContextMenuContent`:

```tsx
function ContextMenu() {
  const active = useContextMenuStore(s => s.active);
  if (!active) return null;
  return <ContextMenuBar />;
}
```

When inactive: the floating div exists with `display: none`, empty inside. When active: the floating div has `display: ''`, `ContextMenuBar` renders the button groups, controller positions and reveals.

**NOTE**: THIS IS JUST A ROUGH SKETCH. THE NAMES COULD BE CLEARER. BUT THATS THE GENERAL IDEA. FOR EXAMPLE, WE CAN JUST HAVE THE DATASET VISIBLE and another dataset name/mode when its not visible or whatever
- Point is: there is a critical distinction: when the menu is INACTIVE, this means menu is completely not shown. the class will subscribe the same way as the react side to showing the menu. when the menu is ACTIVE: we setup a CAMERA SUBSCRIPTION, this will be used for hiding the menu by setting opacity to 0 and turning off pointer events. ITS OKAY IF WE DO IT INLINE AS WELL, NO PROBLEM. WHICHEVER IS EASIER. we want to wait for the camera to "settle". then we show menu again.
- THE IMPERATIVE CLASS SETS UP THE SUBSCRIPTION TO THE CAMERA WHENEVER ITS ACTIVE. WHEN INACTIVE IT UNSUBSCRIBES AND RESETS THE CSS. EVERY TIME THE MENU IS ACTIVATED FROM THE INACTIVE STATE AND APPEARS, WE MUST RUN IT THROUGH A FUNCTION FOR SETTING THE DISPLAY OFF OF DISPLAY NONE: WE WANT TO MAKE IT PARTICIPATE IN LAYOUT MEASUREMENTS. 
- THEN, WE CALL INSIDE THE FUNCTION THE REGULAR "COMPUTE POSITION"
- THIS COMPUTE POSITION IS CALLED EVERY TIME WE SHOW THE MENU, INCLUDING WHEN WE ARE SHOWING THE MENU AFTER HIDING IT AFTER CAMERA CHANGES, AND WHEN WE SHOW THE MENU AFTER ITS COMPLETELY INACTIVE AS WELL.
- THE CONSTRAINTS FOR POSITIONING: THE MENU WILL BE PLACED AT THE TOP OF THE SELECTION USUALLY, CENTERED. use virtual elements doing world to screen conversions, i want it fixed padding wise above or below the element, centered on whats visible, and always if the top/bottom of the bounds it goes there, but i want the top menu toolbar to be factored in, and it should be biased to going towards the top still and go bottom when it would not be able to be placed, including padding, at the top considering the toolbar, it should also factor the zoom controls at the bottom, ensuring it doesn't hit that, and it should not use auto update as that is not performant or meant for this use case. whenever the bounds are COMPLETELY off screen, meaning, the entire selection or object bounds do not even have a sliver visible, we can hide it. 
## 5. Fixed vs. Absolute Positioning Strategy

Floating UI's `computePosition` accepts a `strategy` option: `'absolute'` (default) or `'fixed'`.

### What Each Does

- **`strategy: 'absolute'`**: floating-ui computes `left`/`top` values relative to the floating element's `offsetParent`. The floating element must have `position: absolute` in CSS.
- **`strategy: 'fixed'`**: floating-ui computes `left`/`top` values relative to the viewport. The floating element must have `position: fixed` in CSS.

### Why Fixed is Correct Here

Your virtual element's `getBoundingClientRect()` returns viewport-relative coordinates (that's what `worldToClient` produces—screen coordinates). With `strategy: 'fixed'`, floating-ui's computed `x`/`y` are also viewport-relative. The coordinate spaces match directly.

With `strategy: 'absolute'`, floating-ui would need to account for the offsetParent's position, scroll offsets, etc. Since `#overlay-root` is an unstyled div, its offsetParent is `<body>` (or `<html>`), which means the coordinates would need adjustment if the page ever scrolls (unlikely in a fullscreen canvas app, but a latent bug). `fixed` eliminates this class of problems entirely.

Additionally, `position: fixed` inherently escapes `overflow: hidden` on all ancestors (provided no ancestor has `transform`, `filter`, `will-change: transform`, or `contain: paint`—none of which apply to your unstyled `#overlay-root` or `<body>`). This is defense-in-depth on top of the portal already placing the DOM outside Workspace.

### Required CSS on the Floating Element

css

```css
.context-menu-floating {
  position: fixed;
  width: max-content;    /* Prevent shrinking to parent width */
  top: 0;                /* Initial value; floating-ui overwrites */
  left: 0;               /* Initial value; floating-ui overwrites */
  z-index: 1000;         /* Above canvas, above toolbar */
}
```

Floating-ui's documentation explicitly requires these initial styles be set before `computePosition` is called. The `top: 0; left: 0` prevents the element from being at some browser-default position before positioning runs.

---

## 6. Virtual Elements and World-to-Screen Conversion

A floating-ui virtual element is any object with a `getBoundingClientRect()` method. This replaces a real DOM element as the "reference" (anchor) for positioning.

### Building the Virtual Element

typescript

```typescript
import type { VirtualElement } from '@floating-ui/dom';

function createSelectionVirtualElement(
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
): VirtualElement {
  return {
    getBoundingClientRect() {
      // worldToClient converts world-space canvas coordinates
      // to viewport-relative screen coordinates
      const [left, top] = worldToClient(bounds.minX, bounds.minY);
      const [right, bottom] = worldToClient(bounds.maxX, bounds.maxY);

      return {
        x: left,
        y: top,
        top,
        left,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      };
    },
  };
}
```

### Why This Works

Every time floating-ui calls `getBoundingClientRect()` on the virtual element, it gets fresh screen coordinates derived from the current camera state. The virtual element is a _live computation_, not a snapshot. This means:

- You store the **world-space bounds** of the selection (stable across camera changes)
- The virtual element's `getBoundingClientRect()` converts to screen space on demand
- When you call `computePosition` after a camera change, it reads the new screen position automatically

### Important: getBoundingClientRect is Called Synchronously

Floating-ui calls `getBoundingClientRect()` synchronously inside `computePosition`. Since `worldToClient` reads camera state from a Zustand store (synchronous `getState()` call), this is zero-cost and always fresh.

---

## 7. The Middleware Chain

Middleware execute in order. Each middleware receives the coordinates from the previous one and can modify them or provide data. The recommended order from floating-ui's docs:

```
offset → flip → shift → [arrow] → hide
```

`offset` goes first because all subsequent middleware should work with the offset-adjusted coordinates. `hide` goes last because it's data-only (doesn't modify coordinates) and should evaluate the final position.

### Your Configuration

typescript

```typescript
import {
  computePosition,
  offset,
  flip,
  shift,
  hide,
} from '@floating-ui/dom';

// These should be reactive to layout changes, but for a fullscreen
// canvas app they're essentially constants. Measure once on init
// or derive from known CSS values.
const TOOLBAR_HEIGHT = 48;      // your top toolbar height in px
const ZOOM_CONTROLS_HEIGHT = 48; // your bottom-right zoom controls height
const MENU_GAP = 8;             // px between selection bounds and menu

async function positionContextMenu(
  virtualEl: VirtualElement,
  floatingEl: HTMLElement
) {
  const result = await computePosition(virtualEl, floatingEl, {
    strategy: 'fixed',
    placement: 'top',          // Bias: prefer above the selection
    middleware: [
      // 1. Gap between selection and menu
      offset(MENU_GAP),

      // 2. Flip to bottom when top doesn't fit
      flip({
        padding: {
          top: TOOLBAR_HEIGHT + MENU_GAP,
          bottom: ZOOM_CONTROLS_HEIGHT + MENU_GAP,
          left: MENU_GAP,
          right: MENU_GAP,
        },
        fallbackPlacements: ['bottom'],
        fallbackStrategy: 'initialPlacement',
      }),

      // 3. Shift horizontally to stay in viewport
      shift({
        padding: {
          top: TOOLBAR_HEIGHT + MENU_GAP,
          bottom: ZOOM_CONTROLS_HEIGHT + MENU_GAP,
          left: MENU_GAP,
          right: MENU_GAP,
        },
      }),

      // 4. Detect when selection is off-screen
      hide({
        strategy: 'referenceHidden',
      }),
    ],
  });

  return result;
}
```

### What Each Middleware Does

**`offset(MENU_GAP)`**

Adds an 8px gap between the edge of the selection bounding box and the menu. Without this, the menu sits flush against the selection. Offset is always first because flip and shift need to evaluate overflow _including_ the offset distance.

**`flip({ ... })`**

Checks if there's enough space to place the menu at `placement: 'top'`. "Enough space" means the menu plus its offset fits between the selection's top edge and the viewport's top edge minus `padding.top` (the toolbar). If not, it tries `'bottom'` (the only `fallbackPlacement`).

The `padding` option creates virtual boundaries that the flip algorithm treats as viewport edges. By setting `padding.top` to `TOOLBAR_HEIGHT + MENU_GAP`, you're telling flip: "the usable viewport starts 56px from the top." The menu will flip to bottom if it would overlap the toolbar.

`fallbackStrategy: 'initialPlacement'` means: if neither top nor bottom has enough space (extreme zoom, tiny viewport), revert to the initial placement (`'top'`) rather than picking whichever has more space. This prevents surprising jumps.

**`shift({ ... })`**

After flip decides top vs. bottom, shift ensures the menu stays within viewport bounds horizontally. If the menu is wider than the selection, it shifts left/right so the menu doesn't go off-screen. The `padding` values prevent it from touching the toolbar area or zoom controls.

This is what gives you "centered on the selection, but clamped to stay on screen." Floating-ui centers the menu on the reference by default (placement `'top'` centers horizontally). Shift only kicks in when that centering would push the menu off-screen.

**`hide({ strategy: 'referenceHidden' })`**

This doesn't modify coordinates. It adds data: `middlewareData.hide.referenceHidden` is `true` when the reference element (your virtual selection bounds) is fully clipped/off-screen.

How "fully clipped" is determined: floating-ui checks the reference rect against the clipping ancestors. For a virtual element with no `contextElement`, the clipping boundary is the viewport. So `referenceHidden` becomes true when the selection bounding box is completely outside the viewport.

**Important caveat:** `referenceHidden` detects when the _entire_ reference rect is off-screen. If even 1px of the selection is visible, `referenceHidden` remains false


# NOTE, THE ABOVE IS AN EXCERPT AND MIGHT NOT ALIGN WITH MY ACTUAL STRATEGY, SO I WILL CLARIFY IT HERE
- First off: Center the menu based on the visible portion. so if only 1/4 of the left side is on your screen, we center it based on that visible portion. 
- We want to show it usually positioned at the top. however: factor in not only the toolbar, but the toolbars padding, and also the fact that the toolbar is offset slightly from the top of the screen(the toolbar referring to ToolPanel.tsx, the fixed tool toolbar). so, we want the contextual menu toolbar to also have padding, so the toolbars should never directly ever touch. 
- the same goes for zoom controls at the bottom, factor that into the padding. even when its very close to each other, they are still slightly spaced apart
- Now: when the menu cannot fit on the top, meaning it intersects the padding space even slightly: so not just directly touching, and also this is applied to the entire top of the screen: the toolbar is placed currently centered in the top. whenever the padding or further intersects or whatever, then we flip it to the bottom of the bounds.
- NOW: when the bounds as well on the bottom are also perhaps offscreen, so imagine the top and bottom bounds are going past the outside of the viewport top/bottom, the fallback placement is this precisely: right under the toolbar at the top. meaning, its still always visible.
- the fallback is not bottom, its top. but: remember, you essentially can think about it like this, chop off the top portion of the screen in your measurements, accounting for the "gap" in between the fixed top toolbar and the top of the screen that is tiny, then the toolbar height itself, then the padding of the toolbar, then the padding of the context menu that needs space to breathe.
- the zoom controls: this will also be an obstacle. its currently bottom left. so lets say there is room on the bottom. however, the menu would intersect the zoom controls + padding. so then, you should shift the menu to the right. think about the toolbar/zoom controls as a fixed barrier: you can never overlap it, and never touch it, the context menu and the ui exclusion zones will always at its closest have the padding between them.
- the "shift" is also used when the menu stays within viewport bounds. so lets say the selection is partially off screen, the shift goes horizontal to ensure its on screen.
# TOOLTIPS:
We will also have tooltips for the context menu. we will implement this after we have this working though. we will likely using floating-ui's "react-dom" package. the entire react package is a bit verbose and we won't need it. but we can do our own setup with the lighter weight "useFloating.ts".

# `createPortal` should be unconditional in Canvas.tsx. The portal target div always exists, the portal call always runs, and the component _inside_ the portal decides what to render:

tsx

````tsx
// Canvas.tsx
function Canvas() {
  return (
    <>
      <div ref={containerRef} className="canvas-container">
        <canvas ref={baseRef} />
        <canvas ref={overlayRef} />
        <div ref={editorHostRef} />
      </div>
      {createPortal(
        <ContextMenu />,
        document.getElementById('context-menu-portal')!
      )}
    </>
  );
}
```

This is cleaner because `Canvas.tsx` declares "I own a context menu that lives in the overlay" once, and the conditional logic is pushed down into `ContextMenu` where it belongs.

## DOM structure (overlay-root as grouping node)
```
<div id="root">
  <RoomDocRegistryProvider>
    <Workspace>
      ...canvas, UI...
    </Workspace>
    <div id="overlay-root">              ← grouping node, no styles
      <div id="context-menu-portal" />   ← portal target for context menu
      <!-- future: right-click-menu-portal, etc. -->
    </div>
  </RoomDocRegistryProvider>
</div>
```

`overlay-root` groups all overlay portals. `context-menu-portal` is the specific target. The floating div that floating-ui positions is rendered *inside* `context-menu-portal` by React when active. Clean separation.

## The component tree

Here's where the real question is. You're right that having `StrokeContextMenu`, `ShapeContextMenu`, `ConnectorContextMenu` as totally separate components is wrong. The variants share the container (same height, background, shadow, border-radius, padding), the layout direction (horizontal icon bar), many of the same action buttons, and the same icon set. What differs is *which buttons appear and which are absent.*

The right decomposition is one menu shell with composable button groups that appear or disappear based on selection kind:
```
ContextMenu                          ← active/inactive gate + floating ref
  └── ContextMenuBar                 ← the visual shell (flexbox, background, shadow)
        ├── [StrokeStyleGroup]       ← stroke width, dash pattern (if strokes/shapes)
        ├── [Divider]
        ├── [FillGroup]              ← fill color (if shapes)
        ├── [Divider]
        ├── [TextStyleGroup]         ← bold, italic, size (if text)
        ├── [Divider]
        ├── [ConnectorGroup]         ← line type, arrows (if connectors)
        ├── [Divider]
        ├── CommonActionsGroup       ← always: delete, duplicate, copy, lock, group
        └── OverflowButton           ← always: "more" kebab
````

function ContextMenu() {
  const active = useContextMenuStore(s => s.active);

  if (!active) return null;

  return (
    <div className="context-menu-floating" ref={floatingRef}>
      <ContextMenuBar />
    </div>
  );
}

function ContextMenuBar() {
  const kind = useSelectionStore(s => s.selectionKind);

  return (
    <div className="context-menu-bar">
      {hasStrokeStyles(kind) && (
        <>
          <StrokeStyleGroup />
          <Divider />
        </>
      )}
      {hasFill(kind) && (
        <>
          <FillGroup />
          <Divider />
        </>
      )}
      {hasTextStyles(kind) && (
        <>
          <TextStyleGroup />
          <Divider />
        </>
      )}
      {hasConnectorStyles(kind) && (
        <>
          <ConnectorGroup />
          <Divider />
        </>
      )}
      <CommonActionsGroup />
      <Divider />
      <OverflowButton />
    </div>
  );
}

Where the predicate functions are simple:

typescript

```typescript
function hasStrokeStyles(kind: SelectionKind): boolean {
  return kind === 'strokes' || kind === 'shapes' || kind === 'mixed';
}
function hasFill(kind: SelectionKind): boolean {
  return kind === 'shapes' || kind === 'mixed';
}
// etc.
```

### Why this is better than variant components

**One shell, always.** The `context-menu-bar` CSS class defines the container once. No risk of visual inconsistency between "variants."

**Buttons are defined once.** The `DeleteButton` component exists in one place, used by `CommonActionsGroup`. Not duplicated across five variant components.

**Adding a new selection kind doesn't require a new component.** You update the predicate functions and maybe add a new button group. The shell, common actions, and overflow button don't change.

**Mixed selections compose naturally.** When the user selects a shape and a connector, `kind === 'mixed'` and both `hasFill` and `hasConnectorStyles` return true, so both groups appear. No need for a dedicated `MixedContextMenu` that manually assembles pieces.

**Height stays consistent** because the bar is always one row of icon buttons. The width varies by how many groups are visible, which is exactly the dimension floating-ui needs to measure on mount.

### The individual button groups

Each group is a small component that reads relevant state from stores:

tsx

```tsx
function StrokeStyleGroup() {
  // Reads intersection of selected objects' stroke properties
  const strokeWidth = useSelectionStore(s => s.commonStrokeWidth);
  const dashPattern = useSelectionStore(s => s.commonDashPattern);

  return (
    <div className="button-group">
      <MenuButton
        icon={<StrokeWidthIcon />}
        label="Stroke width"
        active={strokeWidth !== null}
        onClick={() => openStrokeWidthPicker()}
      />
      <MenuButton
        icon={<DashPatternIcon />}
        label="Dash pattern"
        active={dashPattern !== null}
        onClick={() => openDashPatternPicker()}
      />
    </div>
  );
}
```

`MenuButton` is the atomic reusable unit — handles the icon, tooltip (via `@floating-ui/react-dom`), active state styling, and click handler. Every button in every group uses the same component.

Element mutation through selection-store
This is the natural home. "Apply bold to all selected text objects" needs selectedIds and access to getActiveRoomDoc(). If that action lives elsewhere, it has to import both. In selection-store, selectedIds is already there:
typescriptapplyToSelection: (mutator: (handle: ObjectHandle) => void) => {
  const { selectedIds } = get();
  const roomDoc = getActiveRoomDoc();
  const snapshot = roomDoc.getCurrentSnapshot();
  roomDoc.mutate(() => {
    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (handle) mutator(handle);
    }
  });
},

setSelectedColor: (color: string) => {
  get().applyToSelection((handle) => {
    handle.y.set('color', color);
  });
  // Also persist as preferred color in device-ui-store
  useDeviceUIStore.getState().setDrawingColor(color);
},
React components call this directly. No indirection, no new store:
tsxfunction ColorButton() {
  const color = useSelectionStore(s => s.commonStyles?.color);
  return (
    <button onClick={() => useSelectionStore.getState().setSelectedColor('#ff0000')}>
      ...
    </button>
  );
}

# the context menu will be used for selection, and also used for text when its in edit mode
- the current text context menu can be used as a reference for the context menu for selection. the current "SelectionContextMenu.tsx" can be used as a reference for the context menu as well: this is a non active component that was purely a demo, and it is purely meant for just the prototyping initially and was used for the styling of the current text context menu. do not view it as authoritative for the context menu for selection, as there are many visual changes needed but its a solid starting point.

# IMPORTANT: The context menu react side will need to be as robust and granular as possible. 
- we will want reusable components, we want to seperate things into groups: for example, we will be adding text in shapes, so the shapes will also inherit those settings and groupings, and in the future we will be adding a background color to text, this will also share the same icon for the text context menu.

# CRITICAL: MENU ACTIVE/INACTIVE/SHOW/HIDE GUIDE
- The menu will be shown when selected ids is greater then 1, but it goes further then that. the menu will hide during active transforms, including scale/translate/endpoint drag. then on pointer up, the menu will show again. however, there are some fields that need to be added in, as we cannot just show the menu after "endScale" or "endTranslate" or "endEndpointDrag", as the menu will show again for text specifically with the font size being incorrect, the order in select tool is "endTransform" in the store, and then it mutates Yjs. we have not implemented the necessary fields to show/hide the menu yet, so this needs consideration. we want to show the context menu based on: if select tool is active, and we are NOT in gesture, but after gesture its specifically after "end" after mutating Yjs to reflect the correct values. the marquee state as well will hide it, as thats a gesture. the text editing state even if not selected will show the menu as well. so the select tool will be closely related to the showing/hiding during gesture.
- the class should technically be able to show/hide based on subscriptions, but, for hiding the menu it could be a public method if we want easier show/hide from select tool as well.
- the menu should show: when there is greater then 0 selected IDs, and, when not zooming/panning, and we're not mid gesture, the gesture state is idle. so maybe hide menu when the phase != idle? in select tool?
- there is also a difference in "hiding menu" vs the menus inactive state. the menu inactive means the display is none. but for zoom/pan / gestures the menu also is still there, we just disable pointer events and opacity is set to 0.
- so: not only do we have to show the menu when state is idle and selectedIDs is more than 1, and also if text is editing we show menu, but, we also have a problem: i will discuss this in the prompt in the future.

---

# CHANGELOG

**Session 1 — React primitives layer**
- Installed `lucide-react` (tree-shakeable, only Bold/Italic will bundle)
- Created `client/src/components/context-menu/`: CSS foundation (`ctx-menu`, `ctx-btn` variants, sizing, states), atomic components (MenuButton with mousedown preventDefault, Divider, ButtonGroup, ColorCircle, SizeStepper, TypefaceButton), icon set (AlignTextLeft/Center/Right, TextColorIcon, HighlightIcon, ChevronDown, Minus, Plus, MoreDots), barrel exports
- No existing files modified besides `client/package.json` + `CLAUDE.md` file map

**Session 2 — Selection store infrastructure (context menu data layer)**
- **selection-store.ts** — Major rewrite: self-managing `setSelection(ids)` (dropped `selectionKind` param, store computes composition internally via single-pass `computeSelectionComposition`). Added `'textOnly'` to `SelectionKind`. New state fields: `selectedIdSet` (O(1) lookup), `kindCounts`, `idsByKind`, `menuActive`, `selectedStyles` (live style snapshot: color/colorMixed/colorSecond/width/fillColor/fontSize/textAlign), `boundsVersion`. New actions: `refreshStyles()` (style recompute with `stylesEqual` diff), `onObjectMutation(touched, deleted, bboxChanged)` (bridge from Y.js observer), `filterByKind(kind)`. `menuActive` derived in every action that touches selection/transform/marquee/textEditing. `beginScale` reads `selectionKind` from own state. Exported `computeSelectionBounds()` (extracted from SelectTool). `computeStyles` dispatches by kind — mixed → EMPTY_STYLES immediately, single-kind → single-pass with early break.
- **SelectTool.ts** — Removed `computeSelectionKind()` (30 lines) and `computeSelectionBounds()` (26 lines). Updated 6 `setSelection` call sites (dropped 2nd arg), updated `beginScale` call (dropped `selectionKind` arg), replaced 10 `this.computeSelectionBounds()` calls with imported standalone. Cleaned unused imports.
- **room-doc-manager.ts** — Observer bridge: accumulates `bboxChangedIds` in `applyObjectChanges`, calls `sel.onObjectMutation(touchedIds, deletedIds, bboxChangedIds)` when selection is active. 5 lines, zero overhead when nothing selected.
- **ContextMenuController.ts** — New skeleton class: `init(floatingEl)`/`destroy()` lifecycle, `scheduleReposition()` rAF stub, `show()`/`hide()` data-visible attribute toggle. No subscriptions wired yet.
- NOTE: This is a first pass — the store structure needs rethinking. `menuActive` is over-embedded into every action (should be its own derived concern). `idsByKind` as stored state is wasteful (inline in action). The observer bridge in room-doc-manager is a middleman transferring full sets when a simpler signal would suffice. SelectTool.isActive() should be the primary gate for menu hiding — the tool knows its own gesture state. Position computation should happen once at gesture end, not continuously. Consider immer/shallow for zustand boilerplate. Next session will restructure: leaner store fields, SelectTool-driven show/hide, client/utils helpers, and wire the actual ContextMenuController subscriptions + floating-ui positioning.
