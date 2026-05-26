# Top Bar

> **Snapshot, not canon.** This directory is under active UI work. Hex
> codes, font weights, geometry, divider thickness, animation timings, and
> the main menu's content shape are all in flux. Read the values below as
> _the current state you are about to mutate_, not as decisions locked in.
>
> **Task scope comes from the prompt, not this doc.** The body below
> describes what currently exists.

Two floating chrome pills along the top edge of the canvas, plus a
dropdown menu that hangs off the left bar.

- **`TopBar`** (left, `top-bar-left`) — sidebar toggle · Avlo logo ·
  divider · board name ("Untitled" hardcoded) · main-menu trigger ·
  divider · undo/redo.
- **`TopBarRight`** (right, `top-bar-right`) — collaborator avatars ·
  divider · Share button.
- **`MainMenu`** (popover) — drops out from the trigger to the right of
  the board name. Scaffold only today (no actions wired); the trigger and
  five rows are styled, the rest is placeholder.

Both pills share the same `.top-bar` chrome and sit at `z-index: 400`.
The dropdown sits at `z-index: 401` so it paints over its own host pill.

---

## File Map

| File | Responsibility |
|---|---|
| `TopBar.tsx` | Left-bar shell — orders sidebar / logo / divider / name / `MainMenuTrigger` / divider / `HistoryButtons`. |
| `TopBarRight.tsx` | Right-bar shell — `UserAvatarCluster` / divider / Share button. Share copies `window.location.href` to clipboard (placeholder for a real share modal). |
| `TopBar.css` | The only stylesheet for this folder. Holds the shared `.top-bar` pill, every button variant, the main-menu container + items + divider + open animation, and the Share button. |
| `HistoryButtons.tsx` | `memo`'d. Undo/Redo buttons, subscribed to `history-store` (`selectCanUndo` / `selectCanRedo`). Clicks call `undo()` / `redo()` from `room-runtime`. |
| `MainMenuTrigger.tsx` | The chevron-down button that replaces the kebab + the menu's open/close state + outside-click dismiss. |
| `MainMenu.tsx` | Static row composition — three groups divided by hairlines: `Export` · `Board` / `Edit` / `Preferences` · `Keyboard shortcuts`. Every row currently just closes the menu on click. |
| `MainMenuItem.tsx` | One row: leading 20×20 icon · label · optional trailing chevron-right (for popouts). `forwardRef` so a future focus/keyboard story can address rows directly. |
| `index.ts` | Public exports — `TopBar`, `TopBarRight`. Everything else (menu, icons) is internal. |
| `icons/*.tsx` | One SVG per file. See **Icons** below. |

Mounted in `components/RoomPage.tsx` (one `<TopBar />` + one `<TopBarRight />` sibling).

---

## Design Tokens

The top bar **does not own a tokens file**. Values are inlined as CSS
literals, deliberately keyed off the same numbers the context menu and
zoom bar already use. The vocabulary below is the chrome-wide language —
share it across any new top-bar surface.

### Inks
| Token | Hex | Where it appears today |
|---|---|---|
| Engaged dark | `#1b1f22` | `MainMenuTrigger` ink at rest; `MainMenuTrigger[aria-expanded="true"]` background; `HistoryButtons` ink at rest. Matches context-menu `--ctx-engaged`. |
| Tier dark | `#282e34` | Board name (`.top-bar-name`). Matches context-menu `--ctx-engaged-tier`. |
| Body text | `#48525b` | `MainMenuItem` label + icon + chevron (all via `currentColor`). Matches context-menu `--ctx-text`. |
| Disabled ink | `#0b294652` | `HistoryButtons:disabled` (32% navy — fades cleanly inside the `#1b1f22` family instead of switching to a foreign warm/cool grey). |
| Legacy ink | `#1a1a1a` | `.top-bar-sidebar`, `.top-bar-logo`. Pre-engaged-dark; not aligned yet. |
| Share fill | `#ef4e3a` (hover `#d74634`, active `#bf3e2e`) | Single primary CTA — the warm pole in an otherwise cool chrome palette. White text via `currentColor`. |

### Washes & hairlines
| Token | Value | Role |
|---|---|---|
| Hover wash | `rgba(42, 82, 121, 0.08)` | Every transparent button's `:hover`. Matches context-menu `--ctx-hover` and the zoom bar's hover wash (recolored together). |
| Divider | `rgba(42, 82, 121, 0.12)` | `.top-bar-divider` (vertical, 2px) and `.main-menu-divider` (horizontal, 2px). Same value the context menu's `--ctx-divider` and the zoom bar's dividers use. |
| Pill border | `rgba(0, 0, 0, 0.08)` | Every pill (top bar + main menu). |
| Pill shadow | `0 2px 8px rgba(0,0,0,.1), 0 0 1px rgba(0,0,0,.06)` | `.top-bar` chrome. |
| Menu shadow | `0 4px 16px rgba(0,0,0,.1), 0 1px 4px rgba(0,0,0,.06)` | `.main-menu` popover — heavier than the bar to read as floating chrome. |

**One chrome language.** Inside the chrome (top bar, main menu, zoom bar,
context menu), the divider hairline is always the blue-tinted
`rgba(42, 82, 121, 0.12)` and the hover wash is always the matching
`0.08`. Don't introduce a parallel grey/black wash on a new surface
without a reason — recolor the surface to the existing token instead.

---

## Geometry

### Pill (`.top-bar`)
- Position: `fixed`, `top: 7px`. Left bar `left: 9px`; right bar `right: 9px`.
- Height `48px`, radius `12px`, padding `0 6px 0 5px` (left) / `0 7px` (right).
- Gap `2px` between children (`gap: 2px` on left only; right is `0`).
- `inline-flex` so the right bar grows leftward as peers join.

### Buttons
| Class | Size | Radius | Inner SVG |
|---|---|---|---|
| `.top-bar-sidebar` | 32×32 | 8px | 24×24 |
| `.top-bar-menu-trigger` | 32×32 | 8px | 20×20 |
| `.top-bar-history-btn` | 32×32 | 8px | 20×20 |
| `.top-bar-share` | auto×32, `padding: 0 14px 0 9px`, `gap: 6px` | 8px | 20×20 |

Every button suppresses focus via `onMouseDown={preventFocus}` +
`tabIndex={-1}` so canvas focus is preserved. The Share button is the
exception that proves the rule — it has its own dedicated coral fill and
active scale-down, since it's the one primary action and reads as
clickable chrome rather than a tool button.

### Dividers
`.top-bar-divider` — 2×24, vertical, `flex-shrink: 0`. Default margin is
`0 4px 0 9px` (asymmetric to balance the text mass of the board name to
its right); `.top-bar-divider-history` overrides to symmetric `0 9px`,
and the right-bar override is `0 8px`.

### Main menu popover
- `min-width: 210px`, padding `6px`, radius `12px`, gap `2px` between items.
- `position: absolute` inside `.main-menu-anchor` (the trigger's wrapper);
  `top: calc(100% + 12px)` — clears the pill (~8px of pill below the
  trigger bottom) plus a 4px breathing gap. **Tight but visible.** Don't
  go below `+10px` (touches the pill); don't go above `+16px` (looks
  detached).
- `z-index: 401` — one above the pill it hangs from.

### Menu rows
- 32 tall, 12px horizontal padding, 10px icon→label gap, 8px radius.
- Leading icon 20×20, label flex-grows, trailing chevron 16×16 (smaller
  than the leading icon so the popout affordance stays subordinate).
- Font: `12px / 700 / line-height 1.3`, ink `#48525b` (driving icon +
  label + chevron via `currentColor` so the row recolors as a unit on
  hover).
- Hover wash on the row, not the icon.
- Horizontal divider between groups: 2px tall, blue-tinted, `margin: 4px 6px`.

### Main menu animation
`@keyframes main-menu-enter` — `130ms cubic-bezier(0.16, 1, 0.3, 1)`
(ease-out-expo). `opacity 0 → 1`, `scale(0.97) → 1`,
`translateY(-4px) → 0`. `transform-origin: top left` so the menu pops
out of the trigger (where it was summoned), not inflating from its own
center. Hard-decelerating curve feels instant on press, soft on landing
— the right tradeoff for a frequently-accessed menu.

---

## Main Menu — Trigger + Outside Click

### Trigger
`MainMenuTrigger` is the chevron-down button. State is local
(`useState`); no store involvement.

- Rest: transparent bg, ink `#1b1f22`.
- Open: bg `#1b1f22`, glyph flips white via `currentColor`. The
  `[aria-expanded="true"]` selector carries every hover/active mirror
  so the engaged fill survives hover and press on an open trigger.

### Outside-click dismiss
`document.addEventListener('pointerdown', ...)`. **Not `mousedown`** —
this is the same pattern `ZoomControls` uses, and the reason is
load-bearing:

The canvas (`CanvasRuntime.handlePointerDown`) calls `e.preventDefault()`
on `pointerdown` for tool gestures. Chromium suppresses the synthesized
`mousedown` when its source `pointerdown` is `preventDefault`'d, so a
`document.addEventListener('mousedown', ...)` listener never fires for
clicks on the canvas surface — the menu would only close when clicking
on _other_ DOM chrome. `pointerdown` fires before any
`preventDefault` can take effect and matches the canvas's own event
model, so clicks anywhere outside the menu close it.

The trigger button keeps `onMouseDown={toggle}` — `pointerdown` bubbles
to the document _first_ (target is inside the trigger's `containerRef`,
no close), then React's `onMouseDown` fires and toggles. Inverting the
order would close the menu before the open could register.

### Menu items
Currently every row's `onClick` is `onClose` — clicking any row dismisses
the menu and does nothing else. When real actions land, wire each into
the `onClick` slot on `MainMenuItem` (the component already accepts an
`onClick` prop) and let the row's own action call `onClose` after.

`Board` / `Edit` / `Preferences` carry the trailing chevron-right because
they will eventually open popouts — direction and shape not yet decided.

---

## TopBarRight

Minimal today, but shares the same `.top-bar` pill chrome as the left bar.

- `UserAvatarCluster` — collaborator presence renders here.
- `.top-bar-divider` — same 2px blue-tinted hairline as the left bar
  (with a symmetric `0 8px` margin override since there's no text-mass
  asymmetry to balance).
- Share button — coral CTA, copies `window.location.href` to clipboard
  on click. Future work: a real share modal with permissions, link
  expiry, etc.

---

## Patterns

### `preventFocus` on mousedown
```ts
const preventFocus = (e: MouseEvent) => e.preventDefault();
// <button tabIndex={-1} onMouseDown={preventFocus} onClick={...}>
```
Shared across `HistoryButtons`, `TopBarRight`, `MainMenuItem`. Stops the
button from stealing focus from the canvas, which keeps keyboard tool
switches working through any chrome interaction.

### Engaged-dark trigger
A trigger button that swaps to `#1b1f22` fill + white glyph on
`[aria-expanded="true"]`. One source today (`top-bar-menu-trigger`); the
same pattern lives in the context menu as `.ctx-btn-engaged`. If a
second engaged trigger lands here, lift it into a shared class.

### Single-ink rows
`MainMenuItem` declares one `color: #48525b` on the row and lets every
SVG inherit via `currentColor`. The hover wash is on the row, not the
icon, so the entire row recolors as a unit when (and if) the row's text
color changes later.

---

## Icons

All icons live in `topbar/icons/`. **One SVG per file**, so per-icon
tweaks land in one place — the icon set is the most likely thing to
churn.

| File | viewBox | Native size | Notes |
|---|---|---|---|
| `AvloLogo.tsx` | `0 4 58 34` | 34h | Righteous typeface "avlo", 0.85 opacity to soften visual weight. The `top: -1px` adjustment in `.top-bar-logo` is optical alignment with the wordmark's x-height. |
| `SidebarIcon.tsx` | `0 0 24 24` | 24×24 | Three filled pill rows, deliberately tighter spacing than a standard hamburger so it reads "sidebar" rather than "menu". |
| `ChevronDownIcon.tsx` | `0 0 24 24` | 20×20 (CSS) | Mural solid chevron. Glyph for the main-menu trigger. |
| `ChevronRightIcon.tsx` | `0 0 24 24` | 16×16 (CSS) | Same Mural geometry rotated 90°. Popout affordance on main-menu rows. |
| `ExportIcon.tsx` | `0 0 24 24` | 20×20 (CSS) | Mural download SVG with the arrow path **vertically mirrored** around y=6.942 (y_abs → 13.884 − y_abs; dy_rel → −dy_rel; arc sweep flag flipped 0↔1). Tail now sits at the bottom (overlapping the tray top by 0.384 — same visual continuity the original had between tip and tray), so it reads as "upload out of the tray" instead of "download into it". Tray path is untouched. |
| `BoardIcon.tsx` | `0 0 24 24` | 20×20 (CSS) | Mural `muralsAll` — rounded square frame with carved inner shapes via `evenodd`. |
| `EditIcon.tsx` | `0 0 24 24` | 20×20 (CSS) | Mural pencil-on-card, two paths. |
| `PreferencesIcon.tsx` | `0 0 24 24` | 20×20 (CSS) | Sliders in a rounded-square frame. **Redrawn at 24-viewBox** by scaling every coordinate in the original 32-viewBox source (svgrepo) by 0.75 — matches the density of every other icon here. |
| `KeyboardIcon.tsx` | `0 0 24 24` | 20×20 (CSS) | Mural `keyboard`. Carved key grid via `evenodd`. |
| `UndoIcon.tsx` / `RedoIcon.tsx` | `0 0 24 24` | 20×20 (CSS) | Curved arrow looping back left / right. Mirror geometry — one path each. |
| `ShareIcon.tsx` | `0 0 24 24` | 20×20 (CSS) | Person + "+" badge. Two paths, both `currentColor` so the badge tints with the row. |

**Convention.** All glyphs use `fill="currentColor"` on the paths and
`aria-hidden="true" focusable="false"` on the SVG element. Default size
comes from CSS, never the SVG itself — pass `width` / `height` through
`...props` so the consumer chooses the render size.

---

## Routing & Mount

```
RoomPage.tsx
├── <TopBar />
│   ├── .top-bar-sidebar     (no-op placeholder)
│   ├── AvloLogo
│   ├── .top-bar-divider
│   ├── .top-bar-name        ("Untitled" — hardcoded)
│   ├── MainMenuTrigger      ← owns the dropdown
│   │   └── MainMenu (open ? rendered : null)
│   │       ├── MainMenuItem × 5
│   │       └── main-menu-divider × 2
│   ├── .top-bar-divider-history
│   └── HistoryButtons       ← memo'd, subscribes to history-store
│
└── <TopBarRight />
    ├── UserAvatarCluster
    ├── .top-bar-divider
    └── .top-bar-share       (clipboard placeholder)
```

The sidebar button and the board name are **placeholders** — present in
the markup, no behavior yet. The Share button works (copies URL) but is
also a placeholder for a real share flow.
