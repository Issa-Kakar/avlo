# Sticky Note Palette — Handoff

Context for the next agent picking up the sticky-note toolbar work — what exists
and what's still open. The user will describe the specific tweaks they want
directly; this doc is just the lay of the land.

## Goal

Building out the **sticky-note side of the toolbar**. This session delivered the
**color palette popout** — the inspector that appears when the Sticky Note tool
button is clicked, for choosing a sticky note's fill color. References at repo
root: `stickynotetoolbar.png` (Zoom), `stickynotepallete.png` (Miro).

## What was done

Committed on branch `parallel` as `e2b629a` — `feat(sticky-notes): color palette
popout panel`. Typecheck clean. 6 files:

| File | Change |
|---|---|
| `client/src/stores/device-ui-store.ts` | palette constant + store fields / actions / subscription |
| `client/src/components/toolbar/inspectors/StickyNotePanel.tsx` | the popout component (new) |
| `client/src/components/toolbar/inspectors/StickyNotePanel.css` | its styles (new) |
| `client/src/components/toolbar/Toolbar.tsx` | Sticky Note button toggles the panel |
| `client/src/components/toolbar/Toolbar.css` | suppress tool tooltips while the panel is open |
| `client/src/tools/TextTool.ts` | dismiss the panel on a note-create gesture |

### Palette — `NOTE_COLOR_PALETTE`

In `device-ui-store.ts`. 12 entries (`{ name, fill }`), rendered 6 rows × 2.
Ordered as a continuous warm→cool→neutral hue ramp so the 2-wide grid reads as
one sweep:

| Row | Left | Right |
|---|---|---|
| 1 | Yellow `#FFD95E` | Orange `#FFAD5C` |
| 2 | Red `#FF6E6E` | Pink `#FF8FB3` |
| 3 | Purple `#C193F2` | Blue `#8FB4FF` |
| 4 | Cyan `#73D2EE` | Teal `#67DEC6` |
| 5 | Green `#86DF9C` | Lime `#C5E27D` |
| 6 | White `#F2F1EC` | Black `#28282C` |

Every fill is light enough for black body text except Black. It's one array —
freely editable; the panel and its row layout follow from its length/order.

### Store (`device-ui-store.ts`)

- `note.fillColor: string` — default `#FFD95E`. The chosen sticky fill; setter
  `setNoteFillColor`. Persisted (part of the `note` cluster).
- `stickyPanelOpen: boolean` — popout visibility. Ephemeral, **not persisted**.
  Actions: `openStickyPanel`, `closeStickyPanel` (idempotent), `toggleStickyPanel`.
  Selector: `selectStickyPanelOpen`.
- A `tool.active` subscription closes the panel on any switch away from the
  `note` tool — single chokepoint, covers toolbar / keyboard / shape-mode.
- Persist key bumped `avlo.toolbar.v2` → `v3` (`note.fillColor` is a new field
  nested in an already-persisted cluster; a shallow merge would drop it).
  **Any further store-shape change needs another bump.**

### Panel (`StickyNotePanel.tsx` + `.css`)

- Mounted by `Toolbar.tsx` while `stickyPanelOpen` is set — gated render, same
  pattern as the pen inspector; a direct child of `.toolbar-main`, pill-centered,
  pops out to the right of the dock.
- Near-black popout (`#0b0b0c`), ~118×326px, 12 swatches in a 2-column grid.
- Each swatch is styled as a miniature sticky note — surface gradient + 1px
  rim-light bevel + a folded corner. The fold is a real chamfer: `::before` is
  the note face with its bottom-right corner clipped away, `::after` is the
  dog-ear (that corner folded back in — a darker triangle, right angle pointing
  inward). No drop shadow (invisible on black); depth plus a color-matched
  **bloom** come in on hover (lift + scale + alternating tilt + glow). The
  popout fades + slides in as one quick unit on open.
- **No selected/active swatch state** — intentional; it's a one-shot picker.
- Swatch visuals are driven by CSS custom properties in `StickyNotePanel.css`
  (`--rim`, `--edge`, `--glow`, `--fold`) plus per-swatch inline `--fill` /
  `--tilt`.

### Behaviour

- **Sticky Note toolbar button** (`clickNote`, Toolbar.tsx): if the note tool is
  already active → toggle the panel; otherwise → activate the note tool + open
  the panel.
- **Swatch click** → `setNoteFillColor(fill)` + `closeStickyPanel()`.
- Panel also closes on: **Escape**, a **tool switch** (the subscription), and a
  **note-create press on the canvas** (`TextTool.begin`, gated to note mode so a
  pan never closes it).

### Follow-up refinement (this session)

On top of `e2b629a`, pure CSS plus a one-line TSX cleanup (removed the
now-dead `--i` stagger index):

- **Swatch fold reworked into a real chamfer.** `::before` is the note
  face with its bottom-right corner clipped away; `::after` is the dog-ear
  — that corner folded back onto the note, a darker triangle whose right
  angle points inward. Replaces the old same-square gradient triangle that
  read as ambiguous corner shading.
- **Panel ~25% smaller.** Swatch 58→44px; gaps, padding, radius, fold
  size, and the mobile breakpoint scaled to match.
- **Entry animation toned down.** Dropped the per-swatch stagger + spring
  bounce; the popout now fades + slides in as one ~130ms unit.

## Outstanding — broader goal, not done

1. **Text-tool integration.** `TextTool.createTextObject` (`TextTool.ts:226`)
   hardcodes the note fill: `TextTool.ts:246` writes the `NOTE_FILL_COLOR`
   constant (`#FEF3AC`, `core/text/sticky-note.ts:37`). Wire it to read the
   store instead (`note.fillColor`, via `useDeviceUIStore.getState()` or
   `selectNote`) so a new note picks up the panel's color. Store default is
   now `#FFD95E` — the intended replacement for the dull `#FEF3AC`.
2. **Color-aware rendering.** Sticky-note text is hardcoded `#1a1a1a` in two
   spots: the canvas render path (`core/text/sticky-note.ts:582`,
   `ctx.fillStyle`) and the Tiptap editor overlay (`TextTool.ts:385`,
   `--text-color`). With user-chosen fills the text color must derive from
   the fill for contrast — dark text on light fills, light text on the
   near-black 'Black' sticky (`#28282C`). Prior art for the luminance test:
   `presence-renderer.ts:90` (`L > 0.45 ? '#1a1a1a' : '#fff'`) and
   `components/toolbar/color/palette.ts` (`luminance` / `isDark`). Both
   render paths must agree; `core/text/CLAUDE.md` (lines 91, 305, 580) also
   documents the hardcoded color — update it when this lands.
3. **Drag-to-create from the toolbar** — separately planned, not started.
   Lower priority than 1 + 2.

## Pointers

- Architecture docs: `client/src/components/toolbar/CLAUDE.md` (toolbar +
  device-ui-store) and `client/src/core/text/CLAUDE.md` (sticky-note system).
- Typecheck: `npm run typecheck` from repo root. Dev server in this worktree:
  `npm run dev:p`.
