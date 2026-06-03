/**
 * Room session store — the server-delivered effective mode + access state for the
 * active room (§7/§8/H27). Populated by `room-doc-manager`'s provider listeners:
 *
 *   • `custom-message` `mode:editor|viewer` → `mode` (the live `isReadOnly` recompute on
 *     the server is the enforcement boundary; this flag is what a future viewer-client UI
 *     gates on — step 8, deferred).
 *   • `connection-close` 4401/4403 → `access` `unauthenticated`/`forbidden` (the manager
 *     also `disconnect()`s the provider so the stock auto-reconnect loop stops).
 *
 * No editing-surface gating is wired yet — storing the mode closes the server-delivery
 * loop and lets a forbidden client stop cleanly.
 */
import { create } from 'zustand';

export type RoomMode = 'editor' | 'viewer';
export type RoomAccess = 'connecting' | 'ok' | 'unauthenticated' | 'forbidden';

interface RoomSessionState {
  mode: RoomMode;
  access: RoomAccess;
}

export const useRoomSessionStore = create<RoomSessionState>(() => ({
  mode: 'editor',
  access: 'connecting',
}));

/** Apply a `mode:` custom message. Reaching editor mode also clears a transient denial. */
export function setRoomMode(mode: RoomMode): void {
  useRoomSessionStore.setState({ mode, access: 'ok' });
}

/** Record a terminal access denial (4401/4403) — the provider is disconnected alongside. */
export function setRoomAccess(access: RoomAccess): void {
  useRoomSessionStore.setState({ access });
}

/** Reset to the connecting baseline on room switch / teardown. */
export function resetRoomSession(): void {
  useRoomSessionStore.setState({ mode: 'editor', access: 'connecting' });
}
