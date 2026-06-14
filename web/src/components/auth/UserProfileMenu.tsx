import { imagesClient } from '@avlo/api-client';
import { useAuthStore } from '@/stores/auth-store';
import { useDropdown } from '../context-menu/useDropdown';
import { LogoutIcon } from '../icons/LogoutIcon';
import { signOut } from './SignInButton';
import './UserProfileMenu.css';

/** First letters of the first two words — the no-avatar fallback glyph. */
function initialsOf(name: string): string {
  return (
    name
      .split(' ')
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

/**
 * Signed-in profile affordance (renders nothing for anon — `SignInButton` is the anon
 * counterpart): a circular avatar trigger — the Google avatar snapshot when
 * `avatarHash` is set, else an initials circle in the presence color — opening a
 * dropdown with the account name (email as tooltip) and Log out. Sits furthest right
 * on both surfaces; the canvas variant suppresses focus like every other pill control.
 */
export function UserProfileMenu({ variant }: { variant: 'dashboard' | 'canvas' }) {
  const isAnon = useAuthStore((s) => s.isAnon);
  const name = useAuthStore((s) => s.name);
  const email = useAuthStore((s) => s.email);
  const color = useAuthStore((s) => s.color);
  const avatarHash = useAuthStore((s) => s.avatarHash);
  const { open, containerRef, toggle, close } = useDropdown();

  if (isAnon) return null;

  const canvas = variant === 'canvas';
  return (
    <div className={canvas ? 'profile-menu profile-menu-canvas' : 'profile-menu profile-menu-dashboard'} ref={containerRef}>
      <button
        type="button"
        className="profile-trigger"
        aria-label="Account"
        aria-expanded={open}
        tabIndex={canvas ? -1 : undefined}
        onMouseDown={(e) => {
          if (canvas) e.preventDefault();
          toggle(e);
        }}
      >
        {avatarHash ? (
          <img
            className="profile-avatar"
            src={imagesClient.avatars[':hash'].$url({ param: { hash: avatarHash } }).toString()}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="profile-avatar profile-avatar-initials" style={{ background: color }}>
            {initialsOf(name)}
          </span>
        )}
      </button>
      {open && (
        <div className="profile-dropdown" role="menu">
          <div className="profile-name" title={email}>
            {name}
          </div>
          <div className="profile-divider" />
          <button
            type="button"
            role="menuitem"
            className="profile-item"
            onClick={() => {
              close();
              void signOut();
            }}
          >
            <LogoutIcon width={20} height={20} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
