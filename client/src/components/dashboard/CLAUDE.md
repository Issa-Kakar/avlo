# Dashboard (`/home`)

The canvas-list landing surface — the screen a user lands on to browse / search /
sort / open their canvases. Mounted by `routes/home.tsx`; `/` redirects here
(`routes/index.tsx`), and the room's top-bar logo links here
(`<Link to="/home" preload="intent">`). It mounts **no** canvas/room runtime
(no `connectRoom`).

> **Live data.** Rows come from `useRoomList()` (`query/room-list.ts` — the D1
> projection merged with local facts); the `/home` route warms it with a
> non-blocking `void prefetchQuery` loader, which is why the top-bar logo can
> intent-preload `/home` (see `topbar/CLAUDE.md` › *Navigation precedent*) —
> keep this route's `beforeLoad`/loader **side-effect-free**.
> Interactive today: **row click → open room**, **New Canvas** (mint id + local
> facts + navigate), **star toggle**, the Home **Filter/Sort** dropdowns, and
> the **kebab → Rename** flow (owner rows only; inline input in the name cell,
> committed through `useRenameRoom()` — `query/room-rename.ts`). Search is
> visual-only.
>
> **TODO (user-flagged):** the rename UI has rough touches — some weird
> behaviour/bugs to follow up on. Specifics will be provided in a later
> session; don't infer the fixes from this doc.

## Shape

```
Dashboard            shell — owns view ('home'|'recent'|'starred') + Home filter/sort + renamingId + useRenameRoom
├── Sidebar          AvloLogo (reused from topbar/icons) + 3 nav buttons; active = matches view
└── main
    ├── TopHeader    search field + SignInButton (auth) + New Canvas (focus/press are CSS, render-free)
    └── scroll › content › spine(max-width 1280)
        └── HomeView / RecentView / StarredView   useMemo'd filter→sort→group → CanvasTable
            └── CanvasTable   column-driven header + grouped rows + empty state (threads renamingId → per-row boolean)
                └── CanvasRow (memo) → Cell      OwnerAvatar in the owner cell; KebabMenuCell (owner rows) + NameCell input while renaming
```

The `spine` (max-width 1280, left-aligned) shares the top bar row's left edge + right
cap, so the New Canvas button lines up with the table's right edge.

## Conventions / performance

- **Hover is CSS, not React.** Row background uses a `:hover` selector (`Dashboard.css`) —
  `CanvasRow` is `memo`'d, so a hover never triggers a render; a star toggle or rename start/end
  re-renders only the affected row (rows receive `starred`/`renaming` **booleans**, never the
  Set/id). The kebab is persistently visible (not hover-revealed) on OWNED rows only — rename is
  owner-only and an inert button next to working ones reads as broken, so non-owned rows get an
  empty cell with the same grid footprint.
- **Rename flow.** Kebab (`useDropdown`, right-anchored `.dash-row-menu`) → "Rename" swaps the
  name cell to an uncontrolled `.dash-rename-input` (Enter/blur commit, Esc cancels via ref
  flag; empty/unchanged reverts). `Dashboard` owns `renamingId` + commits pre-normalized
  (`normalizeRoomTitle`) text through `useRenameRoom()`; optimistic update + offline queueing
  live in the mutation defaults (`query/room-rename.ts`). Kebab/menu/input all stopPropagation
  and the row ignores clicks while renaming, so editing never opens the room.
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
| `Dashboard.tsx` | Shell + state (view / filter / sort / renamingId) + `useRenameRoom` commit + the three view components + column templates. The only importer of `Dashboard.css`. |
| `Sidebar.tsx` | Logo + nav. |
| `TopHeader.tsx` | Search field (visual-only) + `<SignInButton variant="dashboard"/>` (`components/auth/` — Google sign-in/out placeholder) + New Canvas (mint id + facts + navigate). |
| `SortFilterDropdown.tsx` | Generic Filter/Sort dropdown. |
| `CanvasTable.tsx` | Column-driven header + grouped body + empty state. Owns the `Column` contract (`CanvasRow.tsx`); derives each row's `renaming` boolean from `renamingId`. |
| `CanvasRow.tsx` | `memo`'d row + `Cell` renderer + `Column`/`RowRenameProps` types + `KebabMenuCell` (owner-only Rename menu) + `NameCell` (inline rename input). |
| `OwnerAvatar.tsx` | 25×25 initials circle, tint by name. |
| `data.ts` | Types + placeholder `CANVASES` + filter/sort/group + `tintFor`/`initials`/`formatDate`/`recencyBucket`. **The backend seam.** |
| `Dashboard.css` | All styles (`@layer components`, `dash-*` classes). |
| `icons/*.tsx` | Home, Recent, Star, Search, PlusAlt, Kebab. (Chevron + check reused — see above.) |
