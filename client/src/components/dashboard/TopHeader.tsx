import { PlusAltIcon } from './icons/PlusAltIcon';
import { SearchIcon } from './icons/SearchIcon';

// Search field (visual-only placeholder — focus state is CSS) + New Canvas. The only
// behavior is New Canvas → onNewCanvas (mint a room id + navigate).
export function TopHeader({ onNewCanvas }: { onNewCanvas: () => void }) {
  return (
    <header className="dash-topbar">
      <div className="dash-topbar-row">
        <div className="dash-search">
          <SearchIcon width={22} height={22} />
          <input className="dash-search-input" type="text" placeholder="Search by title" aria-label="Search by title" />
        </div>

        <div className="dash-topbar-spacer" />

        <button type="button" className="dash-new-canvas" onClick={onNewCanvas}>
          <PlusAltIcon width={21} height={21} />
          New Canvas
        </button>
      </div>
    </header>
  );
}
