# UI Components Documentation

## TopBar — Floating Logo Panel

Fixed floating panel at top-left of the room page. Provides app identity, board name, and settings access. **UI only** — no click handlers or state wired yet. Structured for future sidebar toggle, board rename, and settings dropdown.

### Layout

```
┌────────────────────────────────────────────────┐
│  [≡< btn]  avlo  │  Untitled          ⋮ btn   │
│   sidebar  logo  │  board name        kebab    │
└────────────────────────────────────────────────┘
```

- **Sidebar button**: Hamburger + left-pointing chevron. Standalone `<button>`. Future: toggles room list sidebar.
- **Logo**: "avlo" in Righteous font. Decorative, not clickable.
- **Divider**: 1px vertical line separating nav area from board area.
- **Board name**: `<span>` with `cursor: text`. Future: inline editable input.
- **Kebab button**: Vertical three-dot menu. Future: board settings dropdown.

### Files

| File | Purpose |
|------|---------|
| `TopBar.tsx` | Panel component — assembles sidebar btn, logo, divider, name, kebab btn |
| `TopBar.css` | Panel styling — fixed position, white bg, 48px height, hover states |
| `icons/AvloLogo.tsx` | Logo SVG — Righteous font, opacity 0.85, viewBox centered for flexbox |
| `icons/SidebarIcon.tsx` | Hamburger + chevron SVG — all filled paths, no strokes |
| `icons/KebabIcon.tsx` | Vertical three-dot SVG — chunky r=2 dots, 7px spacing |

### Rendering

`<TopBar />` is rendered in `RoomPage.tsx` as a sibling of `<Canvas />`. Fixed positioning at `top: 12px; left: 12px; z-index: 400`.

### Font

Righteous (Google Fonts, single weight) loaded in `client/index.html` via `<link>`. Temporary — replace with local `@font-face` later.

---

## Icon Design Conventions

All TopBar icons use **filled paths** (`fill="currentColor"`, no strokes) for crisp rendering. Color is inherited from parent CSS via `currentColor`.

### AvloLogo

SVG `<text>` element rendering "avlo" in Righteous at fontSize 29. `opacity="0.85"` softens the single-weight font's visual heaviness.

**ViewBox centering trick**: viewBox `"0 4 75 34"` is symmetric around the x-height center (y≈21) of the text, not the bounding box center. This ensures `align-items: center` in the flex parent aligns the text body (not ascenders) with adjacent elements. The `height` prop controls render size (default 34).

### SidebarIcon

Hamburger menu with left-pointing chevron indicating an expandable left sidebar. All elements are filled `<path>` elements in a `24×24` viewBox:

- **Chevron**: Filled polygon `M9.5 0 L1 3.5 L9.5 7 L9.5 5 L4.5 3.5 L9.5 2 Z`. 8.5 units wide, 7 tall, 2-unit arm thickness tapering to tip. Inner notch from (4.5, 3.5) to (9.5, 2)–(9.5, 5).
- **Lines**: Pill shapes (rounded rect, h=2, r=1) at y=3.5, 12, 20.5. Spacing: 8.5 units symmetric. Top line is shorter (x=12→22) to accommodate the chevron. Mid/bot lines are full-width (x=1→22).
- Content fills ~90% of viewBox height. CSS renders at 24×24px.

### KebabIcon

Three filled circles in a `16×20` viewBox. Dots at y=3, 10, 17 with r=2. Center-to-center spacing: 7px, edge gap: 3px. Renders at 16×20px default.

---

## CSS Architecture

### Panel (`.top-bar`)

```
position: fixed, top: 12px, left: 12px, z-index: 400
height: 48px, inline-flex, align-items: center
background: #ffffff, border-radius: 12px
border: 1px solid rgba(0,0,0,0.08)
box-shadow: 0 2px 8px rgba(0,0,0,0.1), 0 0 1px rgba(0,0,0,0.06)
```

### Interactive elements

All buttons: `background: transparent`, `border: none`, `border-radius: 8px`, `cursor: pointer`, `color: #1a1a1a`. Hover: `background: rgba(0,0,0,0.05)`.

- Sidebar button: 40×40px grid cell, 24×24px icon
- Kebab button: 28×40px grid cell
- Board name: 13px, `cursor: text`, max-width 160px with ellipsis

### Responsive

At `≤768px`: panel shifts to `top: 8px; left: 8px`.

---

## Future Wiring

| Element | Future behavior |
|---------|----------------|
| Sidebar button | Toggle room list sidebar panel |
| Board name span | Replace with `<input>` for inline board rename |
| Kebab button | Open board settings dropdown/popover |
| Logo | No planned interactivity |
