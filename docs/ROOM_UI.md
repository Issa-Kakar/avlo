# Room UI Components

Floating UI panels overlaid on the canvas. All use fixed positioning, white backgrounds, and shared design tokens from `RoomPage.css`.

---

## Fonts

| Font          | Source                      | Weights            | Usage                                                          |
| ------------- | --------------------------- | ------------------ | -------------------------------------------------------------- |
| **Figtree**   | Google Fonts (`index.html`) | 400, 500, 600, 700 | App-wide UI font (`--font-stack`). All buttons, labels, menus. |
| **Righteous** | Google Fonts (`index.html`) | 400 (single)       | Logo text only (`AvloLogo.tsx`).                               |

`--font-stack` defined in `RoomPage.css`: `'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.

---

## TopBar — Floating Logo Panel

Fixed panel at top-left. App identity, board name, and settings access. **UI only** — no click handlers wired yet.

### Layout

```
┌──────────────────────────────────────────────┐
│  [≡ btn]  avlo  │  Untitled          ⋮ btn   │
│  sidebar  logo  │  board name        kebab    │
└──────────────────────────────────────────────┘
```

### Files

| File                    | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `TopBar.tsx`            | Panel component — sidebar btn, logo, divider, name, kebab btn       |
| `TopBar.css`            | Styling — `fixed; top: 12px; left: 12px; z-index: 400`, 48px height |
| `icons/AvloLogo.tsx`    | "avlo" SVG text, Righteous font, opacity 0.85                       |
| `icons/SidebarIcon.tsx` | Hamburger icon — three horizontal pill lines, filled paths          |
| `icons/KebabIcon.tsx`   | Vertical three-dot icon, r=2 circles, 7px spacing                   |

### Styling

- **Panel**: `height: 48px`, `border-radius: 12px`, white bg, `box-shadow: 0 2px 8px rgba(0,0,0,0.1)`
- **Sidebar button**: 40×40px grid cell, 24×24px icon, `color: #1a1a1a`
- **Board name**: 13px, `font-weight: 700`, `color: #3d3d3d`, `cursor: text`, max-width 160px with ellipsis
- **Kebab button**: 28×40px grid cell, `color: #1a1a1a`
- **Hover** (all buttons): `background: rgba(0,0,0,0.05)`
- **Responsive**: shifts to `top: 8px; left: 8px` at ≤768px

### Future Wiring

| Element        | Planned behavior            |
| -------------- | --------------------------- |
| Sidebar button | Toggle room list sidebar    |
| Board name     | Inline `<input>` for rename |
| Kebab button   | Board settings dropdown     |

---

## ZoomControls — Bottom-Right Zoom Bar

Fixed bar at bottom-right. Mural-style layout with zoom +/-, percentage pill dropdown, and flanking utility buttons.

### Layout

```
┌─────────────────────────────────────────────────────┐
│  [mouse]  │  [−]  [  50%  ]  [+]  │  [?]           │
│  settings │  zoom   pill    zoom   │  help           │
└─────────────────────────────────────────────────────┘
                      ▲
              ┌───────────────────┐
              │ 🔍 Zoom to fit   │
              │ ──────────────── │
              │ Zoom to 50%      │
              │ Zoom to 100%     │
              │ Zoom to 150%     │
              │ Zoom to 200%     │
              └───────────────────┘
```

### Files

| File               | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `ZoomControls.tsx` | Bar component — buttons, pill, dropdown menu with presets               |
| `ZoomControls.css` | Styling — `fixed; bottom: 16px; right: 16px; z-index: 380`, 48px height |

### Icons (from `icons/index.tsx`)

| Icon                | Style                                            | Usage                                  |
| ------------------- | ------------------------------------------------ | -------------------------------------- |
| `IconZoomPlus`      | Filled chunky cross, rounded 1.25r corners       | Zoom in button                         |
| `IconZoomMinus`     | Filled rounded rect bar, 1.5r corners            | Zoom out button                        |
| `IconZoomToFit`     | 4 corner arrows + eye center (2 paths, evenodd)  | Menu "Zoom to fit" item                |
| `IconHelp`          | Circle with question mark cutout (evenodd)       | Help button (no handler yet)           |
| `IconMouseSettings` | Mouse body with scroll arrows (2 paths, evenodd) | Mouse settings button (no handler yet) |

All icons: `viewBox="0 0 24 24"`, `fill="currentColor"`, rendered at 20×20px in bar buttons, 18×18px in menu items.

### Bar Styling

- **Container**: `height: 48px`, `border-radius: 14px`, white bg, `padding: 6px`, `box-shadow: 0 2px 8px rgba(0,0,0,0.1)`
- **Buttons**: 34×34px, `border-radius: 8px`, `color: #2a2a2a`. Hover: `background: rgba(0,0,0,0.05)`. Disabled: `opacity: 0.35`
- **Zoom pill**: `height: 34px`, `border-radius: 999px`, 13px `font-weight: 700`, `color: #4a4a4a`. Active (menu open): `background: #1a1a1a; color: #fff` (dark pill)
- **Dividers**: 1×22px, `rgba(0,0,0,0.16)`, 3px horizontal margin

### Menu Styling

- **Container**: `border-radius: 12px`, `min-width: 200px`, `padding: 6px`, opens 8px above bar. 140ms fade+slide-up animation
- **Items**: `height: 36px`, 13px `font-weight: 700`, `color: #3d3d3d`. Hover: `background: rgba(0,0,0,0.05)`
- **Divider**: 1px, `rgba(0,0,0,0.08)`, 4px vertical / 8px horizontal margin

### Behavior

- **Zoom in/out**: `zoomIn()` / `zoomOut()` from `ZoomAnimator.ts`. Disabled at min/max zoom (`PERFORMANCE_CONFIG`)
- **Zoom pill click**: Toggles dropdown menu. Pill inverts to dark when open
- **Presets**: `zoomTo(scale)` — animates to 50%, 100%, 150%, or 200%
- **Zoom to fit**: Computes union bounds of all objects, calls `animateToFit(bounds, 80)`
- **Outside click**: `pointerdown` listener closes menu when clicking outside bar ref

### Responsive

| Breakpoint | Change                                                     |
| ---------- | ---------------------------------------------------------- |
| ≤768px     | `bottom/right: 12px`                                       |
| ≤480px     | `bottom/right: 8px`, buttons shrink to 28px, icons to 18px |

---

## Icon Design Conventions

All icons across both panels use **filled paths** (`fill="currentColor"`, no strokes). Color is inherited from parent CSS via `currentColor`.

- **TopBar icons**: `SidebarIcon` (hamburger), `KebabIcon` (three-dot) — standalone component files
- **Toolbar/Zoom icons**: All in `icons/index.tsx` — shared `React.FC<React.SVGProps<SVGSVGElement>>` pattern, `viewBox="0 0 24 24"`
