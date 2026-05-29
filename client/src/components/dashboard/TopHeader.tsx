import { PlusAltIcon } from './icons/PlusAltIcon';
import { SearchIcon } from './icons/SearchIcon';

// Search field + New Canvas. Both are visual-only placeholders today; focus and
// press states are CSS (:focus-within / :active), so this stays render-free.
export function TopHeader() {
  return (
    <header className="dash-topbar">
      <div className="dash-topbar-row">
        <div className="dash-search">
          <SearchIcon width={22} height={22} />
          <input className="dash-search-input" type="text" placeholder="Search by title" aria-label="Search by title" />
        </div>

        <div className="dash-topbar-spacer" />

        <button type="button" className="dash-new-canvas">
          <PlusAltIcon width={21} height={21} />
          New Canvas
        </button>
      </div>
    </header>
  );
}
