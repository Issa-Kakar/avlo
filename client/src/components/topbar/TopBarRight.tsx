import type { MouseEvent } from 'react';
import { UserAvatarCluster } from '../UserAvatarCluster';
import { ShareIcon } from './icons/ShareIcon';
import './TopBar.css';

/** Copies the room URL to the clipboard. The real Share modal is future work;
 *  this keeps the button functional in the meantime. */
const handleShare = async () => {
  try {
    await navigator.clipboard?.writeText(window.location.href);
  } catch (error) {
    console.error('Failed to copy link:', error);
  }
};

/** Chrome controls stay out of the focus system — preventDefault on mousedown
 *  keeps focus on the canvas (same pattern as HistoryButtons). */
const preventFocus = (e: MouseEvent) => e.preventDefault();

/** Right-side counterpart to TopBar — collaborator avatars + the Share CTA,
 *  in a pill that reuses the shared `.top-bar` chrome. */
export function TopBarRight() {
  return (
    <div className="top-bar top-bar-right">
      <UserAvatarCluster />
      <div className="top-bar-divider" />
      <button
        type="button"
        className="top-bar-share"
        tabIndex={-1}
        onMouseDown={preventFocus}
        onClick={handleShare}
        title="Copy board link"
      >
        <ShareIcon className="top-bar-share-icon" />
        Share
      </button>
    </div>
  );
}
