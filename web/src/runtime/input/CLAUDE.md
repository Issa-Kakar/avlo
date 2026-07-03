# Input & Keyboard Subsystem

Imperative modules for keyboard-shortcut dispatch, DOM event registration, modifier-state tracking, toolbar drag-place entry, browser-zoom blocking, and cursor tracking. No React — all module-level singletons and pure functions. Camera motion (zoom / edge-scroll / arrow-key pan) lives in `../viewport`; this layer only *triggers* it.

## File Map

| File | Purpose |
|------|---------|
| `keyboard-manager.ts` | All keybinding dispatch: tool switches, modifiers, spacebar pan, paste routing |
| `InputManager.ts` | Sole DOM event registrar + modifier state owner (shift/ctrl/meta) |
| `toolbar-place.ts` | Drag-place entry from inspector buttons — applies selection, `beginPlace` on the tool singleton, pointer capture to canvas |
| `install-ui-zoom-block.ts` | Page-zoom block: window-capture wheel+ctrl, Cmd/Ctrl + plus/minus/equal/0, Safari gesturestart; install/dispose by CanvasRuntime, scoped to canvas-room |
| `cursor-tracking.ts` | Last cursor world position for paste placement |

Camera motion: `../viewport/{zoom,edge-scroll,arrow-key-pan}.ts` — see `../viewport/CLAUDE.md`.

---

## InputManager — Event Registration & Modifier State

Single owner of ALL DOM event listeners. Forwards to CanvasRuntime (canvas pointer/wheel/drop), keyboard-manager (keydown/keyup/paste/blur), and presence-pointer (document pointermove/pointerout, plus window blur).

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
| `pointermove` (presence) | document | handlePresencePointerMove → broadcast world cursor |
| `pointerout` (presence) | document | handlePresencePointerOut → clearCursor on window exit |
| `blur` | window | clearModifiers → handleBlur → handlePresenceBlur |

All **canvas** pointer events registered with `{ passive: false }`; the two **document** presence pointer listeners use `{ passive: true }` (they never `preventDefault`).

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
Starts continuous pan (`../viewport/arrow-key-pan.ts`). Guards: not repeat, no active gesture, not editing, not in spacebar pan.

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
| `3` | shape: triangle | Sets tool + variant |
| `i` | image file picker | One-shot action, not a tool switch |

#### Modifier Shortcuts (Cmd/Ctrl + Key)

| Shortcut | Action | Gesture Behavior |
|----------|--------|-----------------|
| `Cmd+C` | Copy selected | Works anytime |
| `Cmd+X` | Cut selected | Blocked during active gesture |
| `Cmd+V` | Paste | Handled via DOM paste event, not here |
| `Cmd+D` | Duplicate selected | Blocked during active gesture |
| `Cmd+A` | Select all | Cancels non-select tool gesture first |
| `Cmd+Z` | Undo | Mid-gesture: cancels the gesture *instead of* undoing (the cancel is the undo). No history pop. |
| `Cmd+Shift+Z` | Redo | Ignored during gesture — gesture continues, no redo |
| `Cmd+Y` | Redo | Ignored during gesture — gesture continues, no redo |
| `Cmd+B` | Toggle bold | Blocked during gesture |
| `Cmd+I` | Toggle italic | Blocked during gesture |
| `Cmd+H` | Toggle highlight | Blocked during gesture; uses `computeUniformInlineStyles()` for toggle detection |
| `Cmd+=` / `Cmd++` | Zoom in (`../viewport/zoom.ts`) | `e.preventDefault()` blocks browser zoom |
| `Cmd+-` | Zoom out (`../viewport/zoom.ts`) | `e.preventDefault()` blocks browser zoom |
| `Cmd+0` | Reset zoom to 100% | Animated |

#### Action Keys (Bare)

| Key | Action | Conditions |
|-----|--------|------------|
| `Delete` / `Backspace` | Delete selected objects | Requires selection |
| `Enter` | Edit selected text/shape/note/code | Single selection, select tool only. text/shape/note → textTool; code → codeTool |
| `Escape` | Cancel gesture → clear selection | Layered: gesture first, then selection |
| `Space` (hold) | Ephemeral pan mode | See spacebar pan section |
| `Arrow keys` (hold) | Continuous pan | `../viewport/arrow-key-pan.ts` |

### Paste Handler

`handlePaste(e: ClipboardEvent)`:
- Same input focus + active-room guards as keydown
- `e.preventDefault()` (clipboard-actions handles all paste paths itself)
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
Keyboard-manager computes `computeUniformInlineStyles(selectedIds)` live — doesn't read cached inline styles from the selection store (which returns `EMPTY_INLINE_STYLES` for mixed selections). If all selected text is already highlighted → remove. Otherwise → apply device-ui-store `highlightColor` (default `#ffd43b`).

---

## Toolbar Drag-Place (`toolbar-place.ts`)

Entry points for placing a shape / sticky note by dragging off an inspector button (`beginShapePlace`, `beginNotePlace`). Each: applies the selection (variant / fill) up front so a sub-threshold release degrades to click semantics, guards on `isSpacebarPanMode()` + `tool.canBegin()`, then `beginPlace` on the tool singleton and captures the pointer to the canvas — every subsequent move/up retargets through the normal InputManager → CanvasRuntime → tool dispatch. Imported by `components/toolbar/inspectors/{ShapeInspector,StickyNotePanel}.tsx`.

---

## Cursor Tracking

Minimal module: `lastCursorWorld: [number, number] | null`.

- `setLastCursorWorld(pos)` — called by `CanvasRuntime.handlePointerMove()` after screenToWorld conversion, and by `../viewport/edge-scroll.ts` after each auto-pan tick
- `getLastCursorWorld()` — read by clipboard paste for cursor-position placement

Returns null if the cursor has never entered the canvas (paste falls back to viewport center).

---

## CanvasRuntime Event Flow

```
User Input → InputManager (DOM events)
  ├── Canvas pointer events → updateModifiers() → CanvasRuntime.*
  │     ├── handlePointerDown → spacebar pan check → MMB pan → tool dispatch
  │     ├── handlePointerMove → cursor tracking + edge scroll + tool.move()
  │     ├── handlePointerUp → tool.end() + stopEdgeScroll
  │     └── handleWheel → ctrl: pinch-zoom (both modes) / plain: mouse→wheel-zoom, trackpad→pan
  │
  ├── Document presence pointer → presence-pointer.*
  │     ├── handlePresencePointerMove → screenToWorldInto → updateCursor
  │     ├── handlePresencePointerOut → clearCursor (on genuine window exit)
  │     └── handlePresenceBlur → clearCursor (window blur; via onBlur)
  │
  ├── Keyboard events → updateModifiers() → keyboard-manager.*
  │     ├── handleKeyDown → guard hierarchy → modifier/bare dispatch
  │     ├── handleKeyUp → spacebar release + arrow key release
  │     └── handleBlur → clear all ephemeral state
  │
  └── Paste event → keyboard-manager.handlePaste → clipboard-actions
```
