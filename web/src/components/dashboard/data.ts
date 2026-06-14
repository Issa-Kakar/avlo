/**
 * Dashboard display model + pure derivation logic.
 *
 * Live data is the read-time merge in `query/room-list.ts` (`useRoomList()`): the D1
 * server projection (TanStack Query) unioned with the local facts store. This file
 * owns the `Canvas` display shape, the permission → Type-column labels, and the pure
 * filter/sort/group/format helpers — all written against real epoch-ms timestamps,
 * so they carry over to merged rooms unchanged.
 */
import type { Permission } from '@avlo/shared';

export interface Canvas {
  id: string;
  name: string;
  owner: string; // display name — "Me" (anon self) / account name / "Anonymous" (anon other)
  isOwner: boolean; // drives the kebab gate + the "Owned by me" filter
  permission: Permission; // the Type column (`permissionLabel`)
  starred: boolean;
  openedTs: number; // last-opened, epoch ms (max of local + server)
  createdTs: number; // created, epoch ms
}

/** The Type column's permission → label mapping ("can view"/"can edit" live in the Share modal). */
export function permissionLabel(p: Permission): 'Open' | 'View only' | 'Private' {
  return p === 'public' ? 'Open' : p === 'readonly' ? 'View only' : 'Private';
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

/* ----- date formatting + recency ----- */

const sameYearFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const otherYearFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** "May 28" within the current year, "Nov 3, 2025" otherwise. */
export function formatDate(ts: number, now: number = Date.now()): string {
  const fmt = new Date(ts).getFullYear() === new Date(now).getFullYear() ? sameYearFmt : otherYearFmt;
  return fmt.format(ts);
}

const DAY_MS = 86_400_000;
const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function recencyBucket(ts: number, now: number = Date.now()): Recency {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 6) return 'Earlier this week';
  return 'Older';
}

/* ----- filter / sort / group ----- */

export function applyFilter(list: readonly Canvas[], filter: FilterOption): Canvas[] {
  if (filter === 'Owned by me') return list.filter((c) => c.isOwner);
  if (filter === 'Not owned by me') return list.filter((c) => !c.isOwner);
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
export function groupByRecency(list: readonly Canvas[], now: number = Date.now()): CanvasGroup[] {
  const sorted = [...list].sort((a, b) => b.openedTs - a.openedTs);
  return RECENCY_ORDER.map((title) => ({ title, rows: sorted.filter((c) => recencyBucket(c.openedTs, now) === title) }));
}
