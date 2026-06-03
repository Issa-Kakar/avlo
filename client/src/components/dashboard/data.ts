/**
 * Dashboard placeholder data + derivation logic.
 *
 * This is the ONE seam to replace when the canvas-list backend lands:
 *   - swap `CANVASES` for the real canvases query,
 *   - swap `NOW` for `Date.now()`,
 *   - swap `ME` for the signed-in user's display name (auth-store getUserProfile().name).
 * Everything else (filter / sort / group / format) is written against real
 * epoch-millisecond timestamps already, so it carries over unchanged.
 */

export interface Canvas {
  id: string;
  name: string;
  owner: string; // display name; avatar is derived from initials + a name-hash tint
  starred: boolean;
  openedTs: number; // last-opened, epoch ms
  createdTs: number; // created, epoch ms
}

export type FilterOption = 'Owned by anyone' | 'Owned by me' | 'Not owned by me';
export type SortOption = 'Last opened' | 'Last created' | 'Oldest' | 'Alphabetically';
export type Recency = 'Today' | 'Yesterday' | 'Earlier this week' | 'Older';

export interface CanvasGroup {
  title: string | null; // null = flat list (no section header)
  rows: Canvas[];
}

export const FILTER_OPTIONS: readonly FilterOption[] = ['Owned by anyone', 'Owned by me', 'Not owned by me'];
export const SORT_OPTIONS: readonly SortOption[] = ['Last opened', 'Last created', 'Oldest', 'Alphabetically'];
export const RECENCY_ORDER: readonly Recency[] = ['Today', 'Yesterday', 'Earlier this week', 'Older'];

/** Fixed anchor for deterministic placeholder buckets. Replace with `Date.now()` when wired. */
const at = (year: number, month: number, day: number) => new Date(year, month - 1, day).getTime();
export const NOW = at(2026, 5, 28);

/** Current user (placeholder). Replace with the signed-in user's name. */
export const ME = 'Issa Kakar';

export const CANVASES: readonly Canvas[] = [
  { id: 'c1', name: "Issa's room", owner: 'Issa Kakar', starred: true, openedTs: at(2026, 5, 28), createdTs: at(2026, 3, 12) },
  { id: 'c2', name: 'Product Design Sprint', owner: 'Issa Kakar', starred: false, openedTs: at(2026, 5, 28), createdTs: at(2026, 4, 2) },
  { id: 'c3', name: 'Q3 Roadmap Planning', owner: 'Maya Lindqvist', starred: true, openedTs: at(2026, 5, 27), createdTs: at(2026, 2, 18) },
  { id: 'c4', name: 'Engineering Standup', owner: 'Daniel Osei', starred: false, openedTs: at(2026, 5, 27), createdTs: at(2026, 1, 9) },
  { id: 'c5', name: 'Marketing Brainstorm', owner: 'Priya Nair', starred: false, openedTs: at(2026, 5, 25), createdTs: at(2026, 4, 22) },
  { id: 'c6', name: 'Onboarding Flows', owner: 'Issa Kakar', starred: true, openedTs: at(2026, 5, 24), createdTs: at(2026, 3, 30) },
  { id: 'c7', name: 'Research Repository', owner: 'Sofia Ramos', starred: false, openedTs: at(2026, 5, 12), createdTs: at(2025, 11, 3) },
  { id: 'c8', name: 'Brand Refresh', owner: 'Maya Lindqvist', starred: false, openedTs: at(2026, 4, 28), createdTs: at(2025, 12, 15) },
];

/* ----- owner avatar derivation ----- */

// Muted tints, deliberately cooler/softer than the random presence palette —
// picked deterministically from the owner name so an owner reads the same everywhere.
const AVATAR_TINTS = ['#7fb3c9', '#a0b6c4', '#8aa1ad', '#9fb8a6', '#b3a6bf', '#c0a99a'] as const;

export function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % AVATAR_TINTS.length;
  return AVATAR_TINTS[h];
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/* ----- date formatting + recency ----- */

const sameYearFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const otherYearFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** "May 28" within the current year, "Nov 3, 2025" otherwise. */
export function formatDate(ts: number, now: number = NOW): string {
  const fmt = new Date(ts).getFullYear() === new Date(now).getFullYear() ? sameYearFmt : otherYearFmt;
  return fmt.format(ts);
}

const DAY_MS = 86_400_000;
const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function recencyBucket(ts: number, now: number = NOW): Recency {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 6) return 'Earlier this week';
  return 'Older';
}

/* ----- filter / sort / group ----- */

export function applyFilter(list: readonly Canvas[], filter: FilterOption): Canvas[] {
  if (filter === 'Owned by me') return list.filter((c) => c.owner === ME);
  if (filter === 'Not owned by me') return list.filter((c) => c.owner !== ME);
  return [...list];
}

export function sortCanvases(list: Canvas[], sort: SortOption): Canvas[] {
  const out = [...list];
  switch (sort) {
    case 'Last opened':
      return out.sort((a, b) => b.openedTs - a.openedTs);
    case 'Last created':
      return out.sort((a, b) => b.createdTs - a.createdTs);
    case 'Oldest':
      return out.sort((a, b) => a.createdTs - b.createdTs);
    case 'Alphabetically':
      return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Group by last-opened recency, in RECENCY_ORDER. Empty buckets stay in the array; the table skips them. */
export function groupByRecency(list: readonly Canvas[], now: number = NOW): CanvasGroup[] {
  const sorted = [...list].sort((a, b) => b.openedTs - a.openedTs);
  return RECENCY_ORDER.map((title) => ({ title, rows: sorted.filter((c) => recencyBucket(c.openedTs, now) === title) }));
}
