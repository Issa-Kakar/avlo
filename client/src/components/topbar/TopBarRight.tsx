import { type MouseEvent, useState } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { SignInButton } from '../auth/SignInButton';
import { UserProfileMenu } from '../auth/UserProfileMenu';
import { UserAvatarCluster } from '../UserAvatarCluster';
import { ShareIcon } from './icons/ShareIcon';
import { ShareModal } from './ShareModal';
import './TopBar.css';

/** Chrome controls stay out of the focus system — preventDefault on mousedown
 *  keeps focus on the canvas (same pattern as HistoryButtons). */
const preventFocus = (e: MouseEvent) => e.preventDefault();

/** Right-side counterpart to TopBar — collaborator avatars, the anon sign-in CTA (its
 *  trailing divider renders only when the CTA does), the Share CTA (opens the share
 *  modal), and the signed-in profile menu furthest right. Reuses the shared `.top-bar`
 *  pill chrome. */
export function TopBarRight() {
  const isAnon = useAuthStore((s) => s.isAnon);
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <div className="top-bar top-bar-right">
      <UserAvatarCluster />
      <div className="top-bar-divider" />
      {isAnon && (
        <>
          <SignInButton variant="canvas" />
          <div className="top-bar-divider" />
        </>
      )}
      <button
        type="button"
        className="top-bar-share"
        tabIndex={-1}
        onMouseDown={preventFocus}
        onClick={() => setShareOpen(true)}
        title="Share this board"
      >
        <ShareIcon className="top-bar-share-icon" />
        Share
      </button>
      <UserProfileMenu variant="canvas" />
      {shareOpen && <ShareModal onClose={() => setShareOpen(false)} />}
    </div>
  );
}
