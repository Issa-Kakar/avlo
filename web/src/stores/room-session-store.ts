/**
 * Room session store — the server-delivered per-session room state (§7/§8/H27).
 * Populated by `room-doc-manager`'s provider listeners (custom `__YPS:` strings the
 * provider surfaces as `custom-message`) + seeded from the rooms query cache by the
 * room route's beforeLoad:
 *
 *   • `mode:editor|viewer` → `mode` (the live `isReadOnly` recompute on the server is the
 *     enforcement boundary; this flag is what a future viewer-client UI gates on).
 *   • `title:<t>` → `title` (pushed on connect + rebroadcast on every rename; also set
 *     optimistically by the rename mutation and seeded from the dashboard cache).
 *   • `owner:1|0` → `isOwner` (per-connection; gates the rename affordance — enforcement
 *     stays server-side in the DO).
 *   • `perm:<p>` → `permission` (room-wide; drives the Share modal's current value — also
 *     set optimistically by the permission mutation and seeded from the dashboard cache).
 *   • `connection-close` 4401/4403 → `access` `unauthenticated`/`forbidden` (the manager
 *     also `disconnect()`s the provider so the stock auto-reconnect loop stops).
 *
 * Ephemeral by design — `resetRoomSession()` on room switch / teardown; no persist
 * (offline reload re-seeds title from the persisted rooms query cache).
 */
import type { Permission } from '@avlo/shared';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export type RoomMode = 'editor' | 'viewer';
export type RoomAccess = 'connecting' | 'ok' | 'unauthenticated' | 'forbidden';

interface RoomSessionState {
  mode: RoomMode;
  access: RoomAccess;
  title: string | null; // null = not yet known (renders as 'Untitled')
  isOwner: boolean;
  permission: Permission | null; // null = not yet known
}

interface RoomSessionActions {
  /** Apply a `mode:` custom message. Reaching editor mode also clears a transient denial. */
  setRoomMode(mode: RoomMode): void;
  /** Record a terminal access denial (4401/4403) — the provider is disconnected alongside. */
  setRoomAccess(access: RoomAccess): void;
  /** Apply a `title:` push / cache seed / optimistic rename. */
  setRoomTitle(title: string | null): void;
  /** Apply an `owner:` push / cache seed. */
  setRoomIsOwner(isOwner: boolean): void;
  /** Apply a `perm:` push / cache seed / optimistic permission flip. */
  setRoomPermission(permission: Permission | null): void;
  /** Reset to the connecting baseline on room switch / teardown. */
  resetRoomSession(): void;
}

const INITIAL: RoomSessionState = { mode: 'editor', access: 'connecting', title: null, isOwner: false, permission: null };

export const useRoomSessionStore = create<RoomSessionState & RoomSessionActions>()(
  immer((set) => ({
    ...INITIAL,
    setRoomMode: (mode) =>
      set((s) => {
        s.mode = mode;
        s.access = 'ok';
      }),
    setRoomAccess: (access) =>
      set((s) => {
        s.access = access;
      }),
    setRoomTitle: (title) =>
      set((s) => {
        s.title = title;
      }),
    setRoomIsOwner: (isOwner) =>
      set((s) => {
        s.isOwner = isOwner;
      }),
    setRoomPermission: (permission) =>
      set((s) => {
        s.permission = permission;
      }),
    resetRoomSession: () => set(INITIAL),
  })),
);

// Stable action refs — defined once inside create(), so destructuring yields references
// that never change (mirrors room-list-store). Import these directly at call sites.
export const { setRoomMode, setRoomAccess, setRoomTitle, setRoomIsOwner, setRoomPermission, resetRoomSession } =
  useRoomSessionStore.getState();
