# Toolbar + Device-UI WIP

> **EVERYTHING IS MUTABLE.** This dir + `stores/device-ui-store.ts` are under
> active redesign in the `avlo-parallel` worktree. Hex codes, icon weights,
> spacing, threshold values, layout, the connector variant set, persist keys,
> store shape, inspector shape — all of it is in flux. **Do not treat any
> value or structure documented here as canonical.** Read this as the
> snapshot-shape you're about to mutate, not as the spec.
>
> This CLAUDE.md is intentionally a wider scope than just `toolbar/`: the
> toolbar and `device-ui-store` were rebuilt together and the surface area
> (inspectors, color primitives, cluster selectors, persist sinks, cursor
> wiring, cross-store reactions, downstream tool reads) needs to be
> reasoned about as one system.
>
> **Task scope comes from the prompt, not this doc.** This doc tells you
> *what currently exists*. The prompt tells you what to change.

---

## Scope

Files this doc covers — anything that touches the dock, the inspectors, the
color primitives, the central UI store, or the surfaces that consume it.

```
components/toolbar/                ← this directory (live)
stores/device-ui-store.ts          ← central UI state
stores/selection-store.ts          ← cross-store reaction sits here
renderer/OverlayRenderLoop.ts      ← subscribes to tool.active
renderer/layers/connector-preview.ts ← reads connector cluster live
tools/DrawingTool.ts               ← reads pen/highlighter/shape at begin
tools/ConnectorTool.ts             ← reads connector cluster at begin
tools/selection/selection-field-table.ts ← persist sinks
components/toolbar/icons/          ← toolbar icon source (one icon per file)
components/RoomPage.tsx            ← mount site
```

Context menu lives in `components/context-menu/` with its own CLAUDE.md and
its own persist consumers via the same field table — out of scope to refactor
*from this doc*, but cross-references are noted.

---

## File Map — `toolbar/`

CSS is co-located with components. `inspectors/Inspector.css` `@import`s
the four primitive CSS files so an inspector only needs one stylesheet
import.

| File | Role |
|---|---|
| `index.ts` | Re-exports `{ Toolbar }`. Single export — no barrel sprawl. |
| `Toolbar.tsx` | Vertical main pill (13 buttons + 2 actions). Dispatches `<PenInspector />` xor `<ConnectorInspector />` based on `activeTool`. Module-level pre-bound onClicks. |
| `Toolbar.css` | Dock design tokens (scoped to `.toolbar-wrap`) + main-pill + actions-pill + tooltip styling. |
| `weights.ts` | `STROKE_WEIGHTS: readonly StrokeWeightOption[]` (4 entries `{ width, Icon }`) + `StrokeWidthPreset = 4 \| 7 \| 10 \| 13` (UI-only union; store field is `number`). |
| `connector-variants.ts` | `CONNECTOR_VARIANT_IDS` (ordered tuple) + `CONNECTOR_VARIANT_SPECS` (keyed table of `{ label, type, startCap, endCap }`) + `ConnectorVariantId` + `deriveConnectorVariant(type, startCap, endCap) → ConnectorVariantId \| null`. Pure, table-driven. |
| `icons/` | All toolbar icon SVGs (see "Icons" section below). One icon per file with two grouped exceptions (stroke weights, connector variants). No barrel — consumers import each icon directly. |
| `inspectors/Inspector.css` | Inspector pill shell + `inspector-divider`; `@import`s the 4 `color/*` primitive CSS files. |
| `inspectors/InspectorButton.tsx/css` | Memoized 30×30 square icon button with `is-active` state. Used by pen/highlighter toggles, weight buttons, connector variants. |
| `inspectors/PenInspector.tsx` | Takes a `tool: StrokeTool` prop. Pen/highlighter toggle (2), divider, `<WeightSelector>`, divider, `<ColorSlots>` + picker. Picker state is component-local `useState`. Reads its slot cluster via `s.strokeTools[tool]`. |
| `inspectors/ConnectorInspector.tsx` | 4 variant buttons sourced from `../icons` via `VARIANT_ICONS` lookup table, divider, `<ColorField>` + picker. Active variant **derived** from caps via `deriveConnectorVariant` — never stored. `VARIANT_HANDLERS` + `VARIANT_ICONS` module-level. |
| `inspectors/WeightSelector.tsx` | Memoized **controlled** 4-button stroke-weight row (`value` / `onChange`). Returns a fragment so the buttons stay direct flex children of `.inspector`. Per-preset `useMemo` handler table — built to also drive `connector.width` later. |
| `color/ColorSlots.tsx/css` | Memoized pen/highlighter **3-slot** column — definitionally 3-slot, iterates `SLOT_INDICES`. Owns a `usePickerDismiss` wrapper containing the slots + picker. `ColorSlots.css` styles the column (`.color-slots`) and opts its slots out of `ColorButton`'s hover-scale. |
| `color/ColorField.tsx/css` | Memoized connector single-color field — sibling of `ColorSlots`, also built on `ColorButton`. One trigger button (no checkmark) + picker. Owns a `usePickerDismiss` wrapper. |
| `color/ColorButton.tsx/css` | The shared swatch-button **primitive** (renamed from `ColorSlot`). `selected?` → checkmark + active ring; `expanded?` → picker-trigger aria — **decoupled**. `colorButtonStyle(color, selected)` centralizes the lone `React.CSSProperties` cast for `--slot-tint` — exported, so `ColorPicker`'s swatches reuse it for the same active ring. |
| `color/ColorPicker.tsx/css` | 23-swatch grid (6 cols, last cell empty) + custom-hex input (`+` action toggles, validated against `/^#([0-9a-f]{3}\|[0-9a-f]{6})$/i`) + disabled eyedropper button. The swatch matching the current color gets a checkmark **and** the slot's tinted offset ring. **Purely presentational** — outside-click dismissal owned by the wrapper's `usePickerDismiss`. |
| `color/use-picker-dismiss.ts` | `usePickerDismiss(isOpen, onClose) → ref` — shared outside-click hook. The ref's element must wrap both the trigger button(s) and the picker. |
| `color/CheckIcon.tsx` | Memoized `<svg>` check; props `color`, `size`, `strokeWidth`. |
| `color/palette.ts` | `PALETTE` (23 colors), `PALETTE_COLS = 6`, `luminance`, `checkmarkColorFor`, `isDark` (< 0.25, slot inset), `isNearBlack` (< 0.13, picker border), `colorsEqual` (case-insensitive, handles 3/6 hex). |

The `color/` primitives are scoped here today but designed to move to a
shared location if/when the context menu adopts them.

### Not in this dir

- The context menu has its own color UI (`components/context-menu/`); the
  two surfaces don't share a picker yet.
- Stroke / shape / text / note inspectors are **not yet ported** — those
  properties are still edited via the context menu only.

---

## Component Hierarchy

```
RoomPage
└─ <Toolbar />                                     zero props
   └─ .toolbar-wrap                                 fixed left:12px, viewport-centered (top:50%)
      ├─ .toolbar-main (pill, position:relative)
      │   ├─ 13× <ToolButton>                       React.memo; module-level onClicks
      │   ├─ {isStrokeTool(activeTool) && <PenInspector tool={activeTool} />}   .inspector absolute, centered vs main pill
      │   └─ {activeTool === 'connector' && <ConnectorInspector />}
      └─ .toolbar-actions (pill)                   Undo, Redo
```

`PenInspector` body (`tool: StrokeTool` prop):
```
.inspector
├─ <InspectorButton> Pen
├─ <InspectorButton> Highlighter
├─ .inspector-divider
├─ <WeightSelector value onChange>                  4× <InspectorButton>, returns a fragment
├─ .inspector-divider
└─ <ColorSlots slots=cluster.slots activeSlot>       cluster = s.strokeTools[tool]
   ├─ 3× <ColorButton>                              selected = checkmark + tinted offset ring
   └─ {isPickerOpen && <ColorPicker />}            isPickerOpen = local useState
```

`ConnectorInspector` body:
```
.inspector
├─ 4× <InspectorButton>                            line / arrow / doubleArrow / elbow (inlined SVGs)
├─ .inspector-divider
└─ <ColorField color=connector.color>
   ├─ 1× <ColorButton>                              expanded only — no checkmark
   └─ {isPickerOpen && <ColorPicker />}
```

### Layout metrics (live values — tune freely)

| Token | Value |
|---|---|
| `toolbar-wrap` position | `fixed; left:12px; top:50%; transform:translateY(-50%); z-index:380` |
| Main-pill button | 32×32, 8px radius, 24×24 icon, 2px gap, 8px container padding, 14px container radius |
| `<768px` override | 28×28 button, 20×20 icon, 3px container padding, 10px radius, `left:6px` |
| Inspector pill | `left: calc(100% + 10px); top:50%; translateY(-50%)`; 4px gap, 6px container padding, 14px radius |
| `<768px` inspector | `left: calc(100% + 6px)` |
| `InspectorButton` | 30×30, 7px radius, 20×20 icon |
| Color slot | 24×24, 6px radius, 12px vertical gap, 6px/4px container padding |
| Color picker | `left: calc(100% + 12px); top:-8px`; 22×22 swatches, 6-col grid (23 swatches → 6+6+6+5), 10px gap, 10px container padding |
| Tooltip | CSS pseudo-element on `.tool-btn`, suppressed while any `.inspector` is mounted via `.toolbar-wrap:has(.inspector) .toolbar-main .tool-btn::after { display: none; }` |

### Active-slot anatomy

Composite `box-shadow` (read CSS — easier than prose). `--slot-tint` is set
inline by `ColorButton.tsx`'s `colorButtonStyle()` as a CSS custom property:

- Gap ring: `0 0 0 2px var(--dock-bg)` separates the fill from the next layer.
- Offset ring: `0 0 0 4px var(--slot-tint)` — same color as the slot.
- Inner stroke (`data-dark` only): white inset (`0.7` active, `0.55` inactive) to keep dark rect edges readable on the near-black dock.
- Checkmark: 16×16 SVG, contrast-flipped via `luminance(color) ≤ 0.55`.

### Tool order (top → bottom in `.toolbar-main`)

Each handler is module-level in `Toolbar.tsx`:

| Order | Tool | Key | Handler | Notes |
|---|---|---|---|---|
| 1 | Select | V | `setActiveTool('select')` | Default tool on every load (see persist). |
| 2 | Pan | Space | `setActiveTool('pan')` | Permanent button; spacebar is an *ephemeral* pan, separate path. |
| 3 | — | — | divider | |
| 4 | Sticky Note | N | `setActiveTool('note')` | Routes to `TextTool` via `tool-registry`. |
| 5 | Text | T | `setActiveTool('text')` | |
| 6 | Rectangle | R | `setShapeMode('rectangle')` | Atomic: writes `tool.active='shape'` + `shape.variant='rectangle'`. Commits `shapeType:'rect'`. |
| 7 | Ellipse | O | `setShapeMode('ellipse')` | |
| 8 | Diamond | D | `setShapeMode('diamond')` | |
| 9 | Connector | A | `setActiveTool('connector')` | Opens `ConnectorInspector`. |
| 10 | Pen | P | `setActiveTool('pen')` | Opens `PenInspector`. **Stays highlighted while `activeTool === 'highlighter'`** — there is no top-level highlighter button (highlighter lives inside the inspector). |
| 11 | Code | — | `setActiveTool('code')` | |
| 12 | Image | I | `openImageFilePicker()` | **One-shot, never marked active.** `'image'` is not in the `Tool` union. |
| 13 | Eraser | E | `setActiveTool('eraser')` | |

Below the main pill, in `.toolbar-actions`: Undo, Redo — call
`getActiveRoomDoc().undo()/redo()` gated on `hasActiveRoom()`.

`ShapeVariant` union includes `'triangle'` but the toolbar doesn't expose
it yet. Existing `'roundedRect'` shape objects in user data still render
correctly — only new toolbar shapes go through `SHAPE_VARIANT_TO_TYPE` in
`DrawingTool.ts` (which maps `rectangle → 'rect'`).

---

## `device-ui-store.ts`

Central persisted UI store. State is nested by tool cluster; actions are
flat (mirrors `selection-store.ts`'s split). The store IS the toolbar's
data model — the toolbar mostly just visualizes and mutates it.

### Type shape

```ts
type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan'
          | 'select' | 'shape' | 'code' | 'connector' | 'note';
type ShapeVariant = 'diamond' | 'rectangle' | 'ellipse' | 'triangle';
type StrokeTool = 'pen' | 'highlighter';                     // subset of Tool
type SlotColors = readonly [string, string, string];         // was `ColorSlots`
type SlotIndex  = 0 | 1 | 2;
const SLOT_INDICES = [0, 1, 2];                              // readonly SlotIndex[] — iterate this
const HIGHLIGHTER_OPACITY = 0.45;                            // fixed; pen is always 1
const isStrokeTool = (t: Tool): t is StrokeTool => …;        // dodges core/accessors' getStrokeTool
interface StrokeCluster { slots: SlotColors; activeSlot: SlotIndex }   // module-local
interface StrokeStyle   { color: string; width: number; opacity: number }   // exported

interface DeviceUIState {
  user:        { id: string; name: string; color: string };
  tool:        { active: Tool; cursorOverride: string | null };
  strokeWidth: number;          // top-level — shared by pen + highlighter
  strokeTools: Record<StrokeTool, StrokeCluster>;   // replaces `pen` + `highlighter`; no stored opacity
  shape:       { variant; color; fillColor; width; align; alignV };
  connector:   { color; width; type; startCap; endCap };
  text:        { color; align; size; fontFamily; highlightColor; fillColor };
  note:        { align; alignV; fontFamily };
  code:        { lineNumbers; headerVisible };
}
```

`resolveStrokeStyle(s, tool) → StrokeStyle` is the consumer-facing read —
it collapses the slot indirection (`c.slots[c.activeSlot]` + `strokeWidth` +
per-tool opacity) so `DrawingTool` never touches slots. `StrokeCluster` is
module-local; only `StrokeStyle` is exported.

**No `as` casts at the initial-state site.** Contextual typing through
`create<DeviceUIStore>()` propagates declared field types into the literal
(e.g. `'rectangle'` narrows to `ShapeVariant`, `'elbow'` to `ConnectorType`,
`StrokeCluster` into the `strokeTools` literal). The only surviving toolbar
CSS cast lives in `ColorButton.tsx`'s `colorButtonStyle()` for the
`--slot-tint` custom property.

**Why `strokeWidth` is top-level.** Pen and highlighter genuinely share it
— width changes apply to both. Putting it inside a `strokeTools` cluster
would lie about the model and force a mirror.

### Middleware stack

```ts
create<DeviceUIStore>()(
  subscribeWithSelector(
    persist(
      immer((set, get) => ({ ... })),
      { name: 'avlo.toolbar.v2', version: 2, partialize, storage: createJSONStorage(localStorage) },
    ),
  ),
);
```

| Layer | Why |
|---|---|
| `immer` (innermost) | Setters mutate the draft directly: `state.strokeTools[tool].slots[c.activeSlot] = color`. `Draft<SlotColors>` strips `readonly` so index writes typecheck without `as unknown as [string, string, string]`. Multi-field writes in one recipe = one subscriber notification. |
| `persist` | Sees plain post-immer state. `partialize` drops `tool.active` and `tool.cursorOverride` — load always resets to `'select'`; override is ephemeral. |
| `subscribeWithSelector` (outermost) | Enables selector-form `subscribe((s) => s.path, fn)`. Internal cursor subscriptions + overlay-loop + selection-store reaction all rely on this. |

### Persist key

`name: 'avlo.toolbar.v2'`, `version: 2`. No `migrate`. Earlier `avlo.toolbar.v1`
payloads (the pre-`strokeTools` `pen`/`highlighter` shape) are orphaned in
localStorage and never read. **Bumping the key is the standard cheap "throw
old payloads away" — there is no migration contract to preserve.** First load
after a bump regenerates user identity through the init block.

### Subscriptions (live)

| Path watched | Callback | Lives in |
|---|---|---|
| `s.tool.active` | `applyCursor` | `device-ui-store.ts` (self-sub) |
| `s.tool.cursorOverride` | `applyCursor` | `device-ui-store.ts` (self-sub) — keeps `setCursorOverride` a pure recipe |
| `s.tool.active` | overlay invalidate-all | `renderer/OverlayRenderLoop.ts:31` — evicts live preview on tool switch |
| `s.tool.active` (with prev) | `clearSelection()` when prev was `'select'` | `stores/selection-store.ts:416` — **one-way reaction; device-ui-store does NOT import selection-store** |

### Action / setter contract

- All setters are immer recipes. Multi-field writes are atomic by construction.
- `setActiveTool(tool)` — `state.tool.active = tool`.
- `setShapeMode(variant)` — atomic `state.tool.active = 'shape'` + `state.shape.variant = variant`.
- `setConnectorMode(variant)` — looks up `CONNECTOR_VARIANT_SPECS[variant]`. For `'elbow'` it writes **only** `state.connector.type = 'elbow'` (caps preserved). For straight variants it writes the full `(type, startCap, endCap)` triple. Single subscriber notification per click.
- `setStrokeSlotColor(tool, color)` / `setStrokeActiveSlot(tool, slot)` — both `tool`-keyed; `setStrokeSlotColor` is a direct draft index write on that tool's active slot.
- `setCursorOverride` — idempotent guard then recipe. Cursor application is the subscription's job, not the setter's.
- Width setters take `number` (not `StrokeWidth` / `ConnectorWidth` unions). The preset unions live UI-side only (`StrokeWidthPreset` in `weights.ts`). Off-preset widths (e.g. from a future drag-resize) persist with no cast.

### Stable action handler exports

At module scope, `device-ui-store.ts` destructures every action out of
the live store and re-exports them as named consts:

```ts
export const { setActiveTool, setStrokeWidth, setShapeMode, setConnectorMode, … } = useDeviceUIStore.getState();
```

Zustand actions are defined once inside `create()`; the references never
change. Components import these directly so memoized children retain
prop equality across renders. **Always prefer the named export over
`useDeviceUIStore.getState().setX` in JSX.**

### User identity init

```ts
if (!useDeviceUIStore.getState().user.id) {
  const profile = generateUserProfile();
  useDeviceUIStore.setState({ user: { id: ulid(), name: profile.name, color: profile.color } });
}
```

Fires once on first-ever load (empty localStorage) or after a manual wipe.
Once seeded, `user` persists via `partialize`. `getUserId()` and
`getUserProfile()` are the imperative getters; `ownerId`, undo tracking,
and presence self-filter all read these.

### Cursor management

`applyCursor()` reads `tool.cursorOverride ?? computeBaseCursor()` and
writes it to `canvas.style.cursor`. Subscriptions on
`tool.active`/`tool.cursorOverride` invoke `applyCursor` automatically.
`setCursorOverride(null)` clears the override (subscription falls back to
the base cursor).

| Tool | Base cursor |
|---|---|
| `eraser` | `url("/cursors/avloEraser.cur") 16 16, auto` |
| `pan` | `grab` |
| `select` | `default` |
| `text`, `note` | `text` |
| anything else | `crosshair` |

`SelectTool` uses `setCursorOverride('grabbing' / 'grab' / 'pointer' / handleCursor(id))`
extensively during drag / hover transitions; see `tools/selection/CLAUDE.md`.

### Selectors

Stable module-level functions. Cluster selectors return the existing
nested object reference — unrelated updates don't change identity, so
plain `Object.is` is correct (no `useShallow` needed for cluster reads).

| Kind | Names |
|---|---|
| Cluster | `selectUser`, `selectShape`, `selectConnector`, `selectText`, `selectNote`, `selectCode` |
| Scalar | `selectActiveTool`, `selectStrokeWidth`, `selectTextColor`, `selectTextAlign`, `selectTextSize`, `selectTextHighlightColor`, `selectTextFontFamily` |

`resolveStrokeStyle(s, tool)` is not a selector (it takes a second arg) but
lives beside them — it's the stroke-tool read consumers use *instead of* a
`selectPen` / `selectHighlighter` pair. The pen inspector reads its cluster
with an inline `(s) => s.strokeTools[tool]` selector.

### Public constants

| Name | Use |
|---|---|
| `TEXT_FONT_SIZE_PRESETS` | `[10,12,14,18,24,36,48,64,80,144]` — context menu + store |
| `TEXT_FONT_FAMILIES` | `['Grandstander','Inter','Lora','JetBrains Mono']` |
| `HIGHLIGHT_COLORS` | 8-entry list `[null, ...7 yellows/blues/etc.]` for the text highlight picker |
| `SLOT_INDICES` | `[0,1,2]` typed `readonly SlotIndex[]` — `ColorSlots` iterates it directly (no slice/cast) |
| `HIGHLIGHTER_OPACITY` | `0.45` — highlighter's fixed draw opacity; `resolveStrokeStyle` returns it for the highlighter tool, `1` for pen |

---

## How the toolbar consumes the store

| Component | Selectors used | Picker state |
|---|---|---|
| `Toolbar.tsx` | `s.tool.active`, `s.shape.variant` — 2 scalar selectors | — |
| `PenInspector.tsx` | `selectStrokeWidth` + an inline `(s) => s.strokeTools[tool]` cluster selector (`tool` is a prop, not read from the store) | `useState` |
| `ConnectorInspector.tsx` | `selectConnector` — single cluster selector; destructures `{ type, startCap, endCap, color }` | `useState` |

The cluster selector in `ConnectorInspector` replaces the four prior
scalar selectors. A cap-only change still fires only the connector
cluster's subscription; the inspector re-renders, the derivation runs
(~5 comparisons), and `<InspectorButton>` children see new `isActive`
booleans. `Toolbar.tsx` doesn't subscribe to the connector cluster, so it
never re-renders on a connector cap change.

`PenInspector` takes its tool as a prop — `Toolbar.tsx`'s `isStrokeTool`
guard narrows `activeTool` to `StrokeTool` inside the `&&` and passes it,
no cast. The inspector then reads `s.strokeTools[tool]` inline — the
cluster ref only changes when that tool's own fields change, so editing a
slot updates the right column without subscribing to both clusters.

---

## How tools / renderer consume the store

| Consumer | Read pattern | Notes |
|---|---|---|
| `DrawingTool.begin()` | `useDeviceUIStore.getState()` once at gesture start; branches on `ui.tool.active`. The `isStrokeTool` branch calls `resolveStrokeStyle(ui, activeTool)` → `{ color, width, opacity }` (one branch for pen + highlighter; no slot access, no cast — `activeTool` is narrowed to `StrokeTool`). Shape reads `ui.shape.color/width/fillColor + variant`. | Settings frozen for the duration of the gesture. Hold-snap from a stroke commits the resulting shape **unfilled** (fillColor stays null). |
| `ConnectorTool.begin()` | `useDeviceUIStore.getState().connector` once; destructures `{ color, width, startCap, endCap, type }` into frozen private fields. | Re-read once mid-move at `probeSnap` for connector type only (acceptable — the user can change it mid-gesture; routing follows). |
| `connector-preview.ts:drawConnectorPreview` | `useDeviceUIStore.getState().connector` per frame | Live style during preview. The doc-comment notes "device-ui-store is stable within a gesture" — true; the live read is for the few cases where it changes between gestures. |
| `CodeTool.begin()` | `useDeviceUIStore.getState()` reads `text` and `code` clusters for defaults | |
| `OverlayRenderLoop.start()` | Subscribes to `s.tool.active` → `invalidateAll` | Evicts in-flight preview on tool switch. Replaces the prior whole-store subscription with selector form. |
| `selection-store.ts` bottom | Subscribes to `s.tool.active` → `clearSelection()` when prev was `'select'` | Cross-store reaction lives here, not in device-ui-store. **Do not invert.** |
| `selection-field-table.ts:250-267` | Per-property persist sinks: `setShapeColorPersist`, `setShapeFillColorPersist`, `setShapeWidthPersist`, `setStrokeWidthPersist`, `setConnectorColorPersist`, `setConnectorWidthPersist`, `setTextSize`, `setTextColor`, `setTextFillColor`, `setTextFontFamily`, `setNoteFontFamily`, `setTextAlign`, `setNoteAlign`, `setShapeAlign`, `setNoteAlignV`, `setShapeAlignV`, `setCodeLineNumbers`, `setCodeHeaderVisible` | These are the bridge between *selection-driven* edits in the context menu and *toolbar-driven* defaults. Editing a shape's stroke color in the context menu also updates `shape.color` so the next new shape inherits it. **Pen/highlighter slots are deliberately NOT persisted from selection** — editing a stroke's color does not overwrite the pen's active slot (the field table has no `stroke` persist for `COLOR` for this reason). |

---

## Icons

All toolbar icons live in `components/toolbar/icons/`. One icon per file
with their name as the filename (`IconSelect.tsx`, `IconPan.tsx`, …) plus
two grouped exceptions — `StrokeWeightIcons.tsx` and
`ConnectorVariantIcons.tsx` — which keep tight design families together
while still exporting each member as a separate component. **No barrel** —
consumers import each icon directly (`from './icons/IconSelect'`, etc.) so
the file system itself is the canonical export list. Grouped files are
imported as `from './icons/StrokeWeightIcons'` etc., picking the members
out in a single statement.

```
icons/
├── IconSelect.tsx                    ┐
├── IconPan.tsx                       │
├── IconStickyNote.tsx                │
├── IconText.tsx                      │
├── IconRectangle.tsx                 │  main pill (12 individual files)
├── IconEllipse.tsx                   │
├── IconDiamond.tsx                   │
├── IconArrow.tsx                     │  ← connector tool button (the diagonal arrow)
├── IconPen.tsx                       │
├── IconCode.tsx                      │
├── IconImage.tsx                     │
├── IconEraser.tsx                    ┘
├── IconUndo.tsx                      ┐  actions
├── IconRedo.tsx                      ┘
├── IconInspectorPen.tsx              ┐  pen inspector
├── IconInspectorHighlighter.tsx      ┘
├── StrokeWeightIcons.tsx             # IconStrokeWeight1..4 (shared squiggle lineage)
└── ConnectorVariantIcons.tsx         # IconConnectorLine / Arrow / DoubleArrow / Elbow
                                      #   (shared VARIANT_STROKE, hosted by ConnectorInspector
                                      #    via a `Record<ConnectorVariantId, FC>` lookup)
```

Zoom/help icons (`IconZoomPlus`, `IconZoomMinus`, `IconZoomToFit`, `IconHelp`,
`IconMouseSettings`) live in the sibling `components/icons/index.tsx` and
are consumed by `ZoomControls.tsx` — **not toolbar icons; don't move them
here.** TopBar's logo/sidebar/kebab icons are their own files under
`components/icons/`.

Reference design notes for the icon system live in
`docs/TOOLBAR_ICON_DESIGN.md` — chunky filled-path approach inspired by
Mural. The current icons are a mix of ports from svgrepo (eraser, code)
and re-drawn hand-crafted weights (the stroke-weight squiggles).

---

## Design Tokens

Scoped to the `.toolbar-wrap` rule in `Toolbar.css` (single source of truth —
inherited by every toolbar descendant, deliberately *not* in the page-global
`:root`, so they can't bleed into other components):

```css
--dock-bg:        #171717
--dock-border:    #4a4a4a
--dock-hover:     #383838
--accent:         #1f51ff
--icon-muted:     #ffffff
--icon-selected:  #ffffff
--divider:        #4a4a4a
--ring:           #1d4ed8
```

All `toolbar/*.css` files reference these via `var(--name, fallback)` with
hardcoded fallbacks so partials still render if the import order shifts
during refactoring.

---

## Memoization

| Component | Memo | Click handlers |
|---|---|---|
| `ToolButton` (13 in `Toolbar.tsx`) | `React.memo` | Module-level pre-bound consts (`clickSelect`, `clickPan`, …). |
| `InspectorButton` | `React.memo` | Sourced from `VARIANT_HANDLERS` (module-level) or `WeightSelector`'s `useMemo` handler table. No inline arrows reach the memoized child. |
| `WeightSelector` | `React.memo` | Controlled. `useMemo` per-preset handler table keyed on the `onChange` prop — callers pass a stable module-level store action (`setStrokeWidth`). |
| `ColorSlots` | `React.memo` | Iterates `SLOT_INDICES`; `PenInspector` passes stable `useCallback` handlers. Non-active slots compose a fresh `onClick` closure each render — bounded to ≤2 per inspector. |
| `ColorField` | `React.memo` | Single `ColorButton`; all handlers are stable `useCallback`s from `ConnectorInspector` — no `useMemo`-wrapped array needed (the old `useMemo<readonly [string]>` is gone). |
| `ColorButton` | `React.memo` | The shared swatch primitive. `selected` / `expanded` are plain booleans. |
| `ColorPicker`, inner `Swatch` | `React.memo` | Swatch click is an inline arrow; bounded to 23 closures per picker open. |
| `CheckIcon` | `React.memo` | — |

**Invariant:** every onClick passed to a memoized child should be a
module-level const, a destructured-store handler, or sourced from a stable
lookup table (`VARIANT_HANDLERS` module-level; `WeightSelector`'s via
`useMemo`). The slot/swatch inline arrows are the intentional exceptions
(≤23 closures total, all bounded).

---

## RoomPage Wiring

`RoomPage.tsx` imports `{ Toolbar } from './toolbar'` and renders `<Toolbar />`
inside its single Tailwind shell `<div>`, alongside `<Canvas />`, `<TopBar />`,
the `.micro-cluster-right` cluster, and `<ZoomControls />`. The old
`.app-container > .workspace > .canvas-container` nest is gone — the shell is
one `position: relative` div; the toolbar itself is `position: fixed`, so it
never depended on that nest.

`Toolbar.tsx` renders the inspector inside `.toolbar-main` so the
inspector's `top: 50%; transform: translateY(-50%)` centers against the
**main pill** — not the taller `.toolbar-wrap`, which also stacks
`.toolbar-actions` underneath.

---

## Stale References (need a cleanup sweep — not blocking)

Carried over from the old horizontal top dock (`ToolPanel.tsx/css`,
deleted). Update opportunistically when working in the relevant file:

- `client/src/core/image/CLAUDE.md:184` — references `components/ToolPanel.tsx`.
- `client/src/components/context-menu/CLAUDE.md:101` — "Top 72px = ToolPanel (48px) + padding". The dock is vertical-left now; the relevant exclusion math is `12px + 48px pill + padding ≈ 64-72px` on the left edge.

These do not affect runtime; they just lie to a future reader.

---

## Reference Assets (untracked, repo root)

Used during the port from Mural's reference UI. Kept around as design
input, not load-bearing for the app:

`zoommenustroke.png`, `muraltoolbar.png`, `mural_strokeMenu.png`,
`CONNECTOR_MENU.png`, `MURAL_ZOOM_HTML.MD`, `cssmural.md`, plus various
Mural screenshots and `docs/TOOLBAR_ICON_DESIGN.md`.

---

## Invariants worth preserving when tweaking

These are the contracts that previous refactor passes paid for. **If a
change breaks one of these, do it deliberately, not accidentally.**

1. **No `tool.active` field is persisted.** Every load starts at
   `'select'`. `partialize` enforces this.
2. **Cluster object references are stable across unrelated updates.** A
   cluster selector subscribed via `useDeviceUIStore(selectX)` only
   re-fires when the cluster itself changes — this is what makes
   `Object.is` cluster reads work and lets the connector inspector use
   one selector for four fields.
3. **Atomic multi-field writes.** `setShapeMode`, `setConnectorMode`,
   `setStrokeSlotColor`, etc. write all their fields in one immer recipe →
   one subscriber notification. Don't split them into multiple `set()`
   calls.
4. **Connector variant is derived, not stored.** `deriveConnectorVariant`
   is the only source. Adding a "current variant" field is a regression
   that re-introduces the three-write race `setConnectorMode` eliminates.
5. **Pen and highlighter slot columns are independent.** `strokeTools`
   keys a `StrokeCluster` (`slots` + `activeSlot`) per `StrokeTool`.
   `resolveStrokeStyle(s, tool)` resolves the right one at gesture begin.
   No shared "current color" mirror; opacity is the `HIGHLIGHTER_OPACITY`
   constant, not stored state.
6. **`strokeWidth` is top-level**, shared by pen + highlighter. Don't
   move it under `strokeTools` or a cluster.
7. **Picker state is component-local.** Each inspector owns its own
   `useState`. Don't lift it back into the store.
8. **Image is a one-shot, not a sustained tool.** `'image'` is
   intentionally absent from the `Tool` union. The toolbar's Image button
   calls `openImageFilePicker()` and is never marked active.
9. **Selection-store knows about device-ui-store; not the reverse.**
   The cross-store reaction lives in `selection-store.ts`. Don't import
   `selection-store` from `device-ui-store`.
10. **No casts at the initial-state site.** Contextual typing through
    `create<DeviceUIStore>()` does the work. If a cast feels necessary,
    the type is probably wrong somewhere else.
11. **`setCursorOverride` is a pure recipe.** Cursor application is the
    subscription's job. Don't inline `applyCursor()` into the setter.

---

## Tuning Targets (visible knobs, nothing finalized)

Listing the most likely-to-be-tweaked surfaces so an agent knows where
to look. **This list is not a roadmap — the actual change will come from
the prompt.**

- **Palette** (`color/palette.ts:PALETTE`) — 23 hex codes eyeballed from
  Mural's `zoommenustroke.png`; the rightmost column is its own red ramp
  (light pink → red → dark red, rows 1-3), 4th cell left empty. Every
  entry is up for adjustment.
- **`isDark` threshold** (`color/palette.ts:isDark`, `< 0.25`) — drives
  the white inset stroke on dark slot buttons (`ColorButton`).
- **`isNearBlack` threshold** (`color/palette.ts:isNearBlack`, `< 0.13`) —
  drives the picker swatch's contrast border (white at 0.55, matching
  ColorButton's dark-slot edge — a border not an inset, so the swatch keeps
  its size). Tighter than `isDark` on purpose: only near-black blends in.
- **`checkmarkColorFor` threshold** (`palette.ts`, `> 0.55`) — separate
  from `isDark` because contrast threshold and "needs an edge stroke
  against the dock" are different perceptual questions.
- **Connector variant icons** (`icons/ConnectorVariantIcons.tsx`) —
  `IconConnectorLine/Arrow/DoubleArrow/Elbow`, placeholder geometry,
  viewBox 0–24 with bbox center at (12, 12). All four want a design pass.
- **Stroke-weight icons** (`icons/StrokeWeightIcons.tsx`,
  `IconStrokeWeight1..4`) — W2/W3 currently use Mural's `drawWeight20`
  / `drawWeight40` paths; W1 and W4 are custom. Geometry is up for tuning.
- **Eraser + Code icons** — both ported from svgrepo, still WIP. The
  code icon's inner chevrons/slash render small inside the 24-unit
  viewBox.
- **Color picker positioning** — `top: -8px` from the slot column.
  Vertical alignment with the slot row center may be cleaner once more
  inspectors land.
- **Inspector pill geometry** — gap (4px), padding (6px), radius (14px),
  divider width (70%) all eyeballed.
- **Slot offset ring on dark colors** — `--slot-tint` is the slot's own
  color, so a black slot's ring is also black against the near-black
  dock and reads as a thin gap only. Design question, not a bug.
- **`Tool` union membership** — `'image'` deliberately absent. Adding/
  removing tools changes the cursor switch (`computeBaseCursor`), the
  `tool-registry`, and the toolbar.
- **`ShapeVariant` union** — has `'triangle'` declared but not exposed
  in the toolbar. A "mixed shape menu" button is a likely path forward
  for surfacing roundedRect / triangle / etc. from one slot.
- **Persist key bump** — flip `'avlo.toolbar.v2'` / `version: 2` if the
  state shape changes incompatibly. There's no migrate fn; old payloads
  are discarded.
- **Eyedropper** — rendered but disabled in `ColorPicker.tsx`. Wire to
  the `EyeDropper` API when prioritized.
- **Mobile breakpoint** — `@media (max-width: 768px)` overrides live in
  `Toolbar.css` and `Inspector.css`. The breakpoint and the override
  values are both eyeballed.
- **Tooltip behavior** — CSS pseudo-element, suppressed while any
  inspector is open via `:has(.inspector)`. Replace with a JS-backed
  tooltip if/when richer content is needed.

---

## Working in this surface — checklist

When the prompt asks you to tweak something here:

- Touch the live values directly. Don't add a config layer or
  abstraction "for future flexibility" — the values ARE the design
  decisions, and they belong inline.
- If you rename or restructure store fields, the persist key MUST bump
  and the `selection-field-table.ts` persist sinks need to follow.
- If you add a new tool, update: `Tool` union, `Toolbar.tsx` button list,
  `computeBaseCursor`, `tool-registry.ts`, and (if it has an inspector)
  `Toolbar.tsx`'s inspector dispatch.
- If you add a new persisted field, update `partialize` (additive — old
  payloads silently lack new fields and pick up the literal defaults).
- If you delete an icon from `components/toolbar/icons/`, grep for
  consumers first. The deleted-ToolPanel didn't take its icons with it.
- Don't add comments that explain WHAT well-named code does. Reserve
  comments for hidden invariants (the existing comments in this surface
  are good models — e.g. the `setConnectorMode` elbow-skips-caps
  comment, the `partialize` `tool.active` comment).
- The codebase enforces zero-allocation hot paths elsewhere, but this
  surface is **react render code**, not a hot path. Don't over-optimize
  picker re-renders unless profiling says otherwise.
