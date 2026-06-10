import { generateRoomId } from '@avlo/shared';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { useRoomList } from '@/query/room-list';
import { useRenameRoom } from '@/query/room-rename';
import { createRoom, toggleStar } from '@/stores/room-list-store';
import type { Column, RowRenameProps } from './CanvasRow';
import { CanvasTable } from './CanvasTable';
import {
  applyFilter,
  type Canvas,
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

interface ViewProps extends RowRenameProps {
  canvases: Canvas[];
  renamingId: string | null;
  onOpen: (id: string) => void;
  onToggleStar: (id: string) => void;
}

function HomeView({
  canvases,
  filter,
  setFilter,
  sort,
  setSort,
  ...rowProps
}: ViewProps & { filter: FilterOption; setFilter: (v: FilterOption) => void; sort: SortOption; setSort: (v: SortOption) => void }) {
  const columns = useMemo(() => homeColumns(sort), [sort]);
  const groups = useMemo<CanvasGroup[]>(
    () => [{ title: null, rows: sortCanvases(applyFilter(canvases, filter), sort) }],
    [canvases, filter, sort],
  );

  return (
    <>
      <h1 className="dash-h1 dash-h1-home">Home</h1>
      <div className="dash-controls">
        <SortFilterDropdown label="Filter by" options={FILTER_OPTIONS} value={filter} onChange={setFilter} />
        <SortFilterDropdown label="Sort by" options={SORT_OPTIONS} value={sort} onChange={setSort} />
      </div>
      <CanvasTable columns={columns} groups={groups} {...rowProps} spacious />
    </>
  );
}

function RecentView({ canvases, ...rowProps }: ViewProps) {
  const groups = useMemo(() => groupByRecency(canvases), [canvases]);
  return (
    <>
      <h1 className="dash-h1">Recent</h1>
      <CanvasTable columns={RECENT_COLUMNS} groups={groups} {...rowProps} />
    </>
  );
}

function StarredView({ canvases, ...rowProps }: ViewProps) {
  const groups = useMemo<CanvasGroup[]>(
    () => [{ title: null, rows: canvases.filter((c) => c.starred).sort((a, b) => b.openedTs - a.openedTs) }],
    [canvases],
  );
  return (
    <>
      <h1 className="dash-h1">Starred</h1>
      <CanvasTable columns={RECENT_COLUMNS} groups={groups} {...rowProps} />
    </>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const canvases = useRoomList();
  const [view, setView] = useState<DashboardView>('home');
  const [filter, setFilter] = useState<FilterOption>('Owned by anyone');
  const [sort, setSort] = useState<SortOption>('Last opened');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const { mutate: renameRoom } = useRenameRoom();

  const openCanvas = useCallback(
    (id: string) => {
      void navigate({ to: '/room/$roomId', params: { roomId: id } });
    },
    [navigate],
  );

  // New Canvas: mint a room id, stamp local facts (so it appears instantly), navigate.
  // Zero round-trips — the DO mints ownership on first connect, the queue projects to D1.
  const newCanvas = useCallback(() => {
    const id = generateRoomId();
    createRoom(id);
    void navigate({ to: '/room/$roomId', params: { roomId: id } });
  }, [navigate]);

  // Kebab → Rename (owner rows only). The optimistic update + offline queueing live in
  // the mutation defaults (query/room-rename.ts); the input commits pre-normalized text.
  const onRenameStart = useCallback((id: string) => setRenamingId(id), []);
  const onRenameEnd = useCallback(() => setRenamingId(null), []);
  const onRenameCommit = useCallback((id: string, title: string) => renameRoom({ roomId: id, title }), [renameRoom]);
  const rowProps = { renamingId, onOpen: openCanvas, onToggleStar: toggleStar, onRenameStart, onRenameCommit, onRenameEnd };

  return (
    <div className="dash-root">
      <Sidebar view={view} onSelect={setView} />
      <main className="dash-main">
        <TopHeader onNewCanvas={newCanvas} />
        <div className="dash-scroll">
          <div className="dash-content">
            {/* max-width spine — shares the same left edge + right cap as the top-bar row */}
            <div className="dash-spine">
              {view === 'home' && (
                <HomeView canvases={canvases} {...rowProps} filter={filter} setFilter={setFilter} sort={sort} setSort={setSort} />
              )}
              {view === 'recent' && <RecentView canvases={canvases} {...rowProps} />}
              {view === 'starred' && <StarredView canvases={canvases} {...rowProps} />}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
