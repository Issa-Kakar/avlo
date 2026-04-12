# Input, Keyboard & Viewport Subsystem

Imperative modules for keyboard shortcuts, DOM event registration, modifier state tracking, viewport control (zoom, edge scroll, arrow key pan), and cursor tracking. No React — all module-level singletons and pure functions.

## File Map

| File | Purpose |
|------|---------|
| `runtime/keyboard-manager.ts` | All keybinding dispatch: tool switches, modifiers, spacebar pan, paste routing |
| `runtime/InputManager.ts` | Sole DOM event registrar + modifier state owner (shift/ctrl/meta) |
| `runtime/cursor-tracking.ts` | Last cursor world position for paste placement |
| `runtime/viewport/zoom.ts` | Animated zoom: step, fit-to-bounds, reset, center-preserving transforms |
| `runtime/viewport/edge-scroll.ts` | Auto-pan near viewport edges during qualifying drags |
| `runtime/viewport/arrow-key-pan.ts` | Continuous arrow key panning with easeInQuad acceleration |

---

## InputManager — Event Registration & Modifier State

Single owner of ALL DOM event listeners. Forwards to CanvasRuntime (pointer/wheel/drop) and keyboard-manager (keydown/keyup/paste/blur).

### Event Registration

| Event | Target | Handler |
|-------|--------|---------|
| `pointerdown` | canvas | updateModifiers → runtime.handlePointerDown |
| `pointermove` | canvas | updateModifiers → runtime.handlePointerMove |
| `pointerup` | canvas | updateModifiers → runtime.handlePointerUp |
| `pointercancel` | canvas | runtime.handlePointerCancel |
| `pointerleave` | canvas | runtime.handlePointerLeave |
| `lostpointercapture` | canvas | runtime.handleLostPointerCapture |
| `wheel` | container | runtime.handleWheel |
| `pointerdown` (overlay) | container | MMB only, `.dom-overlay-root` target → runtime.handlePointerDown |
| `dragover` | canvas | preventDefault, dropEffect = 'copy' |
| `drop` | canvas | runtime.handleDrop |
| `keydown` | document | updateModifiers → handleKeyDown |
| `keyup` | document | updateModifiers → handleKeyUp |
| `paste` | document | handlePaste |
| `blur` | window | clearModifiers → handleBlur |

All pointer events registered with `{ passive: false }`.

### Modifier State

Three module-level booleans, updated from **both** pointer and keyboard events (always fresh regardless of input source):

| Getter | Tracks | Usage |
|--------|--------|-------|
| `isShiftHeld()` | Shift key | Multi-select additive click (SelectTool) |
| `isCtrlOrMetaHeld()` | Ctrl OR Meta | Universal shortcuts (Cmd+C on Mac, Ctrl+C on Windows) |
| `isCtrlHeld()` | Ctrl only (NOT Meta) | Connector snap suppression — Meta excluded because Cmd conflicts with macOS clipboard shortcuts |

`clearModifiers()` resets all three on window blur (prevents stuck state when user tabs away).

### Overlay Pointer Down

Special handler for middle-mouse-button (button === 1) on the container element. Only fires when target is inside `.dom-overlay-root` (Tiptap/CodeMirror overlay). Routes to `runtime.handlePointerDown` so MMB pan works even when clicking on DOM overlays.

---

## Keyboard Manager — Shortcut Dispatch

Pure dispatch logic — no DOM listeners. Receives forwarded events from InputManager.

### Guard Hierarchy

Processed top-to-bottom on every `keydown`. Early return at each level prevents lower handlers from firing.

**Guard 1 — Input Focus:**
Returns immediately if focus is on any of:
- `HTMLInputElement` or `HTMLTextAreaElement`
- Any element with `isContentEditable`
- `document.activeElement` is contentEditable
- `textTool.isEditorMounted()` (Tiptap overlay active)
- `codeTool.isEditorMounted()` (CodeMirror overlay active)

This lets Tiptap handle its own Cmd+B/I natively. Keyboard-manager shortcuts only fire when no text editor has focus.

**Guard 2 — Room Check:**
Returns if `hasActiveRoom()` is false.

**Guard 3 — Modifier First:**
If `metaKey || ctrlKey` → `handleModifierShortcut()` and return. Disambiguates Cmd+C from bare `c`.

**Guard 4 — Escape (always handled):**
Layered cancel: active gesture → `tool.cancel()`, else selected objects → `clearSelection()`.

**Guard 5 — Spacebar:**
Activates ephemeral pan mode. Guards: not key repeat, not already in pan mode, no active gesture, not editing text.

**Guard 6 — Arrow Keys:**
Starts continuous pan. Guards: not repeat, no active gesture, not editing, not in spacebar pan.

**Guard 7 — Gesture/Editing Block:**
If gesture active OR text editing → return. Blocks all remaining bare keys.

**Guard 8 — Bare Key Dispatch:**
Tool switches, shape variants, delete, enter-to-edit, image picker.

### Complete Keybinding Reference

#### Tool Switches (Bare Keys)

| Key | Tool | Notes |
|-----|------|-------|
| `v` | select | |
| `p` | pen | |
| `e` | eraser | |
| `t` | text | |
| `n` | note | Maps to TextTool internally |
| `h` | pan (hand) | |
| `a` | connector (arrow) | |
| `r` | shape: rectangle | Sets tool + variant |
| `o` | shape: ellipse | Sets tool + variant |
| `d` | shape: diamond | Sets tool + variant |
| `i` | image file picker | One-shot action, not a tool switch |

#### Modifier Shortcuts (Cmd/Ctrl + Key)

| Shortcut | Action | Gesture Behavior |
|----------|--------|-----------------|
| `Cmd+C` | Copy selected | Works anytime |
| `Cmd+X` | Cut selected | Works anytime |
| `Cmd+V` | Paste | Handled via DOM paste event, not here |
| `Cmd+D` | Duplicate selected | Blocked during active gesture |
| `Cmd+A` | Select all | Cancels non-select tool gesture first |
| `Cmd+Z` | Undo | Mid-gesture: cancels the gesture *instead of* undoing (the cancel is the undo). No history pop. |
| `Cmd+Shift+Z` | Redo | Ignored during gesture — gesture continues, no redo |
| `Cmd+Y` | Redo | Ignored during gesture — gesture continues, no redo |
| `Cmd+B` | Toggle bold | Blocked during gesture |
| `Cmd+I` | Toggle italic | Blocked during gesture |
| `Cmd+H` | Toggle highlight | Blocked during gesture; uses `computeUniformInlineStyles()` for toggle detection |
| `Cmd+=` / `Cmd++` | Zoom in | `e.preventDefault()` blocks browser zoom |
| `Cmd+-` | Zoom out | `e.preventDefault()` blocks browser zoom |
| `Cmd+0` | Reset zoom to 100% | Animated |

#### Action Keys (Bare)

| Key | Action | Conditions |
|-----|--------|------------|
| `Delete` / `Backspace` | Delete selected objects | Requires selection |
| `Enter` | Edit selected text/shape/note | Single selection only, select tool only, text/shape/note kind |
| `Escape` | Cancel gesture → clear selection | Layered: gesture first, then selection |
| `Space` (hold) | Ephemeral pan mode | See spacebar pan section |
| `Arrow keys` (hold) | Continuous pan | See arrow key pan section |

### Paste Handler

`handlePaste(e: ClipboardEvent)`:
- Same input focus guard as keydown
- Checks `clipboardData.files` for OS file paste (image types) → `pasteImage(file)`
- Falls back to `pasteFromClipboard()` for all other paste paths
- `Cmd+V` is intentionally NOT in `handleModifierShortcut()` — the DOM paste event fires naturally from the Cmd+V keypress, and using the paste event gives access to `clipboardData.files` for OS file paste

### Key Up & Blur

`handleKeyUp`:
- Space release → exit spacebar pan mode, clear cursor override (unless panTool mid-drag)
- Arrow key release → `stopDirection(key)` in arrow-key-pan

`handleBlur`:
- Exit spacebar pan mode if active
- `stopAll()` on arrow-key-pan (clear stale held-key state)

---

## Spacebar Ephemeral Pan

Hold-to-pan without switching `activeTool`. Follows Figma/Excalidraw convention.

### State
Module-level `spacebarPanMode` boolean + exported `isSpacebarPanMode()` getter.

### Lifecycle

| Event | Action |
|-------|--------|
| `keydown` (space) | Set `spacebarPanMode = true`, `setCursorOverride('grab')`. Guards: no key repeat, no active gesture, not editing text. |
| `keyup` (space) | Clear `spacebarPanMode`. If panTool not mid-drag → clear cursor override. If mid-drag → panTool continues until pointerup. |
| `blur` (window) | Clear stale state. |

### CanvasRuntime Integration

- **handlePointerDown**: After MMB check, before left-click dispatch — if `button === 0 && isSpacebarPanMode()`, routes to `panTool.begin()`.
- **handlePointerMove**: If `isSpacebarPanMode()` and panTool not active, returns early to suppress tool hover dispatch (prevents SelectTool from clearing the grab cursor).
- **handlePointerUp**: After `panTool.end()`, if `isSpacebarPanMode()`, restores `setCursorOverride('grab')` (open hand between drags).

### Bare Key Blocking
`handleBareKey()` early-returns if `spacebarPanMode` — all tool switch keys blocked during space-hold.

---

## Text Formatting Shortcuts

`Cmd+B`, `Cmd+I`, `Cmd+H` toggle formatting on selected objects.

### During Text Editing
Guard 1 (input focus) catches Tiptap's contentEditable focus → Tiptap handles Cmd+B/I natively. `Cmd+H` isn't a default Tiptap keybinding (Tiptap uses Cmd+Shift+H), so it's keyboard-manager-only.

### Canvas Selection (Not Editing)
Calls `toggleSelectedBold()`, `toggleSelectedItalic()`, or `setSelectedHighlight()` from `selection-actions.ts`. These work on text objects, shapes with labels, and mixed selections.

### Highlight Toggle Logic
Keyboard-manager computes `computeUniformInlineStyles(selectedIds, objectsById)` live — doesn't read cached inline styles from the selection store (which returns `EMPTY_INLINE_STYLES` for mixed selections). If all selected text is already highlighted → remove. Otherwise → apply device-ui-store `highlightColor` (default `#ffd43b`).

---

## Cursor Tracking

Minimal module: `lastCursorWorld: [number, number] | null`.

- `setLastCursorWorld(pos)` — called by `CanvasRuntime.handlePointerMove()` after screenToWorld conversion
- `getLastCursorWorld()` — read by clipboard paste for cursor-position placement

Returns null if the cursor has never entered the canvas (paste falls back to viewport center).

---

## Zoom System (`viewport/zoom.ts`)

Animated zoom with easeOutCubic easing over 180ms. Module-level RAF animation state with seamless mid-animation retargeting.

### Zoom Steps
Predefined log-spaced percentages: `[0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5]`

Step tolerance (STEP_EPS): 0.005 for "at this step" comparisons.

### Rapid Click Accumulation
`pendingStep` stores the target from the last step request. Rapid `zoomIn()`/`zoomOut()` calls use `pendingStep` as the base (if ahead/behind current scale), allowing fast clicks to jump multiple steps without waiting for animation completion.

### Center Preservation
`calculateZoomTransform(currentScale, currentPan, zoomFactor, zoomCenter)` computes new scale + pan such that world coordinates under the zoom center remain fixed. Used by both step zoom (viewport center) and pinch zoom (pinch midpoint).

### Public API

| Function | Behavior |
|----------|----------|
| `zoomIn()` | Next step from current/pending scale, centered on viewport |
| `zoomOut()` | Previous step, centered on viewport |
| `zoomTo(targetScale)` | Animate to specific scale, centered on viewport |
| `animateZoomReset()` | Animate to scale=1, pan={0,0} |
| `animateToFit(bounds, padding, maxScale, minScale)` | Fit world bounds in viewport. Floor applied first, then cap — "never zoom in" always wins. |
| `animateZoom(toScale, toPan)` | Low-level: animate to target. Retargets seamlessly mid-animation. |
| `cancelZoom()` | Cancel in-progress animation |
| `clampScale(scale)` | Clamp to MIN_ZOOM/MAX_ZOOM from camera store |

### Fit-to-Bounds

`animateToFit(bounds, padding=80, maxScale=Infinity, minScale=0)`:
- Computes fitting scale: `min((width - 2*padding) / boundsW, (height - 2*padding) / boundsH)`
- Applies: `clampScale(min(max(fitScale, minScale), maxScale))`
- Centers camera on bounds midpoint
- Used by clipboard paste (`ensureVisible`) with maxScale=currentScale (only zoom out), minScale=0.25

---

## Edge Scrolling (`viewport/edge-scroll.ts`)

Auto-pan when pointer nears viewport edge during qualifying tool drags.

### Eligibility
Only active during `select`, `connector`, or `shape` tool drags (tool must be active). Pen, highlighter, eraser, text, pan, code, note are excluded.

### Proximity Model

40px edge zone from each viewport edge. `computeProximity(pos, size)` returns a signed normalized value:
- `0` — pointer in interior (no scroll)
- `-1` to `0` — pointer approaching min edge (left/top)
- `0` to `1` — pointer approaching max edge (right/bottom)
- Beyond viewport bounds: clamped at ±1

Proximity is **squared** before applying to speed — fine-grained control at low proximity (entering zone at 0.25 → 0.0625 factor), steeper at edge (1.0 → 1.0 factor).

### Timing

| Phase | Duration | Behavior |
|-------|----------|----------|
| **Delay** | 120ms | No scrolling — prevents accidental trigger |
| **Ramp** | 300ms | easeInQuad acceleration (t² curve) |
| **Full speed** | After 420ms | Proximity² × BASE_SPEED at full easing |

### Speed

`BASE_SPEED = 9` CSS px per 16ms tick (~540 CSS px/s max at proximity=1, full easing).

All speeds are screen-space (÷ scale for world delta) — consistent visual speed regardless of zoom level.

**Small screen factor**: 0.65× per axis when viewport dimension < 1000px.

### Tool Re-dispatch

After each pan, the module:
1. Calls `screenToWorld(lastClientX, lastClientY)` to get updated world coordinates
2. Updates cursor tracking via `setLastCursorWorld(world)`
3. Calls `getCurrentTool()?.move(world[0], world[1])` to update the active tool

Safe for all eligible tools — SelectTool translate/scale/marquee, ConnectorTool snap+routing, DrawingTool shape preview all update naturally.

### CanvasRuntime Integration

| Call Site | Action |
|-----------|--------|
| `handlePointerMove` | `updateEdgeScroll(clientX, clientY)` — updates proximity + starts/stops RAF |
| `handlePointerUp` | `stopEdgeScroll()` |
| `handlePointerCancel` | `stopEdgeScroll()` |
| `handleLostPointerCapture` | `stopEdgeScroll()` |
| `stop()` (runtime teardown) | `stopEdgeScroll()` |
| Camera subscription | `isEdgeScrolling()` guard prevents redundant `tool.onViewChange()` calls (tool already re-dispatched immediately after pan) |

### Stop Conditions
Pointer up/cancel/lost-capture, runtime stop, eligibility loss (tool change, gesture end), or pointer returning to interior (delay resets on re-entry).

---

## Arrow Key Pan (`viewport/arrow-key-pan.ts`)

Smooth continuous canvas pan while arrow keys are held. Own RAF loop, independent from edge scroll.

### Speed & Acceleration
- **Base speed**: 800 CSS px/s at full acceleration
- **Start fraction**: 25% of base speed (200 CSS px/s)
- **Ramp**: easeInQuad over 400ms from 25% → 100%
- **Scale-adjusted**: world speed = computed speed ÷ camera scale
- **Diagonal normalization**: direction vector normalized per-tick to prevent 1.41× speed

### Guards (in keyboard-manager)
- Key repeat events ignored (only initial keydown starts a direction)
- Blocked during: active gesture, text editing, spacebar pan mode
- `stopDirection(key)` on keyup, `stopAll()` on window blur (clears stale held-key state)

### Direction Tracking
Module-level `Set<string>` of held direction keys. RAF loop runs while set is non-empty. Delta time capped at 50ms to prevent large jumps after tab-away.

Pan direction matches "grab" semantics: ArrowRight → content moves right (pan.x increases).

---

## CanvasRuntime Event Flow

```
User Input → InputManager (DOM events)
  ├── Pointer events → updateModifiers() → CanvasRuntime.*
  │     ├── handlePointerDown → spacebar pan check → MMB pan → tool dispatch
  │     ├── handlePointerMove → cursor tracking + edge scroll + tool.move()
  │     ├── handlePointerUp → tool.end() + stopEdgeScroll
  │     └── handleWheel → zoom (velocity boost + Ctrl pinch)
  │
  ├── Keyboard events → updateModifiers() → keyboard-manager.*
  │     ├── handleKeyDown → guard hierarchy → modifier/bare dispatch
  │     ├── handleKeyUp → spacebar release + arrow key release
  │     └── handleBlur → clear all ephemeral state
  │
  └── Paste event → keyboard-manager.handlePaste → clipboard-actions
```

