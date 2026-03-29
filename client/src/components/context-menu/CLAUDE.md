# Context Menu System

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

### effectiveKind Logic

Text editing does **not** unconditionally override to `textOnly`. The bar preserves `selectionKind` from the store, so shape label editing shows `shapesOnly` (with text controls embedded). When `textEditingId !== null` AND `kind === 'none'` (standalone editing with no selection), the kind is resolved by looking up the editing object's actual kind from the snapshot:

```typescript
const effectiveKind =
  editing !== null && kind === 'none'
    ? (getCurrentSnapshot().objectsById.get(editing)?.kind === 'note' ? 'notesOnly' : 'textOnly')
  : codeEditing !== null && kind === 'none' ? 'codeOnly'
  : kind;
```

This means:
- Editing a standalone text object -> `textOnly` bar
- Editing a sticky note -> `notesOnly` bar
- Editing a code block -> `codeOnly` bar
- Editing a shape label -> `shapesOnly` bar (shape is in selection, so `kind === 'shapesOnly'`)

The same resolution happens in `refreshStyles()` when `textEditingId` is set and `selectedIds` is empty — the snapshot is checked to determine whether to use `'notesOnly'` or `'textOnly'`.

All bars end with: `| Trash | ... |` (the `...` overflow button has no functionality yet).

### `strokesOnly`

```
[Size S/M/L/XL] | [Color filled-circle]  |  Trash  ...
```

- **Size** — stroke width. Presets: 6=S, 10=M, 14=L, 18=XL. Non-preset values show "Size" with blank label.
- **Color** — filled circle. Mixed colors show SVG diagonal split of first two. Dropdown: 9x2 color grid (18 colors).

### `shapesOnly`

```
[ShapeType] | [Typeface] | [-FontSize+] | [B] [I] | [TextColor] [Highlight] | [Border hollow-circle] [Fill filled-circle] | [Size S/M/L/XL]  |  Trash  ...
```

Shapes now include the full text formatting suite for shape labels:

- **ShapeType** — leftmost. Shows current type icon, or composite `IconShapes` when mixed/null. Dropdown: Rectangle, Circle, Diamond, Rounded, Text, Sticky Note (text/note are no-op placeholders). Calls `setSelectedShapeType(key)`.
- **Typeface** — self-subscribing. Shows current font rendered in its own typeface. Dropdown: 4 items (Draw/Inter/Lora/Mono). Calls `setSelectedFontFamily(family)`. Persists to `device-ui-store.textFontFamily`.
- **FontSize** — stepper with dropdown. `IconStepUp`/`IconStepDown` chevron arrows (not +/-). Display range: 1-999. Stepper steps through `TEXT_FONT_SIZE_PRESETS`, caps at 10 min / 144 max. Dropdown lists all presets with checkmark. Dropdown items center-aligned (`ctx-submenu-fontsize` with `justify-content: center`).
- **Bold** / **Italic** — self-subscribing `memo` components. Active state (blue) when entire selection has the style applied uniformly. Same TipTap/`formatFragment()` dual path as text objects.
- **TextColor** — "A" icon with colored bar. When no label exists on the shape, falls back to `device-ui-store.textColor`. Calls `setSelectedTextColor`.
- **Highlight** — self-subscribes to `selectInlineHighlightColor`. Marker pen icon with colored bar.
- **Border** — hollow circle variant. Dropdown: 9x2 grid. Calls `setSelectedColor`.
- **Fill** — filled circle variant. Mixed fills show SVG diagonal split. Dropdown: 9x2 grid with no-fill slot. `NO_FILL` sentinel maps to `setSelectedFillColor(null)`.
- **Size** — border/stroke width (rightmost). Same presets as strokes.

**Device-UI-store fallback for unlabeled shapes:** When a shape has no label, `computeStyles` returns `null` for `fontSize`/`labelColor`. `ShapeStyleGroup` reads `deviceTextSize` and `deviceTextColor` from `device-ui-store` as fallback values. This ensures the menu shows the values that would be used if the user starts typing to create a label — matching the "what you see is what you'd get" principle.

### `textOnly`

```
[ShapeType] | [Typeface] | [-FontSize+] | [B] [I] | [Align] | [TextColor] [Highlight] | [Fill filled-circle]  |  Trash  ...
```

- **ShapeType** — always shows `IconTextType`. Dropdown items all no-op (future: text<->shape conversion). Includes Sticky Note item.
- **Typeface** — same as shapesOnly.
- **FontSize** — same stepper with chevron arrows. Only renders if `fontSize !== null`.
- **Bold** / **Italic** — same self-subscribing components.
- **Alignment** — `AlignDropdown`. Self-subscribing. Compact horizontal row of 3 icon buttons (left/center/right), active icon gets blue highlight. Defaults to `'left'` when null. Calls `setSelectedTextAlign(align)`. Preserves left edge via `anchorFactor` math on origin.
- **TextColor** — "A" icon with colored bar. Falls back to `'#262626'` when `labelColor` is null.
- **Highlight** — same as shapesOnly.
- **Fill** — filled circle variant, identical pattern to shape fill. No border/stroke controls (text objects don't have stroke).

### `notesOnly`

```
[NoteType] | [Typeface] | [B] [I] | [NoteAlign] | [Highlight] | [Fill filled-circle]  |  Trash  ...
```

Sticky notes have a dedicated bar with no text color control (note text is hardcoded `#1a1a1a`) and no font size stepper (font size is derived from scale):

- **NoteType** — always shows `IconStickySquareFold`. Same `ShapeTypeDropdown` with `mode='note'`. Dropdown items include all shape types + text + sticky note (all no-op, type conversion not yet implemented).
- **Typeface** — same self-subscribing `TypefaceButton`. Persists to `device-ui-store.noteFontFamily` (not `textFontFamily`).
- **Bold** / **Italic** — same self-subscribing components. Uses TipTap chain when editor active, `formatFragment()` when not.
- **NoteAlign** — `NoteAlignDropdown`. Self-subscribing to `selectedStyles.textAlign` and `selectedStyles.textAlignV`. Trigger: current H-align icon + chevron. Submenu: H-align row (left/center/right) + divider + V-align row (top/middle/bottom). H-align calls `setSelectedTextAlign`, V-align calls `setSelectedTextAlignV`. Notes use top-left origin so no anchor math needed for H-align (just sets `align` key). V-align sets `alignV` key. Persists to `device-ui-store.noteAlign`/`noteAlignV`.
- **Highlight** — same as other kinds.
- **Fill** — filled circle variant. Default color `'#FEF3AC'` (warm sticky yellow). No no-fill slot needed (notes always have fill). Device-ui persist is skipped (note fill is per-object, not a device default).

**Note-specific device-ui persistence:** Font family and alignment actions detect `selectionKind === 'notesOnly'` and persist to note-specific device-ui fields (`noteFontFamily`, `noteAlign`, `noteAlignV`) rather than the text defaults.

### `connectorsOnly`

```
[Size S/M/L/XL] | [Color filled-circle]  |  Trash  ...
```

- **Size** — connector width. Presets: 2=S, 4=M, 6=L, 8=XL.
- **Color** — same as strokes.

### `codeOnly`

```
[Language ▾] | [-FontSize+] | [CodeLines]  |  Trash  ...
```

- **Language** — `LanguageDropdown`. Self-subscribing to `selectedStyles.codeLanguage`. Trigger: "LANGUAGE" label + current name. Dropdown: 3 items (JavaScript, TypeScript, Python) with checkmark. Calls `setSelectedCodeLanguage(key)`.
- **FontSize** — same `FontSizeStepper` component. Wired to `incrementCodeFontSize`/`decrementCodeFontSize`/`setSelectedCodeFontSize`. Font size change proportionally scales code block width (`width * newFs/oldFs`). Steps through `TEXT_FONT_SIZE_PRESETS`, caps 10-144.
- **CodeLines** — `IconCodeLines` stateless action button. Calls `toggleCodeLineNumbers()` on `mouseDown`. No `active` state tracking — reads fresh from Y.Map each click to determine toggle direction. Atomically sets/unsets `lineNumbers` on all selected (or editing) code objects. Persists new value to `device-ui-store.codeLineNumbers` for new block defaults.

### `mixed`

```
[Filter "{N} objects"]  |  Trash  ...
```

- **Filter** — `FilterObjectsDropdown`. Shows count of total objects. Dropdown lists each kind with count > 0 (icon + label + count): Strokes, Shapes, Text, Connectors, Code Block, Sticky Note. Clicking a kind calls `filterSelectionByKind(kind)` — filters `selectedIds` to that kind only. No style controls for mixed.

---

## React Component Tree

```
ContextMenu                         <- gate on menuOpen, renders null when closed
└── ContextMenuBar                  <- reads selectionKind + textEditingId, computes effectiveKind
    ├── [kind-specific groups]      <- memo'd sub-components per kind
    ├── <div className="ctx-divider" />
    ├── CommonActionsGroup          <- Trash button -> deleteSelected()
    ├── <div className="ctx-divider" />
    └── OverflowButton              <- IconMoreDots, no handler (placeholder)
```

### Component Inventory

| Component | Props/Store | Pattern |
|-----------|-------------|---------|
| `MenuButton` | `active?, ref?, ...HTMLButton` | Base primitive. `mouseDown preventDefault` keeps canvas focus. |
| `ButtonGroup` | `children, className?` | Flex row wrapper (`ctx-group`). |
| `ColorCircle` | `color, size?, variant?, secondColor?` | Visual indicator. Variants: `filled` (solid), `hollow` (border ring), `none` (checkered). `secondColor` renders SVG diagonal split (clip-path circle). |
| `ColorPickerPopover` | `color, variant?, secondColor?, mode?, selectedColor?, onSelect?` | Dropdown: 9x2 grid. Fill mode adds no-fill slot. |
| `TextColorPopover` | `color, onSelect?` | Dropdown: 9x2 grid. "A" icon trigger with color bar. |
| `HighlightPickerPopover` | `onSelect?` | Self-subscribes to `selectInlineHighlightColor`. 4x2 rounded-square grid + none. |
| `SizeLabel` | `value, kind, onSelect?` | SVG text "Size S/M/L/XL" + dropdown. Fixed widths prevent layout shift. |
| `FontSizeStepper` | `value, onDecrement?, onIncrement?, onSelectSize?` | Chevron up/down arrows + SVG text center value + dropdown of presets. |
| `AlignDropdown` | (no props) | Self-subscribes to `selectedStyles.textAlign`. Compact horizontal 3-icon dropdown. |
| `NoteAlignDropdown` | (no props) | Self-subscribes to `selectedStyles.textAlign` + `textAlignV`. Two-row submenu: H-align (left/center/right) + divider + V-align (top/middle/bottom). |
| `TypefaceButton` | (no props) | Self-subscribes to `selectedStyles.fontFamily`. 4-item font family dropdown. |
| `ShapeTypeDropdown` | `mode: 'shapes'\|'text'\|'note'` | Subscribes to `selectedStyles.shapeType`. 6-item dropdown (rect, circle, diamond, rounded, text, sticky note). Trigger icon: shapes mode = current type or composite, text mode = `IconTextType`, note mode = `IconStickySquareFold`. |
| `FilterObjectsDropdown` | `kindCounts, onFilterByKind` | Left-aligned dropdown listing kinds with counts (incl. Code Block, Sticky Note). |
| `LanguageDropdown` | (no props) | Self-subscribes to `selectedStyles.codeLanguage`. 3-item language picker. |
| `BoldButton` | (internal memo) | Self-subscribes to `selectInlineBold`. 16x16 icon. |
| `ItalicButton` | (internal memo) | Self-subscribes to `selectInlineItalic`. 16x16 icon. |

### Dropdown Pattern (`useDropdown` hook, shared by 8 components)

All dropdowns use the `useDropdown()` hook which encapsulates:
- `open` state + `containerRef` for outside-click detection
- `toggle(e)` — preventDefault + toggle open (for trigger `onMouseDown`)
- `close()` — close dropdown (for item callbacks)

Items use `onMouseDown` with `e.preventDefault()` + action callback + `close()`.
Dropdown positioned via CSS absolute (`ctx-submenu` class, centered or left-aligned).

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
  colorMixed: boolean;            // Multiple different stroke colors
  colorSecond: string | null;     // Second stroke color for split indicator
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
}
```

Computed by `computeStyles(ids, kind, objectsById)`. Tracks different fields per kind:

| Kind | Tracks |
|------|--------|
| `strokesOnly` | color, width |
| `shapesOnly` | color, width, fillColor, fillColorMixed, fillColorSecond, shapeType, fontSize, fontFamily, labelColor |
| `connectorsOnly` | color, width |
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

Free mutation functions called by context menu buttons. Pattern: read IDs from store -> `getActiveRoomDoc().mutate()` -> persist to device-ui-store -> `refreshStyles()`.

All text actions use the text-editing fallback: `ids = textEditingId ? [textEditingId] : selectedIds`. Code actions use an analogous pattern: `ids = codeEditingId ? [codeEditingId] : selectedIds` — this ensures language/fontSize/lineNumbers changes work during active CodeTool editing (not just via SelectTool selection).

**Note-specific device-ui routing:** Actions that persist to device-ui (`setSelectedFontFamily`, `setSelectedTextAlign`) check `selectionKind === 'notesOnly'` and route to note-specific setters (`setNoteFontFamily`, `setNoteAlign`) instead of text defaults. `setSelectedFontSize` skips notes entirely (font size is derived from scale). `setSelectedFillColor` skips device-ui persist entirely for notes (note fill is per-object, not a device default).

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
| `setSelectedTextAlign(align)` | Text + Notes | `textAlign` or `noteAlign` by kind | Text: preserves left edge via anchorFactor math. Notes: just sets `align` key (top-left origin, no anchor shift) |
| `setSelectedTextAlignV(alignV)` | Notes only | `noteAlignV` | Sets `alignV` key on Y.Map |
| `toggleSelectedBold()` | Text + Notes + labeled shapes | -- | Editor -> TipTap chain; no editor -> `formatFragment()` |
| `toggleSelectedItalic()` | Text + Notes + labeled shapes | -- | Editor -> TipTap chain; no editor -> `formatFragment()` |
| `setSelectedHighlight(color\|null)` | Text + Notes + labeled shapes | -- | Editor -> TipTap chain; no editor -> `formatFragment()` |
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
| `selection-store.ts` | `menuOpen`, `selectedStyles`, `inlineStyles`, `boundsVersion`, `selectionKind`, `kindCounts` |
| `selection-utils.ts` | Pure functions: `computeStyles`, `computeSelectionBounds`, `computeUniformInlineStyles` |
| `selection-actions.ts` | 21 mutation functions called by menu buttons |

---

## File Map

| File | Responsibility |
|------|----------------|
| `ContextMenu.tsx` | Gate (menuOpen) -> ContextMenuBar -> kind-branched groups |
| `ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide/active lifecycle |
| `context-menu.css` | All styling: floating container, bar glass effect, buttons, submenus, animations |
| `MenuButton.tsx` | Base button primitive (`mouseDown preventDefault` keeps canvas focus) |
| `ButtonGroup.tsx` | Flex row wrapper |
| `ColorCircle.tsx` | Visual indicator: `filled` / `hollow` / `none` variants, optional `secondColor` split |
| `ColorPickerPopover.tsx` | 9x2 color grid dropdown. `mode='fill'` adds no-fill slot. |
| `TextColorPopover.tsx` | 9x2 color grid. "A" icon trigger with color bar. |
| `HighlightPickerPopover.tsx` | Self-subscribing. 4x2 rounded-square grid + none swatch. |
| `SizeLabel.tsx` | SVG text "Size S/M/L/XL" + dropdown. Fixed widths prevent layout shift. |
| `FontSizeStepper.tsx` | Chevron up/down arrows + SVG center value + preset dropdown |
| `AlignDropdown.tsx` | Self-subscribing alignment dropdown (3 H-align icons, horizontal compact submenu) |
| `NoteAlignDropdown.tsx` | Self-subscribing H+V alignment dropdown. Two-row submenu: left/center/right + divider + top/middle/bottom. |
| `TypefaceButton.tsx` | Self-subscribing font family dropdown (4 families, ShapeTypeDropdown pattern) |
| `ShapeTypeDropdown.tsx` | Subscribes to `shapeType`. 6-item type switcher. Modes: `'shapes'`/`'text'`/`'note'`. |
| `FilterObjectsDropdown.tsx` | Mixed selection kind filter with counts (incl. Code Block, Sticky Note) |
| `LanguageDropdown.tsx` | Self-subscribing code language picker (JS/TS/Python) |
| `color-palette.ts` | `CONTEXT_MENU_COLORS` (18 hex), `NO_FILL` sentinel |
| `useDropdown.ts` | Shared hook: open state, containerRef, toggle, close, outside-click dismiss |
| `icons/` | Custom SVGs: fill-based paths for pixel-crisp rendering at small sizes |

### Icons

| File | Exports |
|------|---------|
| `UtilityIcons.tsx` | `IconChevronDown`, `IconMinus`, `IconPlus`, `IconMoreDots`, `IconCheck`, `IconNoFill`, `IconStepUp`, `IconStepDown` |
| `FilterIcons.tsx` | `IconShapes`, `IconPenStroke`, `IconConnectorLine`, `IconTextType`, `IconCodeBlock` |
| `CodeIcons.tsx` | `IconCodeLines` (22x16 viewBox, filled digits + stroke code bars) |
| `AlignIcons.tsx` | `IconAlignTextLeft`, `IconAlignTextCenter`, `IconAlignTextRight`, `IconAlignVTop`, `IconAlignVMiddle`, `IconAlignVBottom` |
| `FormatIcons.tsx` | `IconBold` (20x20 viewBox), `IconItalic` (20x20 viewBox) |
| `ShapeTypeIcons.tsx` | `IconRectType`, `IconCircleType`, `IconDiamondType`, `IconRoundedRectType`, `IconStickySquareFold` |
| `TextColorIcon.tsx` | `TextColorIcon` (props: `barColor`) |
| `HighlightIcon.tsx` | `HighlightIcon` (props: `barColor`) |
| `TrashIcon.tsx` | `IconTrash` |

**Convention:** `fill="currentColor"` with fill-based paths (not stroke), except step/chevron arrows which use `stroke="currentColor"`. SVG text elements use `textRendering="geometricPrecision"` to prevent subpixel shift during scale animation. `IconStepUp`/`IconStepDown` are 10x6 viewBox chevron arrows, rendered at 12x7 CSS size inside 18x14 buttons. Vertical alignment icons (`IconAlignVTop/Middle/Bottom`) use 24x24 viewBox Mural SVG paths.

---

## CSS Notable Details

- `.ctx-btn-sq`: 34x34, padding 0. Inner SVG 18x18.
- `.ctx-btn-color`: 34x34. Inner SVG 20x20.
- `.ctx-fontsize-arrows`: flex column, 18px wide, gap 1px. Each arrow button 18x14, SVG 12x7.
- `.ctx-fontsize-value`: 32px min-width, 28px height, SVG 30x16 viewBox.
- `.ctx-submenu-fontsize`: 56px min-width, items center-aligned (`justify-content: center`).
- `.ctx-submenu-note-align`: flex column, centered. Contains `.ctx-align-row` (flex row, gap 2px) + `.ctx-align-divider` (1px separator).
- `.ctx-divider`: 1px wide, 24px tall, rgba(0,0,0,0.18).

---
