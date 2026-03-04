# Context Menu System

Selection-aware contextual toolbar positioned above/below the selection via `@floating-ui/dom`.

## Architecture

Two-layer split: **imperative controller** owns DOM positioning + visibility, **React** owns content rendering. The portal element is a static div in `index.html` — always present in the DOM, never managed by React lifecycle.

```
index.html
├── #overlay-root                              ← unstyled grouping node
│   └── #context-menu-portal                   ← .context-menu-floating, position:fixed
│       └── <ContextMenu />                    ← React portal from Canvas.tsx
│
ContextMenuController.ts (singleton)
├── init(el): binds portal element, wires menuOpen + boundsVersion subscriptions
├── show(): SelectTool pointer-up path. Auto-activates, positions, reveals.
├── hide(): SelectTool pointer-down. Hides but keeps React mounted.
├── onCameraMove(): CanvasRuntime piggybacks. Debounce 150ms → reposition.
└── destroy(): teardown on Canvas unmount

ContextMenu.tsx (React)
├── ContextMenu()       ← gate: returns null when !menuOpen
└── ContextMenuBar()    ← kind-branched groups based on effectiveKind
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
show()       ← SelectTool end/cancel. Auto-sets menuOpen if not already active. Primary path.
menuOpen     ← store subscription (beginTextEditing). No-op if show() already activated.
```

### Deactivation

```
menuOpen → false  ← clearSelection, endTextEditing with no selection → deactivate()
```

### Gesture Flow

```
begin()  → controller.hide()  → visible=false, ctx-hidden added, timers cancelled
move()   → setSelection(ids)  → no menuOpen change (marquee stays hidden)
end()    → controller.show()  → active+visible=true, menuOpen set, RAF → position → class removed
```

**Single-text re-click exception:** When clicking a single-selected text object (to mount editor), `begin()` calls `hide()` as usual, then immediately `cancelHide()` — synchronous class add/remove in the same frame means no paint, no flash. If the user drags instead, `move()` calls `hide()` when the drag threshold passes. Without this, the menu would flash: instant hide in `begin()` → 200ms spring re-show in `end()` after editor mounts.

### Camera

`onCameraMove()` called by CanvasRuntime. No-op when `!active || !visible`. Adds `ctx-hidden` instantly, debounces 150ms, repositions on settle.

### Full Lifecycle

```
Canvas.tsx mount
  → contextMenuController.init(portalEl)
    ├─ subscribes to menuOpen  → activate() / deactivate()
    └─ subscribes to boundsVersion → schedulePosition() if active+visible

SelectTool.begin()  → controller.hide()  (+ cancelHide() for single-text re-click)
SelectTool.move()   → controller.hide()  (objectInSelection drag start — deferred from begin)
SelectTool.end()    → controller.show()  (guarded: selectedIds > 0 || textEditingId)
SelectTool.cancel() → controller.show()  (same guard)

beginTextEditing()  → menuOpen=true (store) → activate() via subscription
endTextEditing()    → menuOpen=conditional → deactivate() if no selection

CanvasRuntime camera sub → contextMenuController.onCameraMove()

Canvas.tsx unmount → controller.destroy()
```

---

## Positioning

`@floating-ui/dom` with `strategy:'fixed'`, `placement:'top'`.

**Virtual element:** `createVirtualElement(worldBounds)` converts selection world bounds to screen rect via `worldToClient()`. No viewport clipping — floating-ui middleware handles edges.

**Middleware chain:** `offset(40)` → `flip` (top-biased, bottom fallback) → `shift` (horizontal clamping, cross-axis) → `hide` (referenceHidden detection — hides when selection scrolls fully offscreen).

**Exclusion zones:** `FLIP_PADDING: { top: 72, bottom: 76, left: 12, right: 12 }`, `SHIFT_PADDING: { top: 72, bottom: 12, left: 12, right: 12 }`. Top 72px = ToolPanel (48px) + padding. Bottom 76px for flip = ZoomControls area.

**Bounds source:** `computeSelectionBounds()` — zero-arg, reads `selectedIds`/`textEditingId` from store internally. Text objects use derived frame from `getTextFrame(id)` (text layout cache). Other objects use `handle.bbox`.

---

## Show/Hide CSS

The `ctx-hidden` class toggles on the **portal container** (`#context-menu-portal`). The container itself (`position: fixed`) is always present and participating in layout — never `display: none`.

Animation is on the **inner `.ctx-menu` div** (the React bar):

- `.ctx-menu`: `opacity: 1; transform: scale(1)` with spring transition (`200ms cubic-bezier(0.34, 1.56, 0.64, 1)`)
- `.ctx-hidden .ctx-menu`: `visibility: hidden; opacity: 0; transform: scale(0.96); transition: none`

Adding `ctx-hidden` = instant hide (no transition). Removing it = spring reveal via base `.ctx-menu` transition.

---

## Menu Bar by Selection Kind

Text editing overrides `selectionKind` to `textOnly` regardless of actual selection.

All bars end with: `| Trash | … |` (the `…` overflow button has no functionality yet).

### `strokesOnly`

```
[Size S/M/L/XL] | [Color ●▾]  |  🗑  …
```

- **Size** — stroke width. Presets: 6=S, 10=M, 14=L, 18=XL. Strokes scale uniformly during transforms, so width may not match a preset — non-preset values show "Size" with blank label.
- **Color** — filled circle. Mixed colors show SVG diagonal split of first two. Dropdown: 9×2 color grid (18 colors).

### `shapesOnly`

```
[ShapeType ▾] | [Size S/M/L/XL] | [Border ○▾] [Fill ●▾]  |  🗑  …
```

- **ShapeType** — leftmost. Shows current type icon, or composite `IconShapes` when mixed/null. Dropdown: Rectangle, Circle, Diamond, Rounded, Text (text is no-op placeholder for future shape↔text conversion). Calls `setSelectedShapeType(key)`.
- **Size** — stroke width for shapes. Same presets as strokes (6/10/14/18).
- **Border** — hollow circle variant. Always shows first color only (no split). Dropdown: 9×2 grid. Calls `setSelectedColor`.
- **Fill** — filled circle variant. Mixed fills show SVG diagonal split of first two colors. When no fill (and not mixed), shows checkered "none" pattern. Dropdown: 9×2 grid with no-fill slot (replaces white pastel at index 10). `NO_FILL` sentinel maps to `setSelectedFillColor(null)`.

### `connectorsOnly`

```
[Size S/M/L/XL] | [Color ●▾]  |  🗑  …
```

- **Size** — connector width. Presets: 2=S, 4=M, 6=L, 8=XL. Non-preset or mixed shows blank.
- **Color** — same as strokes.

### `textOnly`

```
[ShapeType ▾] | [Typeface ▾] | [−FontSize+] | [B] [I] | [L C R] | [TextColor] [Highlight]  |  🗑  …
```

- **ShapeType** — always shows `IconTextType`. Dropdown items all no-op (future: text↔shape conversion).
- **Typeface** — shows "Draw" (Grandstander font). No dropdown yet — placeholder button.
- **FontSize** — stepper with dropdown. Display range: 1–999 (never 4+ digits). `−`/`+` buttons step through `TEXT_FONT_SIZE_PRESETS`, caps at 10 min / 144 max. In-between values (from future uniform scaling) step to the next preset up. Dropdown lists all presets with checkmark on active. Mixed font size across selected text objects: shows the first object's value. Calls `decrementFontSize`, `incrementFontSize`, `setSelectedFontSize`.
- **Bold** / **Italic** — self-subscribing `memo` components with `selectInlineBold`/`selectInlineItalic`. Active state (blue) only when the **entire** selection has the inline style applied uniformly. When TipTap is mounted: driven by editor `onTransaction`. When not mounted: driven by `computeUniformInlineStyles` from text-system cache. Actions: `toggleSelectedBold`/`toggleSelectedItalic` — editor mounted → TipTap chain, no editor → `Y.XmlText.format()` via `formatFragment()`. Deep observer auto-refreshes cache + styles.
- **Alignment** — 3 buttons: Left, Center, Right. Calls `setSelectedTextAlign(align)`. Preserves left edge via `anchorFactor` math on origin.
- **TextColor** — `TextColorPopover`. Icon is "A" with colored bar. Dropdown: 9×2 grid. Calls `setSelectedTextColor`. Persists to `device-ui-store.textColor`.
- **Highlight** — `HighlightPickerPopover`. Self-subscribes to `selectInlineHighlightColor`. Icon is marker pen with colored bar (or striped grey when null). Dropdown: 4×2 grid of rounded-square swatches from `HIGHLIGHT_COLORS` + "none" swatch with diagonal slash. Calls `setSelectedHighlight(color | null)`. Editor mounted → TipTap chain, no editor → `Y.XmlText.format()` via `formatFragment()`.

### `mixed`

```
[Filter ▾ "{N} objects"]  |  🗑  …
```

- **Filter** — `FilterObjectsDropdown`. Shows count of total objects. Dropdown lists each kind with count > 0 (icon + label + count). Clicking a kind calls `filterSelectionByKind(kind)` — filters `selectedIds` to that kind only, then `setSelection` re-derives everything. The bar switches to the single-kind layout.
- No style controls for mixed — user must filter first.

---

## React Component Tree

```
ContextMenu                         ← gate on menuOpen, renders null when closed
└── ContextMenuBar                  ← reads selectionKind + textEditingId, computes effectiveKind
    ├── [kind-specific groups]      ← memo'd sub-components per kind
    ├── <div className="ctx-divider" />
    ├── CommonActionsGroup          ← Trash button → deleteSelected()
    ├── <div className="ctx-divider" />
    └── OverflowButton              ← IconMoreDots, no handler (placeholder)
```

### Component Inventory

| Component | Props/Store | Pattern |
|-----------|-------------|---------|
| `MenuButton` | `active?, ref?, ...HTMLButton` | Base primitive. `mouseDown preventDefault` keeps canvas focus. |
| `ButtonGroup` | `children, className?` | Flex row wrapper (`ctx-group`). |
| `ColorCircle` | `color, size?, variant?, secondColor?` | Visual indicator. Variants: `filled` (solid), `hollow` (border ring), `none` (checkered). `secondColor` renders SVG diagonal split (clip-path circle). |
| `ColorPickerPopover` | `color, variant?, secondColor?, mode?, selectedColor?, onSelect?` | Dropdown: 9×2 grid. Fill mode adds no-fill slot. |
| `TextColorPopover` | `color, onSelect?` | Dropdown: 9×2 grid. "A" icon trigger with color bar. |
| `HighlightPickerPopover` | `onSelect?` | Self-subscribes to `selectInlineHighlightColor`. 4×2 rounded-square grid + none. |
| `SizeLabel` | `value, kind, onSelect?` | SVG text "Size S/M/L/XL" + dropdown. Fixed widths prevent layout shift. |
| `FontSizeStepper` | `value, onDecrement?, onIncrement?, onSelectSize?` | ±buttons + SVG text center value + dropdown of presets. |
| `TypefaceButton` | `name?, fontFamily?, onClick?` | SVG text font name. Placeholder — no dropdown, no handler wired. |
| `ShapeTypeDropdown` | `mode: 'shapes'\|'text'` | Subscribes to `selectedStyles.shapeType`. 5-item dropdown. |
| `FilterObjectsDropdown` | `kindCounts, onFilterByKind` | Left-aligned dropdown listing kinds with counts. |
| `BoldButton` | (internal memo) | Self-subscribes to `selectInlineBold`. |
| `ItalicButton` | (internal memo) | Self-subscribes to `selectInlineItalic`. |

### Dropdown Pattern (`useDropdown` hook, shared by 7 components)

All dropdowns use the `useDropdown()` hook which encapsulates:
- `open` state + `containerRef` for outside-click detection
- `toggle(e)` — preventDefault + toggle open (for trigger `onMouseDown`)
- `close()` — close dropdown (for item callbacks)

Items use `onMouseDown` with `e.preventDefault()` + action callback + `close()`.
Dropdown positioned via CSS absolute (`ctx-submenu` class, centered or left-aligned).

### Self-Subscribing Components

`BoldButton`, `ItalicButton`, and `HighlightPickerPopover` each subscribe to their own narrow store slice. Parent `TextStyleGroup` does not re-render when their state changes.

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

### SelectedStyles

```typescript
interface SelectedStyles {
  color: string;                  // First object's stroke/border color (default '#262626')
  colorMixed: boolean;            // Multiple different stroke colors
  colorSecond: string | null;     // Second stroke color for split indicator
  width: number | null;           // Uniform width or null if mixed
  fillColor: string | null;       // First shape's fill color, null = no fill. Kept even when mixed.
  fillColorMixed: boolean;        // Multiple different fill colors
  fillColorSecond: string | null; // Second fill color for split indicator
  shapeType: string | null;       // Uniform shape type, 'text' for textOnly, null if mixed
  fontSize: number | null;        // First text object's fontSize (rounded)
  textAlign: TextAlign | null;    // Uniform alignment or null if mixed
}
```

Computed by `computeStyles(ids, kind, objectsById)`. Tracks different fields per kind:

| Kind | Tracks |
|------|--------|
| `strokesOnly` | color, width |
| `shapesOnly` | color, width, fillColor, fillColorMixed, fillColorSecond, shapeType |
| `connectorsOnly` | color, width |
| `textOnly` | color, fontSize, textAlign, shapeType='text' |
| `mixed` | Returns `EMPTY_STYLES` immediately |

### InlineStyles

```typescript
interface InlineStyles {
  bold: boolean;               // All text uniformly bold
  italic: boolean;             // All text uniformly italic
  highlightColor: string | null; // Uniform highlight color or null
}
```

Two sources:
1. **Editor active** — TipTap `onTransaction` reads `editor.isActive('bold'|'italic'|'highlight')` → `setInlineStyles()` (equality-gated).
2. **No editor** — `refreshStyles()` calls `computeUniformInlineStyles(ids, objectsById)` from text-system cache. Only runs when `textEditingId === null && kind === 'textOnly'`.

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
|--------|--------------|--------------------|--------------------|
| `setSelection(ids)` | No | Yes | Yes |
| `clearSelection()` | `false` | No (resets to empty) | Resets to 0 |
| `beginTextEditing()` | `true` | Yes | No |
| `endTextEditing()` | Conditional | Yes | No |
| `refreshStyles()` | No | (is itself) | No |
| `setInlineStyles(next)` | No | No | No |

### Free Function

`filterSelectionByKind(kind)` — filters `selectedIds` to matching kind, calls `setSelection` → re-derives everything. Used by `FilterObjectsDropdown`.

---

## Selection Actions (`selection-actions.ts`)

Free mutation functions called by context menu buttons. Pattern: read IDs from store → `getActiveRoomDoc().mutate()` → persist to device-ui-store → `refreshStyles()`.

All text actions use the text-editing fallback: `ids = textEditingId ? [textEditingId] : selectedIds`.

| Function | Scope | Persists To | Notes |
|----------|-------|-------------|-------|
| `setSelectedColor(color)` | All objects | `drawingColor` | Stroke/border color |
| `setSelectedFillColor(color\|null)` | Shapes only | `fillColor` + `fillEnabled` | `null` deletes fillColor key |
| `setSelectedWidth(width)` | All objects | `connectorSize` or `drawingSize` by kind | |
| `setSelectedShapeType(shapeType)` | Shapes only | — | |
| `deleteSelected()` | All objects | — | Anchor cleanup for connectors, then `clearSelection()` |
| `setSelectedTextColor(color)` | Text only | `textColor` | Text-editing fallback |
| `setSelectedFontSize(size)` | Text only | `textSize` | Clamped 1–999, rounded |
| `incrementFontSize()` | Text only | `textSize` | Steps through presets, caps 10–144 |
| `decrementFontSize()` | Text only | `textSize` | Steps through presets, caps 10–144 |
| `setSelectedTextAlign(align)` | Text only | `textAlign` | Preserves left edge via anchorFactor math |
| `toggleSelectedBold()` | Text only | — | Editor → TipTap chain; no editor → `Y.XmlText.format()` |
| `toggleSelectedItalic()` | Text only | — | Editor → TipTap chain; no editor → `Y.XmlText.format()` |
| `setSelectedHighlight(color\|null)` | Text only | — | Editor → TipTap chain; no editor → `Y.XmlText.format()` |

---

## RoomDocManager Observer Bridge

The deep observer on `objects` Y.Map classifies mutations into `touchedIds` and `deletedIds`. The bridge in `applyObjectChanges()` keeps the menu in sync with a single unified pass:

| Condition | Action | Effect |
|-----------|--------|--------|
| Selected/editing object deleted | `clearSelection()` or `endTextEditing()` | Menu closes |
| Selected/editing object touched | `refreshStyles()` | Style controls update |
| Selected/editing object bbox changed | `boundsVersion++` | Controller repositions menu |

All property mutations (including style-only changes like color, fill, opacity) push dirty rects unconditionally, so the base canvas always repaints.

---

## Integration Points

| File | Integration |
|------|-------------|
| `index.html` | Static portal: `<div id="context-menu-portal" class="context-menu-floating ctx-hidden">` |
| `Canvas.tsx` | `createPortal(<ContextMenu />, portalEl)` + `controller.init(el)` / `destroy()` |
| `CanvasRuntime.ts` | Camera subscription calls `contextMenuController.onCameraMove()` |
| `SelectTool.ts` | `begin()` → `hide()`, `end()`/`cancel()` → `show()` (guarded) |
| `TextTool.ts` | `onCreate` → `syncInlineStylesToStore` + boundsVersion bump. `onTransaction` → `syncInlineStylesToStore`. Click-outside handler excludes `.ctx-menu`. |
| `room-doc-manager.ts` | Observer bridge: refreshStyles + boundsVersion for selected/editing objects |
| `selection-store.ts` | `menuOpen`, `selectedStyles`, `inlineStyles`, `boundsVersion`, `selectionKind`, `kindCounts` |
| `selection-utils.ts` | Pure functions: `computeStyles`, `computeSelectionBounds`, `computeUniformInlineStyles` |
| `selection-actions.ts` | 13 mutation functions called by menu buttons |

---

## File Map

| File | Responsibility |
|------|----------------|
| `ContextMenu.tsx` | Gate (menuOpen) → ContextMenuBar → kind-branched groups |
| `ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide/active lifecycle |
| `context-menu.css` | All styling: floating container, bar glass effect, buttons, submenus, animations |
| `MenuButton.tsx` | Base button primitive (`mouseDown preventDefault` keeps canvas focus) |
| `ButtonGroup.tsx` | Flex row wrapper |
| `ColorCircle.tsx` | Visual indicator: `filled` / `hollow` / `none` variants, optional `secondColor` split |
| `ColorPickerPopover.tsx` | 9×2 color grid dropdown. `mode='fill'` adds no-fill slot. |
| `TextColorPopover.tsx` | 9×2 color grid. "A" icon trigger with color bar. |
| `HighlightPickerPopover.tsx` | Self-subscribing. 4×2 rounded-square grid + none swatch. |
| `SizeLabel.tsx` | SVG text "Size S/M/L/XL" + dropdown. Fixed widths prevent layout shift. |
| `FontSizeStepper.tsx` | ± buttons + SVG center value + preset dropdown |
| `TypefaceButton.tsx` | SVG text font name (placeholder — no dropdown) |
| `ShapeTypeDropdown.tsx` | Subscribes to `shapeType`. 5-item type switcher. |
| `FilterObjectsDropdown.tsx` | Mixed selection kind filter with counts |
| `color-palette.ts` | `CONTEXT_MENU_COLORS` (18 hex), `NO_FILL` sentinel |
| `useDropdown.ts` | Shared hook: open state, containerRef, toggle, close, outside-click dismiss |
| `icons/` | Custom 16×16 SVGs: fill-based paths for pixel-crisp rendering at small sizes |

### Icons

| File | Exports |
|------|---------|
| `UtilityIcons.tsx` | `IconChevronDown`, `IconMinus`, `IconPlus`, `IconMoreDots`, `IconCheck`, `IconNoFill` |
| `FilterIcons.tsx` | `IconShapes`, `IconPenStroke`, `IconConnectorLine`, `IconTextType` |
| `AlignIcons.tsx` | `IconAlignTextLeft`, `IconAlignTextCenter`, `IconAlignTextRight` |
| `FormatIcons.tsx` | `IconBold`, `IconItalic` |
| `ShapeTypeIcons.tsx` | `IconRectType`, `IconCircleType`, `IconDiamondType`, `IconRoundedRectType` |
| `TextColorIcon.tsx` | `TextColorIcon` (props: `barColor`) |
| `HighlightIcon.tsx` | `HighlightIcon` (props: `barColor`) |
| `TrashIcon.tsx` | `IconTrash` |

**Convention:** 16×16 viewBox, integer coords, `fill="currentColor"` with fill-based paths (not stroke). SVG text elements use `textRendering="geometricPrecision"` to prevent subpixel shift during scale animation.

---

## Known Issues / Next Steps

- **`computeStyles` returns `EMPTY_STYLES` for mixed** — style groups get no data for mixed selections. Acceptable since mixed shows only the filter dropdown, but limits future mixed-kind style editing.
- **Bold/Italic/Highlight without editor** — ✅ Done. `formatFragment()` walks `Y.XmlFragment` and applies `Y.XmlText.format()` directly. Deep observer auto-refreshes cache + styles.
- **Bottom exclusion zone is full-width** — `FLIP_PADDING.bottom = 76` blocks bottom placement across entire viewport. Zoom controls are only bottom-left.
