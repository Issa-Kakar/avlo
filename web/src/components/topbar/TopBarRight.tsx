import { lazy, type MouseEvent, Suspense, useState } from 'react';
import { selectAiPanelOpen, toggleAiPanel, useAiPanelStore } from '@/stores/ai-panel-store';
import { useAuthStore } from '@/stores/auth-store';
import { SignInButton } from '../auth/SignInButton';
import { UserProfileMenu } from '../auth/UserProfileMenu';
import { UserAvatarCluster } from '../UserAvatarCluster';
import { AiIcon } from './icons/AiIcon';
import { ShareIcon } from './icons/ShareIcon';
import { ShareModal } from './ShareModal';
import './TopBar.css';

/** Chrome controls stay out of the focus system — preventDefault on mousedown
 *  keeps focus on the canvas (same pattern as HistoryButtons). */
const preventFocus = (e: MouseEvent) => e.preventDefault();

/** Lazy — keeps agents/ai-chat (and their AI SDK graph) out of the main chunk;
 *  the chunk loads on first panel open. */
const AiPanel = lazy(() => import('../ai/AiPanel'));

/** Right-side counterpart to TopBar — collaborator avatars, the anon sign-in CTA (its
 *  trailing divider renders only when the CTA does), the AI toggle (opens the
 *  assistant panel overlay), the Share CTA (opens the share modal), and the
 *  signed-in profile menu furthest right. Reuses the shared `.top-bar` pill chrome. */
export function TopBarRight() {
  const isAnon = useAuthStore((s) => s.isAnon);
  const aiOpen = useAiPanelStore(selectAiPanelOpen);
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
        className="top-bar-ai"
        tabIndex={-1}
        onMouseDown={preventFocus}
        onClick={toggleAiPanel}
        aria-expanded={aiOpen}
        title="AI assistant"
        aria-label="AI assistant"
      >
        <AiIcon className="top-bar-ai-icon" />
      </button>
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
      {aiOpen && (
        <Suspense fallback={null}>
          <AiPanel />
        </Suspense>
      )}
    </div>
  );
}
