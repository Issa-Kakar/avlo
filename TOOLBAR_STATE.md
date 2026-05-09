# Toolbar Redesign — Current State (2026-05-09)

> **Not finalized.** The pen and connector inspectors have been rewritten from
> scratch onto a slot-based color model that mirrors Mural's zoom-menu
> pattern. Hex codes, icon weights, spacing, threshold values, and the
> connector variant icon set are all still in active tuning.

## Situation

The toolbar now has:

- **Vertical main pill** on the left edge (unchanged from the prior pass).
- **Pen / highlighter inspector** with three persistent color slots per tool
  (active slot drives `drawingSettings.color`). Click an inactive slot to
  switch; click the active slot to open a color picker. The picker holds a
  24-color palette + a custom-hex entry; picking any color closes it.
- **Connector inspector** with three variant buttons (straight,
  double-arrow, elbow-with-end-cap) and a single-slot color picker that
  reuses the same primitives as the pen inspector.

The previous `ToolPanel.tsx` / `ToolPanel.css` (horizontal top dock + the
old `FIXED_COLORS` + `MORE_COLORS` + `recentColors` popover) is **deleted**.
The barrel export was removed from `client/src/components/index.ts`. Git
history preserves the old code — there is no longer an "archived in place"
file on disk.

Reference assets used during the port still live untracked in the repo
root: `zoommenustroke.png`, `muraltoolbar.png`, `mural_strokeMenu.png`,
`CONNECTOR_MENU.png`, `MURAL_ZOOM_HTML.MD`, `cssmural.md`, plus the various
Mural screenshots and the `docs/TOOLBAR_ICON_DESIGN.md` working notes.

---

## File Status

### `client/src/components/toolbar/` (live)

Granular, single-responsibility files. CSS is co-located with each
component; the shared `Inspector.css` `@import`s the per-primitive CSS so
inspectors only need one stylesheet import.

| File                       | Role                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `index.ts`                 | re-exports `{ Toolbar }`                                                                                           |
| `Toolbar.tsx`              | main dock; dispatches `<PenInspector />` or `<ConnectorInspector />` based on `activeTool`                         |
| `Toolbar.css`              | `:root` design tokens (moved here from the deleted `ToolPanel.css`) + main-pill + actions-pill + tooltip styling   |
| `PenInspector.tsx`         | pen / highlighter toggle, 4 weight buttons, 3-slot color row + picker                                              |
| `ConnectorInspector.tsx`   | 3 variant buttons (inlined SVGs — placeholder geometry) + 1-slot color row + picker                                |
| `Inspector.css`            | shared inspector pill shell + divider; imports the 3 primitive CSS files                                           |
| `InspectorButton.tsx/css`  | reusable square icon button with `is-active` state — used for tool toggles, weight buttons, connector variants     |
| `ColorSlots.tsx/css`       | reusable column of 1–3 rounded-square slots; manages click semantics (non-active = switch, active = toggle picker) |
| `ColorSlot.tsx`            | single slot — checkmark + `--slot-tint` offset ring when active; `data-dark` triggers a white inset stroke         |
| `ColorPicker.tsx/css`      | 24-swatch grid (6×4) + custom hex input + outside-click close; `data-dark` swatches get a brighter border          |
| `CheckIcon.tsx`            | tiny memoized `<svg>` check, accepts `color` + `size` + `strokeWidth`                                              |
| `palette.ts`               | `PALETTE` (24 colors), `PALETTE_COLS = 6`, `luminance`, `checkmarkColorFor`, `isDark`, `colorsEqual`               |
| `constants.ts`             | `SIZE_PRESETS`, `WEIGHT_ICONS`, `CONNECTOR_VARIANTS`                                                               |
| `actions.ts`               | module-level handlers (selectTool, selectShape, undo/redo, setStrokeSize, selectSlot, setActiveSlotColor, setConnectorVariant, setConnectorColor, toggleColorPicker, closeColorPicker) |

### Wiring

- `RoomPage.tsx:14` — `import { Toolbar } from './toolbar';`.
- `RoomPage.tsx:64` — `<Toolbar />` rendered alongside `<TopBar />`,
  `<UserAvatarCluster />`, `<ZoomControls />`.
- `Toolbar.tsx` renders the active inspector inside `.toolbar-main` so the
  inspector's `top: 50%; transform: translateY(-50%)` centers against the
  main pill (and not the taller `.toolbar-wrap`, which also stacks
  `.toolbar-actions` underneath).

### Stale references (still need a cleanup sweep)

- `CLAUDE.md:137` — file map still reads
  `components/ToolPanel.tsx (toolbar + inspector)`. Should point to
  `components/toolbar/Toolbar.tsx` + the inspectors directory.
- `client/src/core/image/CLAUDE.md:184` — table row references
  `components/ToolPanel.tsx`.
- `client/src/components/context-menu/CLAUDE.md:101` — exclusion-zone math
  still says `Top 72px = ToolPanel (48px) + padding`. The dock is vertical
  on the left now; flip/shift padding needs to be re-measured against the
  left edge (`12px` + `48px` pill + padding ≈ `64–72px` left exclusion).
- `RoomPage.tsx` JSDoc header (line 1–4) still describes the old top dock.

---

## Component Hierarchy

```
RoomPage
└─ <Toolbar />                                     zero props
   └─ .toolbar-wrap                                 fixed, left:12px, viewport-centered
      ├─ .toolbar-main (pill, position:relative)
      │   ├─ 13× <ToolButton>                       memoized, module-level pre-bound onClicks
      │   ├─ {isPen && <PenInspector />}
      │   │   └─ .inspector (absolute, centered against main pill)
      │   │      ├─ 2× <InspectorButton>           pen / highlighter toggle
      │   │      ├─ inspector-divider
      │   │      ├─ 4× <InspectorButton>           stroke weight (W1..W4)
      │   │      ├─ inspector-divider
      │   │      └─ <ColorSlots count=3>
      │   │         ├─ 3× <ColorSlot>              active = checkmark + color-tinted offset ring
      │   │         └─ {isPickerOpen && <ColorPicker />}
      │   └─ {isConnector && <ConnectorInspector />}
      │      └─ .inspector
      │         ├─ 3× <InspectorButton>            straight / doubleArrow / elbow
      │         ├─ inspector-divider
      │         └─ <ColorSlots count=1>
      │            ├─ 1× <ColorSlot>
      │            └─ {isPickerOpen && <ColorPicker />}
      └─ .toolbar-actions (pill)                   Undo, Redo
```

### Layout metrics

Main-pill width: **48px** (8px padding + 32px button). Inspector pill opens
at `calc(100% + 10px)` to the right (`6px` on `<768px`). Inspector pill
holds 30×30 buttons + 24×24 color slots with 12px vertical gap. Color
picker opens at `calc(100% + 12px)` to the right of the slot column,
`top: -8px` so it aligns near the top of the slot row.

Picker: 6×4 grid of 22×22 swatches with 10px gap. 10px container padding.
Custom-hex row appears below the grid when the `+` action button is
toggled.

### Color slot anatomy (active state)

- Background: the slot's color (24×24, `border-radius: 6px`).
- Inner stroke (data-dark only): `inset 0 0 0 1px rgba(255,255,255,0.7)`
  for active dark colors (or `0.55` for inactive dark colors). Keeps the
  rect edge readable against the near-black dock background.
- Gap ring: `0 0 0 2px var(--dock-bg)`.
- Offset ring: `0 0 0 4px var(--slot-tint)` — `--slot-tint` is the slot's
  own color, set inline in `ColorSlot.tsx` as a CSS variable.
- Checkmark: 16×16 SVG, stroke color is white if `luminance(color) ≤ 0.55`
  else black.

### Tool order (top → bottom in `.toolbar-main`)

1. Select `V` — `selectTool('select')`
2. Pan `Space` — `selectTool('pan')`
3. divider
4. Sticky Note `N` — `selectTool('note')`
5. Text `T` — `selectTool('text')`
6. Rectangle `R` — `selectShape('rectangle')`
7. Ellipse `O` — `selectShape('ellipse')`
8. Diamond `D` — `selectShape('diamond')`
9. Connector `A` — `selectTool('connector')` → opens Connector inspector
10. Pen `P` — `selectTool('pen')` → opens Pen inspector. Stays highlighted
    while `activeTool === 'highlighter'` (no top-level highlighter button).
11. Code — `selectTool('code')`
12. Image `I` — `pickImage()`; never marked active.
13. Eraser `E` — `selectTool('eraser')`

### Pen inspector contents

1. Pen toggle (`IconInspectorPen`, 30×30 button, 20×20 icon).
2. Highlighter toggle (`IconInspectorHighlighter`).
3. Divider.
4. Stroke weights `W1..W4` — `SizePreset [4, 7, 10, 13]` mapped to
   `IconStrokeWeight1..4` via index in `constants.ts`. Per-button
   handlers come from a module-level lookup table so memoized
   `InspectorButton` keeps its props stable.
5. Divider.
6. `<ColorSlots />` — 3 rounded squares. Pen and highlighter each persist
   their own slot column + active-slot pointer; switching active tool
   replays that tool's slot color into `drawingSettings.color`.

### Connector inspector contents

1. Straight, double-arrow, elbow buttons. Each `setConnectorVariant(...)`
   call writes a preset triple `(connectorType, startCap, endCap)` from
   the `CONNECTOR_VARIANT_PRESETS` table in `device-ui-store.ts`. Variant
   is the source of truth; the legacy fields are derived.
2. Divider.
3. `<ColorSlots count=1 />` over `connectorColor`. Picker behaves
   identically to the pen inspector's picker — single shared
   `isColorPickerOpen` flag in the store guarantees only one picker is
   ever open at a time.

### Color picker

- 24 colors in a 6×4 grid (`PALETTE` in `palette.ts`). Currently-selected
  color shows a 13×13 checkmark (contrast-flipped via `checkmarkColorFor`).
- `+` action toggles a custom-hex input (validated against
  `/^#([0-9a-f]{3}|[0-9a-f]{6})$/i`). Submitting via Enter or the apply
  button calls `onPick`; closing via Escape clears the draft.
- Eyedropper button is rendered but currently disabled (placeholder for
  the system eyedropper API).
- Closes on outside click. Clicks inside the slots column do not close the
  picker — those clicks are handled by the slot itself.
- Picking any color *also closes the picker*. This is centralized in
  `actions.ts` (`setActiveSlotColor` and `setConnectorColor` both call
  `setColorPickerOpen(false)` after committing the color), so every entry
  point — palette swatch, hex submit — gets the close-on-pick behavior
  for free.

### Tooltip behavior

Same as the prior pass — CSS pseudo-element on `.tool-btn`, positioned
`right` of the button (`left: calc(100% + 10px); top: 50%`), suppressed
while any inspector is open via
`.toolbar-wrap:has(.inspector) .toolbar-main .tool-btn::after { display: none; }`.

---

## State Integration (`useDeviceUIStore`)

### New persisted fields

| Field                          | Type                  | Purpose                                                                |
| ------------------------------ | --------------------- | ---------------------------------------------------------------------- |
| `penColorSlots`                | `ColorSlots` (3-tuple)| Pen's three persistent slot colors                                     |
| `penActiveSlot`                | `0 \| 1 \| 2`          | Which pen slot is active                                               |
| `highlighterColorSlots`        | `ColorSlots`          | Highlighter's three persistent slot colors                             |
| `highlighterActiveSlot`        | `0 \| 1 \| 2`          | Which highlighter slot is active                                       |
| `connectorColor`               | `string`              | Single-slot connector color                                            |
| `connectorVariant`             | `'straight' \| 'doubleArrow' \| 'elbow'` | Source of truth — `connectorType` + caps are derived |
| `isColorPickerOpen`            | `boolean`             | One-flag picker visibility (shared by pen and connector inspectors)    |

### Removed fields

`recentColors`, `isColorPopoverOpen`, `addRecentColor`, `setColorPopoverOpen` — all dropped. Persisted store key bumped to `avlo.toolbar.v5`, version `3`. Old localStorage entries are wiped on first load (schema is incompatible with the prior shape).

### Sync rules

- `setActiveTool('pen' | 'highlighter')` pushes the destination tool's
  active-slot color into `drawingSettings.color` so `DrawingTool` (which
  freezes `settings.color` at `begin()`) picks it up. Also closes the
  picker.
- `setActiveSlot(slot)` — switches the active slot for whichever tool is
  currently active and pushes that slot's color into `drawingSettings.color`.
- `setActiveSlotColor(color)` — writes the color into the *current
  tool's* active slot AND `drawingSettings.color`.
- `setConnectorVariant(variant)` — writes the variant + the derived
  `connectorType` / `connectorStartCap` / `connectorEndCap`.
- `ConnectorTool.begin()` reads `state.connectorColor` (changed from
  `state.drawingSettings.color`). The connector now has its own dedicated
  color independent of pen.

### Narrow component selectors

| Component                | Selectors                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Toolbar.tsx`            | `activeTool`, `shapeVariant`                                                                                                             |
| `PenInspector.tsx`       | `activeTool`, `drawingSettings.size`, `isColorPickerOpen`, conditional `penColorSlots` / `highlighterColorSlots`, conditional `*ActiveSlot` |
| `ConnectorInspector.tsx` | `connectorVariant`, `connectorColor`, `isColorPickerOpen`                                                                                |
| `ColorPicker.tsx`        | none — all data flows in via props                                                                                                       |

---

## Memoization

- `ToolButton` (13 instances in `Toolbar.tsx`) — `React.memo`. All click
  handlers are module-level constants.
- `InspectorButton` — `React.memo`. Pen-inspector weight buttons read
  click handlers from a module-level `WEIGHT_HANDLERS` lookup keyed by
  size; connector-inspector variant buttons use the same pattern via
  `VARIANT_HANDLERS`. No inline arrows reach the memoized child.
- `ColorSlots` — `React.memo`. `ConnectorInspector` wraps its single
  color in `useMemo<readonly [string]>(() => [color], [color])` so the
  memo holds across renders that don't actually change the color.
- `ColorSlot` — `React.memo`. The active-vs-inactive `onClick` choice
  is composed inline (`isActive ? onTogglePicker : () => onSelectSlot(i)`)
  inside `ColorSlots`, so non-active slots see a fresh closure each
  render — acceptable since the column is at most 3 items.
- `ColorPicker` and the inner `Swatch` — both `React.memo`. The picker
  re-renders only when `currentColor`, `onPick`, or `onClose` change.
- `CheckIcon` — `React.memo`.

Critical invariant: every onClick passed to a memoized child is either a
module-level const or sourced from a module-level lookup table. The two
exceptions (slot inline arrows, picker swatch inline arrow inside
`onClick={() => onPick(color)}`) are bounded to ≤24 closures per render
and intentional.

---

## Icons

### Used by `toolbar/`

`IconSelect`, `IconPan`, `IconStickyNote`, `IconText`, `IconRectangle`,
`IconEllipse`, `IconDiamond`, `IconArrow`, `IconPen`, `IconCode`,
`IconImage`, `IconEraser`, `IconUndo`, `IconRedo`, `IconInspectorPen`,
`IconInspectorHighlighter`, `IconStrokeWeight1..4`.

The connector inspector inlines its three variant SVGs in
`ConnectorInspector.tsx`. Each path is laid out so the bbox center sits
at viewBox (12, 12).

### Defined but unreferenced

- `IconHighlighter`, `IconFill`, `IconLine` — were used only by the
  deleted `ToolPanel`. Safe to delete from `icons/index.tsx` if no other
  callers crop up.

---

## Design Tokens

The `:root` block now lives in **`client/src/components/toolbar/Toolbar.css`**:

```css
--dock-bg:        #101720
--dock-border:    #4a4a4a
--dock-hover:     #383838
--accent:         #1f51ff
--icon-muted:     #f5f5f5
--icon-selected:  #f5f5f5
--divider:        #4a4a4a
--ring:           #1d4ed8
```

All `toolbar/*.css` files reference these via `var(..., fallback)` with
hardcoded fallbacks, so they still render correctly if the import order
changes.

---

## Pending / Tuning Targets

**Nothing on this list is finalized — palette hex codes, icon weights,
spacing, threshold values, and the variant icon set are all in flux.**

- **Palette hex codes**: `palette.ts:PALETTE` is eyeballed from
  `zoommenustroke.png`. Each color needs a pixel-accurate sample pass.
- **Connector variant icons**: deliberately crude placeholders — the
  current paths are bbox-centered but the geometry (especially the
  double-arrow chevron weight and the elbow corner radius) needs a real
  design pass. Likely candidate to redo against
  `docs/TOOLBAR_ICON_DESIGN.md` next.
- **`isDark` threshold** (`palette.ts:isDark`, currently `< 0.25`). May
  need to widen to `0.3-0.35` if mid-dark colors (e.g. `#F44336` at
  ~0.41) read as needing the inset white stroke too.
- **Slot offset ring on dark colors**: the `--slot-tint` outer ring is
  the slot's own color, so a black slot's ring is also black against the
  near-black dock — barely visible. Considering either tinting the ring
  brighter for dark slots or accepting that the white inner stroke is
  enough on its own.
- **Eyedropper** is rendered but disabled. Wire to
  `EyeDropper` API when prioritized.
- **Hex input UX**: opens via the `+` action, autofocuses, closes on
  Escape. Potentially redundant with the eyedropper once the latter is
  live — re-evaluate.
- **Picker positioning**: `top: -8px` from the slot column. Looks OK for
  the pen inspector (slots near the bottom), might want vertical
  alignment with the slot row's vertical center for consistency once
  more inspectors land.
- **Stroke-weight icon scale jumps** (`1.00 / 1.12 / 1.24 / drawWeight60`)
  — progression may not feel linear enough across the four presets.
  Carried over from the prior pass.
- **Fill toggle / shape inspector / text inspector**: still not ported.
  Selection-based mutation lives in the context menu; we have not yet
  decided whether the dock will grow inspectors for non-pen, non-connector
  tools or whether the context menu remains the single source.
- **Stale CLAUDE.md references**: see the list under "Stale references"
  above. Should be swept in a follow-up commit.

---

## Recent Behavior Changes (since the last state doc)

- 2026-04-22 → 2026-05-09: refactor pass replaced the `FIXED_COLORS` +
  `MORE_COLORS` + `recentColors` popover with a 3-slot persistent color
  model. Added the connector inspector. Deleted `ToolPanel.tsx/css`.
  Added `data-dark` luminance-driven inner outline on dark slots /
  swatches. Centralized close-on-pick in `actions.ts`. Bumped checkmark
  size + stroke. Widened slot column gap to 12px and picker grid gap to
  10px.
