import type { Permission } from '@avlo/shared';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useSetPermission } from '@/query/room-permission';
import { useRoomSessionStore } from '@/stores/room-session-store';
import { useDropdown } from '../context-menu/useDropdown';
import { ChevronDownBoldIcon } from '../icons/ChevronDownBoldIcon';
import { LinkIcon } from '../icons/LinkIcon';

const routeApi = getRouteApi('/room/$roomId');

/** Share-modal labels for the permission enum ("Open"/"View only"/"Private" is the
 *  dashboard's Type-column vocabulary; the modal speaks access-level). */
const PERMISSION_OPTIONS: readonly { value: Permission; label: string }[] = [
  { value: 'public', label: 'can edit' },
  { value: 'readonly', label: 'can view' },
  { value: 'private', label: 'no access' },
];

const shareLabel = (p: Permission): string => PERMISSION_OPTIONS.find((o) => o.value === p)?.label ?? 'can edit';

/**
 * Centered share modal (state owned by `TopBarRight`): the board link with the current
 * permission beside it — a dropdown wired to `useSetPermission()` for the owner
 * (optimistic; the session store updates instantly), a static label for everyone else —
 * plus the coral Copy Link CTA, hidden while the room is private (a link nobody can
 * open isn't worth copying). Dismisses on overlay press + Escape.
 */
export function ShareModal({ onClose }: { onClose: () => void }) {
  const { roomId } = routeApi.useParams();
  const isOwner = useRoomSessionStore((s) => s.isOwner);
  const permission = useRoomSessionStore((s) => s.permission) ?? 'public';
  const { mutate: setPermission } = useSetPermission();
  const { open, containerRef, toggle, close } = useDropdown();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const href = window.location.href;

  return (
    <div className="share-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="share-modal" role="dialog" aria-modal="true" aria-label="Share board">
        <div className="share-title">Share</div>

        <div className="share-link-row">
          <LinkIcon width={20} height={20} />
          <span className="share-link-text">{href}</span>
          {isOwner ? (
            <div className="share-perm" ref={containerRef}>
              <button type="button" className="share-perm-trigger" aria-expanded={open} onMouseDown={toggle}>
                {shareLabel(permission)}
                <ChevronDownBoldIcon width={16} height={16} />
              </button>
              {open && (
                <div className="share-perm-menu" role="menu">
                  {PERMISSION_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="menuitem"
                      className={o.value === permission ? 'share-perm-item share-perm-item-selected' : 'share-perm-item'}
                      onClick={() => {
                        close();
                        if (o.value !== permission) setPermission({ roomId, permission: o.value });
                      }}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span className="share-perm-static">{shareLabel(permission)}</span>
          )}
        </div>

        {permission !== 'private' && (
          <button type="button" className="share-copy" onClick={() => void navigator.clipboard?.writeText(href)}>
            Copy Link
          </button>
        )}
      </div>
    </div>
  );
}
