# Context Menu System

Selection-aware contextual toolbar positioned above/below the selection via `@floating-ui/dom`.

## Architecture

Two-layer split: **imperative controller** owns DOM positioning + visibility, **React** owns content rendering.

```
index.html (static portal divs)
├── #overlay-root                          ← unstyled grouping node
│   └── #context-menu-portal               ← .context-menu-floating, position:fixed
│       └── <ContextMenu />                ← React portal from Canvas.tsx
│
ContextMenuController.ts (singleton)       ← floating-ui positioning, show/hide/active lifecycle
├── Subscribes to: menuOpen, boundsVersion
├── Public: show(), hide(), onCameraMove(), init(), destroy()
└── Positions via: computePosition(virtualElement, el, { strategy:'fixed', placement:'top' })

ContextMenu.tsx (React gate + bar)
├── ContextMenu()                          ← renders null when !menuOpen
└── ContextMenuBar()                       ← kind-branched groups based on selectionKind
```

## Controller State Machine

Two boolean flags: `active` (React mounts content) and `visible` (not gesture/camera-hidden).

```
Activation:
  show()       ← SelectTool end/cancel. Auto-sets menuOpen. Primary path.
  menuOpen     ← store subscription (beginTextEditing). No-op if show() already activated.

Deactivation:
  menuOpen→false  ← clearSelection, endTextEditing with no selection.

Gesture flow:
  begin()  → controller.hide()  → visible=false, ctx-hidden added, timers cancelled
  move()   → setSelection(ids)  → no menuOpen change (marquee stays hidden)
  end()    → controller.show()  → active+visible=true, menuOpen set, RAF → position → class removed

Camera: onCameraMove() called by CanvasRuntime. Debounces 150ms, repositions on settle.
```

## Show/Hide CSS

`ctx-hidden` class toggle on the floating container. No `display:none` — container always participates in layout.

- `.ctx-menu` has `opacity:1; transform:scale(1)` with spring transition (200ms cubic-bezier)
- `.ctx-hidden .ctx-menu` has `visibility:hidden; opacity:0; transform:scale(0.96); transition:none`
- Adding `ctx-hidden` = instant hide. Removing it = spring reveal.

## Positioning

`@floating-ui/dom` with `strategy:'fixed'`, `placement:'top'`. Virtual element converts world bounds to screen rect via `worldToClient()`. Middleware: `offset(40)` → `flip` (top-biased, falls back to bottom) → `shift` (horizontal clamping) → `hide` (referenceHidden detection).

Exclusion zones: top 72px (ToolPanel + padding), bottom 76px for flip (ZoomControls), 12px sides.

## Bar Layout by selectionKind

| Kind | Groups |
|------|--------|
| `strokesOnly` | `[SizeLabel] \| [ColorPicker]` |
| `shapesOnly` | `[ShapeType ▾] \| [SizeLabel] \| [BorderColor(hollow)] [FillColor(filled)]` |
| `connectorsOnly` | `[SizeLabel] \| [ColorPicker]` |
| `textOnly` | `[ShapeType ▾] \| [Typeface] \| [FontSizeStepper] \| [B] [I] \| [L C R] \| [TextColor] [Highlight]` |
| `mixed` | `[FilterDropdown]` (no style controls — filters to single kind) |

All kinds end with: `| Trash | ... |`

Text editing overrides kind to `textOnly` regardless of selection.

## Data Layer

- **`selection-store.ts`** — `menuOpen`, `selectedStyles` (live style snapshot), `inlineStyles` (bold/italic/highlightColor for text), `selectionKind`, `kindCounts`, `boundsVersion`, `refreshStyles()`, `setInlineStyles()`. Selectors: `selectInlineBold`, `selectInlineItalic`, `selectInlineHighlightColor`.
- **`selection-utils.ts`** — `computeStyles()` (single-pass, early break), `computeSelectionComposition()`, `computeSelectionBounds()` (zero-arg, reads store internally), `computeUniformInlineStyles()`, `SelectedStyles`/`InlineStyles` types, `stylesEqual()`/`inlineStylesEqual()`
- **`selection-actions.ts`** — Free mutation functions: `setSelectedColor`, `setSelectedFillColor`, `setSelectedWidth`, `setSelectedShapeType`, `deleteSelected`, `setSelectedTextColor`, `setSelectedFontSize`, `incrementFontSize`, `decrementFontSize`, `setSelectedTextAlign`, `toggleSelectedBold`, `toggleSelectedItalic`, `setSelectedHighlight`. Pattern: read selectedIds (or textEditingId) from store → `getActiveRoomDoc().mutate()` → persist to device-ui-store → `refreshStyles()`. Inline formatting actions (`toggleSelectedBold`, `toggleSelectedItalic`, `setSelectedHighlight`) gate on `textTool.getEditor()` — no-op when not editing (future: Yjs delta mutation for canvas-selected text).

## Wired Actions

| Button | Action | Scope |
|--------|--------|-------|
| Stroke color picker | `setSelectedColor(color)` | All selected objects |
| Shape border color picker | `setSelectedColor(color)` | All selected objects |
| Shape fill color picker | `setSelectedFillColor(color \| null)` | Shapes only; `NO_FILL` sentinel → `null` |
| Connector color picker | `setSelectedColor(color)` | All selected objects |
| SizeLabel dropdown (S/M/L/XL) | `setSelectedWidth(size)` | All selected objects |
| ShapeType dropdown (shapes mode) | `setSelectedShapeType(key)` | Shapes only; mutates Y.Map `shapeType`, calls `refreshStyles()` |
| ShapeType dropdown (text mode) | no-op | All items no-op (future: shape↔text conversion) |
| Trash button | `deleteSelected()` | Anchor cleanup + delete + clearSelection |
| FontSizeStepper ± | `incrementFontSize()` / `decrementFontSize()` | Text only; steps through `TEXT_FONT_SIZE_PRESETS` |
| FontSizeStepper value dropdown | `setSelectedFontSize(size)` | Text only; 10 presets with checkmark on active |
| Text color (TextColorPopover) | `setSelectedTextColor(color)` | Text only; persists to device-ui `textColor` |
| Highlight (HighlightPickerPopover) | `setSelectedHighlight(color \| null)` | Editor only; `chain().focus().setHighlight/unsetHighlight` |
| Bold button | `toggleSelectedBold()` | Editor only; self-subscribes to `selectInlineBold` |
| Italic button | `toggleSelectedItalic()` | Editor only; self-subscribes to `selectInlineItalic` |
| Alignment L/C/R | `setSelectedTextAlign(align)` | Text only; adjusts origin to preserve left edge |

## Key Conventions

- Icons: 16x16 viewBox, integer coords, fill-based paths (not stroke) for crisp rendering at small sizes
- SizeLabel/TypefaceButton/FontSizeStepper: SVG `<text>` with `textRendering="geometricPrecision"` — prevents subpixel shift during `scale(0.96)` hide/show animation
- SizeLabel is a dropdown trigger (click opens S/M/L/XL preset menu with checkmark on active item)
- Divider is inlined as `<div className="ctx-divider" />` — no component wrapper
- Dropdowns (ColorPickerPopover, TextColorPopover, HighlightPickerPopover, SizeLabel, FontSizeStepper, ShapeTypeDropdown, FilterObjectsDropdown) use same pattern: local `useState` for open, `useRef` + `useEffect` for outside-click dismiss, `onMouseDown preventDefault`
- Self-subscribing buttons (BoldButton, ItalicButton, HighlightPickerPopover): own `memo` components with individual store selectors — parent doesn't re-render on their state changes
- `MenuButton` uses `mouseDown preventDefault` to keep canvas focus

---

# CHANGELOG

**Session 1 — React primitives layer**
- Installed `lucide-react` (tree-shakeable, only Bold/Italic will bundle)
- Created `client/src/components/context-menu/`: CSS foundation (`ctx-menu`, `ctx-btn` variants, sizing, states), atomic components (MenuButton with mousedown preventDefault, Divider, ButtonGroup, ColorCircle, SizeStepper, TypefaceButton), icon set (AlignTextLeft/Center/Right, TextColorIcon, HighlightIcon, ChevronDown, Minus, Plus, MoreDots), barrel exports
- No existing files modified besides `client/package.json` + `CLAUDE.md` file map

**Session 2 — Selection store infrastructure (context menu data layer)**
- **selection-store.ts** — Major rewrite: self-managing `setSelection(ids)` (dropped `selectionKind` param, store computes composition internally via single-pass `computeSelectionComposition`). Added `'textOnly'` to `SelectionKind`. New state fields: `selectedIdSet` (O(1) lookup), `kindCounts`, `idsByKind`, `menuActive`, `selectedStyles` (live style snapshot: color/colorMixed/colorSecond/width/fillColor/fontSize/textAlign), `boundsVersion`. New actions: `refreshStyles()` (style recompute with `stylesEqual` diff), `onObjectMutation(touched, deleted, bboxChanged)` (bridge from Y.js observer), `filterByKind(kind)`. `menuActive` derived in every action that touches selection/transform/marquee/textEditing. `beginScale` reads `selectionKind` from own state. Exported `computeSelectionBounds()` (extracted from SelectTool). `computeStyles` dispatches by kind — mixed → EMPTY_STYLES immediately, single-kind → single-pass with early break.
- **SelectTool.ts** — Removed `computeSelectionKind()` (30 lines) and `computeSelectionBounds()` (26 lines). Updated 6 `setSelection` call sites (dropped 2nd arg), updated `beginScale` call (dropped `selectionKind` arg), replaced 10 `this.computeSelectionBounds()` calls with imported standalone. Cleaned unused imports.
- **room-doc-manager.ts** — Observer bridge: accumulates `bboxChangedIds` in `applyObjectChanges`, calls `sel.onObjectMutation(touchedIds, deletedIds, bboxChangedIds)` when selection is active. 5 lines, zero overhead when nothing selected.
- **ContextMenuController.ts** — New skeleton class: `init(floatingEl)`/`destroy()` lifecycle, `scheduleReposition()` rAF stub, `show()`/`hide()` data-visible attribute toggle. No subscriptions wired yet.
- NOTE: This was a first pass — see Session 3 for the restructuring.

**Session 3 — Store refactoring, SelectTool menu ownership, controller skeleton**
- **`client/src/lib/utils/selection-utils.ts`** — **New file.** Extracted pure functions from selection-store: `computeSelectionComposition` (no longer stores per-kind ID arrays, just counts), `computeSelectionBounds`, `computeStyles`, `stylesEqual`. Types: `KindCounts`, `SelectedStyles`. Constants: `EMPTY_STYLES`, `EMPTY_KIND_COUNTS`, `EMPTY_ID_SET`.
- **`client/src/stores/selection-store.ts`** — Added `subscribeWithSelector` middleware (enables selector-based `.subscribe()` for controller/future consumers). Stripped: `deriveMenuActive()` (was called 10+ times across actions), `onObjectMutation` action (23-line middleman), `idsByKind` field + `IdsByKind` type + `EMPTY_IDS_BY_KIND` + `filterByKind` action. Imports utils from `selection-utils.ts`. Added `filterSelectionByKind()` as free function (not a store action). Simplified `refreshStyles` to single conditional. Removed `menuActive` from ALL transform/marquee `set()` calls — `setSelection` no longer sets it, `beginTranslate`/`beginScale`/`beginEndpointDrag`/`beginMarquee`/`endTransform`/`cancelTransform`/`endMarquee`/`cancelMarquee` no longer touch it. Only `clearSelection` (→ false), `beginTextEditing` (→ true), `endTextEditing` (→ `selectedIds.length > 0`) still set `menuActive` directly.
- **`client/src/lib/tools/SelectTool.ts`** — SelectTool now owns `menuActive` lifecycle: `begin()` sets `menuActive: false` (hides on any gesture start). `end()` and `cancel()` set `menuActive: true` when `selectedIds.length > 0 || textEditingId !== null` (shows after gesture completes). This is correct ordering: end() calls resetState() first, then checks store state, so the menu shows after transform commit.
- **`client/src/lib/room-doc-manager.ts`** — Removed debug `console.log`s (textContentChangedIds, fontSizeChangedIds). Removed dead `else if (field === 'fontSize')` branch (text system handles fontSize through its own cache lifecycle). Replaced `sel.onObjectMutation(touchedIds, deletedIds, bboxChangedIds)` bridge with inline logic: deletion → clearSelection, touch → refreshStyles, bboxChanged → boundsVersion bump. Same behavior, no middleman action.
- **`client/src/canvas/ContextMenuController.ts`** — Bare minimum skeleton wiring store/camera subscriptions. Subscribes to `menuActive` (activate/deactivate), `boundsVersion` (reposition), camera (hide during pan/zoom with 80ms settle timer). Placeholder positioning via `worldToClient` center-above-selection. **NOT a real implementation** — no floating-ui, no virtual elements, no exclusion zones, no flip/shift/hide middleware, no proper show/hide vs active/inactive distinction. This will be substantially rewritten.
- **OPEN**: The current `menuActive` boolean conflates two different concerns: (1) whether the menu is _active_ (has content to show, React mounts components) vs (2) whether the menu is _visible_ (not hidden during gesture/zoom). Right now `begin()` sets `menuActive: false` which would unmount React content — but mid-gesture the React components should stay mounted, just hidden (`opacity: 0`, `pointer-events: none`). The floating DOM container is always present (`display: none` only when truly inactive). Need to split into: `menuActive` (controls React mount/unmount + `display: none`/`display: ''`) and a separate visibility concern (controls `data-visible` attribute for opacity/pointer-events during gestures and camera changes). SelectTool's `begin()`/`end()` should toggle visibility, not activity. Activity changes only on selection/clearSelection/textEditing transitions.

**Session 4 — Portal infrastructure, React component library expansion, device-ui fillColor**
- **`client/src/App.tsx`** — Added persistent portal divs: `<div id="overlay-root"><div id="context-menu-portal" /></div>` as sibling to `<Routes>` inside `<RoomDocRegistryProvider>`. `overlay-root` is an unstyled grouping node for future overlay portals (right-click menu, tooltips). Persistent across route changes, inside provider for context access.
- **`client/src/canvas/Canvas.tsx`** — Three additions: (1) Module-level `contextMenuController` singleton (matches tool-registry pattern — created once at import, persists for app lifetime). (2) `useLayoutEffect` grabs `#context-menu-floating` by ID, calls `controller.init(el)`, cleanup calls `destroy()`. (3) Unconditional `createPortal` renders the persistent floating div + `<ContextMenu />` into `#context-menu-portal`. Return wrapped in fragment for the portal sibling. Controller manages `display`/`data-visible` on the floating div — React never touches positioning.
- **`client/src/components/context-menu/ContextMenu.tsx`** — **New file.** Gate component, renders `null` for now. Future: subscribes to `menuActive`, renders `<ContextMenuBar />` when active.
- **`client/src/components/context-menu/icons/FilterIcons.tsx`** — **New file.** Four kind-indicator icons: `IconShapes` (overlapping circle + rect), `IconPenStroke` (pen nib), `IconConnectorLine` (routed path with endpoint dot + arrowhead), `IconTextType` (T with baseline). All follow existing pattern: `(props: SVGProps)`, 16x16 viewBox, `aria-hidden`, stroke-based with `currentColor`.
- **`client/src/components/context-menu/icons/ActionIcons.tsx`** — **New file.** `IconTrash` — Trash-2 style (lid + body + two vertical lines inside). Same pattern as FilterIcons.
- **`client/src/components/context-menu/FilterObjectsDropdown.tsx`** — **New file.** Props-driven dropdown for mixed selections. Accepts `kindCounts: KindCounts` and `onFilterByKind` callback. Button shows "Filter" label + `{total} objects` count + chevron. Dropdown lists each kind with count > 0: icon + label + count. Uses `MenuButton` primitive, `mouseDown preventDefault` on items. Not wired to store yet (pure props).
- **`client/src/components/context-menu/color-palette.ts`** — **New file.** `CONTEXT_MENU_COLORS`: 24 hex colors (6 columns × 4 rows). Ordered: neutrals/lightest → pastels → vivid → deep/dark. Separate from `TEXT_COLOR_PALETTE` (12 colors, text-specific in device-ui-store).
- **`client/src/components/context-menu/SizeLabel.tsx`** — **New file.** Maps numeric size presets to S/M/L/XL labels. Accepts `value: number` and `kind: 'stroke' | 'connector'`. Stroke: 6=S, 10=M, 14=L, 18=XL. Connector: 2=S, 4=M, 6=L, 8=XL.
- **`client/src/components/context-menu/ColorCircle.tsx`** — Replaced `outline?: boolean` prop with `variant?: 'filled' | 'hollow' | 'none'`. `'filled'` (default) = solid color + subtle border (existing behavior). `'hollow'` = transparent bg + thick colored border (was `outline={true}`). `'none'` = checkered grey pattern via CSS class `ctx-color-none` (for "no fill" state). No callers used `outline` in production (only demo), clean replacement.
- **`client/src/components/context-menu/context-menu.css`** — Appended: `.context-menu-floating` (fixed, max-content, z-1000, display:none, opacity:0, pointer-events:none), `[data-visible]` state (opacity:1, pointer-events:auto, 150ms fade-in, instant snap-off on removal). `.ctx-submenu` (absolute dropdown, white bg, shadow, border-radius, 120ms slide-in animation). `.ctx-submenu-item` (32px height, flex with icon/label/value, hover state). `.ctx-btn-filter` / `.ctx-filter-label` / `.ctx-filter-title` / `.ctx-filter-count` (two-line filter button layout). `.ctx-filter-num` (right-aligned tabular count). `.ctx-color-none` (repeating-conic-gradient checkered pattern). `.ctx-btn-danger` (red text + red hover bg). `.ctx-size-label` (small S/M/L/XL label styling).
- **`client/src/stores/device-ui-store.ts`** — Added `fillColor: string` field (default `'#BFDBFE'`, light blue) + `setFillColor: (color: string) => void` action. Separate from `drawingSettings.fill` boolean (toggle) — `fillColor` stores the actual color value for shape fills. Bumped persist version to 2 (zustand auto-merges new fields with defaults, no migration needed).
- **Barrel exports** — `icons/index.ts`: added FilterIcons + ActionIcons re-exports. `context-menu/index.ts`: added ContextMenu, FilterObjectsDropdown, SizeLabel, CONTEXT_MENU_COLORS, and 5 new icon exports.
- **Typecheck**: all workspaces pass clean (`npm run typecheck`).

**Session 5 — Floating-UI integration, controller rewrite, React component tree**
- **`client/package.json`** — Installed `@floating-ui/dom` (computePosition, offset, flip, shift, hide middleware).
- **`client/src/stores/selection-store.ts`** — Renamed `menuActive` → `menuOpen` (all occurrences). Added `menuOpen: true` to `setSelection()` (was missing — menu never opened on selection). `clearSelection` sets `menuOpen: false`. `beginTextEditing` sets `menuOpen: true`. `endTextEditing` sets `menuOpen: selectedIds.length > 0`. Transform/marquee actions do NOT touch `menuOpen`.
- **`client/src/canvas/ContextMenuController.ts`** — **Full rewrite** (~170 lines). State machine: `dormant` (display:none, no subscriptions) → `hidden` (display:block, content mounted, opacity:0) → `positioned` (data-visible set, visible). Floating-UI: `computePosition` with `strategy: 'fixed'`, `placement: 'top'`, middleware chain: `offset(12)`, `flip` (fallbackPlacements: ['bottom'], fallbackStrategy: 'initialPlacement'), `shift`, `hide` (referenceHidden). Virtual element: `createVirtualElement(worldBounds)` clips selection bounds to viewport via `worldToClient` + `Math.max/min` against `cssWidth/cssHeight`. Exclusion zone padding: top 72px (toolbar 48px + 12px offset + 12px gap), bottom 76px for flip (zoom controls), 12px sides. Post-compute: fallback clamp (y >= 72 when both top/bottom offscreen), zoom controls avoidance (shift x when bottom-left overlap). Lazy camera subscription: `subCamera()` on open, `unsubCamera()` on close. Camera changes → 150ms settle timer → reposition. Public API: `hide()` (SelectTool gesture start → opacity:0, stays open), `show()` (gesture end → schedule reposition). Module-level singleton: `export const contextMenuController = new ContextMenuController()`.
- **`client/src/lib/tools/SelectTool.ts`** — Imports `contextMenuController` singleton. `begin()`: replaced `useSelectionStore.setState({ menuActive: false })` with `contextMenuController.hide()`. `end()` and `cancel()`: replaced `useSelectionStore.setState({ menuActive: true })` with `contextMenuController.show()` (guarded by `selectedIds.length > 0 || textEditingId !== null`).
- **`client/src/canvas/Canvas.tsx`** — Changed `import { ContextMenuController } from './ContextMenuController'` → `import { contextMenuController } from './ContextMenuController'`. Removed `const contextMenuController = new ContextMenuController()` (line 10). `useLayoutEffect` init unchanged, now uses the imported singleton.
- **`client/src/components/context-menu/ContextMenu.tsx`** — **Full implementation** (~175 lines). Added `import './context-menu.css'` (CSS was never imported before — root cause of menu appearing in normal flow). Gate: `ContextMenu()` subscribes to `menuOpen`, renders null when closed. Bar: `ContextMenuBar()` subscribes to `selectionKind` + `textEditingId`, computes `effectiveKind` (textEditing overrides to 'textOnly'), conditionally renders groups with trailing dividers. Visibility predicates: `showStroke` (strokesOnly|shapesOnly|mixed), `showFill` (shapesOnly|mixed), `showText` (textOnly|mixed), `showConnector` (connectorsOnly|mixed). Group components (all `React.memo`): `MixedFilterGroup` (FilterObjectsDropdown + filterSelectionByKind), `StrokeStyleGroup` (ColorCircle + SizeLabel), `FillGroup` (ColorCircle variant=none when null), `TextStyleGroup` (TextColorIcon + HighlightIcon + SizeStepper + alignment buttons), `ConnectorGroup` (ColorCircle + SizeLabel kind=connector), `CommonActionsGroup` (IconTrash), `OverflowButton` (IconMoreDots). Selectors: module-level stable refs with `useShallow` from `zustand/react/shallow` for object selectors.
- **`client/src/components/context-menu/ColorCircle.tsx`** — Added `secondColor?: string | null` prop. When `variant='hollow'` and `secondColor` is set, renders diagonal split via `linear-gradient(135deg, color 50%, secondColor 50%)` instead of hollow ring.
- **Bugs discovered & fixed during session**: (1) `context-menu.css` was never imported — `.context-menu-floating` had no styles at all, menu content rendered in normal document flow below the 100vh app container, causing scrollbar + canvas resize glitch. (2) `open()` never set `this.state = 'hidden'` — state stayed `'dormant'`, `positionMenu()` early-returned, position was never computed. (3) `this.el.style.display = ''` intended to "show" element but actually removes inline style, letting CSS `display: none` re-apply — changed to `display = 'block'`.
- **Typecheck + ESLint**: all clean.

## CURRENT ISSUES (post-session 5)

### 1. Display lifecycle still not working correctly
- The menu's `display: none` → `display: block` transition is still unreliable. The ordering between the controller setting `display: block`, React rendering content into the div, and `computePosition` measuring the div is not explicit or guaranteed. The controller calls `computePosition` inside a rAF `.then()` (microtask after async promise resolution) — by the time it resolves, the state may have changed, or the element may not have content yet.

### 2. Centering/positioning is badly off
- The menu does not center on the selection. It appears offset, misaligned. The virtual element's `getBoundingClientRect` clips to viewport, but the interaction between clipping and floating-ui's centering logic is producing incorrect results. The `left`/`top` values being applied are wrong.

### 3. Two divs with conflicting position styles
- The DOM has `#context-menu-portal` (the portal target) and `#context-menu-floating` (the div rendered inside the portal by React). The controller positions `#context-menu-floating` with inline `left`/`top`. But both divs exist in the tree with different characteristics. The controller grabs `#context-menu-floating` by ID, which is the inner div — this is correct in principle but the two-div nesting adds confusion. The outer `#context-menu-portal` is just an empty mount point and should have zero visual presence.

### 4. `#overlay-root` should never have been styled
- `#overlay-root` is explicitly a grouping node with no styles (as defined in PROMPT.MD and Session 4). A `position: fixed; width: 0; height: 0;` rule was incorrectly added to RoomPage.css. This was reverted by the user. The overlay-root must remain unstyled — the scrollbar issue it was trying to fix was actually caused by the missing CSS import (issue fixed separately).

### 5. Mixed selection shows duplicate/wrong groups
- When selection is mixed (e.g. shapes + strokes), the visibility predicates cause multiple groups to render that show overlapping controls. `showStroke` returns true for `mixed` AND `shapesOnly` — so a mixed selection with shapes shows StrokeStyleGroup (color circle + size) AND FillGroup (another color circle). This produces two color circles side by side. The predicates need to be re-evaluated for what each kind actually needs vs what's redundant.

### 6. Text icons appear for non-text selections
- `showText` returns true for `mixed`, so any mixed selection (even shapes + strokes with no text objects) shows TextStyleGroup with TextColorIcon, HighlightIcon, SizeStepper, and alignment buttons. These should only appear when text objects are actually in the selection.

### 7. Fill group shows for mixed even without shapes
- `showFill` returns true for `mixed` regardless of whether shapes are actually present. A mixed selection of strokes + connectors (no shapes) would still show the fill color circle.

### 8. `computeStyles` returns `EMPTY_STYLES` for mixed selections
- In `selection-utils.ts`, `computeStyles` immediately returns `EMPTY_STYLES` when `kind === 'mixed'`. This means all style-dependent groups (color, width, fill, fontSize) show with empty/default values rather than the actual common styles. The groups render but have no meaningful data to display.

### 9. No actions wired on any buttons
- All button `onClick` handlers are omitted or noop. The structure renders but nothing is interactive. This is expected (structure-first approach) but worth noting for the next session.

**Session 6 — Controller bug fixes, DOM consolidation, component hierarchy rework**
- **`client/src/canvas/ContextMenuController.ts`** — Replaced 3-state string machine (`dormant`/`hidden`/`positioned`) with two boolean flags (`active`/`visible`). `hide()` now calls `cancelAnimationFrame(this.rafId)` — fixes stale menu during drag (pending RAF was firing after hide and re-revealing). `schedulePosition()` uses double-RAF for measurement timing. `offset(12)` → `offset(40)` for dropdown clearance. Removed viewport clipping from `createVirtualElement` — was artificially shrinking the reference rect and pulling the menu left when selections extended partially offscreen (floating-ui's `shift` middleware already handles viewport clamping, `hide` middleware handles fully-offscreen detection). `boundsVersion` subscription guarded on `this.active && this.visible`.
- **`client/src/App.tsx`** — Added `className="context-menu-floating"` to `#context-menu-portal`. This div is now the one floating-ui positions directly.
- **`client/src/canvas/Canvas.tsx`** — Removed wrapper `<div id="context-menu-floating">` from portal. Portal now renders `<ContextMenu />` directly into `#context-menu-portal`. `useLayoutEffect` grabs `#context-menu-portal` instead of `#context-menu-floating`. Two divs merged into one.
- **`client/src/components/context-menu/ContextMenu.tsx`** — Mixed selection now renders ONLY `MixedFilterGroup` + `CommonActionsGroup` + `OverflowButton` (no style groups). Removed `showStroke`/`showFill`/`showText`/`showConnector` predicates. `TextStyleGroup` reordered to match TextContextMenu: TypefaceButton → SizeStepper → Bold/Italic → Align L/C/R → TextColor/Highlight. `StrokeStyleGroup`, `FillGroup`, `ConnectorGroup` now use `ColorPickerPopover` instead of plain `MenuButton` + `ColorCircle`.
- **`client/src/components/context-menu/MenuButton.tsx`** — Removed `React.forwardRef`, uses React 19 ref-as-prop pattern.
- **`client/src/components/context-menu/SizeStepper.tsx`** — Added explicit `width={12} height={12}` to IconMinus/IconPlus.
- **`client/src/components/context-menu/SizeLabel.tsx`** — Redesigned: shows "Size S/M/L/XL", returns null for non-preset values.
- **`client/src/components/context-menu/FilterObjectsDropdown.tsx`** — Icons bumped to 20px.
- **`client/src/components/context-menu/ColorPickerPopover.tsx`** — **New file.** 24-color grid (6x4) from `color-palette.ts`. Absolute-positioned dropdown below trigger. Outside-click dismiss. `onSelect` callback (action dispatch deferred).
- **`client/src/components/context-menu/icons/FormatIcons.tsx`** — **New file.** `IconBold` (filled path) and `IconItalic` (stroke-based).
- **`client/src/components/context-menu/context-menu.css`** — Added `opacity: 0; pointer-events: none` to `.context-menu-floating` base rule (required for hide state — without these, removing `data-visible` while `display: block` leaves the menu visible). Added `.ctx-size-btn svg { width: 12px; height: 12px; }`. Updated `.ctx-filter-title` (12px, #1F2937), `.ctx-filter-count` (11px, #6B7280), `.ctx-filter-num` (font-weight 600, #374151). Added `.ctx-size-label-prefix`, `.ctx-color-grid`, `.ctx-color-swatch` styles.
- **Typecheck**: all workspaces pass clean.

**Session 7 — Class toggle animation, controller streamline, marquee fix**
- **`client/src/components/context-menu/context-menu.css`** — Replaced `display:none`/`data-visible` show/hide system with `ctx-hidden` class toggle. `.context-menu-floating` stripped to positioning-only (`position: fixed; width: max-content; top: 0; left: 0; z-index: 1000; pointer-events: none`). No `display: none`, no `opacity: 0` on container — container is always present, child opts in. `.ctx-menu` gets `pointer-events: auto`, `opacity: 1`, `transform: scale(1)`, spring transition (`200ms cubic-bezier(0.34, 1.56, 0.64, 1)` on both opacity and transform). New `.ctx-hidden .ctx-menu` rule: `visibility: hidden; opacity: 0; transform: scale(0.96); pointer-events: none; transition: none` — instant hide (no animation on add), removing `ctx-hidden` triggers spring reveal via base `.ctx-menu` transition. Added `.ctx-btn-font svg { width: 10px; height: 10px; flex-shrink: 0 }` — fixes ChevronDown SVG cutoff in TypefaceButton (SVG had no explicit dimensions, defaulted to 300×150 in flex context).
- **`client/src/canvas/ContextMenuController.ts`** — **Full rewrite** (~145 lines). Removed lazy camera sub/unsub (`subCamera`, `unsubCamera`, `cameraUnsub` field) — camera now piggybacked from CanvasRuntime via `onCameraMove()` public method. Removed `useCameraStore` import. `el` changed from `HTMLElement | null` to definite assignment `el!: HTMLElement` — all null checks removed (persistent portal div). Double-RAF → single RAF (no timing issues with `visibility: hidden`). `show()` is now the smart entry point: auto-activates if not active (sets `menuOpen: true` in store so React mounts content), sets `visible = true`, clears any pending settle timer, schedules position. `activate()` is now subscription-only (text editing path via `beginTextEditing → menuOpen: true`) — returns early if `show()` already activated. `hide()` sets `visible = false`, adds `ctx-hidden`, cancels RAF + settle timer. `onCameraMove()` checks `!active || !visible` (no-ops during gesture-hidden or inactive), adds `ctx-hidden`, debounces via settle timer. `deactivate()` resets position to 0,0. Removed dead code: `ZOOM_CONTROLS_RIGHT_EDGE` constant, `placement` destructure, commented-out manual clamp logic.
- **`client/src/stores/selection-store.ts`** — **Removed `menuOpen: true` from `setSelection()`**. This was the root cause of the marquee bug: during marquee drag, `updateMarqueeSelection()` calls `setSelection(ids)` every frame, which was setting `menuOpen: true`, triggering `activate()` on the controller, overriding the `hide()` from `begin()`. Now `menuOpen` is only set to `true` by: (1) `show()` from SelectTool on pointer up (the correct activation point), (2) `beginTextEditing()`. Set to `false` by: `clearSelection()`, `endTextEditing()` when no selection.
- **`client/src/canvas/CanvasRuntime.ts`** — Imports `contextMenuController`. Added `contextMenuController.onCameraMove()` to the existing camera subscription callback alongside `getCurrentTool()?.onViewChange()`. The controller's method is a fast no-op when inactive. Eliminates all lazy subscription management in the controller.
- **`client/src/App.tsx`** — Added `ctx-hidden` to initial className on portal div (`className="context-menu-floating ctx-hidden"`) — prevents FOUC on mount.

### Controller State Machine (post-session 7)

```
Two boolean flags:
  active  — menu logically open (React mounts content via menuOpen in store)
  visible — not gesture-hidden (camera debounce can show, SelectTool.begin sets false)

Activation paths:
  show()      — SelectTool end/cancel. Auto-sets menuOpen if needed. Primary entry point.
  menuOpen    — store subscription (beginTextEditing). No-op if show() already activated.

Deactivation:
  menuOpen → false — store subscription (clearSelection, endTextEditing with no selection).

Camera: onCameraMove() called by CanvasRuntime — no lazy sub needed.
  No-op if !active || !visible (gesture-hidden or inactive).

Gesture flow:
  begin()  → controller.hide()  → visible=false, class added, timers cancelled
  move()   → setSelection(ids)  → no menuOpen change! (marquee fix)
  end()    → controller.show()  → active+visible=true, menuOpen set, RAF → position → class removed
```

## CURRENT ISSUES (post-session 13)

### 1. Zoom controls exclusion zone is full-width bottom edge (carried from session 6)
- `FLIP_PADDING.bottom = 76` prevents bottom placement across the entire viewport bottom. Zoom controls are bottom-left only (~176px wide). Over-restricts for center/right selections. Needs per-corner exclusion logic or `shift` with asymmetric padding.

### 2. `computeStyles` returns `EMPTY_STYLES` for mixed selections
- In `selection-utils.ts`, `computeStyles` immediately returns `EMPTY_STYLES` when `kind === 'mixed'`. Style-dependent groups render with empty/default values.

### 3. Bold/Italic/Highlight no-op when not editing
- Inline formatting actions (`toggleSelectedBold`, `toggleSelectedItalic`, `setSelectedHighlight`) gate on `textTool.getEditor()`. When text objects are selected but not being edited, these buttons do nothing. Future: apply formatting via direct Yjs delta mutations on `Y.XmlFragment`.

**Session 8 — Selection mutation actions + store prep**
- **`client/src/lib/utils/selection-utils.ts`** — Added `shapeType: string | null` to `SelectedStyles` interface, `EMPTY_STYLES`, `computeStyles` (tracked only for `shapesOnly` kind, with mixed detection via `getShapeType` accessor), and `stylesEqual`. Import added: `getShapeType` from `@avlo/shared`.
- **`client/src/lib/utils/selection-actions.ts`** — **New file.** Five free mutation functions for context menu wiring: `setSelectedColor(color)` (all objects, persists drawingColor), `setSelectedFillColor(fillColor)` (shapes only, null removes fill, persists fill toggle + color), `setSelectedWidth(width)` (all objects, persists to connector or drawing size based on selectionKind), `setSelectedShapeType(shapeType)` (shapes only, maps to ShapeVariant for persistence), `deleteSelected()` (mirrors EraserTool anchor cleanup — builds anchorCleanups map for surviving connectors, single Y.js transaction: clear dead anchors then delete objects, clears selection after). All follow pattern: read selectedIds from store → `getActiveRoomDoc().mutate()` → persist to device-ui-store → `refreshStyles()`.
- **`client/src/stores/device-ui-store.ts`** — Expanded tool-switch subscription: when switching away from select tool (`prevState.activeTool === 'select'`), calls `useSelectionStore.getState().clearSelection()`. Import added: `useSelectionStore` (no circular dep — selection-store does not import device-ui-store).
- **Typecheck**: all workspaces pass clean.

**Session 9 — Cleanup, font size fix, size dropdown, action wiring**
- **`Divider.tsx`** — **Deleted.** Inlined all 8 usages in `ContextMenu.tsx` to `<div className="ctx-divider" />`. Removed from `index.ts` barrel.
- **`context-menu.css`** — Removed dead selectors: `.ctx-font-name`, `.ctx-size-label-prefix`, `.ctx-size-label-value`. Color swatches bumped from 24px→28px, grid gap 5px→6px, padding 10/12px→12/14px. Added `.ctx-submenu-item-active` (blue bg), `.ctx-size-item-label` (600 weight, 14px), `.ctx-size-item-value` (right-aligned, grey, tabular-nums).
- **`FontSizeStepper.tsx`** — Converted plain text `{value}` to SVG `<text>` with `textRendering="geometricPrecision"` (26×16 SVG, centered via `textAnchor="middle"`). Fixes subpixel shift during `scale(0.96)` hide/show animation — matches SizeLabel pattern.
- **`SizeLabel.tsx`** — Refactored from simple button to dropdown component. `useState` + outside-click dismiss (same pattern as `ColorPickerPopover`). Shows S/M/L/XL preset items with checkmark on active, numeric `px` value right-aligned. Props: `onClick` removed, `onSelect?: (size: number) => void` added. Stroke presets: 6/10/14/18. Connector presets: 2/4/6/8.
- **`icons/MenuIcons.tsx`** — Added `IconCheck` (16×16 fill-based checkmark path). Exported from `icons/index.ts` and `context-menu/index.ts`.
- **`ContextMenu.tsx`** — Wired all mutation actions: `onSelect={setSelectedWidth}` on all 3 SizeLabel instances, `onSelect={setSelectedColor}` on stroke/border/connector ColorPickerPopovers, `onSelect={(c) => setSelectedFillColor(c === NO_FILL ? null : c)}` on fill ColorPickerPopover, `onClick={deleteSelected}` on trash button. Imports: `setSelectedWidth`, `setSelectedColor`, `setSelectedFillColor`, `deleteSelected` from `selection-actions.ts`, `NO_FILL` from `color-palette.ts`.
- **Typecheck**: all workspaces pass clean.

**Session 10 — ShapeType dropdown, cache eviction fix, filter improvements**
- **`icons/ShapeTypeIcons.tsx`** — **New file.** Four fill-based 16×16 shape type icons using `evenodd` cutout paths (hollow shapes, not stroke — matches context-menu icon convention): `IconRectType` (sharp rect), `IconCircleType` (circle), `IconDiamondType` (rotated square), `IconRoundedRectType` (rounded rect rx=4).
- **`ShapeTypeDropdown.tsx`** — **New file.** Dropdown for switching shape types (or showing current type for text). Props: `mode: 'shapes' | 'text'`. Follows SizeLabel pattern: `useState` + `useRef` + `useEffect` outside-click dismiss, `onMouseDown preventDefault`. Subscribes to `selectedStyles.shapeType` from selection store. **Trigger:** shapes mode shows current type icon (mixed/null → composite `IconShapes`, specific → matching icon), text mode always shows `IconTextType`. **Dropdown:** 5 items (Rectangle, Circle, Diamond, Rounded, Text) with 22px icons, left-aligned submenu (`ctx-submenu-type`). Active item highlighted with blue text (`ctx-submenu-item-active`) + right-aligned checkmark (`ctx-type-check`, `margin-left: auto`). **Actions:** shapes mode calls `setSelectedShapeType(key)` for shape items, text item is no-op (future shape→text conversion). Text mode: all items no-op.
- **`selection-utils.ts`** — `computeStyles` now returns `shapeType: 'text'` for `textOnly` selections (was `null`). Enables the ShapeTypeDropdown to highlight the "Text" item in text mode without branching on mode — active check is uniformly `shapeType === key`.
- **`ContextMenu.tsx`** — Inserted `<ShapeTypeDropdown>` as leftmost item in both `shapesOnly` and `textOnly` bars, each followed by a divider before the existing style groups.
- **`context-menu.css`** — Added: `.ctx-btn-type` (34px height trigger button), `.ctx-submenu-type` (left-aligned, `left: 0; transform: none`), `.ctx-type-item` (36px height, 13px font, 10px gap), `.ctx-type-check` (`margin-left: auto`), `.ctx-submenu-filter` + `.ctx-filter-item` (matching left-aligned style for filter dropdown). `.ctx-submenu-item-active` now sets `color: #3b82f6` (blue text + icons via `currentColor` inheritance) — applies to both SizeLabel and ShapeType active items.
- **`FilterObjectsDropdown.tsx`** — Replaced `onMouseLeave` dismiss with `useRef` + `useEffect` outside-click dismiss (matches all other dropdowns). Added `ctx-submenu-filter` class for left-aligned submenu. Bumped item icons to 22px, trigger text to 13px. Added `ctx-filter-item` class for bigger items.
- **`room-doc-manager.ts`** — **Cache eviction fix:** In `applyObjectChanges`, the non-bbox-change else branch now evicts cache for shape objects (`kind === 'shape'`). Root cause: `shapeType` mutations change the cached Path2D geometry but not the BBox (computed from frame + width only), so cache was never evicted and stale paths kept rendering. Fix is cheap — shape Path2D rebuilds are fast and the eviction only fires on actual Y.Map mutations, not per frame.
- **Barrel exports** — `icons/index.ts`: added `IconRectType`, `IconCircleType`, `IconDiamondType`, `IconRoundedRectType`. `context-menu/index.ts`: added `ShapeTypeDropdown` + 4 icon exports.
- **Typecheck**: all workspaces pass clean.

**Session 11 — Icon & styling fixes, file renames**
- **`context-menu.css`** — Glass effect on `.ctx-menu`: `background` changed from `rgba(255,255,255,0.97)` to `rgba(255,255,255,0.94)`, added `backdrop-filter: blur(12px)` + `-webkit-backdrop-filter: blur(12px)`.
- **`icons/MenuIcons.tsx` → `icons/UtilityIcons.tsx`** — Renamed (git mv). Contains generic UI primitives (chevron, ±, dots, check, no-fill). `IconMoreDots` circle radius increased from `r="1.5"` to `r="1.8"`.
- **`icons/ActionIcons.tsx` → `icons/TrashIcon.tsx`** — Renamed (git mv). `IconTrash` rewritten from stroke-based to fill-based (`fillRule="evenodd"` cutouts) per project convention.
- **Import updates** — 5 files updated for renames: `icons/index.ts`, `ShapeTypeDropdown.tsx`, `SizeLabel.tsx`, `FontSizeStepper.tsx`, `TypefaceButton.tsx` — all `'./icons/MenuIcons'` → `'./icons/UtilityIcons'`, `'./ActionIcons'` → `'./TrashIcon'`.
- **`ShapeTypeDropdown.tsx`** — Trigger icon bumped from 16×16 to 20×20 for more visual mass in the 34px button.
- **`icons/FilterIcons.tsx`** — `IconShapes` rewritten: circle top-left + square bottom-right with clean overlap (square visually "on top"). Circle rendered as clipped 270° arc ring (fill-based), square as evenodd ring. No visible intersection underneath.
- **`icons/HighlightIcon.tsx`** — Redesigned: scaled 1:1 from reference SVG (30×30 → 20×20). Barrel with cubic bezier cap corners, curved tip taper, connecting lines, and small filled nib. Color bar unchanged.
- **`icons/FormatIcons.tsx`** — `IconBold`: `fill="#1F2937"` → `fill="currentColor"` for active-state theming. `IconItalic`: unchanged (kept original `fill="#1F2937"` on both svg and path).

**Session 12 — Inline styles store infrastructure + portal fix**
- **`client/src/lib/utils/selection-utils.ts`** — Added `InlineStyles` type (`bold`, `italic`, `highlightColor`), `EMPTY_INLINE_STYLES` constant, `inlineStylesEqual()` equality helper, `computeUniformInlineStyles(ids, objectsById)` pure function (aggregates `getInlineStyles()` from text-system cache — all-bold/all-italic/uniform-highlight semantics). Refactored `computeSelectionBounds()` to zero-arg: reads `selectedIds` + `textEditingId` from selection store internally (circular import safe — runtime-only access inside function body). Import added: `useSelectionStore` from selection-store, `getInlineStyles` from text-system.
- **`client/src/stores/selection-store.ts`** — Added `inlineStyles: InlineStyles` to `SelectionState` (default: `EMPTY_INLINE_STYLES`). Added `setInlineStyles(next)` action with `inlineStylesEqual` equality gate. Updated `refreshStyles()`: when `textEditingId === null` and kind is `textOnly`, computes inline styles from cache via `computeUniformInlineStyles` and patches into store (single `set()` call batching both `selectedStyles` and `inlineStyles`). Updated `endTextEditing()`: now calls `refreshStyles()` so inline styles snap from editor-last-state to cache-derived values. Updated `clearSelection()`: resets `inlineStyles` to `EMPTY_INLINE_STYLES`. Added selectors: `selectInlineBold`, `selectInlineItalic`, `selectInlineHighlightColor`. Cleaned up unused `_computeSelectionBounds` import alias. New imports: `computeUniformInlineStyles`, `inlineStylesEqual`, `EMPTY_INLINE_STYLES`, `InlineStyles` from selection-utils.
- **`client/src/lib/room-doc-manager.ts`** — Extended observer bridge: when `textEditingId !== null` and `selectedIdSet.size === 0` (text editing without selection), handles deletion (calls `endTextEditing()`) and bbox changes (bumps `boundsVersion` for context menu repositioning). Skips `refreshStyles` during editing — editor owns inline styles.
- **`client/src/canvas/ContextMenuController.ts`** — `positionAndReveal()` replaced manual ID construction with zero-arg `computeSelectionBounds()`.
- **`client/src/lib/tools/SelectTool.ts`** — All 10 `computeSelectionBounds(store.selectedIds)` call sites updated to zero-arg `computeSelectionBounds()`.
- **`client/index.html`** — Added static portal divs: `<div id="overlay-root"><div id="context-menu-portal" class="context-menu-floating ctx-hidden"></div></div>`. Permanent mount point — React never manages lifecycle.
- **`client/src/App.tsx`** — Removed `<div id="overlay-root">` block (moved to static HTML).
- **`client/src/canvas/Canvas.tsx`** — Removed render-body `document.getElementById('context-menu-portal')` call. Portal now uses `document.getElementById('context-menu-portal')!` directly (safe — element is in static HTML, always present).
- **Typecheck**: all workspaces clean (only pre-existing `TextContextMenu.ts` error from unrelated WIP).

**Session 13 — Text action wiring, TipTap event bridge, observer bridge fix**
- **`client/src/lib/room-doc-manager.ts`** — **Observer bridge bug fix:** Text editing branch now calls `refreshStyles()` when the editing object is in `touchedIds`. Previously only handled deletion + bbox changes — undo of `fontSize`/`align`/`color` left `selectedStyles` stale because the bridge skipped `refreshStyles()` during editing. Root cause of font size and text align not reflecting in the toolbar after undo.
- **`client/src/stores/selection-store.ts`** — `beginTextEditing()` now calls `refreshStyles()` after `set()`, so initial styles populate correctly when text editing starts (was stale/null before).
- **`client/src/lib/utils/selection-utils.ts`** — `computeStyles` always returns `firstFontSize` for textOnly selections (removed `fontSizeMixed ? null :` branch). Mixed sizes show first object's value — stepper steps from there, setting applies uniformly to all. Matches Miro UX.
- **`client/src/lib/tools/TextTool.ts`** — Added `getEditor()` and `getContainer()` public getters. Added module-level `syncInlineStylesToStore(editor)` — reads `editor.isActive('bold'|'italic'|'highlight')` → calls `setInlineStyles()` on selection store. Wired `onCreate` (syncs initial inline styles + bumps `boundsVersion` for context menu reposition after first layout) and `onTransaction` (fires on every cursor move, typing, formatting — equality gate in `setInlineStyles` makes redundant calls free) on Editor constructor.
- **`client/src/lib/utils/selection-actions.ts`** — 8 new text action functions: `setSelectedTextColor(color)` (mutates Y.Map color, persists textColor), `setSelectedFontSize(size)` (clamped 1-999, text objects only), `incrementFontSize()` / `decrementFontSize()` (step through `TEXT_FONT_SIZE_PRESETS`, edge cases: <10→10, >144→144), `setSelectedTextAlign(align)` (preserves left edge via `anchorFactor` math, each object gets own `W` from cached frame, calls `invalidateWorld(computeSelectionBounds())` for canvas redraw), `toggleSelectedBold()` / `toggleSelectedItalic()` (editor `chain().focus().toggleBold/Italic().run()`, no-op when no editor), `setSelectedHighlight(color|null)` (editor `setHighlight`/`unsetHighlight`). All text actions read `textEditingId` fallback: `ids = textEditingId ? [textEditingId] : selectedIds`.
- **`client/src/components/context-menu/TextColorPopover.tsx`** — **New file.** `TextColorIcon` trigger + standard 18-color `CONTEXT_MENU_COLORS` grid dropdown. Same popover pattern (useState + useRef + outside-click dismiss). No `colorMixed` handling — just renders `barColor={color}`.
- **`client/src/components/context-menu/HighlightPickerPopover.tsx`** — **New file.** Self-subscribes to `selectInlineHighlightColor`. `HighlightIcon` trigger with store-derived `barColor`. 4×2 grid of 28px rounded-square (6px radius) swatches from `HIGHLIGHT_COLORS`. "None" swatch: grey `#e5e7eb` background with diagonal slash (`ctx-highlight-slash` span, 45° rotated 2px bar). Blue ring on selected. Same popover pattern.
- **`client/src/components/context-menu/FontSizeStepper.tsx`** — Converted to stepper+dropdown hybrid. Props: `onValueClick` → `onSelectSize`. Center value button opens dropdown of all 10 `TEXT_FONT_SIZE_PRESETS` with checkmark on active. Display value clamped 1-999. Same popover pattern.
- **`client/src/components/context-menu/ContextMenu.tsx`** — All text buttons fully wired. `BoldButton` and `ItalicButton` are self-subscribing `memo` components with `selectInlineBold`/`selectInlineItalic` selectors — parent `TextStyleGroup` doesn't re-render on bold/italic changes. Alignment buttons wired to `setSelectedTextAlign`. Text color uses `TextColorPopover`. Highlight uses `HighlightPickerPopover`. FontSizeStepper wired: `onDecrement={decrementFontSize}`, `onIncrement={incrementFontSize}`, `onSelectSize={setSelectedFontSize}`.
- **`client/src/components/context-menu/icons/FormatIcons.tsx`** — Both `IconBold` and `IconItalic` now use `fill="currentColor"` (removed hardcoded `#1F2937` from svg and path). Enables CSS `.active { color: #3b82f6 }` inheritance for active-state theming.
- **`client/src/components/context-menu/context-menu.css`** — Added highlight picker styles: `.ctx-submenu-highlight` (auto-width, 10px/12px padding), `.ctx-highlight-grid` (4-col grid, 8px gap), `.ctx-highlight-swatch` (28px rounded-square, 6px radius, relative+overflow for slash), `.ctx-highlight-swatch-none` (grey `#e5e7eb`), `.ctx-highlight-slash` (absolute 45° diagonal bar). Added `.ctx-submenu-fontsize` (90px min-width).
- **Typecheck**: all workspaces clean (only pre-existing `TextContextMenu.ts` + `isNew` errors).
