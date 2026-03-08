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

## Files

| File                                               | Action                                |
| -------------------------------------------------- | ------------------------------------- |
| `client/src/canvas/keyboard-manager.ts`            | Created                               |
| `client/src/canvas/cursor-tracking.ts`             | Created                               |
| `client/src/lib/clipboard/clipboard-serializer.ts` | Created                               |
| `client/src/lib/clipboard/clipboard-actions.ts`    | Created                               |
| `client/src/canvas/CanvasRuntime.ts`               | Modified — keyboard + cursor tracking |
| `client/src/components/RoomPage.tsx`               | Modified — removed hooks              |
| `client/src/components/ToolPanel.tsx`              | Modified — direct undo/redo           |
| `client/vite.config.ts`                            | Modified — env-based ports            |
| `package.json`                                     | Modified — dev:p scripts              |
| `client/src/hooks/useKeyboardShortcuts.ts`         | Deleted                               |
| `client/src/hooks/use-undo-redo.ts`                | Deleted                               |
