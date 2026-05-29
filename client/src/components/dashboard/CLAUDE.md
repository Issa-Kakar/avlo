# Dashboard (`/home`)

The canvas-list landing surface — the screen a user lands on to browse / search /
sort / open their canvases. Mounted by `routes/home.tsx`; `/` redirects here
(`routes/index.tsx`). It mounts **no** canvas/room runtime (no `connectRoom`).

> **Placeholder.** UI only, no backend. The single data seam is `data.ts`
> (`CANVASES` query + `NOW` + `ME`). The only interactive behaviors today are the
> **star toggle** and the Home **Filter/Sort** dropdowns (local state). Search,
> New Canvas, kebab menus, and row clicks are visual-only — the wiring points are
> noted in code.

## Shape

```
Dashboard            shell — owns view ('home'|'recent'|'starred') + starredIds + Home filter/sort
├── Sidebar          AvloLogo (reused from topbar/icons) + 3 nav buttons; active = matches view
└── main
    ├── TopHeader    search field + New Canvas (focus/press are CSS, render-free)
    └── scroll › content › spine(max-width 1280)
        └── HomeView / RecentView / StarredView   useMemo'd filter→sort→group → CanvasTable
            └── CanvasTable   column-driven header + grouped rows + empty state
                └── CanvasRow (memo) → Cell      OwnerAvatar in the owner cell
```

The `spine` (max-width 1280, left-aligned) shares the top bar row's left edge + right
cap, so the New Canvas button lines up with the table's right edge.

## Conventions / performance

- **Hover is CSS, not React.** Row background uses a `:hover` selector (`Dashboard.css`) —
  `CanvasRow` is `memo`'d, so a hover never triggers a render and a star toggle re-renders only
  the toggled row (it receives a `starred` **boolean**, not the Set). The kebab is persistently
  visible (not hover-revealed).
- **One generic dropdown** (`SortFilterDropdown`, used for both Filter + Sort) built on the
  context-menu's shared `useDropdown` hook. Open fill + selected row are CSS, keyed off
  `[aria-expanded]` + `.dash-dd-item-selected`. The menu enter is a fade + 8px downward glide on the
  emphasized-decelerate curve (`cubic-bezier(0.05,0.7,0.1,1)`, 180ms), `prefers-reduced-motion`-aware;
  **no scale** (scaling shimmered the text + bled a white edge). The trigger hugs its content with the
  chevron tucked beside the label — it reuses the topbar's `ChevronDownIcon`, inherits the trigger's
  `currentColor` (so it matches the label: #1b1f22 → white on open), **no** rotation. The selected-row
  check reuses the context-menu's `IconCheck`.
- **Tokens, not literals.** Reuses the `--color-chrome-*` scale where values match; the
  surface-specific values are `--color-dash-*` in `index.css`'s `@theme`. The few single-use
  shadows/washes stay literal (commented).
- Icons: one file each under `icons/`, `React.SVGProps<SVGSVGElement>` + `fill="currentColor"`,
  consumer passes `width`/`height` (matches `topbar/icons/*`). `StarIcon` adds a `filled` prop.
  The chevron + check are **not** local — reused from `topbar/icons/ChevronDownIcon` and
  `context-menu/icons` (`IconCheck`).
- `data.ts` models real epoch-ms timestamps + an `Intl` formatter + a day-diff recency bucket, so
  swapping in the real query/`Date.now()` is a drop-in.

## File map

| File | Responsibility |
|------|----------------|
| `Dashboard.tsx` | Shell + state (view / starredIds / filter / sort) + the three view components + column templates. The only importer of `Dashboard.css`. |
| `Sidebar.tsx` | Logo + nav. |
| `TopHeader.tsx` | Search field + New Canvas (visual-only). |
| `SortFilterDropdown.tsx` | Generic Filter/Sort dropdown. |
| `CanvasTable.tsx` | Column-driven header + grouped body + empty state. Owns the `Column` contract (`CanvasRow.tsx`). |
| `CanvasRow.tsx` | `memo`'d row + `Cell` renderer + `Column` type. |
| `OwnerAvatar.tsx` | 25×25 initials circle, tint by name. |
| `data.ts` | Types + placeholder `CANVASES` + filter/sort/group + `tintFor`/`initials`/`formatDate`/`recencyBucket`. **The backend seam.** |
| `Dashboard.css` | All styles (`@layer components`, `dash-*` classes). |
| `icons/*.tsx` | Home, Recent, Star, Search, PlusAlt, Kebab. (Chevron + check reused — see above.) |
