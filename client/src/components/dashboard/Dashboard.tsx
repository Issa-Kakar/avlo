import { useCallback, useMemo, useState } from 'react';
import type { Column } from './CanvasRow';
import { CanvasTable } from './CanvasTable';
import {
  applyFilter,
  CANVASES,
  type CanvasGroup,
  FILTER_OPTIONS,
  type FilterOption,
  groupByRecency,
  SORT_OPTIONS,
  type SortOption,
  sortCanvases,
} from './data';
import { Sidebar } from './Sidebar';
import { SortFilterDropdown } from './SortFilterDropdown';
import { TopHeader } from './TopHeader';
import './Dashboard.css';

export type DashboardView = 'home' | 'recent' | 'starred';

// Recent + Starred share this template (both date columns). Home builds its own
// (the 3rd column is dynamic — Last opened vs Created — driven by the sort).
const RECENT_COLUMNS: readonly Column[] = [
  { key: 'star', header: 'Starred', width: '132px' },
  { key: 'name', header: 'Canvas name', width: 'minmax(260px, 1.4fr)' },
  { key: 'date', header: 'Last opened', width: 'minmax(140px, 0.9fr)', dateField: 'openedTs' },
  { key: 'date', header: 'Created', width: 'minmax(140px, 0.9fr)', dateField: 'createdTs' },
  { key: 'owner', header: 'Owner', width: 'minmax(200px, 1.05fr)' },
  { key: 'kebab', header: '', width: '56px' },
];

function homeColumns(sort: SortOption): Column[] {
  const showCreated = sort === 'Last created' || sort === 'Oldest';
  return [
    { key: 'star', header: 'Starred', width: '132px' },
    { key: 'name', header: 'Canvas name', width: 'minmax(280px, 1.4fr)' },
    showCreated
      ? { key: 'date', header: 'Created', width: 'minmax(150px, 0.95fr)', dateField: 'createdTs' }
      : { key: 'date', header: 'Last opened', width: 'minmax(150px, 0.95fr)', dateField: 'openedTs' },
    { key: 'owner', header: 'Owner', width: 'minmax(220px, 1.1fr)' },
    { key: 'kebab', header: '', width: '56px' },
  ];
}

interface ViewProps {
  starredIds: ReadonlySet<string>;
  onToggleStar: (id: string) => void;
}

function HomeView({
  starredIds,
  onToggleStar,
  filter,
  setFilter,
  sort,
  setSort,
}: ViewProps & { filter: FilterOption; setFilter: (v: FilterOption) => void; sort: SortOption; setSort: (v: SortOption) => void }) {
  const columns = useMemo(() => homeColumns(sort), [sort]);
  const groups = useMemo<CanvasGroup[]>(() => [{ title: null, rows: sortCanvases(applyFilter(CANVASES, filter), sort) }], [filter, sort]);

  return (
    <>
      <h1 className="dash-h1 dash-h1-home">Home</h1>
      <div className="dash-controls">
        <SortFilterDropdown label="Filter by" options={FILTER_OPTIONS} value={filter} onChange={setFilter} />
        <SortFilterDropdown label="Sort by" options={SORT_OPTIONS} value={sort} onChange={setSort} />
      </div>
      <CanvasTable columns={columns} groups={groups} starredIds={starredIds} onToggleStar={onToggleStar} spacious />
    </>
  );
}

function RecentView({ starredIds, onToggleStar }: ViewProps) {
  const groups = useMemo(() => groupByRecency(CANVASES), []);
  return (
    <>
      <h1 className="dash-h1">Recent</h1>
      <CanvasTable columns={RECENT_COLUMNS} groups={groups} starredIds={starredIds} onToggleStar={onToggleStar} />
    </>
  );
}

function StarredView({ starredIds, onToggleStar }: ViewProps) {
  const groups = useMemo<CanvasGroup[]>(
    () => [{ title: null, rows: CANVASES.filter((c) => starredIds.has(c.id)).sort((a, b) => b.openedTs - a.openedTs) }],
    [starredIds],
  );
  return (
    <>
      <h1 className="dash-h1">Starred</h1>
      <CanvasTable columns={RECENT_COLUMNS} groups={groups} starredIds={starredIds} onToggleStar={onToggleStar} />
    </>
  );
}

export function Dashboard() {
  const [view, setView] = useState<DashboardView>('home');
  const [starredIds, setStarredIds] = useState<Set<string>>(() => new Set(CANVASES.filter((c) => c.starred).map((c) => c.id)));
  const [filter, setFilter] = useState<FilterOption>('Owned by anyone');
  const [sort, setSort] = useState<SortOption>('Last opened');

  const toggleStar = useCallback((id: string) => {
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="dash-root">
      <Sidebar view={view} onSelect={setView} />
      <main className="dash-main">
        <TopHeader />
        <div className="dash-scroll">
          <div className="dash-content">
            {/* max-width spine — shares the same left edge + right cap as the top-bar row */}
            <div className="dash-spine">
              {view === 'home' && (
                <HomeView
                  starredIds={starredIds}
                  onToggleStar={toggleStar}
                  filter={filter}
                  setFilter={setFilter}
                  sort={sort}
                  setSort={setSort}
                />
              )}
              {view === 'recent' && <RecentView starredIds={starredIds} onToggleStar={toggleStar} />}
              {view === 'starred' && <StarredView starredIds={starredIds} onToggleStar={toggleStar} />}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
