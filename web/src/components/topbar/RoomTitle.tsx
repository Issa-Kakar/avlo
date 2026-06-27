/**
 * Board name in the left TopBar pill — server truth from the room session store
 * (`title:` push / cache seed), editable in place by the room owner only.
 *
 * Read mode: a span that grows with the name up to `.top-bar-name`'s max-width, then
 * ellipsizes. Owners get `cursor: text` + the hover border (the edit affordance);
 * everyone else gets a plain `cursor: default` label.
 *
 * Edit mode: the CSS inline-grid mirror trick (`data-value` replicated into a hidden
 * `::after`) auto-sizes the input to its content under the same max-width — no JS
 * measurement. Enter/blur commit through one path (blur); Escape cancels via a ref flag
 * so the ensuing blur doesn't commit. Empty/unchanged input reverts without a request.
 *
 * Also owns the tab title (`<name> - Avlo`) — it already subscribes to `title` and
 * shares RoomPage's mount lifecycle, so the effect lives here instead of re-rendering
 * the canvas shell. Cleanup restores the static index.html value.
 */
import { normalizeRoomTitle, ROOM_TITLE_MAX_LEN } from '@avlo/shared';
import { getRouteApi } from '@tanstack/react-router';
import { memo, useEffect, useRef, useState } from 'react';
import { useRenameRoom } from '@/query/room-rename';
import { useRoomSessionStore } from '@/stores/room-session-store';

const route = getRouteApi('/room/$roomId');

export const RoomTitle = memo(function RoomTitle() {
  const { roomId } = route.useParams();
  const title = useRoomSessionStore((s) => s.title);
  const isOwner = useRoomSessionStore((s) => s.isOwner);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const cancelled = useRef(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const { mutate } = useRenameRoom();

  const display = title ?? 'Untitled';

  useEffect(() => {
    document.title = `${display} - Avlo`;
    return () => {
      document.title = 'Avlo';
    };
  }, [display]);

  // Commit on outside press. The chrome around the title won't blur it for us — the
  // canvas preventDefaults its pointerdown, and the dock/topbar buttons refuse focus
  // — so without this the input stays focused and keystrokes leak into the canvas. A
  // document `pointerdown` (not mousedown — fires before the canvas's preventDefault)
  // outside the pill blurs the input, committing through the one onBlur path. Same
  // pattern as MainMenuTrigger / useDropdown.
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) wrapRef.current?.querySelector('input')?.blur();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [editing]);

  if (!editing) {
    const startEdit = () => {
      cancelled.current = false;
      setDraft(display);
      setEditing(true);
    };
    return (
      <span
        className={isOwner ? 'top-bar-name top-bar-name-editable' : 'top-bar-name'}
        title={display}
        onClick={isOwner ? startEdit : undefined}
      >
        {display}
      </span>
    );
  }

  const commit = () => {
    setEditing(false);
    const next = normalizeRoomTitle(draft);
    if (next === null || next === display) return; // empty/unchanged → revert, no request
    mutate({ roomId, title: next });
  };

  return (
    <span ref={wrapRef} className="top-bar-name top-bar-name-edit" data-value={draft}>
      <input
        className="top-bar-name-input"
        value={draft}
        size={1}
        maxLength={ROOM_TITLE_MAX_LEN}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (cancelled.current) setEditing(false);
          else commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur(); // commit via the single blur path
          } else if (e.key === 'Escape') {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
});
