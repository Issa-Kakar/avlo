# Keyboard Shortcuts & Clipboard System

## What Changed

### Keyboard shortcuts moved from React hook to imperative module

- **Deleted** `useKeyboardShortcuts` hook and `useUndoRedo` hook
- **Created** `canvas/keyboard-manager.ts` — flat module with `attach()`/`detach()` lifecycle, wired through `CanvasRuntime.start()`/`stop()`
- Proper guard hierarchy: input focus > modifier keys > gesture-active > bare keys
- Bare key shortcuts (tool switches, delete, enter) blocked during active gestures and text editing
- Modifier shortcuts (Cmd+C/V/X/D/A/Z) work anytime (copy/paste even mid-gesture)

### Undo/redo decoupled from React

- `ToolPanel` buttons now call `getActiveRoomDoc().undo()/redo()` directly
- `RoomPage` no longer passes undo/redo callbacks as props
- Keyboard Cmd+Z / Cmd+Shift+Z / Cmd+Y handled in keyboard-manager

### New keybindings

| Key              | Modifier | Action                                                         |
| ---------------- | -------- | -------------------------------------------------------------- |
| Delete/Backspace | —        | Delete selected objects                                        |
| Enter            | —        | Edit selected text/shape label (single selection, select tool) |
| Escape           | —        | Cancel gesture, then clear selection                           |
| Cmd+C            | —        | Copy selected objects                                          |
| Cmd+V            | —        | Paste (internal or external text)                              |
| Cmd+X            | —        | Cut (copy + delete)                                            |
| Cmd+D            | —        | Duplicate at +20,+20 offset                                    |
| Cmd+A            | —        | Select all objects                                             |

### Clipboard system

- **`lib/clipboard/clipboard-serializer.ts`** — serialize/deserialize Y.Map objects and Y.XmlFragment content to JSON
- **`lib/clipboard/clipboard-actions.ts`** — copy, paste, cut, duplicate, selectAll
- **Nonce-based ordering**: copy writes `<!-- avlo:UUID -->` in HTML; paste checks nonce to distinguish internal vs external clipboard content
- **Internal paste**: full-fidelity object duplication with new IDs, connector anchor remapping, position offset to cursor or viewport center
- **External text paste**: creates text object with device-ui-store font preferences
- **Mid-gesture paste**: objects created silently without switching tools or selecting; tool switch + selection only happens when idle

### Cursor position tracking

- **`canvas/cursor-tracking.ts`** — module-level last cursor world position
- Updated in `CanvasRuntime.handlePointerMove()`, used by paste for cursor-position placement

### Parallel worktree dev server

- `vite.config.ts` now reads `VITE_PORT` and `WORKER_PORT` env vars (defaults: 3000/8787)
- Added `npm run dev:p` — runs client on :3001, worker on :8788 for parallel worktree development

---

## Clipboard & Duplicate UX Improvements (v2)

### Ctrl+A mid-gesture fix

Pressing Cmd+A while a non-select tool is mid-gesture (e.g. drawing a stroke) now cancels that gesture before calling `selectAll()`. Previously, `selectAll()` force-switched to the select tool but left the drawing tool's internal state active — switching back to pen would continue the stale stroke. The cancel is skipped when the active tool is already select, since SelectTool's own gesture (marquee, translate) is harmless to interrupt via selection change.

**Where:** `keyboard-manager.ts` Cmd+A handler adds `tool.cancel()` guard.

### Rich text paste from external sources

Pasting HTML from browsers, Google Docs, Notion, etc. now preserves **bold**, **italic**, and **highlight** formatting. The flow:

1. `pasteFromClipboard()` reads `text/html` from the clipboard
2. If the HTML contains an avlo nonce → internal paste (unchanged)
3. Otherwise → `pasteExternalHtml(html)`:
   - Strips any stale avlo nonce comment
   - Extracts plain text for character limit check (>50k chars → truncated plain text fallback)
   - Parses HTML via `generateJSON()` from `@tiptap/core` using the same extension set the editor uses (Document, Paragraph, Text, Bold, Italic, Highlight with multicolor)
   - `prosemirrorJsonToFragment()` walks the ProseMirror JSON doc and builds a `Y.XmlFragment` with proper delta attributes: `bold: true`, `italic: true`, `highlight: '#hex'`
   - Falls back to plain text paste if parsing fails or produces empty content

If the clipboard has no `text/html` type (e.g. terminal copy), plain text paste still works as before.

### Text paste width — font-size aware with auto for short text

Previously pasted text used `width: 'auto'`, causing single-line text to stretch infinitely without wrapping.

Now:

- **Short text (< 65 chars):** `width: 'auto'` — natural sizing, no awkward wide box for a single word or sentence
- **Longer text (>= 65 chars):** `width = max(300, fontSize * 34)` — gives ~65 characters per line at any font size. Examples: fontSize 24 → 816wu, fontSize 64 → 2176wu, fontSize 10 → 340wu (floor 300)

### Character limit on paste

Both `pasteExternalText` and `pasteExternalHtml` enforce a 50,000 character limit. Plain text is silently truncated; HTML that exceeds the limit falls back to truncated plain text. No toast — avoids coupling to React context from the imperative clipboard module.

### Smart duplicate placement

`Cmd+D` no longer uses a naive `[20, 20]` offset. `computeSmartOffset()` queries the spatial index and tries four directions in priority order:

1. **Right** of selection bounds (width + 20px gap)
2. **Below** (height + 20px gap)
3. **Above**
4. **Left**

For each direction, a candidate bounding box is queried against the R-tree spatial index (with 2px epsilon expansion to avoid edge-touching false negatives). Objects in the current selection are excluded. The first direction with zero collisions wins. If all four directions are occupied, falls back to `[40, 40]` diagonal offset.

### Zoom-to-fit for out-of-view content

After paste or duplicate, `ensureVisible(bounds)` checks whether the placed content is **fully contained** within the current viewport. If any edge extends beyond the viewport (even partially), the camera animates to fit:

- **Only zooms out, never in** — `maxScale` is capped at the current camera scale
- **Reasonable floor** — `minScale` is floored at 0.25 (25%), so pasting enormous content doesn't zoom to a microscopic view. The camera centers on the content at 25% even if it can't fully fit
- **Skipped for short text** — auto-width pastes (< 65 chars) don't trigger visibility checks since the paste target is always at the cursor or viewport center

The `animateToFit()` function in `ZoomAnimator.ts` accepts `maxScale` and `minScale` parameters. The floor is applied first, then capped by max — this means "never zoom in" always wins over the floor when the user is already zoomed out past 25%.

### Shared text object creation

Extracted `createPastedTextObject(fragment, charCount)` as a shared helper used by both `pasteExternalText` and `pasteExternalHtml`. Handles: reading device-ui-store text prefs, computing paste width, creating the Y.Map, post-paste tool switch + selection, and visibility check.

## Files (v1–v2)

| File                                               | Action                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `client/src/canvas/keyboard-manager.ts`            | Created; v2: Cmd+A cancels non-select tool gesture                                    |
| `client/src/canvas/cursor-tracking.ts`             | Created                                                                               |
| `client/src/lib/clipboard/clipboard-serializer.ts` | Created                                                                               |
| `client/src/lib/clipboard/clipboard-actions.ts`    | Created; v2: rich text paste, smart duplicate, paste width, char limit, ensureVisible |
| `client/src/canvas/animation/ZoomAnimator.ts`      | Modified — new `animateToFit(bounds, padding, maxScale, minScale)`                    |
| `client/src/canvas/CanvasRuntime.ts`               | Modified — keyboard + cursor tracking                                                 |
| `client/src/components/RoomPage.tsx`               | Modified — removed hooks                                                              |
| `client/src/components/ToolPanel.tsx`              | Modified — direct undo/redo                                                           |
| `client/vite.config.ts`                            | Modified — env-based ports                                                            |
| `package.json`                                     | Modified — dev:p scripts                                                              |
| `client/src/hooks/useKeyboardShortcuts.ts`         | Deleted                                                                               |
| `client/src/hooks/use-undo-redo.ts`                | Deleted                                                                               |

---

## Keyboard Shortcuts & Selection Improvements (v3)

### Tool keybinding overhaul

Remapped to match Excalidraw/tldraw conventions. Spacebar removed as a tool switch (now ephemeral pan).

| Key | Before       | After                |
| --- | ------------ | -------------------- |
| `h` | highlighter  | pan (hand)           |
| `a` | —            | connector (arrow)    |
| `c` | connector    | — (removed)          |
| `r` | —            | shape: rectangle     |
| `o` | —            | shape: ellipse       |
| `d` | —            | shape: diamond       |
| ` ` | pan (switch) | ephemeral pan (hold) |

Highlighter loses its keybinding since `h` was reassigned.

Shape keys (`r`/`o`/`d`) call both `setActiveTool('shape')` and `setShapeVariant(variant)` — two store writes per press. A new `SHAPE_KEYS` map sits alongside `TOOL_KEYS` in `handleBareKey`.

### Spacebar ephemeral pan

Hold-to-pan without switching `activeTool`. Follows Figma/Excalidraw convention: hold space, grab cursor appears, click+drag pans, release mouse shows open hand, release space restores tool cursor.

**State:** Module-level `spacebarPanMode` boolean + exported `isSpacebarPanMode()` getter.

**Lifecycle:**

- `onKeyDown` (space): sets `spacebarPanMode = true`, `setCursorOverride('grab')`. Guards: `e.repeat` prevents key-repeat re-entry, `!gestureActive` prevents interrupting active tool gestures, `!isEditing` prevents activation during text editing. Input focus guard at top of `onKeyDown` already prevents activation during Tiptap contentEditable focus.
- `onKeyUp` (space): clears `spacebarPanMode`. If panTool not mid-drag, clears cursor override. If mid-drag, panTool continues until pointerup (standard Figma behavior).
- `onBlur` (window): clears stale state when user tabs away.
- `handleBareKey`: early-returns if `spacebarPanMode` — all bare keys blocked during space-hold.

**CanvasRuntime integration:**

- `handlePointerDown`: after MMB check, before left-click dispatch — if `button === 0 && isSpacebarPanMode()`, routes to `panTool.begin()`.
- `handlePointerMove`: after pan-active check — if `isSpacebarPanMode()`, returns early to suppress tool hover dispatch (prevents `SelectTool.handleHoverCursor()` from calling `setCursorOverride(null)` and killing the grab cursor).
- `handlePointerUp`: after `panTool.end()` — if `isSpacebarPanMode()`, restores `setCursorOverride('grab')` (open hand between drags).

**Keyboard-manager lifecycle expanded:** `attach()` now registers `keydown`, `keyup`, and window `blur`. `detach()` removes all three.

### Ctrl+B/I/H text formatting shortcuts

Added to `handleModifierShortcut` in keyboard-manager. Works on selected text objects, shapes with labels, and mixed selections containing text.

| Shortcut | Action                                    |
| -------- | ----------------------------------------- |
| Cmd+B    | Toggle bold on all text in selection      |
| Cmd+I    | Toggle italic on all text in selection    |
| Cmd+H    | Toggle highlight on all text in selection |

**During text editing:** Guard 1 (input focus check) catches contentEditable focus, so Tiptap handles Cmd+B/I natively. These handlers only fire for non-editing selection. Cmd+H isn't a default Tiptap keybinding (Tiptap uses Cmd+Shift+H for highlight), so it's keyboard-manager-only.

**Toggle logic — live computation for mixed selections:**

The toggle functions (`toggleSelectedBold`, `toggleSelectedItalic`) and the Cmd+H handler previously read cached `inlineStyles` from the selection store. For mixed selections (`selectionKind === 'mixed'`), inline styles are not tracked — the store always returns `EMPTY_INLINE_STYLES` (bold=false, italic=false, highlightColor=null). This meant toggling always applied the "set" path and never the "unset" path.

Fix: all three now compute inline styles live via `computeUniformInlineStyles(ids, objectsById)` instead of reading the store cache. This iterates selected text-capable objects and reads from the text layout cache — fast enough for keyboard-triggered actions. For homogeneous selections (textOnly/shapesOnly), the live result matches the cached store. For mixed, it now correctly detects whether all text is already bold/italic/highlighted and unsets accordingly.

- `toggleSelectedBold/Italic` in `selection-actions.ts`: replaced `useSelectionStore.getState().inlineStyles.bold/italic` with destructured result from `computeUniformInlineStyles(ids, objectsById)`.
- Cmd+H in `keyboard-manager.ts`: computes `computeUniformInlineStyles(selectedIds, objectsById).highlightColor` to decide set vs unset. Falls back to device-ui-store `highlightColor` or `#ffd43b` for the "set" path.

### Shift/Ctrl+click multi-select

Additive and subtractive click selection, matching standard whiteboard behavior.

**Pointer modifier tracking** (`cursor-tracking.ts`): new `storePointerModifiers(e)` captures `shiftKey` and `ctrlKey||metaKey` at pointerdown time. Exported getters `isShiftPointer()` and `isCtrlOrMetaPointer()`. Called at the top of `CanvasRuntime.handlePointerDown` before any routing.

**SelectTool changes** (`SelectTool.ts`): private `hasAddModifier()` returns `isShiftPointer() || isCtrlOrMetaPointer()`. Only the `end()` method's `pendingClick` phase changes — `begin()`, drag transitions, marquee, translate, scale all unchanged.

| Case                           | Without modifier (unchanged)          | With shift/ctrl                          |
| ------------------------------ | ------------------------------------- | ---------------------------------------- |
| `objectOutsideSelection`       | Replace selection with clicked object | Add clicked object to existing selection |
| `objectInSelection` (multi)    | Drill down to single object           | Remove clicked object from selection     |
| `objectInSelection` (single)   | Start text/label editing              | Remove → `clearSelection()`              |
| `background`                   | Clear selection                       | Clear selection (unchanged)              |
| `selectionGap`                 | Clear on quick tap                    | Clear on quick tap (unchanged)           |
| `handle` / `connectorEndpoint` | No-op / drill down                    | No-op / drill down (unchanged)           |

### Ctrl suppresses connector snapping

Holding Ctrl during connector creation or endpoint drag prevents binding to shapes. `isCtrlHeld()` (live Ctrl state from `cursor-tracking.ts`, updated every pointer event) is checked before each `findBestSnapTarget()` call — when true, snap is forced to `null`, producing a free (unanchored) endpoint with no snap dots.

| Tool          | Call site             | Effect                                                |
| ------------- | --------------------- | ----------------------------------------------------- |
| ConnectorTool | `begin()`             | Start endpoint stays free even if clicking on a shape |
| ConnectorTool | `move()` idle         | No hover snap dots shown on shapes                    |
| ConnectorTool | `move()` creating     | End endpoint stays free, no snap dots                 |
| SelectTool    | `move()` endpointDrag | Dragged endpoint stays free, no snap dots             |

Release Ctrl mid-drag to resume snapping immediately.

### Files (v3)

| File                                        | Changes                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/src/canvas/keyboard-manager.ts`     | TOOL_KEYS/SHAPE_KEYS remapped, spacebar pan (keydown+keyup+blur lifecycle), Cmd+B/I/H handlers, `isSpacebarPanMode` export, bare key block during space-hold |
| `client/src/canvas/CanvasRuntime.ts`        | Spacebar pan routing in handlePointerDown/Up, `storePointerModifiers` call, `isSpacebarPanMode` hover suppression in handlePointerMove                       |
| `client/src/canvas/cursor-tracking.ts`      | Added `storePointerModifiers`, `isShiftPointer`, `isCtrlOrMetaPointer`                                                                                       |
| `client/src/lib/tools/SelectTool.ts`        | Import modifier getters, `hasAddModifier` helper, additive/subtractive logic in `end()` pendingClick                                                         |
| `client/src/lib/utils/selection-actions.ts` | `toggleSelectedBold/Italic` compute inline styles live via `computeUniformInlineStyles`                                                                      |
