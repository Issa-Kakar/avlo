# Context Menu System

> **EVERYTHING IS MUTABLE.** This directory is under active redesign in the
> `avlo-parallel` worktree. Every value documented below — hex codes, font
> weights, icon sizes, spacing, classes, button taxonomies, popover patterns
> — is in flux. **Do not treat any value or structure documented below as
> canonical.** Read it as the snapshot-shape you're about to mutate.
>
> The **filter dropdown** (`FilterObjectsDropdown`, mixed-selection menu) is
> the solid base. Its trigger states, row layout, and the tokens below are
> the design vocabulary every other surface will align to.
> Pull from this list — not from legacy values further down.
>
> **Filter-menu vocabulary (alignment targets):**
> - **Body text:** `#48525b` (`--ctx-text`) — the menu-wide default for label / body text. Trigger FILTER label (w600, 10px, caps + 0.03em tracking), filter row labels (w700, 12px), filter row counts (w500, 11px, tabular-nums), the typeface + font-size dropdown rows. The menu's "everything else" color.
> - **Primary focal text:** `#1F2937` w700, 13px. Closed-trigger `{N} objects` only.
> - **Engaged dark `#1b1f22`** (`--ctx-engaged`) — the menu's darkest tone, two roles. As a *fill* (white text/icons on it): every dropdown trigger that composes the shared `.ctx-btn-engaged` marker (engaged on `[aria-expanded="true"]`), active toggles via `.ctx-btn-fmt.active` (bold / italic, code header / output), every dropdown's active selected row (`.ctx-submenu-item-active`). As *ink*: the `.ctx-btn` base color — every icon button in the bar inherits it; text-bearing triggers (filter, language) paint via explicit SVG `fill` and ignore it.
> - **Tier dark `#282e34`** — a deliberate notch lighter than `#1b1f22`; kept, not debt. It reads better than the near-black on a few surfaces: the stroke-width + connector-type tier-menu active row (`bg-[var(--ctx-engaged-tier)]` utility on the row), the `TypefaceButton` / `LanguageDropdown` trigger ink — reach for it where full `#1b1f22` sits too heavy.
> - **Open-trigger primary text:** pure white.
> - **Open-trigger FILTER subtitle:** `#D4B89B` (warm sand). Intentional warm third pole in the otherwise cool slate palette; deliberately stays subordinate to white (~2× contrast hierarchy). `fill 150ms ease` transition.
> - **Icons:** 20×20, sourced from `components/toolbar/icons/*`. `fill="currentColor"` / `stroke="currentColor"` so they tint via parent.
> - **Row protection:** `whitespace-nowrap` utility on filter dropdown rows — prevents subpixel wrap on borderline-fit labels (e.g. "Sticky Note" against `min-w-[140px]`).
> - **Labels singular:** `Stroke` / `Shape` / `Connector` / `Image`. Two-word singulars (`Code Block`, `Sticky Note`) untouched.
> - **Lock button:** `.ctx-btn-sq .ctx-btn-lock`. `.ctx-btn-lock` is a TSX-only semantic marker (no CSS rules); icon ink `var(--ctx-engaged)` is inherited from the `.ctx-btn` base. Mural 24-viewBox glyph in `icons/LockIcon.tsx`, 20×20. Rendered by the shell as the leftmost button on every bar — including `image` / `bookmark`, where it's the *entire* bar. No-op placeholder; locking is not implemented yet. Trash + overflow `…` were lifted into the upcoming right-click menu; the `IconTrash` source survives at `icons/TrashIcon.tsx` for reuse elsewhere in the app, but nothing in the context menu imports it.
> - **Defaults, not laws.** Icon `#1b1f22` / text `#48525b` are menu-wide starting points; surfaces mix tones case-by-case, per the action / icon / text they carry.
>
> **Aligned to the new vocabulary:** `FilterObjectsDropdown` (the base);
> `StrokeColorControl` + `StrokeWidthControl` (teardrop / bars triggers); the
> text-formatting slice — bold / italic, `AlignDropdown`, `NoteAlignDropdown`,
> `TypefaceButton` — reskinned to Mural glyphs with `.ctx-btn-fmt` engaged
> states; `FontSizeStepper` (value + arrows at `#1b1f22`, dropdown active
> row + rows reconciled); `FillColorControl` + `BorderColorControl` +
> `TextColorPopover` + `HighlightPickerPopover` all share `ColorGrid` (the
> presentational swatch surface — `NoFillIcon` at slot 0 for the
> no-fill / no-stroke / no-highlight cases) sitting under a uniform
> `.ctx-btn-sq` + `.ctx-btn-engaged` trigger (icon `#1b1f22` at rest, bg +
> glyph flip on open, the colored bar stays its own color). Stroke +
> connector selections are fully off the legacy color/size widgets — connector
> bars are now `[Color] | [Width] | [StartCap] [EndCap] | [ConnectorType] | [Label?]`
> (stroke bars are the same minus the trailing four). `ConnectorTypeControl`
> reuses the `StrokeWidthControl` tier-menu shell (Straight, Orthogonal);
> `ConnectorCapControl` is the per-endpoint cap picker (no-arrow ↔ arrow), one
> instance per endpoint with arrow direction mirroring the slot; `LabelButton`
> mirrors `LockButton` as the rightmost shell-button slot, but only renders
> when exactly one connector is selected (a label has no meaningful target on
> a multi-select). `ConnectorTypeControl` and `LabelButton` are no-ops today
> — `ConnectorTypeControl` is read-only on `selectedStyles.connectorType`
> until route/endpoint switching is wired separately; caps wire to
> `setSelectedStartCap` / `setSelectedEndCap` and persist to the device-ui
> `connector.startCap` / `connector.endCap` defaults. `ShapeTypeDropdown`
> is the rightmost slot on shape/text/note bars — Mural `switchType` glyph
> trigger (`.ctx-btn-sq` + `.ctx-btn-engaged`, engaged-dark on open) + a 4×2
> icon-only grid (Sticky · Text · Rect · Circle · Diamond · Triangle ·
> Rounded, one trailing empty cell); every cell is live — same-kind shape
> variants route to `setSelectedShapeType`, cross-kind cells to
> `convertSelectionTo` / `convertSelectionToShape` (in-place kind mutation,
> `tools/selection/convert-kind.ts`). (The text slice still has tweaks
> pending — values are current, not final.)
>
> **Tailwind v4 migration (landed):** every per-control CSS file has been
> deleted; per-control variations (submenu sizing, row geometry, cell layout,
> active-state fills) are now inline Tailwind utilities on the relevant TSX
> element. The CSS foundation is six files under `styles/` (`tokens`, `shell`,
> `buttons`, `dropdowns`, `color-grid`, `svg-triggers`), all wrapped in
> `@layer components` so utilities cleanly override. Every picker trigger
> collapses to `.ctx-btn-sq` (only `TypefaceButton` uses `.ctx-btn min-w-14`
> instead). When inlining a state-conditional bg/text, **don't compose
> conflicting utilities on the same element** — Tailwind v4 sorts utilities
> by its own algorithm, not className order, so `bg-transparent` + active
> `bg-[var(--ctx-engaged)]` won't reliably swap. Pick one set per state via
> a ternary (see `ShapeTypeDropdown` / `ConnectorCapControl` for the
> pattern).
>
> **Bar shell + button geometry** (descriptors, not flux): `.ctx-menu` carries
> the 12px-radius white shell with a 1px hairline + soft drop shadow; the
> `.ctx-btn` family is 32×32 with an 8px radius and `var(--ctx-engaged)` base
> ink. These are current shape, not legacy.
>
> **Task scope comes from the prompt, not this doc.** The body below describes
> *what currently exists*. The prompt tells you what to change.

---

Selection-aware contextual toolbar positioned above/below the selection via `@floating-ui/dom`.

## Architecture

Two-layer split: **imperative controller** owns DOM positioning + visibility, **React** owns content rendering. The portal element is a static div in `index.html` — always present in the DOM, never managed by React lifecycle.

```
index.html
├── #overlay-root                              <- unstyled grouping node
│   └── #context-menu-portal                   <- .context-menu-floating, position:fixed
│       └── <ContextMenu />                    <- React portal from Canvas.tsx
│
ContextMenuController.ts (singleton)
├── init(el): binds portal element, wires menuOpen + boundsVersion subscriptions
├── show(): SelectTool pointer-up path. Auto-activates, positions, reveals.
├── hide(): SelectTool pointer-down. Hides but keeps React mounted.
├── onCameraMove(): CanvasRuntime piggybacks. Debounce 150ms -> reposition.
└── destroy(): teardown on Canvas unmount

ContextMenu.tsx (React)
├── ContextMenu()       <- gate: returns null when !menuOpen
└── ContextMenuBar()    <- kind-branched groups based on effectiveKind
```

### Separation of Concerns

| Concern | Owner | Never touches |
|---------|-------|---------------|
| Positioning (left/top) | Controller | React components |
| Visibility (ctx-hidden class) | Controller | React state |
| Content rendering | React (ContextMenu.tsx) | DOM positioning |
| Store subscriptions for position | Controller (boundsVersion) | React |
| Store subscriptions for styles | React (selectedStyles, inlineStyles) | Controller |

---

## Controller State Machine

Two boolean flags: `active` (React mounts content via `menuOpen` in store) and `visible` (not gesture-hidden or camera-hidden).

### Activation Paths

```
show()       <- SelectTool end/cancel. Auto-sets menuOpen if not already active. Primary path.
menuOpen     <- store subscription (beginTextEditing). No-op if show() already activated.
```

### Deactivation

```
menuOpen -> false  <- clearSelection, endTextEditing with no selection -> deactivate()
```

### Gesture Flow

```
begin()  -> controller.hide()  -> visible=false, ctx-hidden added, timers cancelled
move()   -> setSelection(ids)  -> no menuOpen change (marquee stays hidden)
end()    -> controller.show()  -> active+visible=true, menuOpen set, RAF -> position -> class removed
```

**Single-text re-click exception:** When clicking a single-selected text object (to mount editor), `begin()` calls `hide()` as usual, then immediately `cancelHide()` — synchronous class add/remove in the same frame means no paint, no flash. If the user drags instead, `move()` calls `hide()` when the drag threshold passes. Without this, the menu would flash: instant hide in `begin()` -> 200ms spring re-show in `end()` after editor mounts.

### Camera

`onCameraMove()` called by CanvasRuntime. No-op when `!active || !visible`. Adds `ctx-hidden` instantly, debounces 150ms, repositions on settle.

### Full Lifecycle

```
Canvas.tsx mount
  -> contextMenuController.init(portalEl)
    ├─ subscribes to menuOpen  -> activate() / deactivate()
    └─ subscribes to boundsVersion -> schedulePosition() if active+visible

SelectTool.begin()  -> controller.hide()  (+ cancelHide() for single-text re-click)
SelectTool.move()   -> controller.hide()  (objectInSelection drag start — deferred from begin)
SelectTool.end()    -> controller.show()  (guarded: selectedIds > 0 || textEditingId)
SelectTool.cancel() -> controller.show()  (same guard)

beginTextEditing()  -> menuOpen=true (store) -> activate() via subscription
endTextEditing()    -> menuOpen=conditional -> deactivate() if no selection

CanvasRuntime camera sub -> contextMenuController.onCameraMove()

Canvas.tsx unmount -> controller.destroy()
```

---

## Positioning

`@floating-ui/dom` with `strategy:'fixed'`, `placement:'top'`.

**Virtual element:** `createVirtualElement(worldBounds)` converts selection world bounds to screen rect via `worldToClient()`. No viewport clipping — floating-ui middleware handles edges.

**Middleware chain:** `offset(40)` -> `flip` (top-biased, bottom fallback) -> `shift` (horizontal clamping, cross-axis) -> `hide` (referenceHidden detection — hides when selection scrolls fully offscreen).

**Exclusion zones:** `FLIP_PADDING: { top: 64, bottom: 76, left: 12, right: 12 }`, `SHIFT_PADDING: { top: 64, bottom: 12, left: 64, right: 12 }`. Top 64px clears the TopBar pill (top:7 + h:48 = 55, +9 buffer). Left 64px on shift clears the vertical Toolbar pill (left:9 + w:48 = 57, +7 buffer) — flip's left isn't bumped because there are no left/right fallback placements for it to switch to. Bottom 76 (flip-only) keeps the menu out of the ZoomControls' band (bottom:16 + h:48 = 64, +12 buffer); bottom shift stays at 12 because the zoom bar is right-cornered, so a downward shift on the left/center is unblocked.

**Bounds source:** `computeSelectionBounds()` — zero-arg, reads `selectedIds`/`textEditingId` from store internally. Text objects use derived frame from `getTextFrame(id)` (text layout cache). Other objects use `handle.bbox`.

---

## Show/Hide CSS

The `ctx-hidden` class toggles on the **portal container** (`#context-menu-portal`). The container itself (`position: fixed`) is always present and participating in layout — never `display: none`.

Animation is on the **inner `.ctx-menu` div** (the React bar):

- `.ctx-menu`: `opacity: 1; transform: scale(1)` with spring transition (`200ms cubic-bezier(0.34, 1.56, 0.64, 1)`)
- `.ctx-hidden .ctx-menu`: `visibility: hidden; opacity: 0; transform: scale(0.96); transition: none`

Adding `ctx-hidden` = instant hide (no transition). Removing it = spring reveal via base `.ctx-menu` transition.

**Z-index:** the portal sits at `z-index: 300` — above the canvas / editor / cursor stack (1-4) but BELOW the page chrome (Toolbar / ZoomControls 380, TopBar 400). The exclusion zones in `ContextMenuController` keep most overlaps from happening, but for the irreducible cases (an open zoom-menu, a future top-bar dropdown, a toolbar inspector opening over a selected object near it) the chrome wins. Submenus inside the bar (`.ctx-submenu` `z-index: 10`) live in the portal's stacking context, so they ride along — don't try to re-elevate them to escape the portal.

---

## Menu Bar by Selection Kind

### effectiveKind Logic

Text editing does **not** unconditionally override to `textOnly`. The bar preserves `selectionKind` from the store, so shape label editing shows `shapesOnly` (with text controls embedded). When `textEditingId !== null` AND `kind === 'none'` (standalone editing with no selection), the kind is resolved by looking up the editing object's actual kind via `getHandle()`:

```typescript
const effectiveKind =
  editing !== null && kind === 'none'
    ? (getHandle(editing)?.kind === 'note' ? 'notesOnly' : 'textOnly')
  : codeEditing !== null && kind === 'none' ? 'codeOnly'
  : kind;
```

This means:
- Editing a standalone text object -> `textOnly` bar
- Editing a sticky note -> `notesOnly` bar
- Editing a code block -> `codeOnly` bar
- Editing a shape label -> `shapesOnly` bar (shape is in selection, so `kind === 'shapesOnly'`)

The same resolution happens in `refreshStyles()` when `textEditingId` is set and `selectedIds` is empty — the snapshot is checked to determine whether to use `'notesOnly'` or `'textOnly'`.

Every bar starts with `[Lock]` (shell-rendered — always present, leftmost, even when it's the entire bar for `image` / `bookmark`). The per-kind sections below describe only the content right of that lock.

### `strokesOnly`

```
[Color teardrop] | [Width tier-menu]
```

- **Color** — `StrokeColorControl`. Teardrop trigger filled with the current color — a three-swatch drop when colors are mixed (no more half-circle split). Dropdown: 6-col palette grid mimicking the toolbar picker on a white surface (no dark bg, no custom-hex). Open-trigger bg `#1b1f22`.
- **Width** — `StrokeWidthControl`. Bars-icon trigger → Thinnest / Thin / Thick / Thickest menu. Pen scale `4 / 7 / 10 / 13` (`toolbar/weights.ts` `STROKE_WEIGHTS`). Active tier row filled `#282e34`; off-preset widths leave no row active.

### `shapesOnly`

```
[Typeface] | [-FontSize+] | [B] [I] [NoteAlign] [TextColor] [Highlight] | [Fill filled-circle] [Border hollow-circle] | [Width tier-menu] | [SwitchType]
```

Shapes include the full text formatting suite for shape labels:

- **Typeface** — self-subscribing. Trigger: current font in its own typeface, ink `#282e34`; the trigger stays light when open (no chevron — the font name is the entire affordance). Dropdown: 4 items (Draw/Inter/Lora/Mono), the active row filled `#1b1f22` with a checkmark. Calls `setSelectedFontFamily(family)`. Persists to `device-ui-store.textFontFamily`.
- **FontSize** — stepper with dropdown. `IconStepUp`/`IconStepDown` chevron arrows (not +/-). Display range: 1-999. Stepper steps through `TEXT_FONT_SIZE_PRESETS`, caps at 10 min / 144 max. Dropdown lists all presets with checkmark, center-aligned via a `[&_.ctx-submenu-item]:w-8 [&_.ctx-submenu-item]:justify-center [&_.ctx-submenu-item]:px-0` descendant variant on the submenu container.
- **Bold** / **Italic** — self-subscribing `memo` components. `.ctx-btn-fmt` square buttons; active state fills `#1b1f22` (white icon) when the entire selection has the style uniformly. Same TipTap/`formatFragment()` dual path as text objects.
- **NoteAlign** — `NoteAlignDropdown`. Self-subscribing to `selectedStyles.textAlign` and `selectedStyles.textAlignV`. Chevron-less `.ctx-btn-fmt` trigger (`#1b1f22` when open). Submenu: one flat row — H-align (left/center/right) · vertical divider · V-align (top/middle/bottom). H-align calls `setSelectedTextAlign`, V-align calls `setSelectedTextAlignV`. Persists to `device-ui-store.shapeAlign`/`shapeAlignV`.
- **TextColor** — `.ctx-btn-sq` + `.ctx-btn-engaged` trigger with "A" icon + colored bar. Glyph rests `#1b1f22`, engaged-dark on open (bg flips, glyph flips white, bar keeps its color). When no label exists on the shape, falls back to `device-ui-store.textColor`. Calls `setSelectedTextColor`.
- **Highlight** — same `.ctx-btn-sq` + `.ctx-btn-engaged` trigger pattern, highlighter-marker glyph (24-viewBox Mural-style) with colored bar; self-subscribes to `selectInlineHighlightColor`. Popout reuses `ColorGrid` (`cols=4`, `NoFillIcon` at slot 0 for "no highlight") — pixel-for-pixel match with the fill / border pickers, just a different palette.
- **Fill** — `FillColorControl`: filled square-glyph trigger (`IconColorFill`, reflects the current fill / mixed split / engaged-dark on open). Same shared `ColorGrid` with a no-fill slot. `NO_FILL` sentinel maps to `setSelectedFillColor(null)`.
- **Border** — `BorderColorControl`: hollow frame-glyph trigger (`IconColorBorder`, reflects the current border color / mixed state) → shared `ColorGrid` 6-col palette with a no-stroke slot (the `NoFillIcon` swatch). Calls `setSelectedColor` (with `null` for no stroke).
- **Width** — border width. `StrokeWidthControl` on the outline scale `2 / 4 / 6 / 8` — shapes and connectors share this scale (not the pen `4 / 7 / 10 / 13`).
- **SwitchType** — rightmost. `IconSwitchType` (Mural `switchType` glyph) inside `.ctx-btn-sq` + `.ctx-btn-engaged` (32×32 button, 20×20 SVG, engaged-dark fill flip on open). Popout: icon-only 4×2 grid — Sticky · Text · Rect · Circle · Diamond · Triangle · Rounded, trailing empty cell. 36×36 cells, 24×24 icons, right-anchored (Tailwind `left-auto right-0 translate-x-0`). Active cell = live `shapeType` filled `--ctx-engaged` with a white icon, no checkmark (the active state IS the cell). Shape-variant clicks call `setSelectedShapeType(key)`; Sticky/Text cells call `convertSelectionTo('note'|'text')` — in-place kind mutation on the same Y.Map (`tools/selection/convert-kind.ts`).

**Device-UI-store fallback for unlabeled shapes:** When a shape has no label, `computeStyles` returns `null` for `fontSize`/`labelColor`. `ShapeStyleGroup` reads `deviceTextSize` and `deviceTextColor` from `device-ui-store` as fallback values. This ensures the menu shows the values that would be used if the user starts typing to create a label — matching the "what you see is what you'd get" principle.

### `textOnly`

```
[Typeface] | [-FontSize+] | [B] [I] [Align] [TextColor] [Highlight] | [Fill filled-circle] | [SwitchType]
```

- **Typeface** — same as shapesOnly.
- **FontSize** — same stepper with chevron arrows. Only renders if `fontSize !== null`.
- **Bold** / **Italic** — same self-subscribing components.
- **Alignment** — `AlignDropdown`. Self-subscribing. Chevron-less `.ctx-btn-fmt` trigger (`#1b1f22` when open). Submenu: a horizontal row of 3 icon buttons (left/center/right), the active item filled `#1b1f22`. Defaults to `'left'` when null. Calls `setSelectedTextAlign(align)`. Preserves left edge via `anchorFactor` math on origin.
- **TextColor** — "A" icon with colored bar. Falls back to `'#262626'` when `labelColor` is null.
- **Highlight** — same as shapesOnly.
- **Fill** — `FillColorControl`, identical pattern to shape fill (square fill-glyph trigger → shared `ColorGrid` with the no-fill slot). No border/stroke controls (text objects don't have stroke).
- **SwitchType** — rightmost. Same component as shapesOnly's `SwitchType`, mounted with `mode='text'` — the `Text` row is the always-active cell. Sticky → `convertSelectionTo('note')`; shape variants → `convertSelectionToShape(key)`; the active `Text` cell is the only no-op.

### `notesOnly`

```
[Typeface] | [B] [I] [NoteAlign] [Highlight] | [Fill filled-circle] | [SwitchType]
```

Sticky notes have a dedicated bar with no text color control (note text color is contrast-derived from fill via `getStickyNoteTextColor`) and no font size stepper (font size is derived from scale):

- **Typeface** — same self-subscribing `TypefaceButton`. Persists to `device-ui-store.noteFontFamily` (not `textFontFamily`).
- **Bold** / **Italic** — same self-subscribing components. Uses TipTap chain when editor active, `formatFragment()` when not.
- **NoteAlign** — `NoteAlignDropdown`. Self-subscribing to `selectedStyles.textAlign` and `selectedStyles.textAlignV`. Trigger: current H-align icon, no chevron (`.ctx-btn-fmt`, `#1b1f22` when open). Submenu: one flat row — H-align (left/center/right) · vertical divider · V-align (top/middle/bottom). H-align calls `setSelectedTextAlign`, V-align calls `setSelectedTextAlignV`. Notes use top-left origin so no anchor math needed for H-align (just sets `align` key). V-align sets `alignV` key. Persists to `device-ui-store.noteAlign`/`noteAlignV`.
- **Highlight** — same as other kinds.
- **Fill** — `NoteFillControl`: square fill-glyph trigger → light-surface palette (no no-fill slot — notes always have a fill). Default color `'#FEF3AC'` (warm sticky yellow). Device-ui persist is skipped (note fill is per-object, not a device default).
- **SwitchType** — rightmost. Same component as shapesOnly's `SwitchType`, mounted with `mode='note'` — the `Sticky note` row is the always-active cell. Text → `convertSelectionTo('text')`; shape variants → `convertSelectionToShape(key)`; the active `Sticky note` cell is the only no-op.

**Note-specific device-ui persistence:** Font family and alignment actions detect `selectionKind === 'notesOnly'` and persist to note-specific device-ui fields (`noteFontFamily`, `noteAlign`, `noteAlignV`) rather than the text defaults.

### `connectorsOnly`

```
[Color teardrop] | [Width tier-menu] | [StartCap] [EndCap] | [ConnectorType] | [Label?]
```

- **Color** — `StrokeColorControl`, same as strokes.
- **Width** — `StrokeWidthControl`. Outline scale `2 / 4 / 6 / 8` (shared with shapes).
- **StartCap / EndCap** — `ConnectorCapControl`, one instance per endpoint (`slot='start'` / `'end'`). 32×32 trigger (`.ctx-btn-sq` + `.ctx-btn-engaged`, `--ctx-engaged` ink at rest, engaged-dark fill on open) showing the current cap glyph; popout is a side-by-side two-cell picker (`.ctx-submenu` + inline `flex flex-row gap-1 p-1.5` utilities) — no-arrow + arrow — with 36×36 cells and a 28×28 SVG so the cap glyphs read larger in the picker than at the trigger. Arrow direction mirrors `slot`: start ⇒ left-pointing, end ⇒ right-pointing, both in the trigger and the picker. Active cell fills `--ctx-engaged` with a white icon (no checkmark — the active state IS the cell). Mixed selections collapse to the first connector's cap (no "mixed" affordance — same first-applicable rule as `ConnectorTypeControl`). Wires to `setSelectedStartCap` / `setSelectedEndCap` and persists via `setConnectorStartCap` / `setConnectorEndCap` so a fresh connector picks up the user's most recent choice.
- **ConnectorType** — `ConnectorTypeControl`. Bars-style trigger with the current type glyph (`#1b1f22` ink at rest, engaged-dark fill on open), opening the tier-menu pattern: two rows (Straight, Orthogonal) with icon · label · inline check, the active row filled `#282e34`. Reads `selectedStyles.connectorType` (first connector's type — routing types don't blend, so no mixed UI affordance). **No-op today** — switching `connectorType` needs route + endpoint geometry adjustments inside the connector subsystem; the action wiring lands separately. `CONNECTOR_TYPE` lives in the field table as a read-only descriptor (empty `write: {}`).
- **Label** — `LabelButton`. No-op rightmost shell button (`.ctx-btn-sq .ctx-btn-label`, icon ink `--ctx-engaged`). Placeholder for the future "add connector label" entry-point; same role/shape as `LockButton`. **Single-connector only:** the button + its preceding divider render only when `kindCounts.total === 1` — labels attach to a single connector, so the slot stays hidden on a multi-select where there's no meaningful target.

### `codeOnly`

```
[Language ▾] | [-FontSize+] | [CodeLines] [Header] [Output]
```

- **Language** — `LanguageDropdown`. Self-subscribing to `selectedStyles.codeLanguage`. Trigger mirrors the FILTER stack — a `LANGUAGE` eyebrow over the current language name — but both lines run w700, the value takes the typeface-picker ink (`#282e34`), and the trigger uses `.ctx-btn-lang` (no engaged open-state): a code block always has a language, so the trigger never reads "unset". Dropdown: 3 items (JavaScript, TypeScript, Python), active row dark-filled + checkmark. Calls `setSelectedCodeLanguage(key)`.
- **FontSize** — same `FontSizeStepper` component. Wired to `incrementCodeFontSize`/`decrementCodeFontSize`/`setSelectedCodeFontSize`. Font size change proportionally scales code block width (`width * newFs/oldFs`). Steps through `TEXT_FONT_SIZE_PRESETS`, caps 10-144.
- **CodeLines** — `IconCodeLines` stateless action button. Calls `toggleCodeLineNumbers()` on `mouseDown`. No `active` state tracking — reads fresh from Y.Map each click to determine toggle direction. Atomically sets/unsets `lineNumbers` on all selected (or editing) code objects. Persists new value to `device-ui-store.codeLineNumbers` for new block defaults.
- **Header** / **Output** — `IconCodeHeader` / `IconCodeOutput` toggle buttons (`.ctx-btn-sq ctx-btn-fmt`). Active when the code block's header bar / output panel is visible — engaged `#1b1f22` fill + white icon, the same active state as bold / italic. `mouseDown` calls `toggleCodeHeader` / `toggleCodeOutput`.

### `mixed`

```
[Filter "{N} objects"]
```

- **Filter** — `FilterObjectsDropdown`. Shows count of total objects. Dropdown lists each kind with count > 0 (icon + label + count): Stroke, Shape, Text, Connector, Code Block, Sticky Note, Image, Link. The Link row covers bookmark objects — icon sourced from `toolbar/icons/IconLink` (interlocking-chain glyph, 16-viewBox, three filled paths). Clicking a kind calls `filterSelectionByKind(kind)` — filters `selectedIds` to that kind only. No style controls for mixed.

---

## React Component Tree

```
ContextMenu                  <- gate on menuOpen, renders null when closed
└── ContextMenuBar           <- computes effectiveKind, looks up MENU_BY_KIND
    ├── LockButton           <- no-op placeholder, always leftmost (every kind incl. image/bookmark)
    └── <div .ctx-divider>   <- omitted when MENU_BY_KIND has no entry → lock-only bar
        + <Menu />           <- one menus/* component (StrokeMenu … MixedMenu)
```

`ContextMenu.tsx` is a pure dispatcher — `MENU_BY_KIND` (a `Partial<Record<SelectionKind, ComponentType>>`) maps `effectiveKind` to one `menus/*` component; `none` / `image` / `bookmark` map to nothing, leaving the shell's `LockButton` as the entire bar for those kinds. Each `menus/*` component is `memo`'d and self-subscribing — it owns the store selector(s) for its kind (`useShallow` on every object-returning selector) and returns its `ButtonGroup` (Shape/Text/Note append a `ShapeTypeDropdown` + divider *inside* the group as the rightmost slot, paralleling `LabelButton` on `ConnectorMenu`; `MixedMenu` returns a bare `FilterObjectsDropdown`). The dispatcher never re-renders on a style change — only the mounted menu does.

### Component Inventory

| Component | Props/Store | Pattern |
|-----------|-------------|---------|
| `MenuButton` | `active?, ref?, ...HTMLButton` | Base primitive. `mouseDown preventDefault` keeps canvas focus. |
| `ButtonGroup` | `children, className?` | Flex row wrapper (`ctx-group`). |
| `ColorCircle` | `color, size?, variant?, secondColor?` | Visual indicator. Variants: `filled` (solid), `hollow` (border ring), `none` (checkered). `secondColor` renders SVG diagonal split (clip-path circle). |
| `FillColorControl` | `fillColor, mixed, onSelect` | Shape / text / note fill — square fill-glyph trigger → shared `ColorGrid` 6×4 with `noFill` slot. |
| `BorderColorControl` | `color, mixed, onSelect` | Shape border — hollow frame-glyph trigger → shared `ColorGrid` 6×4 with `noFill` (no-stroke) slot. |
| `ColorGrid` | `palette, cols, value, mixed, noFill?, onSelect` | Presentational swatch grid shared by fill + border. `noFill` renders index 0 as a `NoFillIcon` swatch emitting `onSelect(null)`. |
| `TextColorPopover` | `color, onSelect?` | "A"-glyph trigger with color bar → light-surface palette grid. `.ctx-btn-sq` + `.ctx-btn-engaged` trigger. |
| `HighlightPickerPopover` | `onSelect?` | Self-subscribes to `selectInlineHighlightColor`. Highlighter-marker trigger → `ColorGrid` (`cols=4`, `NoFillIcon` at slot 0 for "no highlight"). `.ctx-btn-sq` + `.ctx-btn-engaged` trigger. |
| `StrokeColorControl` | `color, mixed, onSelect` | Stroke/connector color. Teardrop trigger (current color, or a three-swatch drop when `mixed`) → 6-col palette grid. Toolbar picker mimicked on a light surface. Open-trigger bg `#1b1f22`. |
| `StrokeWidthControl` | `widths, value, onSelect` | Stroke/shape/connector width. Bars-icon trigger (icon `#1b1f22`) → four-tier menu (Thinnest…Thickest), left-aligned rows. Active tier row `#282e34`. `widths` is the per-kind 4-preset list. |
| `ConnectorTypeControl` | `value, onSelect` | Connector routing type. Current-type glyph trigger (`#1b1f22` ink, engaged-dark fill when open) → two-row tier menu (Straight, Orthogonal) with icon · label · inline check. Active row `#282e34`. **No-op `onSelect` today**; routing-switch wiring lands separately. |
| `ConnectorCapControl` | `slot, value, onSelect` | Per-endpoint cap picker. 32×32 glyph trigger (`.ctx-btn-sq` + `.ctx-btn-engaged`, engaged-dark on open) → side-by-side two-cell picker (no-arrow + arrow) with 36×36 cells / 28×28 SVGs. Arrow direction mirrors `slot` (start ⇒ left, end ⇒ right). Active cell `--ctx-engaged` / white icon — applied via a state-ternary on the cell `className` so the active bg utility doesn't collide with the base `bg-transparent`. Mixed selections surface the first connector's value (no "mixed" affordance). |
| `FontSizeStepper` | `value, onDecrement?, onIncrement?, onSelectSize?` | Chevron up/down arrows + SVG text center value + dropdown of presets. |
| `AlignDropdown` | (no props) | Self-subscribes to `selectedStyles.textAlign`. Chevron-less `.ctx-btn-fmt` trigger → horizontal 3-icon submenu. |
| `NoteAlignDropdown` | (no props) | Self-subscribes to `selectedStyles.textAlign` + `textAlignV`. Chevron-less `.ctx-btn-fmt` trigger → one flat submenu row: H-align · vertical divider · V-align. |
| `TypefaceButton` | (no props) | Self-subscribes to `selectedStyles.fontFamily`. Trigger = font name (no chevron); 4-item dropdown, active row `#1b1f22`. |
| `ShapeTypeDropdown` | `mode: 'shapes'\|'text'\|'note'` | Subscribes to `selectedStyles.shapeType`. Rightmost slot on shape/text/note bars — `IconSwitchType` trigger (`.ctx-btn-sq` + `.ctx-btn-engaged`, engaged-dark on open) → icon-only 4×2 grid (Sticky · Text · Rect · Circle · Diamond · Triangle · Rounded, trailing empty cell), right-anchored via `left-auto right-0 translate-x-0`. Active cell = current `shapeType` (shape mode) or fixed `text`/`note` row (text/note modes), filled `--ctx-engaged` with white icon — same state-ternary `className` pattern as `ConnectorCapControl` so the active bg doesn't collide with the base. Same-kind shape variants call `setSelectedShapeType`; cross-kind cells call `convertSelectionTo` / `convertSelectionToShape` (in-place kind mutation). |
| `FilterObjectsDropdown` | `kindCounts, onFilterByKind` | Left-aligned dropdown listing kinds with counts (incl. Code Block, Sticky Note). |
| `LanguageDropdown` | (no props) | Self-subscribes to `selectedStyles.codeLanguage`. 3-item language picker. |
| `BoldButton` | `FormatButtons.tsx` | Self-subscribes to `selectInlineBold`. `.ctx-btn-fmt` button, 20×20 Mural icon, active fills `#1b1f22`. |
| `ItalicButton` | `FormatButtons.tsx` | Self-subscribes to `selectInlineItalic`. `.ctx-btn-fmt` button, 20×20 Mural icon, active fills `#1b1f22`. |

### Dropdown Pattern (`useDropdown` hook, shared by 13 components)

All dropdowns use the `useDropdown()` hook which encapsulates:
- `open` state + `containerRef` for outside-click detection
- `toggle(e)` — preventDefault + toggle open (for trigger `onMouseDown`)
- `close()` — close dropdown (for item callbacks)

Items use `onMouseDown` with `e.preventDefault()` + action callback + `close()`.
Dropdown positioned via CSS absolute (`ctx-submenu` class, default centered; per-control alignment overrides — left or right — composed inline via Tailwind `left-0 translate-x-0` or `left-auto right-0 translate-x-0`).

### Self-Subscribing Components

`BoldButton`, `ItalicButton`, `AlignDropdown`, `NoteAlignDropdown`, `TypefaceButton`, and `HighlightPickerPopover` each subscribe to their own narrow store slice. Parent groups do not re-render when their state changes.

---

## Selection Store Fields (Context Menu)

| Field | Type | Default | Set By |
|-------|------|---------|--------|
| `menuOpen` | `boolean` | `false` | `show()` via setState, `beginTextEditing`, `endTextEditing`, `clearSelection` |
| `selectionKind` | `SelectionKind` | `'none'` | `setSelection` (computed via `computeSelectionComposition`) |
| `kindCounts` | `KindCounts` | `EMPTY_KIND_COUNTS` | `setSelection` |
| `selectedStyles` | `SelectedStyles` | `EMPTY_STYLES` | `refreshStyles` (equality-gated via `stylesEqual`) |
| `inlineStyles` | `InlineStyles` | `EMPTY_INLINE_STYLES` | `refreshStyles` (cache path) or `setInlineStyles` (editor path) |
| `boundsVersion` | `number` | `0` | `setSelection`, observer bridge (bbox changes) |
| `textEditingId` | `string \| null` | `null` | `beginTextEditing`, `endTextEditing` |
| `codeEditingId` | `string \| null` | `null` | `beginCodeEditing`, `endCodeEditing` |

### SelectedStyles

```typescript
interface SelectedStyles {
  color: string;                  // First object's stroke/border color (default '#262626')
  colorMixed: boolean;            // Multiple different stroke colors (strokes, connectors)
  width: number | null;           // Uniform width or null if mixed
  fillColor: string | null;       // First shape/text/note fill color, null = no fill
  fillColorMixed: boolean;        // Multiple different fill colors
  fillColorSecond: string | null; // Second fill color for split indicator
  shapeType: string | null;       // Uniform shape type, 'text' for textOnly, null if mixed
  fontSize: number | null;        // First text/labeled-shape/note fontSize (rounded)
  textAlign: TextAlign | null;    // Uniform H-alignment or null if mixed (textOnly, notesOnly)
  textAlignV: TextAlignV | null;  // Uniform V-alignment or null if mixed (notesOnly only)
  fontFamily: FontFamily | null;  // First text/labeled-shape/note font family
  labelColor: string | null;      // Text color — getColor for text objects, getLabelColor for shapes
  codeLanguage: CodeLanguage | null; // Code block language (codeOnly only)
  connectorType: ConnectorType | null; // Connector routing type (connector-only). First connector's value — no mixed flag (routing types don't blend).
}
```

Computed by `computeStyles(ids, kind, objectsById)`. Tracks different fields per kind:

| Kind | Tracks |
|------|--------|
| `strokesOnly` | color, width |
| `shapesOnly` | color, width, fillColor, fillColorMixed, fillColorSecond, shapeType, fontSize, fontFamily, labelColor, textAlign, textAlignV |
| `connectorsOnly` | color, width, connectorType |
| `textOnly` | color, fontSize, textAlign, fontFamily, labelColor, fillColor, fillColorMixed, fillColorSecond, shapeType='text' |
| `notesOnly` | fillColor, fontFamily, textAlign, textAlignV (multi-note mismatch → null for align fields) |
| `codeOnly` | fontSize, codeLanguage |
| `mixed` | Returns `EMPTY_STYLES` immediately |

**Text field resolution in `computeStyles`:** First object with text data wins. For text objects, reads `getColor()` as `labelColor`. For shapes, reads `getLabelColor()`. Only reads from shapes that `hasLabel()`. Returns `null` for `fontSize`/`fontFamily`/`labelColor` when no text data found (unlabeled shapes).

**Note field resolution in `computeStyles`:** Multi-note loop tracks fillColor from first note only, plus fontSize and fontFamily. textAlign and textAlignV are tracked with mismatch detection — null if mixed across selected notes.

### InlineStyles

```typescript
interface InlineStyles {
  bold: boolean;               // All text uniformly bold
  italic: boolean;             // All text uniformly italic
  highlightColor: string | null; // Uniform highlight color or null
}
```

Two sources:
1. **Editor active** — TipTap `onTransaction` reads `editor.isActive('bold'|'italic'|'highlight')` -> `setInlineStyles()` (equality-gated).
2. **No editor** — `refreshStyles()` calls `computeUniformInlineStyles(ids, objectsById)` when `textEditingId === null` AND kind is `'textOnly'`, `'shapesOnly'`, **or `'notesOnly'`**. Skips shapes without labels. Uses `getInlineStyles(id)` from text-system cache (requires eager tokenization — see text-system CLAUDE.md).

### Selectors

```typescript
selectInlineBold       = s => s.inlineStyles.bold
selectInlineItalic     = s => s.inlineStyles.italic
selectInlineHighlightColor = s => s.inlineStyles.highlightColor
selectTextEditingId    = s => s.textEditingId
selectIsTextEditing    = s => s.textEditingId !== null
```

### Key Actions

| Action | Sets menuOpen | Calls refreshStyles | Bumps boundsVersion |
|--------|--------------|--------------------|---------------------|
| `setSelection(ids)` | No | Yes | Yes |
| `clearSelection()` | `false` | No (resets to empty) | Resets to 0 |
| `beginTextEditing()` | `true` | Yes | No |
| `endTextEditing()` | Conditional | Yes | No |
| `beginCodeEditing()` | `true` | Yes | No |
| `endCodeEditing()` | Conditional | No | No |
| `refreshStyles()` | No | (is itself) | No |
| `setInlineStyles(next)` | No | No | No |

### Free Function

`filterSelectionByKind(kind)` — filters `selectedIds` to matching kind, calls `setSelection` -> re-derives everything. Used by `FilterObjectsDropdown`. Supports: strokes, shapes, text, connectors, code, notes, images.

---

## Selection Actions (`selection-actions.ts`)

Free mutation functions called by context menu buttons. Pattern: read IDs from store -> one `transact()` (via the field-table primitives `applyField`/`toggleField`) -> persist to device-ui-store -> `refreshStyles()`.

All text actions use the text-editing fallback: `ids = textEditingId ? [textEditingId] : selectedIds`. Code actions use an analogous pattern: `ids = codeEditingId ? [codeEditingId] : selectedIds` — this ensures language/fontSize/lineNumbers changes work during active CodeTool editing (not just via SelectTool selection).

**Note/Shape-specific device-ui routing:** Actions that persist to device-ui (`setSelectedFontFamily`, `setSelectedTextAlign`, `setSelectedTextAlignV`) check `selectionKind` and route to kind-specific setters — `notesOnly` → `setNoteAlign`/`setNoteAlignV`/`setNoteFontFamily`, `shapesOnly` → `setShapeAlign`/`setShapeAlignV`, otherwise text defaults. `setSelectedFontSize` skips notes entirely (font size is derived from scale). `setSelectedFillColor` skips device-ui persist entirely for notes (note fill is per-object, not a device default).

| Function | Scope | Persists To | Notes |
|----------|-------|-------------|-------|
| `setSelectedColor(color)` | All objects | `drawingColor` | Stroke/border color |
| `setSelectedFillColor(color\|null)` | Shapes + Text + Notes | Shapes: `fillColor` + `fillEnabled`; Text: `textFillColor`; Notes: no persist | `null` deletes fillColor key |
| `setSelectedWidth(width)` | All objects | `connectorSize` or `drawingSize` by kind | |
| `setSelectedShapeType(shapeType)` | Shapes only | -- | |
| `deleteSelected()` | All objects | -- | Anchor cleanup for connectors, then `clearSelection()` |
| `setSelectedFontFamily(family)` | Text + Notes + labeled shapes | `textFontFamily` or `noteFontFamily` by kind | |
| `setSelectedTextColor(color)` | Text + labeled shapes | `textColor` | Text: sets `color` key. Shapes: sets `labelColor` key |
| `setSelectedFontSize(size)` | Text + labeled shapes (skips notes) | `textSize` | Clamped 1-999, rounded |
| `incrementFontSize()` | Text + labeled shapes (skips notes) | `textSize` | Steps through presets, caps 10-144 |
| `decrementFontSize()` | Text + labeled shapes (skips notes) | `textSize` | Steps through presets, caps 10-144 |
| `setSelectedTextAlign(align)` | Text + Notes + Shapes | `textAlign` or `noteAlign` or `shapeAlign` by kind | Text: preserves left edge via anchorFactor math. Notes/Shapes: just sets `align` key (frame-based, no anchor shift) |
| `setSelectedTextAlignV(alignV)` | Notes + Shapes | `noteAlignV` or `shapeAlignV` by kind | Sets `alignV` key on Y.Map |
| `toggleSelectedBold()` | Text + Notes + labeled shapes | -- | Editor -> TipTap chain; no editor -> `formatFragment()` |
| `toggleSelectedItalic()` | Text + Notes + labeled shapes | -- | Editor -> TipTap chain; no editor -> `formatFragment()` |
| `setSelectedHighlight(color\|null)` | Text + Notes + labeled shapes | -- | Editor -> TipTap chain; no editor -> `formatFragment()` |
| `convertSelectionTo(target)` / `convertSelectionToShape(shapeType)` | Text + Notes + Shapes | -- | Cross-kind conversion — delegates to `convert-kind.ts`; text-editing fallback makes convert-while-editing work |
| `setSelectedCodeLanguage(lang)` | Code blocks | -- | Sets `language` key. Uses `getCodeIds()` fallback |
| `setSelectedCodeFontSize(size)` | Code blocks | -- | Proportionally scales width (`width * newFs/oldFs`). Uses `getCodeIds()` fallback |
| `incrementCodeFontSize()` | Code blocks | -- | Steps through `TEXT_FONT_SIZE_PRESETS`, caps 10-144 |
| `decrementCodeFontSize()` | Code blocks | -- | Steps through `TEXT_FONT_SIZE_PRESETS`, caps 10-144 |
| `toggleCodeLineNumbers()` | Code blocks | `codeLineNumbers` | Reads first object's `lineNumbers`, sets all to inverse. Uses `getCodeIds()` fallback |

---

## RoomDocManager Observer Bridge

The deep observer on `objects` Y.Map classifies mutations into `touchedIds` and `deletedIds`. The bridge in `applyObjectChanges()` keeps the menu in sync with a single unified pass:

| Condition | Action | Effect |
|-----------|--------|--------|
| Selected/editing object deleted | `clearSelection()` or `endTextEditing()` | Menu closes |
| Selected/editing object touched | `refreshStyles()` | Style controls update |
| Selected/editing object bbox changed | `boundsVersion++` | Controller repositions menu |
| Selected/editing object kind changed (cross-kind conversion) | `onObjectsKindChanged` -> `setSelection` re-derive (+ editor re-skin) | Bar swaps to the new kind's menu |

All property mutations (including style-only changes like color, fill, opacity) push dirty rects unconditionally, so the base canvas always repaints.

---

## Integration Points

| File | Integration |
|------|-------------|
| `index.html` | Static portal: `<div id="context-menu-portal" class="context-menu-floating ctx-hidden">` |
| `Canvas.tsx` | `createPortal(<ContextMenu />, portalEl)` + `controller.init(el)` / `destroy()` |
| `CanvasRuntime.ts` | Camera subscription calls `contextMenuController.onCameraMove()` |
| `SelectTool.ts` | `begin()` -> `hide()`, `end()`/`cancel()` -> `show()` (guarded) |
| `TextTool.ts` | `onCreate` -> `syncInlineStylesToStore` + boundsVersion bump. `onTransaction` -> `syncInlineStylesToStore`. Click-outside handler excludes `.ctx-menu`. |
| `room-doc-manager.ts` | Observer bridge: refreshStyles + boundsVersion for selected/editing objects |
| `selection-store.ts` | `menuOpen`, `selectedStyles`, `inlineStyles`, `boundsVersion`, `selectionKind`, `kindCounts`, `computeSelectionBounds()` |
| `selection-utils.ts` | Pure functions: `computeStyles`, `computeUniformInlineStyles` |
| `selection-actions.ts` | Mutation functions called by menu buttons (incl. the cross-kind conversion delegations) |

---

## File Map

| File | Responsibility |
|------|----------------|
| `ContextMenu.tsx` | Slim dispatcher: gate (`menuOpen`) → `ContextMenuBar` → `effectiveKind` → `MENU_BY_KIND` lookup → shell (`<LockButton/>` + optional divider + `<Menu/>`). The only file that imports `context-menu.css`. |
| `ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide/active lifecycle |
| `context-menu.css` | Root CSS manifest — `@import`s six foundation files under `styles/` in cascade order (`tokens` → `shell` → `buttons` → `dropdowns` → `color-grid` → `svg-triggers`). No per-component stylesheets. |
| `menu-widths.ts` | `STROKE_WIDTHS` (pen `4/7/10/13`) + `OUTLINE_WIDTHS` (shape/connector `2/4/6/8`), derived from `toolbar/weights`. |
| `menus/*.tsx` | One self-subscribing menu bar per `SelectionKind` — `StrokeMenu`, `ConnectorMenu`, `ShapeMenu`, `TextMenu`, `NoteMenu`, `CodeMenu`, `MixedMenu`. Each owns its store selector(s) + the JSX for its kind. |
| `FormatButtons.tsx` | `BoldButton` + `ItalicButton` — shared by `ShapeMenu`/`TextMenu`/`NoteMenu`. |
| `LockButton.tsx` | Shell lock button — no-op placeholder, leftmost on every bar (incl. image/bookmark where it's the whole bar). `IconLock` 20×20 inside `.ctx-btn-sq .ctx-btn-lock`. |
| `LabelButton.tsx` | Connector-bar rightmost button — no-op placeholder for the future "add connector label" entry-point. `IconLabel` 20×20 inside `.ctx-btn-sq .ctx-btn-label`. Same shell-button role as `LockButton`. |
| `MenuButton.tsx` | Base button primitive (`mouseDown preventDefault` keeps canvas focus) |
| `ButtonGroup.tsx` | Flex row wrapper |
| `ColorCircle.tsx` | Visual indicator: `filled` / `hollow` / `none` variants, optional `secondColor` split |
| `FillColorControl.tsx` | Square fill-glyph trigger → shared `ColorGrid` 6×4 with `noFill` slot. |
| `BorderColorControl.tsx` | Hollow frame-glyph trigger → shared `ColorGrid` 6×4 with `noFill` (no-stroke) slot. |
| `NoteFillControl.tsx` | Sticky-note fill — light-surface palette, no no-fill slot (notes always have a fill). |
| `ColorGrid.tsx` | Presentational swatch grid — `palette` + `cols` + `value` + `mixed` + optional `noFill` (renders index 0 as a `NoFillIcon` swatch). Shared body of every fill/border control. |
| `TextColorPopover.tsx` | "A"-glyph + bar trigger (`.ctx-btn-sq` + `.ctx-btn-engaged`) → light-surface palette grid. |
| `HighlightPickerPopover.tsx` | Self-subscribing. Highlighter trigger (`.ctx-btn-sq` + `.ctx-btn-engaged`) → shared `ColorGrid` (`cols=4`, slot 0 = `NoFillIcon` for "no highlight"). |
| `StrokeColorControl.tsx` | Stroke/connector color — teardrop trigger + light-surface palette grid (toolbar picker mimic). |
| `StrokeWidthControl.tsx` | Stroke/shape/connector width — bars trigger + Thinnest…Thickest tier menu. |
| `ConnectorTypeControl.tsx` | Connector routing type — current-glyph trigger + two-row tier menu (Straight, Orthogonal). No-op `onSelect` until route/endpoint adjustments are wired. |
| `FontSizeStepper.tsx` | Chevron up/down arrows + SVG center value + preset dropdown |
| `AlignDropdown.tsx` | Self-subscribing alignment dropdown. Chevron-less `.ctx-btn-fmt` trigger; 3 H-align icons in a horizontal submenu. |
| `NoteAlignDropdown.tsx` | Self-subscribing H+V alignment dropdown. Chevron-less `.ctx-btn-fmt` trigger; one flat submenu row: H-align · vertical divider · V-align. |
| `TypefaceButton.tsx` | Self-subscribing font family dropdown (4 families). Trigger = font name only (no chevron); active dropdown row `#1b1f22`. |
| `ShapeTypeDropdown.tsx` | Rightmost trigger (`.ctx-btn-sq` + `.ctx-btn-engaged`, `IconSwitchType`) + 4×2 icon-only grid popout (Sticky · Text · Rect · Circle · Diamond · Triangle · Rounded). Modes: `'shapes'` / `'text'` / `'note'`. Same-kind shape variants mutate via `setSelectedShapeType`; cross-kind cells via `convertSelectionTo` / `convertSelectionToShape` (`tools/selection/convert-kind.ts`). |
| `FilterObjectsDropdown.tsx` | Mixed selection kind filter with counts. Eight kinds: Stroke, Shape, Text, Connector, Code Block, Sticky Note, Image, Link. Link = bookmark; icon sourced from `toolbar/icons/IconLink`. |
| `LanguageDropdown.tsx` | Self-subscribing code language picker (JS/TS/Python) |
| `color-palette.ts` | `CONTEXT_MENU_COLORS` (18 hex), `NO_FILL` sentinel |
| `useDropdown.ts` | Shared hook: open state, containerRef, toggle, close, outside-click dismiss |
| `styles/*.css` | The entire CSS foundation, six files: `tokens.css` (`--ctx-*` custom properties scoped to `.context-menu-floating`, mostly aliasing the chrome-wide `--color-chrome-*` scale in `client/src/index.css`), `shell.css` (`.ctx-menu` / `.ctx-hidden` / `.ctx-divider` / `.ctx-group`), `buttons.css` (`.ctx-btn` family — base, engaged marker, square, format, filter, lang), `dropdowns.css` (`.ctx-submenu` base + `.ctx-submenu-item` / `.ctx-type-item` / `.ctx-align-item` row primitives), `color-grid.css` (`.ctx-cp-grid` / `.ctx-cp-swatch` / `.ctx-cp-swatch-nofill` — shared by every color picker), `svg-triggers.css` (the FILTER + LANGUAGE trigger's nested `<text>` rules + on-open fill swaps). All wrapped in `@layer components`. |
| `icons/` | Custom SVGs: fill-based paths for pixel-crisp rendering at small sizes |

### Icons

| File | Exports |
|------|---------|
| `UtilityIcons.tsx` | `IconChevronDown` (stroked), `IconCheck` (Mural `check` glyph, 24-viewBox), `IconStepUp`, `IconStepDown` |
| `ConnectorTypeIcons.tsx` | `IconConnectorStraight` (Mural `connectorStraightToolbar`), `IconConnectorOrthogonal` (Mural `connectorCornersToolbar`) — 24-viewBox, `currentColor` fills. Used by `ConnectorTypeControl`. |
| `LabelIcon.tsx` | `IconLabel` — Mural `label` glyph (tag silhouette with stitched accent), 24-viewBox `currentColor` fill. Consumed by `LabelButton`. |
| `CodeIcons.tsx` | `IconCodeLines` (22x16 viewBox, filled digits + stroke code bars) |
| `AlignIcons.tsx` | `IconAlignTextLeft/Center/Right` + `IconAlignVTop/Middle/Bottom` — all Mural `textAlign*` glyphs, 24-viewBox |
| `FormatIcons.tsx` | `IconBold`, `IconItalic` — Mural `textStyleBold`/`textStyleItalic` glyphs, 24-viewBox |
| `SwitchTypeIcons.tsx` | `IconSwitchType` — Mural `switchType` glyph (24-viewBox, two stacked arrows wrapping a target ring) consumed by `ShapeTypeDropdown` (rendered inside `.ctx-btn-sq`); `IconSwitchTypeRect` / `IconSwitchTypeCircle` / `IconSwitchTypeDiamond` / `IconSwitchTypeTriangle` / `IconSwitchTypeRoundedRect` — outlined 20-viewBox shape glyphs (`fill="none"`, `stroke="currentColor"`, `strokeWidth=2`, `strokeLinejoin=round`) for the grid items. Stroke=2 in 20-viewBox matches the toolbar `IconShapes` line weight at the dropdown's 24×24 CSS render. |
| `TextColorIcon.tsx` | `TextColorIcon` (props: `barColor`) — "A" glyph + bar (`fill="currentColor"` glyph, explicit `fill={barColor}` bar, so the bar survives the engaged-dark color flip). |
| `HighlightIcon.tsx` | `HighlightIcon` (props: `barColor`) — Mural-style highlighter at 24-viewBox; body + tip on `currentColor`, bar takes `barColor` (with a gray-bar + separators fallback when `barColor` is `null`). |
| `NoFillIcon.tsx` | `NoFillIcon` (props: `selected?`) — Mural `colorTransparent` paths verbatim (white bg + grey ring at `#9ca3af` + "/" slash at `#6b7280`, inset from corners). `selected` lays the `checkboxCustom` check + white halo on top so the check stays readable where it crosses the slash — slash stays drawn in both states. |
| `ColorFillIcon.tsx` | `IconColorFill` (props: `fill`, `mixed`, `engaged?`) — square fill-glyph; reflects current fill, diagonal split when `mixed`, dark-edge tweaks when `engaged` on a dark trigger. |
| `ColorBorderIcon.tsx` | `IconColorBorder` (props: `color`, `mixed`) — hollow frame-glyph; mirrors the fill glyph's footprint as a border-equivalent. |
| `ColorTeardrop.tsx` | `ColorTeardrop` (props: `color`, `mixed?`, `engaged?`) — solid color drop, or a three-swatch drop when `mixed`. Dark `color` + `engaged` → faint light rim so the drop doesn't vanish into the open trigger's dark bg. |
| `StrokeWidthIcons.tsx` | `IconWeightBars` (trigger) + `IconWeight1`–`IconWeight4` (diagonal tier glyphs) |
| `LockIcon.tsx` | `IconLock` — Mural 24-viewBox lock glyph (shackle + body + keyhole via `evenodd`). Consumed by `LockButton`. |
| `TrashIcon.tsx` | `IconTrash` — kept as a source for future reuse elsewhere in the app; **not imported by the context menu**. |

**Convention:** `fill="currentColor"` with fill-based paths (not stroke), except step/chevron arrows which use `stroke="currentColor"`. SVG text elements use `textRendering="geometricPrecision"` to prevent subpixel shift during scale animation. `IconStepUp`/`IconStepDown` are 10x6 viewBox chevron arrows, rendered at 12x7 CSS size inside 18x14 buttons. Alignment icons (`IconAlignText*`, `IconAlignV*`) and bold/italic all use 24×24 Mural SVG paths.

---

## CSS Notable Details

**File layout.** `ContextMenu.tsx` imports one stylesheet — `context-menu.css`,
a thin manifest that `@import`s six foundation files under `styles/` in cascade
order: `tokens.css` → `shell.css` → `buttons.css` → `dropdowns.css` →
`color-grid.css` → `svg-triggers.css`. Per-control variations (submenu sizing,
row geometry, cell layout, active-state fills) live as inline Tailwind v4
utilities directly in TSX — no co-located component stylesheets. Every
foundation file is wrapped in `@layer components { … }`. Tailwind v4 emits
utilities into a later layer than `components`, so inline utilities on a
`.ctx-*` element cleanly override the foundation rule they compose with.

**Tokens** (`styles/tokens.css`, scoped to `.context-menu-floating` — every
surface, incl. the absolutely-positioned submenus, inherits them). Eleven
of the thirteen `--ctx-*` names alias the chrome-wide `--color-chrome-*`
scale in `client/src/index.css`'s `@theme` block (shared with the TopBar,
MainMenu, and ZoomControls); the two odd-byte single-use values
(`--ctx-black-a13`, `--ctx-black-a20`) stay literal. The `--ctx-*` names
are kept so the five sibling foundation files keep working without edit:

- `--ctx-engaged` → `var(--color-chrome-ink-engaged)` (#1b1f22) — `.ctx-btn`
  base ink + engaged-flip fill + `.ctx-btn-fmt.active` toggle fill +
  `.ctx-submenu-item-active` row fill + active-cell fill in the cap +
  switch-type pickers (applied via Tailwind utility on the cell).
- `--ctx-engaged-tier` → `var(--color-chrome-ink-tier)` (#282e34) — tier-row
  active fill on stroke-width + connector-type submenus (applied via
  `bg-[var(--ctx-engaged-tier)] !text-white` Tailwind utilities on the
  active row); typeface / language trigger ink (SVG `<text fill>` reads
  this directly, not via `color`).
- `--ctx-text` → `var(--color-chrome-ink-body)` (#48525b) — body text
  default. `.ctx-submenu-item` row color + every tier/filter row label.
- `--ctx-text-focal` → `var(--color-chrome-ink-focal)` (#1F2937) —
  closed-FILTER `{N} objects` total only.
- `--ctx-accent` → `var(--color-chrome-accent)` (#3b82f6) — focus rings +
  selected highlight swatch ring.
- `--ctx-sand` → `var(--color-chrome-sand)` (#d4b89b) — open-FILTER
  subtitle (warm third pole).
- `--ctx-divider` → `var(--color-chrome-divider)` (`rgba(42,82,121,0.12)`)
  and `--ctx-hover` → `var(--color-chrome-hover)` (`rgba(42,82,121,0.08)`)
  — blue-tinted divider hairline + button hover wash, shared with the
  topbar/zoom chrome. **Sub-byte alpha shift on consolidation**
  (`#2a52791f` → `0.12` = `0x1f→0x1e`, `#2a527914` → `0.08` = `0x14→0x14`)
  — sub-perceptual at low alpha and brings the menu into byte-for-byte
  parity with the divider/hover the topbar + zoom bar already used.
- `--ctx-black-a06` / `--ctx-black-a08` / `--ctx-black-a12` →
  `var(--color-chrome-shadow-a0{6,8,12})` (overlay scale).
- `--ctx-black-a13` (`rgba(0,0,0,0.13)`), `--ctx-black-a20`
  (`rgba(0,0,0,0.20)`) — kept literal: odd-byte, used once each, not in
  the global scale.

Inside the menu, the values are still pure indirection (identical pixels
across the divider/hover alpha-byte rounding noted above); the upstream
hop just lifts the shared values into one chrome-wide source.

**Buttons** (`styles/buttons.css`, the single home for the `.ctx-btn` family):

- `.ctx-btn` (base): 32×32 min, 0 6px padding, 8px radius. Default ink
  `var(--ctx-engaged)` — every icon button inherits it. Hover wash
  `var(--ctx-hover)`; pressed `var(--ctx-black-a08)`; focus ring
  `var(--ctx-accent)`. Text-bearing triggers (`.ctx-btn-filter` /
  `.ctx-btn-lang`) paint via explicit SVG `fill` and ignore the inherited
  color. `TypefaceButton` uses `.ctx-btn` directly with a `min-w-14`
  Tailwind override (the 56px min that used to live in `.ctx-btn-font`).
- `.ctx-btn-engaged` (shared marker): composes with any `.ctx-btn` variant
  whose `[aria-expanded="true"]` should fill `var(--ctx-engaged)` and flip
  `currentColor` to white. Single source of truth for the dropdown-trigger
  flip, with `:hover` / `:active` mirrors so the engaged state survives
  hover + press on an open trigger. Carried by every dropdown trigger that
  inverts on open — `StrokeColorControl`, `FillColorControl`,
  `BorderColorControl`, `NoteFillControl`, `TextColorPopover`,
  `HighlightPickerPopover`, `StrokeWidthControl`, `ConnectorCapControl`,
  `ConnectorTypeControl`, `ShapeTypeDropdown`, `FilterObjectsDropdown`,
  `AlignDropdown`, `NoteAlignDropdown`. `TypefaceButton` and
  `LanguageDropdown` deliberately don't carry it (the typeface trigger
  stays light when open; a code block always has a selected language so the
  trigger never reads "unset"). Icons with explicit `fill` props
  (`ColorTeardrop`, `IconColorFill`, `IconColorBorder`) ignore the color
  portion and stay drawn by their own props.
- `.ctx-btn-sq`: 32×32 (width override), 0 padding. Inner SVG 20×20 — the
  menu-wide icon size; `.ctx-btn-fmt` shares this rule. Code-row buttons
  override the SVG size via Tailwind (`size-4` / `w-[22px] h-4`) for
  non-square viewBoxes. **Every picker trigger uses this one variant** —
  the historical `.ctx-btn-color` / `.ctx-btn-teardrop` / `.ctx-btn-weight` /
  `.ctx-btn-conntype` / `.ctx-btn-cap` / `.ctx-btn-switchtype` aliases were
  redundant (32×32 + 20×20 SVG, no unique rules) and have been collapsed.
- `.ctx-btn-lock` / `.ctx-btn-label`: TSX-only semantic markers on the lock
  and connector-label shell buttons. No CSS rules — both inherit 32×32 from
  `.ctx-btn-sq` and `var(--ctx-engaged)` ink from the `.ctx-btn` base.
- `.ctx-btn-fmt`: bold / italic / code header / code output toggles + align
  dropdown triggers. Inner SVG 20×20 (code header/output keep a 16px inline
  size via Tailwind). `.active` (toggle on) → bg `var(--ctx-engaged)`,
  white icon. Align dropdown triggers compose `.ctx-btn-engaged` for their
  open-state flip instead.
- `.ctx-btn-filter`: 0 8px padding + 6px gap. SVG-text styling for the
  inner FILTER eyebrow + count + the on-open fill swap (label →
  `--ctx-sand`, total → white) lives in `svg-triggers.css` and keys off
  this class.
- `.ctx-btn-lang`: filter chrome minus the engaged state. SVG-text styling
  for the LANGUAGE eyebrow + value lives in `svg-triggers.css`.

**Submenus** (`styles/dropdowns.css`):

- `.ctx-submenu` (base): absolute, `top: calc(100% + 8px)`, `left: 50%`,
  `translate: -50% 0`, `min-width: 160px`, white surface with hairline +
  drop shadow, padding 4, z-index 10. **Default-centered via the CSS
  `translate` property** (not `transform`) — Tailwind v4's `translate-x-*`
  utilities also use `translate`, so per-control alignment overrides cleanly
  cancel the default centering: `left-0 translate-x-0` for left-anchored
  popouts (typeface, filter, language); `left-auto right-0 translate-x-0`
  for the right-anchored switch-type grid.
- `.ctx-submenu-item` (base row): 32 tall, full-width, padding 0 8, ink
  `--ctx-text`. Hover wash `--ctx-hover`. `.ctx-submenu-item-active` fills
  `--ctx-engaged` + white text.
- `.ctx-type-item`: shared by `TypefaceButton`, `LanguageDropdown` (and the
  shape-type rows when the dropdown used a list; the current 4×2 icon-only
  grid bypasses these row classes). 36 tall, 10px gap, weight 500.
  `.ctx-type-check` pins the trailing checkmark to the right.
- `.ctx-align-item`: shared by `AlignDropdown` + `NoteAlignDropdown` —
  32×32 cell, ink `--ctx-engaged`, hover wash. `.ctx-align-item-active`
  fills engaged + white. Inner SVG 20×20.

Per-control submenu modifiers (min-width, padding, layout, alignment) are
**inlined as Tailwind utilities** on the `<div className="ctx-submenu …">`
in TSX. The tier rows in `StrokeWidthControl` / `ConnectorTypeControl`
compose `ctx-submenu-item ctx-submenu-item-active` with utility overrides
(`bg-[var(--ctx-engaged-tier)] !text-white`) — the `!` is needed because
both the base utility `text-[var(--ctx-text)]` and the override sit in the
same `utilities` layer, so without `!important` the cascade order isn't
guaranteed.

**Color picker grid** (`styles/color-grid.css`): shared by every fill /
border / text-color / highlight picker via the `ColorGrid` component (5
callsites: `FillColorControl`, `BorderColorControl`, `NoteFillControl`,
`StrokeColorControl`, `TextColorPopover`, `HighlightPickerPopover`).

- `.ctx-cp-grid`: grid container, gap 10, padding 10. Column count is set
  inline via `gridTemplateColumns: repeat(${cols}, 1fr)` — **not** Tailwind's
  `grid-cols-N` (which emits `repeat(N, minmax(0, 1fr))`); the `minmax(0,…)`
  variant lets columns collapse to 0 in a shrink-to-fit absolute container,
  which was the cause of the original highlight-picker malformation.
- `.ctx-cp-swatch`: 22×22, 6px radius, 1px hairline (`--ctx-black-a08`),
  hover scale 1.1. `[data-near-white]` adds a darker edge so light swatches
  don't blend into the white surface. The active swatch shows a centered
  check, no ring (the white surface needs no halo).
- `.ctx-cp-swatch-nofill`: the no-fill / no-stroke / no-highlight slot —
  strips border + bg so the SVG (`NoFillIcon`) owns the surface. Same 22×22
  footprint and hover-scale as the colored swatches.

**SVG-text triggers** (`styles/svg-triggers.css`): the two triggers that
render their primary text inside an `<svg>` so the ink can flip via parent
`[aria-expanded="true"]`. Nested descendant selectors under attribute
selectors don't translate well to inline Tailwind variants — they belong
in CSS.

- `.ctx-filter-trigger-label` / `.ctx-filter-trigger-total`: FILTER eyebrow
  (10px w600 caps, `--ctx-text` → `--ctx-sand` on open) + `{N} objects`
  count (13px w700 `--ctx-text-focal` → white on open). `fill 150ms ease`
  transitions both.
- `.ctx-lang-trigger-label` / `.ctx-lang-trigger-value`: LANGUAGE eyebrow
  (10px w700 caps `--ctx-text`) + current language (13px w700
  `--ctx-engaged-tier`). No on-open swap — `.ctx-btn-lang` doesn't carry
  `.ctx-btn-engaged`.

**Shell** (`styles/shell.css`):

- `.ctx-menu` / `.ctx-hidden .ctx-menu` / `.ctx-group` /
  `.context-menu-floating` — bar shell, portal contract, visibility toggle.
  See "Show/Hide CSS" above.
- `.ctx-divider`: 2px wide, 24px tall, `--ctx-divider`, flex-shrink 0.
  Used between bar groups AND inside `NoteAlignDropdown`'s submenu to
  separate the H-align + V-align groups (replaces the old `.ctx-align-divider`
  which was byte-identical apart from `flex-shrink`).

---
