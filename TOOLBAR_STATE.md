# Toolbar Redesign — Current State (2026-05-12, post-store-refactor)

> **Not finalized.** The store/toolbar split landed this pass: per-tool flat
> fields on `device-ui-store`, four connector variants derived from cap
> triples, component-local picker state, and a re-organized
> `inspectors/`+`color/` directory layout. Hex codes, icon weights, spacing,
> threshold values, and the connector variant icon set are all still in
> active tuning.

## Situation

The toolbar now has:

- **Vertical main pill** on the left edge.
- **Pen / highlighter inspector** with three persistent color slots per
  tool. Pen and highlighter each persist their own slot column + active-slot
  pointer; the active slot's color is read at `DrawingTool.begin()` time
  (no shared mirror field). Stroke width is shared between pen and
  highlighter (`strokeWidth`). Click an inactive slot to switch; click the
  active slot to open a color picker. The picker holds a 24-color palette +
  a custom-hex entry; picking any color closes it.
- **Connector inspector** with **four** variant buttons (line, arrow,
  doubleArrow, elbow) and a single-slot color picker. The active variant is
  **derived** from `(connectorType, connectorStartCap, connectorEndCap)` at
  render time via `deriveConnectorVariant()` — there is no stored variant
  field. Clicking a button calls `setConnectorMode(variant)`, which writes
  the cap triple atomically in one `set()`.

The previous `ToolPanel.tsx` / `ToolPanel.css` (horizontal top dock + the
old `FIXED_COLORS` + `MORE_COLORS` + `recentColors` popover) is **deleted**.
The barrel export was removed from `client/src/components/index.ts`. Git
history preserves the old code.

Reference assets used during the port still live untracked in the repo
root: `zoommenustroke.png`, `muraltoolbar.png`, `mural_strokeMenu.png`,
`CONNECTOR_MENU.png`, `MURAL_ZOOM_HTML.MD`, `cssmural.md`, plus the various
Mural screenshots and the `docs/TOOLBAR_ICON_DESIGN.md` working notes.

---

## File Status

### `client/src/components/toolbar/` (live)

The flat layout has been split into `inspectors/` (toolbar-specific glue)
and `color/` (reusable color primitives destined to migrate to a shared
location once the context menu adopts them). CSS is co-located with each
component; `inspectors/Inspector.css` `@import`s the three primitive CSS
files (one local, two from `../color/`) so inspectors only need one
stylesheet import.

| File                                  | Role                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                            | re-exports `{ Toolbar }`                                                                                                   |
| `Toolbar.tsx`                         | main dock; dispatches `<PenInspector />` or `<ConnectorInspector />` based on `activeTool`. Direct imports for actions.    |
| `Toolbar.css`                         | `:root` design tokens + main-pill + actions-pill + tooltip styling                                                         |
| `weights.ts`                          | `SIZE_PRESETS: StrokeWidth[]` + `WEIGHT_ICONS` — index-aligned                                                              |
| `connector-variants.ts`               | `ConnectorVariantId`, `CONNECTOR_VARIANT_BUTTONS` (4 entries), `deriveConnectorVariant(type, startCap, endCap)`            |
| `inspectors/Inspector.css`            | shared inspector pill shell + divider; `@import`s the 3 primitive CSS files                                                |
| `inspectors/InspectorButton.tsx/css`  | reusable square icon button with `is-active` state — used by tool toggles, weight buttons, connector variants              |
| `inspectors/PenInspector.tsx`         | pen / highlighter toggle, 4 weight buttons, 3-slot color row + picker (local `useState`)                                   |
| `inspectors/ConnectorInspector.tsx`   | 4 variant buttons (inlined SVGs) + 1-slot color row + picker (local `useState`). Variant derived from caps.                |
| `color/ColorSlots.tsx/css`            | reusable column of 1–3 rounded-square slots; manages click semantics                                                       |
| `color/ColorSlot.tsx`                 | single slot — checkmark + `--slot-tint` offset ring when active; `data-dark` triggers a white inset stroke                 |
| `color/ColorPicker.tsx/css`           | 24-swatch grid (6×4) + custom hex input + outside-click close; `data-dark` swatches get a brighter border                  |
| `color/CheckIcon.tsx`                 | tiny memoized `<svg>` check, accepts `color` + `size` + `strokeWidth`                                                       |
| `color/palette.ts`                    | `PALETTE` (24 colors), `PALETTE_COLS = 6`, `luminance`, `checkmarkColorFor`, `isDark`, `colorsEqual`                       |

### Removed

- `actions.ts` — every action is now either a destructured handler exported
  from `device-ui-store` (e.g. `setActiveTool`, `setStrokeWidth`,
  `setShapeMode`, `setConnectorMode`, …) or a direct import
  (`openImageFilePicker`, `getActiveRoomDoc().undo/redo`). The wrapper layer
  was dead weight once picker state moved into components and the
  shape/connector mode setters became atomic store actions.
- `constants.ts` — split into `weights.ts` (stroke widths + weight icons)
  and `connector-variants.ts` (variant ids + button table + derivation).
- `client/src/utils/color.ts` (`createFillFromStroke` + `hexToRgb` +
  `rgbToHex`) — had no callers left after `DrawingTool` started committing
  raw `shapeFillColor` and `shape-preview.ts` started painting
  `preview.fillColor` directly.

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
      │   │         └─ {isPickerOpen && <ColorPicker />}      isPickerOpen = local useState
      │   └─ {isConnector && <ConnectorInspector />}
      │      └─ .inspector
      │         ├─ 4× <InspectorButton>            line / arrow / doubleArrow / elbow
      │         ├─ inspector-divider
      │         └─ <ColorSlots count=1>
      │            ├─ 1× <ColorSlot>
      │            └─ {isPickerOpen && <ColorPicker />}        isPickerOpen = local useState
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
  for active dark colors (or `0.55` for inactive dark colors).
- Gap ring: `0 0 0 2px var(--dock-bg)`.
- Offset ring: `0 0 0 4px var(--slot-tint)` — `--slot-tint` is the slot's
  own color, set inline in `ColorSlot.tsx` as a CSS variable.
- Checkmark: 16×16 SVG, stroke color is white if `luminance(color) ≤ 0.55`
  else black.

### Tool order (top → bottom in `.toolbar-main`)

Direct module-level handlers in `Toolbar.tsx`:

1. Select `V` — `setActiveTool('select')`
2. Pan `Space` — `setActiveTool('pan')`
3. divider
4. Sticky Note `N` — `setActiveTool('note')`
5. Text `T` — `setActiveTool('text')`
6. Rectangle `R` — `setShapeMode('rectangle')` → committed `shapeType: 'rect'`
   (was `'roundedRect'` pre-refactor; a future "mixed shape menu" button
   will surface `roundedRect`/triangle/etc. from a single slot)
7. Ellipse `O` — `setShapeMode('ellipse')`
8. Diamond `D` — `setShapeMode('diamond')`
9. Connector `A` — `setActiveTool('connector')` → opens Connector inspector
10. Pen `P` — `setActiveTool('pen')` → opens Pen inspector. Stays
    highlighted while `activeTool === 'highlighter'` (no top-level
    highlighter button).
11. Code — `setActiveTool('code')`
12. Image `I` — `openImageFilePicker()`; never marked active. Not a
    sustained mode — `'image'` is no longer in the `Tool` union.
13. Eraser `E` — `setActiveTool('eraser')`

### Pen inspector contents

1. Pen toggle (`IconInspectorPen`, 30×30 button, 20×20 icon).
2. Highlighter toggle (`IconInspectorHighlighter`).
3. Divider.
4. Stroke weights `W1..W4` — `StrokeWidth [4, 7, 10, 13]` mapped to
   `IconStrokeWeight1..4` via index in `weights.ts`. Each icon is a
   distinct hand-drawn squiggle (W1=Mural drawWeight10, W2=drawWeight20,
   W3=drawWeight40, W4=custom heavy). Pen and highlighter SHARE
   `strokeWidth` — changing the width applies to both tools.
5. Divider.
6. `<ColorSlots />` — 3 rounded squares. Pen and highlighter each persist
   their own slot column + active-slot pointer; switching active tool
   swaps the slot column for the new tool. The slot column for the
   inactive tool is unaffected. `DrawingTool.begin()` reads
   `penSlots[penActiveSlot]` or `highlighterSlots[highlighterActiveSlot]`
   based on `activeTool` at gesture start — no shared mirror field.

### Connector inspector contents

1. **Four** variant buttons. Each calls `setConnectorMode(variant)`, an
   atomic store action that writes a `(type, startCap, endCap)` triple in
   one `set()`:
   - `line` → `straight / none / none`
   - `arrow` → `straight / none / arrow`
   - `doubleArrow` → `straight / arrow / arrow`
   - `elbow` → `elbow` (**caps preserved** — only the type flips)

   Single subscriber notification per click, no three-write race.

2. **Active button is derived** at render time via
   `deriveConnectorVariant(type, startCap, endCap)`:
   - `type === 'elbow'` → `'elbow'` (any cap config — elbow swallows them)
   - `straight + arrow/arrow` → `'doubleArrow'`
   - `straight + none/arrow` → `'arrow'`
   - `straight + none/none` → `'line'`
   - Otherwise → `null` (no toolbar button matches; e.g. a backward
     straight `arrow/none`). The selection inspector — once wired —
     still shows the individual caps.

   `deriveConnectorVariant` is pure; called once per inspector render.

3. Divider.
4. `<ColorSlots count=1 />` over `connectorColor`. Picker behaves
   identically to the pen inspector's picker (local `useState`,
   close-on-pick via the inspector's `handlePick` closure).

### Color picker

- 24 colors in a 6×4 grid (`PALETTE` in `color/palette.ts`). Currently-
  selected color shows a 13×13 checkmark (contrast-flipped via
  `checkmarkColorFor`).
- `+` action toggles a custom-hex input (validated against
  `/^#([0-9a-f]{3}|[0-9a-f]{6})$/i`). Submitting via Enter or the apply
  button calls `onPick`; closing via Escape clears the draft.
- Eyedropper button is rendered but currently disabled.
- Closes on outside click. Clicks inside the slots column do not close
  the picker — those clicks are handled by the slot itself.
- Picking any color **also closes the picker** — each inspector's
  `handlePick` closure calls both the slot/color setter and
  `setIsPickerOpen(false)`. (Previously centralized in `actions.ts`;
  now lives at the inspector since picker state is component-local.)

### Tooltip behavior

Same as the prior pass — CSS pseudo-element on `.tool-btn`, positioned
`right` of the button (`left: calc(100% + 10px); top: 50%`), suppressed
while any inspector is open via
`.toolbar-wrap:has(.inspector) .toolbar-main .tool-btn::after { display: none; }`.

---

## State Integration (`useDeviceUIStore`)

### Flat per-tool fields (persisted)

The store no longer has a unified `drawingSettings`. Each tool reads its
own fields at `begin()` time.

| Field                                          | Type                | Purpose                                                              |
| ---------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `penSlots`                                     | `ColorSlots`        | Pen's three persistent slot colors                                   |
| `penActiveSlot`                                | `SlotIndex`         | Which pen slot is active                                             |
| `highlighterSlots`                             | `ColorSlots`        | Highlighter's three persistent slot colors                           |
| `highlighterActiveSlot`                        | `SlotIndex`         | Which highlighter slot is active                                     |
| `highlighterOpacity`                           | `number` (0..1)     | Highlighter-only                                                     |
| `strokeWidth`                                  | `StrokeWidth`       | **Shared** by pen + highlighter                                      |
| `shapeVariant`                                 | `ShapeVariant`      | Active toolbar shape (rectangle/ellipse/diamond/triangle)            |
| `shapeColor`                                   | `string`            | Stroke color for toolbar shapes (independent of pen)                 |
| `shapeFillColor`                               | `string`            | Fill color for toolbar shapes (always applied — toolbar shapes are filled by default; snap-from-stroke commits unfilled) |
| `shapeWidth`                                   | `StrokeWidth`       | Stroke width for toolbar shapes (independent of stroke tools)        |
| `shapeAlign` / `shapeAlignV`                   | `TextAlign(V)`      | Shape label alignment                                                |
| `connectorColor`                               | `string`            | Connector stroke color (independent of pen)                          |
| `connectorWidth`                               | `ConnectorWidth`    | Connector stroke width (`2 \| 4 \| 6 \| 8`)                          |
| `connectorType`                                | `ConnectorType`     | `'elbow' \| 'straight'` — used to derive variant                     |
| `connectorStartCap` / `connectorEndCap`        | `ConnectorCap`      | `'none' \| 'arrow'` — used to derive variant                         |
| `textColor` / `textAlign` / `textSize` / `textFontFamily` / `textHighlightColor` / `textFillColor` | various | Text-tool defaults |
| `noteAlign` / `noteAlignV` / `noteFontFamily`  | various             | Note-tool defaults                                                   |
| `codeLineNumbers` / `codeHeaderVisible`        | `boolean`           | Code-tool defaults                                                   |
| `userId` / `userName` / `userColor`            | strings             | Identity (persisted)                                                 |
| `activeTool` / `cursorOverride`                | `Tool` / `string?`  | Tool state                                                           |

Persisted store key: `'avlo.toolbar.v6'`, version `4`. Old localStorage
entries are wiped on first load (schema is incompatible).

### Removed fields (since prior pass)

- `drawingSettings` (with `size/color/opacity/fill`) — replaced by per-tool
  flat fields.
- `connectorVariant` — derived from caps at render time.
- `CONNECTOR_VARIANT_PRESETS` — replaced by inline switch in
  `setConnectorMode`.
- `isColorPickerOpen` (+ `setColorPickerOpen` / `toggleColorPicker`) —
  moved into component-local `useState` (pen and connector inspectors
  each own their own).
- `penColorSlots` → `penSlots`; `highlighterColorSlots` → `highlighterSlots`
  (rename).
- `connectorSize` → `connectorWidth` (rename).
- `fillColor` → `shapeFillColor` (rename + scope clarification).
- `highlightColor` → `textHighlightColor` (rename + scope clarification).
- `image: { enabled: boolean }` — image is a one-shot toolbar action, not
  a sustained mode.
- `'image'` removed from `Tool` union.
- `TEXT_COLOR_PALETTE` — dead (zero references).
- `getCurrentToolSettings` helper — replaced by per-tool reads at
  `tool.begin()`.

### Sync rules

- `setActiveTool(tool)` — no longer pushes any color into a shared mirror
  field. Each tool's color comes from its own fields.
- `setShapeMode(variant)` — atomic `{ activeTool: 'shape', shapeVariant }`.
- `setConnectorMode(variant)` — atomic `(type, startCap, endCap)` write
  per the variant table above.
- `setPenSlotColor(color)` / `setHighlighterSlotColor(color)` — write
  into the currently-active slot of that tool. No `drawingSettings.color`
  side-effect (it doesn't exist anymore).
- `DrawingTool.begin()` branches on `activeTool`:
  - `'pen'` → `penSlots[penActiveSlot]` + `strokeWidth` + opacity 1 +
    `fillColor: null`.
  - `'highlighter'` → `highlighterSlots[highlighterActiveSlot]` +
    `strokeWidth` + `highlighterOpacity` + `fillColor: null`.
  - `'shape'` → `shapeColor` + `shapeWidth` + opacity 1 + `shapeFillColor`
    (always set; toolbar shapes commit filled).

  Hold-snap from a stroke gesture commits the resulting shape unfilled
  (`fillColor` stays `null` from the stroke begin).
- `ConnectorTool.begin()` reads `connectorColor` / `connectorWidth` /
  `connectorType` / `connectorStartCap` / `connectorEndCap`. Connector
  preview (`renderer/layers/connector-preview.ts`) reads the same fields
  live each frame — `drawingSettings.color` no longer exists, so the
  pre-refactor "preview drew in pen color" bug is structurally impossible.

### Stable action handler exports

At module scope, `device-ui-store.ts` destructures every action out of
the live store and re-exports them as named consts:

```ts
export const {
  setActiveTool, setStrokeWidth, setShapeMode, setConnectorMode,
  setPenActiveSlot, setPenSlotColor, setHighlighterActiveSlot,
  setHighlighterSlotColor, setHighlighterOpacity,
  setShapeVariant, setShapeColor, setShapeFillColor, setShapeWidth, …
} = useDeviceUIStore.getState();
```

Zustand actions are defined once inside `create()`; the references never
change. Components import these directly so memoized children retain
prop equality across renders. This replaces the old `toolbar/actions.ts`
wrapper.

### Narrow component selectors

| Component                | Selectors                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Toolbar.tsx`            | `activeTool`, `shapeVariant`                                                                                                                                |
| `PenInspector.tsx`       | `activeTool`, `strokeWidth`, conditional (`penSlots` xor `highlighterSlots`), conditional (`penActiveSlot` xor `highlighterActiveSlot`). Picker state local. |
| `ConnectorInspector.tsx` | `connectorType`, `connectorStartCap`, `connectorEndCap`, `connectorColor`. Picker state local. Active variant derived from cap triple.                      |
| `ColorPicker.tsx`        | none — all data flows in via props                                                                                                                          |

The three narrow cap selectors in `ConnectorInspector` mean a cap-only
change fires only the relevant selector; the inspector re-renders, the
derivation runs (≈5 comparisons), and `<InspectorButton>`s see new
`isActive` booleans. `Toolbar.tsx` doesn't subscribe to any of those
fields, so it never re-renders on a connector cap change.

---

## Memoization

- `ToolButton` (13 instances in `Toolbar.tsx`) — `React.memo`. All click
  handlers are module-level constants, sourced from direct imports of
  the destructured store handlers (`setActiveTool`, `setShapeMode`, …)
  plus `openImageFilePicker` and a tiny `clickUndo`/`clickRedo` closure.
- `InspectorButton` — `React.memo`. Pen-inspector weight buttons read
  click handlers from a module-level `WEIGHT_HANDLERS` lookup keyed by
  size; connector-inspector variant buttons use the same pattern via
  `VARIANT_HANDLERS`. No inline arrows reach the memoized child.
- `ColorSlots` — `React.memo`. `ConnectorInspector` wraps its single
  color in `useMemo<readonly [string]>(() => [color], [color])` so the
  memo holds across renders that don't actually change the color. Each
  inspector passes stable `useCallback` handlers (`handleSelectSlot`,
  `handlePick`, `handleToggle`, `handleClose`).
- `ColorSlot` — `React.memo`. The active-vs-inactive `onClick` choice
  is composed inline inside `ColorSlots`, so non-active slots see a
  fresh closure each render — bounded ≤3 closures.
- `ColorPicker` and the inner `Swatch` — both `React.memo`.
- `CheckIcon` — `React.memo`.

Critical invariant: every onClick passed to a memoized child is either
a module-level const, a destructured-store handler (also module-level),
or sourced from a module-level lookup table. The two exceptions (slot
inline arrows, picker swatch inline arrow) are bounded to ≤24 closures
per render and intentional.

---

## Icons

### Used by `toolbar/`

`IconSelect`, `IconPan`, `IconStickyNote`, `IconText`, `IconRectangle`,
`IconEllipse`, `IconDiamond`, `IconArrow`, `IconPen`, `IconCode`,
`IconImage`, `IconEraser`, `IconUndo`, `IconRedo`, `IconInspectorPen`,
`IconInspectorHighlighter`, `IconStrokeWeight1..4`.

The connector inspector inlines its **four** variant SVGs in
`inspectors/ConnectorInspector.tsx`. Each path is laid out so the bbox
center sits at viewBox (12, 12).

### Defined but unreferenced

- `IconHighlighter`, `IconFill`, `IconLine` — were used only by the
  deleted `ToolPanel`. Safe to delete from `icons/index.tsx` if no
  other callers crop up.

---

## Design Tokens

The `:root` block lives in **`client/src/components/toolbar/Toolbar.css`**:

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

- **Palette hex codes**: `color/palette.ts:PALETTE` is eyeballed from
  `zoommenustroke.png`. Each color needs a pixel-accurate sample pass.
- **Connector variant icons**: deliberately crude placeholders. There are
  now **four** — the new `arrow` (single end-arrow) icon especially needs
  a design pass. All four should be revisited against
  `docs/TOOLBAR_ICON_DESIGN.md`.
- **Eraser + Code icon polish**: both ported from svgrepo references in
  the 2026-05-12 pass and still WIP. `IconEraser` (svgrepo "eraser") —
  angled block split by a diagonal seam; seam width and tail
  proportions need tuning. `IconCode` (svgrepo "code-square") — filled
  squircle with `</>` + slash cutouts via evenodd; chevrons + slash
  render too small inside the 24-unit viewBox and need a redesign pass.
- **`isDark` threshold** (`color/palette.ts:isDark`, currently `< 0.25`).
  May need to widen to `0.3-0.35` if mid-dark colors read as needing the
  inset white stroke too.
- **Slot offset ring on dark colors**: the `--slot-tint` outer ring is
  the slot's own color, so a black slot's ring is also black against the
  near-black dock — barely visible. Open design question.
- **Eyedropper** is rendered but disabled. Wire to `EyeDropper` API when
  prioritized.
- **Hex input UX**: opens via the `+` action, autofocuses, closes on
  Escape. Potentially redundant with the eyedropper once the latter is
  live.
- **Picker positioning**: `top: -8px` from the slot column. Vertical
  alignment with the slot row center may be cleaner once more inspectors
  land.
- **Rectangle button → `'rect'`, not `'roundedRect'`**: pre-refactor the
  Rectangle (R) button created a `roundedRect`. The new toolbar binding
  is `shapeType: 'rect'`. A future "mixed shape menu" button (one slot
  in `.toolbar-main` that drops down rect / roundedRect / triangle /…)
  will surface `roundedRect` and other variants. The `ShapeVariant` type
  doesn't include `roundedRect` today; adding it is a small follow-up.
  Existing `roundedRect` objects in user data still render correctly —
  only new toolbar shapes are affected.
- **Selection-driven cap setters**: changing a selected connector's caps
  via the (future) selection inspector will automatically update the
  toolbar's active-variant button because the inspector derives the
  active variant from caps. No further toolbar wiring needed when those
  selection actions land.
- **Fill toggle / shape inspector / text inspector**: still not ported.
  Selection-based mutation lives in the context menu; we have not yet
  decided whether the dock will grow inspectors for non-pen, non-connector
  tools or whether the context menu remains the single source.
- **Stale CLAUDE.md references**: see the list under "Stale references"
  above. Should be swept in a follow-up commit.

---

## Recent Behavior Changes

- **2026-05-12 (this pass — store + toolbar refactor)**.
  - **Store rewrite**: split unified `drawingSettings` into per-tool flat
    fields (`penSlots`, `highlighterSlots`, `strokeWidth`, `shapeColor`,
    `shapeFillColor`, `shapeWidth`, `connectorColor`, `connectorWidth`).
    Renamed `SizePreset → StrokeWidth`, `ConnectorSizePreset →
    ConnectorWidth`, `fillColor → shapeFillColor`, `highlightColor →
    textHighlightColor`. Deleted `connectorVariant` + presets,
    `isColorPickerOpen`, `TEXT_COLOR_PALETTE`, `getCurrentToolSettings`,
    `image.enabled`, `'image'` from `Tool` union. Added atomic
    `setShapeMode` + `setConnectorMode`. Exported destructured action
    handlers at module scope (stable refs). Bumped persisted key to
    `'avlo.toolbar.v6'`, version 4.
  - **Toolbar restructure**: split `toolbar/` into `inspectors/`
    (PenInspector, ConnectorInspector, InspectorButton, Inspector.css)
    and `color/` (ColorPicker, ColorSlots, ColorSlot, CheckIcon,
    palette). Added `weights.ts` + `connector-variants.ts`. Deleted
    `actions.ts` + `constants.ts`. CSS `@import` paths updated.
  - **Connector inspector**: now four variants (line / arrow /
    doubleArrow / elbow). Active button **derived** from
    `(connectorType, connectorStartCap, connectorEndCap)` via
    `deriveConnectorVariant`. `setConnectorMode` is a single atomic
    `set()` (no three-write race). Picker state moved into component
    `useState`.
  - **Pen inspector**: reads `strokeWidth` (was `drawingSettings.size`)
    and per-tool slot fields. Picker state moved into component
    `useState`.
  - **`DrawingTool.begin()`**: per-tool reads. Replaced
    `private fill = false` with `private fillColor: string | null = null`.
    Toolbar shape gestures commit raw `shapeFillColor`; snap-from-stroke
    commits unfilled (matches "always unfilled snap" spec).
    `SHAPE_VARIANT_TO_TYPE.rectangle = 'rect'` (was `'roundedRect'`).
  - **Connector preview color bug fixed**: `connector-preview.ts` now
    reads `connectorColor` (was `uiState.drawingSettings.color`) and
    `connectorWidth` (was `connectorSize`). Connector previews now
    match the committed color/width during drag.
  - **`ShapePreview` type**: `fill: boolean → fillColor: string | null`.
    `shape-preview.ts` paints `preview.fillColor` directly — no
    `createFillFromStroke` mix.
  - **`client/src/utils/color.ts` deleted**: `createFillFromStroke` +
    `hexToRgb` + `rgbToHex` had no remaining callers after the
    shape-preview / DrawingTool changes.
  - **`selection-field-table.ts`**: persist sinks updated per renamed
    store fields. Stroke `COLOR` persist removed (pen slots are
    independent of selected stroke color — editing a stroke's color
    no longer overwrites the pen's active slot). Shape and stroke
    `WIDTH` persists split (`setShapeWidthPersist` vs
    `setStrokeWidthPersist`). `FILL_COLOR` persist no longer toggles
    `setFillEnabled` (which doesn't exist).
- 2026-05-12 (earlier): `IconEraser` + `IconCode` rewritten from svgrepo
  references (both still WIP, see Pending).
- 2026-05-09: Stroke-weight icons now visually distinct. W2/W3 replaced
  with Mural's real `drawWeight20` / `drawWeight40` (2 paths each).
  `drawWeight30` skipped: width gap from `drawWeight20` ≈ +0.21 in stroke
  radius, too small to read at icon scale.
- 2026-04-22 → 2026-05-09: refactor pass replaced the `FIXED_COLORS` +
  `MORE_COLORS` + `recentColors` popover with a 3-slot persistent color
  model. Added the connector inspector (3 variants then; 4 now). Deleted
  `ToolPanel.tsx/css`. Added `data-dark` luminance-driven inner outline
  on dark slots / swatches. Bumped checkmark size + stroke. Widened slot
  column gap to 12px and picker grid gap to 10px.
