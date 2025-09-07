# Phase 9 – Final Implementation Plan (UI only)

> **Scope guard (critical):** Phase 9 is **UI-only**. **Exclude**: Phase 7 (presence/awareness, cursors, avatars syncing) and Phase 8 (RBush/spatial index, hit-testing optimizations). You may reference the manager API **read-only** for render triggers. We **will** include: header Clear button, minimap header + collapse/expand, **draggable toolbar**, and **bottom-center dock** for pen/highlighter settings.

---

## Objectives

1. **Port improved HTML layout** into a modular React page (`RoomPage`) with pixel-accurate styling.
2. **Move Clear Board to header** with confirm guard; toolbar no longer contains Clear.
3. **Minimap header & collapse**: headered minimap that collapses into a pill and expands back.
4. **Draggable toolbar**: bounded drag inside canvas container, persistent between sessions (localStorage now; later: per-room).
5. **Bottom-center dock** (Pen/Highlighter only): one-row, modern slider UI with **Color** (black→brand→white) and **Size** (px readout). Dock shows only when Pen/Highlighter is active.
6. **Keyboard shortcuts & a11y**: core hotkeys (P/H/E/T/V, Space, ⌘/Ctrl+±/0, ⌘/Ctrl+Z/⇧+⌘/Ctrl+Z, ⌘/Ctrl+K), aria labels, focus management.

---

## Deliverables

- `RoomPage` React view matching the provided HTML (light/dark supported via CSS vars).
- Component set: `Header`, `CanvasPane`, `ToolPanel`, `Minimap`, `ZoomControls`, `EditorPanel`, `AIPanel`, `Toast`, `UsersModal` (stub).
- **Zustand** UI store for Phase 9-only state (active tool, pen/highlighter settings, zoom, collapse flags, toolbar position).
- CSS port of the HTML token system + the new classes for minimap header, collapsed pill, tool dock, and draggable handle.
- Integration glue (read-only): hooks that subscribe to manager snapshot/gates; optional `clearScene?.()` call.

---

## File & Directory Layout

```
client/src/
  pages/RoomPage/
    RoomPage.tsx
    RoomPage.css
    components/
      Header.tsx
      CanvasPane.tsx
      ToolPanel.tsx
      Minimap.tsx
      ZoomControls.tsx
      EditorPanel.tsx
      AIPanel.tsx
      UsersModal.tsx
      Toast.tsx
      ColorSizeDock.tsx       // bottom-center dock (replaces modal for pen/highlighter)
  stores/
    toolbarStore.ts           // Phase 9 UI state only
  lib/
    useRoomDoc.ts             // read-only adapters to manager (snapshot/gates/clearScene?)
    useDraggableFloat.ts      // pointer events + rAF draggable helper (toolbar)
    keyboard.ts               // keymap + binding
```

---

## State Model (Zustand)

```ts
// stores/toolbarStore.ts
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'select' | 'pan';

interface ToolSettings {
  size: number;
  color: string;
  opacity?: number;
}
export interface ToolbarState {
  activeTool: Tool;
  pen: ToolSettings; // default {size:4, color:'#0F172A'}
  highlighter: ToolSettings; // default {size:8, color:'#F59E0B', opacity:0.25}
  eraser: { size: number };
  text: { size: number; color: string };
  zoom: number; // 1.0 = 100%
  editorCollapsed: boolean;
  minimapCollapsed: boolean;
  toolbarPos: { x: number; y: number }; // persisted to localStorage
  actions: {
    /* setters + toggles */
  };
}
```

- Persist with `persist` middleware under key `avlo.toolbar.v1`. In Phase 9, global persistence is fine; later, key by `roomId`.

---

## Interaction Contracts (Manager API)

**Read-only** subscriptions:

- `subscribeSnapshot(cb)` → triggers when the drawable scene updates (already present from earlier phases)
- `getLastSnapshot()` → current scene snapshot (for minimap/preview only; Phase 9 can fake viewport rect)
- `subscribeGates(cb)` / `gatesString()` → render gates if available (not required here)
- `clearScene?.()` → optional; if undefined, header Clear no-ops safely

No presence, awareness, selection overlays, or spatial index code in Phase 9.

---

## Components – Responsibilities & Acceptance

### `Header`

- Shows logo, editable room title, status chip, users stack (static), Share, Export, Theme, **Clear Board** button.
- **Clear Board**: confirm dialog → call `clearScene?.()`; show toast on success/no-op.
- **Done when** Clear is removed from toolbar; header layout matches HTML; keyboard `⌘/Ctrl+K` triggers clear.

### `CanvasPane`

- Hosts grid background + `<canvas>` element.
- Places floating children: `ToolPanel`, `Minimap`, `ZoomControls`, `ColorSizeDock`.
- Binds resize and DPR scaling for crisp canvas.
- **Done when** all floating elements position correctly and canvas scales on resize.

### `ToolPanel` (draggable)

- Vertical tool buttons; **no Clear**; Pen & Highlighter set active tool and **open/show dock**.
- **Drag** bounded within `.canvas-container`, persisted to localStorage.
- **Done when** drag is smooth (transform-based), persists across reload, and buttons reflect active tool.

### `ColorSizeDock` (bottom center)

- Hidden by default; **visible only** when tool ∈ {`pen`, `highlighter`}.
- **Color slider**: 0→black, 50→brand, 100→white; updates stroke color in real-time.
- **Size slider**: 1–20px with live px readout.
- Highlighter opacity enforced at render path (UI shows color only).
- **Done when** design matches sleek row, works in light/dark, keyboard-accessible.

### `Minimap`

- Has a **mini header** and collapse toggle; collapsed state becomes a **pill** labeled “Minimap”.
- Expanding restores header + content; viewport rect can be static in Phase 9.
- **Done when** collapse/expand is animated (opacity ok), pill reopens, and z-index sits above canvas.

### `ZoomControls`

- Buttons for ±; label shows 25–200%; optional reset (click label → 100%).
- Keyboard ± mirror buttons.
- **Done when** zoom value changes in store and label syncs.

### `EditorPanel` + `AIPanel` + `UsersModal` + `Toast`

- Mirror HTML structure; `EditorPanel` collapses via toggle.
- `UsersModal` can be a stub (no real presence list in Phase 9).

---

## Implementation Steps (Agent-Ready)

1. **Scaffold & Assets**
   - Create directories as above; copy HTML `<style>` into `RoomPage.css` and keep token variables.
   - Add the new CSS blocks for `.minimap-header`, `.minimap-pill`, `.tool-dock`, `.drag-handle`.

2. **State Store**
   - Implement `toolbarStore.ts` with defaults and actions.
   - Add `persist` (key `avlo.toolbar.v1`).

3. **Hooks**
   - `useRoomDoc.ts`: implement `useSnapshot()`, `useGates()`, `useClearScene()` as thin adapters.
   - `useDraggableFloat.ts`: pointer events + rAF translate3d, bounds to `.canvas-container`, commit position on pointerup.

4. **RoomPage**
   - Compose `Header`, `CanvasPane`, `EditorPanel`; inject store-derived props (collapses/zoom).

5. **Header**
   - Wire Clear button → confirm → `clearScene?.()`; show `Toast`.
   - Ensure status chip, share/export/theme buttons match DOM.

6. **CanvasPane**
   - Implement DPR-scaling canvas and mount lifecycle.
   - Place `ToolPanel`, `Minimap`, `ZoomControls`, `ColorSizeDock` absolutely.

7. **ToolPanel**
   - Render tool buttons (Pen/Highlighter open dock; others close dock).
   - Attach `useDraggableFloat` and a small `.drag-handle`.

8. **ColorSizeDock**
   - Read active tool; `show = tool === 'pen' || tool === 'highlighter'`.
   - Color slider: black↔brand↔white interpolation; update store color.
   - Size slider: update size; live readout.

9. **Minimap**
   - Implement collapse/expand with header toggle and pill return.
   - Render static viewport rect; later wire to transforms.

10. **ZoomControls**

- Adjust store zoom; constrain to [0.25, 2.0]; update label.

11. **Keyboard & A11y**

- Global keydown handler in `RoomPage`; guard inputs/textareas.
- Add `aria-label`s to icon buttons; focus outlines visible.

12. **QA Pass**

- Run through checklist below in both themes; viewport sizes 1280×800 and 1920×1080.

---

## QA Checklist

- [ ] Visual parity with HTML (spacing, radii, shadows, tokens) in light/dark.
- [ ] Clear in header, not toolbar; confirm dialog and toast on clear.
- [ ] Toolbar draggable smoothly; persists position; never escapes container; handle cursor changes.
- [ ] Dock shows only for Pen/Highlighter; color/size sliders update immediately; highlighter renders at ~0.25 opacity.
- [ ] Minimap collapses to pill and re-expands; pill has proper elevation and hover.
- [ ] Zoom ± works; label matches store; hotkeys map correctly.
- [ ] Editor panel toggles; Users modal stub opens; Toasts display.
- [ ] No code path imports presence or RBush.

---

## Definition of Done (DoD)

1. **UI-only** features implemented and testable without presence/spatial index.
2. **Header Clear**, **Minimap header+collapse**, **Draggable toolbar**, **Bottom-center dock**, **Zoom**, **Shortcuts**, **A11y** complete.
3. Store persisted settings survive reload; no runtime errors; bundle size increase minimal (no new heavy deps).
4. Code passes lint/format; component boundaries clean; state isolation maintained.

---

## Risks & Mitigations

- **Performance during drag**: Use `transform: translate3d` with rAF throttling; avoid React renders per frame. _Mitigation:_ custom hook already designed for this.
- **Dock overlap on small screens**: Adjust bottom spacing via media queries; hide minimap on very small widths.
- **Color slider discoverability**: Add label and `title` tooltips; consider subtle background gradient.

---

## Time/Complexity Estimate (Phase 9)

- Porting layout + CSS tokens: **0.5–1 day**
- Zustand store + hooks: **0.5 day**
- Header (clear/share/export/theme) + Toast: **0.25 day**
- CanvasPane (DPR scaling) + ZoomControls: **0.5 day**
- ToolPanel (draggable): **0.5 day**
- ColorSizeDock (sliders + logic): **0.5 day**
- Minimap (header + collapse): **0.25–0.5 day**
- Keyboard/A11y/QA polish: **0.5 day**

Total: **~3–4 days** focused effort.

---

## Cut/Paste Snippets (for the Agent)

### Draggable helper signature

```ts
useDraggableFloat({ containerSelector: '.canvas-container' }) => { nodeRef, handleRef }
```

### Dock visibility rule

```ts
const showDock = activeTool === 'pen' || activeTool === 'highlighter';
```

### Clear board handler (header)

```ts
if (confirm('Clear the board for everyone? This cannot be undone.')) clearScene?.();
```

### Color slider mapping (black→brand→white)

```ts
// v ∈ [0..100]; brand from CSS var
```

---

## Handoff Notes

- The standalone HTML prototype `avlo-whiteboard-improved-DRAG-MINIMAP-DOCK.html` reflects the exact interactions; mirror its CSS blocks and JS behavior into React.
- Keep **Phase 9** self-contained so Phase 7/8 can slot in later without refactors.
