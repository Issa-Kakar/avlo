# Toolbar Redesign — Current State (2026-04-22)

## Situation

Mid-transition between two toolbar designs. Both implementations live side by side, and that is intentional:

- **Old (archived-in-place):** `components/ToolPanel.tsx` + `ToolPanel.css` — the original horizontal dock pinned to the top-center of the viewport. Replaced because it felt cluttered, the inspector was tied to every tool, and it had no clear Mural visual parity.
- **New (live):** `components/toolbar/` — a vertical dock pinned to the left edge, split across multiple files after a structural refactor (2026-04-22). This is what `RoomPage` renders today.

The old `ToolPanel.*` files are being kept on disk as a working reference while the new toolbar is tuned — icon weight, inspector feel, pen weight metaphor, color popover layout, and which per-tool features survive the port are all still in flux. Once the new design is finalized, `ToolPanel.*` will be deleted and the stale references listed below will be cleaned up.

Supporting assets on this branch (untracked, in repo root): `muraltoolbar.png`, `mural_strokeMenu.png`, `FIGMA_STROKE_MENU.png`, `TOOLBAR_HTML_REFERENCE.MD`, `STICKYNOTEICONHTML.MD`, `MURAL_ZOOM_HTML.MD`, `cssmural.md`, `docs/TOOLBAR_ICON_DESIGN.md`. These are reference screenshots and extracted HTML/SVG used while porting Mural-style icons into `components/icons/index.tsx`.

---

## File Status

### New toolbar — `client/src/components/toolbar/` (live)

| File               | Lines | Role                                                                                                                                 |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`         | 1     | re-exports `{ Toolbar }`                                                                                                             |
| `Toolbar.tsx`      | 138   | main dock, memoized `ToolButton`, pre-bound click handlers, 2 narrow store selectors                                                 |
| `Toolbar.css`      | 143   | wrap + main/actions pill + tool-btn + tooltip + responsive                                                                           |
| `PenInspector.tsx` | 79    | zero-prop inspector; reads `activeTool`, drawing size/color, popover flag from store                                                 |
| `PenInspector.css` | 156   | inspector panel + dividers + pen/highlighter toggles + weight buttons + color row + rainbow swatch                                   |
| `ColorPopover.tsx` | 88    | recent / more / hex popover; owns hex input state and outside-click                                                                  |
| `ColorPopover.css` | 82    | popover + section headers + swatch grid + hex input + pop-in animation                                                               |
| `ColorSwatch.tsx`  | 24    | memoized swatch, shared by `PenInspector` (fixed row) and `ColorPopover` (recent + more grids)                                       |
| `constants.ts`     | 28    | `SIZE_PRESETS`, `WEIGHT_ICONS`, `FIXED_COLORS`, `MORE_COLORS`, `HEX_REGEX`, `isFixedColor`                                           |
| `actions.ts`       | 47    | stable module-level handlers: `selectTool`, `selectShape`, `setColor`, `pickCustomColor`, `undo`, `redo`, `toggleColorPopover`, etc. |

### Legacy files still on disk

| File                         | Status                                                                | Lines |
| ---------------------------- | --------------------------------------------------------------------- | ----- |
| `components/ToolPanel.tsx`   | Archived-in-place, still re-exported from `components/index.ts`       | 442   |
| `components/ToolPanel.css`   | Archived-in-place — also still defines the `:root` dock design tokens | 452   |
| `components/icons/index.tsx` | Shared with the new toolbar; unchanged since the earlier icon port    | 292   |

### Wiring

- `RoomPage.tsx:14` — `import { Toolbar } from './toolbar';` (resolves to `./toolbar/index.ts`).
- `RoomPage.tsx:64` — `<Toolbar />` rendered inside `.canvas-container`, alongside `<TopBar />`, `<UserAvatarCluster />`, and `<ZoomControls />`.
- `components/index.ts:1` — still re-exports `ToolPanel`. Nothing actually imports it through this barrel, but that line is the reason the old file is technically alive.

### Stale references that will need to be swept when `ToolPanel` is deleted

- `CLAUDE.md:137` — file map still lists `ToolPanel.tsx (toolbar + inspector)` instead of `toolbar/Toolbar.tsx`.
- `client/src/core/image/CLAUDE.md:184` — table row reads `Toolbar Image button | openImageFilePicker() | components/ToolPanel.tsx`.
- `client/src/components/context-menu/CLAUDE.md:101` — exclusion-zone comment: `Top 72px = ToolPanel (48px) + padding.` Obsolete: the dock is vertical on the left. Flip/shift padding needs to be re-measured against the left edge (`12px` + `48px` pill + padding ≈ `64–72px` left exclusion).
- `client/src/components/index.ts:1` — barrel export of the dead component.
- `RoomPage.tsx` JSDoc header (line 1–4) still says "fixed top toolbar at 48px with Inspector extension" — now wrong on both axis and layout.

---

## Component Hierarchy

```
RoomPage
└─ <Toolbar />                               zero props
   └─ .toolbar-wrap                           fixed, left: 12px, vertically centered
      ├─ .toolbar-main (pill)
      │   ├─ 13× <ToolButton>                 memoized, stable pre-bound onClick
      │   └─ <PenInspector />                 rendered when activeTool === 'pen' | 'highlighter'
      │      ├─ pen / highlighter toggle
      │      ├─ 4× stroke weight button
      │      └─ .inspector-colors
      │         ├─ rainbow "more" swatch
      │         ├─ 8× <ColorSwatch>           FIXED_COLORS
      │         └─ <ColorPopover />           rendered when isColorPopoverOpen
      │            ├─ recent grid             ≤5× <ColorSwatch>
      │            ├─ more grid               12× <ColorSwatch>
      │            └─ hex input + apply
      └─ .toolbar-actions (pill)              Undo, Redo
```

### Layout metrics

Main-pill width: **48px** (8px padding + 32px button + 8px padding). Pen inspector opens right at `calc(100% + 10px)` (6px on <768px). Color popover opens right of the inspector at `calc(100% + 8px)`, top-aligned. Undo/Redo is a separate pill with an 8px gap below the main pill.

### Tool order (top → bottom in `.toolbar-main`)

Unchanged by the refactor:

1. Select `V` — `selectTool('select')`
2. Pan `Space` — `selectTool('pan')`
3. `.toolbar-divider`
4. Sticky Note `N` — `selectTool('note')`
5. Text `T` — `selectTool('text')`
6. Rectangle `R` — `selectShape('rectangle')` → sets `activeTool='shape'` + `shapeVariant='rectangle'`
7. Ellipse `O` — same, variant `ellipse`
8. Diamond `D` — same, variant `diamond`
9. Connector `A` — `selectTool('connector')`
10. Pen `P` — `selectTool('pen')`. The pen button's active highlight fires on `activeTool === 'pen' || activeTool === 'highlighter'` (highlighter lives inside the inspector, no top-level button).
11. Code — `selectTool('code')`
12. Image `I` — calls `pickImage()` (wraps `openImageFilePicker()`); never marked active.
13. Eraser `E` — `selectTool('eraser')`

### Pen Inspector contents

1. **Pen toggle** (`IconInspectorPen`) — 30×30 button, 20×20 icon, 3-layer colored SVG
2. **Highlighter toggle** (`IconInspectorHighlighter`) — same dimensions
3. `.inspector-divider`
4. **Stroke weight buttons `W1–W4`** — 28×28 button, 20×20 icon. Maps `SizePreset [4, 7, 10, 13]` → `IconStrokeWeight1..4` via `WEIGHT_ICONS` (both in `constants.ts`).
5. `.inspector-divider`
6. **`.inspector-colors`** — 2-column 16px swatch grid:
   - Rainbow conic-gradient "more colors" button (opens popover). When `currentColor` is custom (not in `FIXED_COLORS`), a center dot is overlaid in the current color.
   - 8 fixed palette colors from `FIXED_COLORS = [...TEXT_COLOR_PALETTE.slice(0, 8)].reverse()` — precomputed once at module load, no per-render slicing.

### Color popover (possibly dropped — see Pending)

Three sections inside a 220px pill, pop-in animation (`inspector-pop-in` 160ms):

- **Recent** — up to 5 from `recentColors`, rendered only if non-empty
- **More** — 12 hardcoded extras in `MORE_COLORS`
- **Hex** — text input + apply button, validated against `HEX_REGEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i`. Custom colors feed `addRecentColor` via `pickCustomColor` in `actions.ts`.

Outside-click closes via `mousedown` + `closest('.inspector-colors')` — clicks on the rainbow button or a fixed swatch do **not** close the popover (matches original UX). Hex input state is local to `ColorPopover`, so typing no longer cascades re-renders to `PenInspector` or `Toolbar`.

### Tooltip behavior

- CSS pseudo-element `::after`, content from `data-tooltip`
- Positioned right of the button: `left: calc(100% + 10px), top: 50%`
- Fades + scales from 0.9 on hover (120ms)
- Suppressed while inspector open via `.toolbar-wrap:has(.pen-inspector) .toolbar-main .tool-btn::after { display: none; }` (in `Toolbar.css`)

### Responsive (`@media (max-width: 768px)`)

Split across `Toolbar.css` and `PenInspector.css` to match component ownership:

- `Toolbar.css` — wrap `left: 6px`; tool-btn `28×28` with 20×20 icons; main/actions padding `3px`, radius `10px`.
- `PenInspector.css` — inspector offset `calc(100% + 6px)`.

---

## State Integration (`useDeviceUIStore`)

Store subscriptions are now narrow per component — the old monolithic file did a single flat destructure of 11 fields, forcing the whole dock to re-render on any of them changing.

| Component          | Narrow selectors                                                                    |
| ------------------ | ----------------------------------------------------------------------------------- |
| `Toolbar.tsx`      | `activeTool`, `shapeVariant`                                                        |
| `PenInspector.tsx` | `activeTool`, `drawingSettings.size`, `drawingSettings.color`, `isColorPopoverOpen` |
| `ColorPopover.tsx` | `recentColors`                                                                      |

All writes go through stable module-level functions in `toolbar/actions.ts`, which call `useDeviceUIStore.getState()` imperatively. That matches the codebase's "getters over parameter passing" convention (see `CLAUDE.md`). Because handlers are never recreated, memoized `ToolButton` / `ColorSwatch` children don't get stale-prop churn.

Undo/Redo call `getActiveRoomDoc().undo() / .redo()` directly, guarded by `hasActiveRoom()`. They bypass the store entirely.

Persisted store key: `avlo.toolbar.v4` (version 2). Unchanged.

Size preset mapping: `SizePreset = 4 | 7 | 10 | 13` in `device-ui-store.ts:14` — the only four values the pen inspector can emit.

---

## Memoization

Applied only where it pays off:

- **`ToolButton`** (13 instances) — `React.memo`. Before the refactor, any `drawingSettings.color` change (e.g., typing a hex) re-rendered all 13 tool buttons. With stable pre-bound handlers + memo, only the button whose `isActive` actually flipped re-renders.
- **`ColorSwatch`** (up to ~25 instances: 8 fixed + ≤5 recent + 12 more) — `React.memo`. One click doesn't re-render the whole grid.
- **`PenInspector` / `ColorPopover`** — not memoized. Their own state / narrow selectors already gate re-renders correctly.
- Weight buttons — inline `.map` inside `PenInspector`. Extracting them would be more churn than it saves since hex-typing no longer triggers any re-render above `ColorPopover`.

Critical invariant: every `onClick` passed to a memoized child is a **module-level `const`** (in `Toolbar.tsx` or `actions.ts`), never an inline `() => …` at the JSX site. The weight-button `.map` is the only intentional exception (4 closures, bounded).

---

## Icons (`components/icons/index.tsx`)

### Used by `toolbar/`

`IconSelect`, `IconPan`, `IconStickyNote`, `IconText`, `IconRectangle`, `IconEllipse`, `IconDiamond`, `IconArrow`, `IconPen`, `IconCode`, `IconImage`, `IconEraser`, `IconUndo`, `IconRedo`, `IconInspectorPen`, `IconInspectorHighlighter`, `IconStrokeWeight1..4`.

### Added for the redesign

- **`IconInspectorPen`** — 3-layer colored pen from Mural's `drawStrokeFine` Lottie. Nib `#B8C1CC`, body `#48525B`, shell `#DCE1E5` evenodd outline. Faces upward.
- **`IconInspectorHighlighter`** — 3-layer marker from Mural's `drawStrokeHighlighter` Lottie. Body `#48525B`, reservoir `#B8C1CC`, envelope `#DCE1E5` evenodd outline.
- **`IconStrokeWeight1`** — `drawWeight10` at natural scale (3 paths; path 2 is `opacity=".35" fillRule="evenodd"`).
- **`IconStrokeWeight2`** — same SVG wrapped in `<g transform="translate(12,12) scale(1.12) translate(-12,-12)">`.
- **`IconStrokeWeight3`** — same pattern at scale `1.24`.
- **`IconStrokeWeight4`** — `drawWeight60`, a distinct 2-path shape (not a scaled variant).

### Exported but unused by the new toolbar

- **`IconHighlighter`** — only used by `ToolPanel.tsx`. The new toolbar uses `IconInspectorHighlighter` inside the inspector.
- **`IconFill`** — only used by `ToolPanel.tsx`'s fill toggle (feature not ported).
- **`IconLine`** — defined but not referenced by either toolbar.

---

## Design Tokens

The `:root` block still lives in **`ToolPanel.css`** (lines 1–47). All three `toolbar/*.css` files reference tokens via `var(..., fallback)` with hardcoded fallbacks, so they render correctly even if `ToolPanel.css` is deleted first — but the canonical definition needs to move before that deletion:

```css
--dock-bg: #101720 /* toolbar/inspector background */ --dock-border: #4a4a4a /* pill border + dividers */ --dock-hover: #383838
  /* button hover */ --accent: #1f51ff /* active tool (blue) */ --icon-muted: #f5f5f5 /* default icon color */ --icon-selected: #f5f5f5
  /* active icon color */ --divider: #4a4a4a --ring: #1d4ed8 /* focus ring */;
```

Old-dock-only metrics that no `toolbar/` file consumes (stay in the old file): `--dock-h`, `--btn`, `--btn-radius`, `--dock-radius`, `--icon`, `--divider-h`, `--dock-gap`, `--dock-pad`, `--swatch`, `--swatch-ring`, `--pill-h`, `--pill-font`, `--pill-radius`.

---

## Old `ToolPanel.tsx` — Feature-Parity Reference

Features present in the old horizontal dock that are **not yet** in the new Toolbar. Each needs an explicit keep/drop/reshape decision before `ToolPanel` can be deleted:

| Feature                                       | Old behavior                                                                                                       | New status                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fill toggle                                   | `IconFill` button in inspector, toggles `drawingSettings.fill`. Shown for `shape \| pen \| highlighter \| select`. | **Not ported.** Selection fill is handled by context-menu; shape-creation default has no entry point in the new dock.                                    |
| S/M/L/XL size pills for non-drawing tools     | `showSizes = !['pan','image'].includes(activeTool)` — pills appeared for text, note, shape, connector              | **Not ported.** Only pen/highlighter get stroke-weight icons. Text/note/shape size is handled by context-menu.                                           |
| Connector stroke size                         | `ConnectorSizePreset [2,4,6,8]` via `setConnectorSize`, pills shown when `activeTool === 'connector'`              | **Not ported.** No connector inspector in new dock.                                                                                                      |
| Color inspector for text/shape/connector/note | `showInspector = ['pen','highlighter','text','shape','connector','note']` — color swatches + hex popover for all   | **Not ported.** Inspector only opens for pen/highlighter; other tools rely on context-menu.                                                              |
| Dedicated Highlighter button in main dock     | `IconHighlighter`, toggles `activeTool === 'highlighter'` directly                                                 | **Replaced.** Highlighter lives inside the pen inspector as a toggle with `IconInspectorHighlighter`.                                                    |
| Tool order                                    | Select, Pan, Note, Pen, Highlighter, Eraser, Text, Connector, Rect, Diamond, Ellipse, Code, Image                  | **Reordered.** See "Tool order" above — shape variants now grouped Rect/Ellipse/Diamond, Eraser moved to the bottom, Highlighter removed from main dock. |
| Undo/Redo container                           | `.undo-redo-compact` — absolute-positioned to right of main dock                                                   | **Reshaped.** Became its own `.toolbar-actions` pill stacked below the main pill with an 8px gap.                                                        |
| Tooltip placement                             | `top: calc(100% + 6px)` — below button                                                                             | **Flipped right.** `left: calc(100% + 10px)` — appropriate for vertical layout.                                                                          |
| `:root` design tokens                         | Defined in `ToolPanel.css`                                                                                         | **Still defined there.** Needs to move or be inlined before deletion.                                                                                    |

---

## Known Pending / Tuning Targets

- Visual tuning of all icons against the Mural/Figma reference PNGs in the repo root. Especially connector, eraser, and code icons.
- Pen inspector feel — divider weights, swatch spacing, custom-color dot contrast, rainbow button readability on the dark dock.
- Stroke-weight icon scale jumps (1.00 / 1.12 / 1.24 / `drawWeight60`) — the progression may not feel linear enough across the four presets.
- **Considering dropping `ColorPopover` entirely** — keep only the 8 fixed colors in the inspector. If we go this route the deletion is well-scoped thanks to the refactor: remove `ColorPopover.{tsx,css}`, drop `MORE_COLORS` + `HEX_REGEX` + `pickCustomColor` + `toggleColorPopover` + `closeColorPopover` from `constants.ts`/`actions.ts`, drop the rainbow swatch-plus button + `isColorPopoverOpen` selector from `PenInspector`, drop `recentColors` + `addRecentColor` + `isColorPopoverOpen` from `device-ui-store.ts` (and the `avlo.toolbar.v4` persisted fields).
- Explicit decision on each old-dock feature in the parity table above: re-introduce in the vertical dock, push to the context menu, or drop entirely.
- Move the `:root` dock design tokens out of `ToolPanel.css` into a neutral theme file (or inline into `toolbar/Toolbar.css`) before deleting the old CSS.
- Update `context-menu/CLAUDE.md` exclusion-zone math — replace the obsolete 72px top exclusion with a left-edge exclusion matching the new vertical dock.
- Delete `ToolPanel.tsx`, `ToolPanel.css`, and the `components/index.ts` barrel export; remove `IconHighlighter` and `IconFill` from `icons/index.tsx` if the old features stay dropped.
- Update the `RoomPage.tsx` JSDoc header (currently describes the old top dock).
