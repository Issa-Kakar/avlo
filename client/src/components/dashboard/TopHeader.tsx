import { SignInButton } from '../auth/SignInButton';
import { UserProfileMenu } from '../auth/UserProfileMenu';
import { PlusAltIcon } from './icons/PlusAltIcon';
import { SearchIcon } from './icons/SearchIcon';

// Search field (visual-only placeholder — focus state is CSS) + auth affordance + New
// Canvas. Anon shows the sign-in CTA before New Canvas; signed-in shows the profile
// menu furthest right (each renders null in the other state). The only behavior here
// is New Canvas → onNewCanvas (mint a room id + navigate).
export function TopHeader({ onNewCanvas }: { onNewCanvas: () => void }) {
  return (
    <header className="dash-topbar">
      <div className="dash-topbar-row">
        <div className="dash-search">
          <SearchIcon width={22} height={22} />
          <input className="dash-search-input" type="text" placeholder="Search by title" aria-label="Search by title" />
        </div>

        <div className="dash-topbar-spacer" />

        <SignInButton variant="dashboard" />

        <button type="button" className="dash-new-canvas" onClick={onNewCanvas}>
          <PlusAltIcon width={21} height={21} />
          New Canvas
        </button>

        <UserProfileMenu variant="dashboard" />
      </div>
    </header>
  );
}
