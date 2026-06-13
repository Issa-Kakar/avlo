/**
 * Local room facts — the client source of truth for per-room data that has no server home
 * yet (or is intentionally local): `createdAt`, `lastVisitedAt`, `starred`. localStorage
 * via Zustand `persist` + `immer` (mirrors device-ui-store): synchronous, so the room
 * route's `recordVisit` and the dashboard merge read it with no async ceremony; reactive;
 * cross-tab via the `storage` event; tiny (one small record per room).
 *
 * The D1 projection (TanStack Query, `query/rooms.ts`) is the OTHER half — server-owned
 * ownership / permission / title. `query/room-list.ts` merges the two by roomId. The
 * optional `permission`/`ownerName`/`isOwner` mirrors below are the persisted local copy
 * of those server facts (stamped by `absorbServerRooms` on every `/rooms` fetch + the
 * room DO's `perm:`/`owner:` pushes), so an offline dashboard renders them too.
 *
 * Keyed by room id as a plain `string` — a RoomId is assignable to string, so branded
 * callers pass through frictionlessly, and a local facts map crosses no trust boundary
 * that would need the brand re-narrowed.
 */
import type { RoomListEntry } from '@avlo/api-client';
import { type Permission, ROOM_ID_RE } from '@avlo/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

export interface RoomFacts {
  createdAt: number;
  lastVisitedAt: number;
  starred: boolean;
  /** Last title this device gave the room. Display fallback for LOCAL-ONLY rooms only —
   *  once the room is server-known, the D1 projection's title wins in the merge. */
  title?: string;
  /** Server-derived mirrors (display-only; the DO is the authority). Stamped by
   *  `absorbServerRooms` + the `perm:`/`owner:` pushes; absent until first server contact. */
  permission?: Permission;
  ownerName?: string | null; // owner's account name; null = anon owner
  isOwner?: boolean; // last-known derived ownership
}

interface RoomListState {
  rooms: Record<string, RoomFacts>;
}

interface RoomListActions {
  /** Stamp a freshly-created room (New Canvas). Idempotent — never clobbers existing facts. */
  createRoom(roomId: string): void;
  /** Record a visit (room route). Upserts lastVisitedAt; back-fills createdAt + starred. */
  recordVisit(roomId: string): void;
  /** Toggle a room's local star (dashboard). Back-fills facts for a server-only row. */
  toggleStar(roomId: string): void;
  /** Stamp the last locally-given title (rename mutation). Back-fills facts; `undefined` clears (rollback). */
  setRoomTitleFact(roomId: string, title: string | undefined): void;
  /**
   * Absorb the `/rooms` projection into the local mirrors. UPDATE-ONLY — never creates a
   * row (creating would stamp `createdAt: Date.now()` and corrupt the Last created/Oldest
   * sorts; server-only rooms read straight off the query entry in the merge). Per-field
   * assignment keeps an unchanged refetch a true no-op (no localStorage churn). Private
   * rooms the caller doesn't own are PRUNED; returns the pruned ids so the caller can
   * drop their per-room doc DBs.
   */
  absorbServerRooms(entries: readonly RoomListEntry[]): string[];
  /** Mirror a `perm:` push / optimistic permission flip. Update-only; `undefined` clears (rollback). */
  setRoomPermissionFact(roomId: string, permission: Permission | undefined): void;
  /** Mirror an `owner:` push. Update-only. */
  setRoomOwnerFact(roomId: string, isOwner: boolean): void;
  /** Drop one room's facts (the 4403 eviction path). */
  removeRoom(roomId: string): void;
  /** Drop everything (sign-out purge). */
  clearAllRooms(): void;
}

export type RoomListStore = RoomListState & RoomListActions;

export const useRoomListStore = create<RoomListStore>()(
  persist(
    immer((set) => ({
      rooms: {},
      createRoom: (roomId) =>
        set((s) => {
          if (s.rooms[roomId]) return;
          const now = Date.now();
          s.rooms[roomId] = { createdAt: now, lastVisitedAt: now, starred: false };
        }),
      recordVisit: (roomId) =>
        set((s) => {
          const now = Date.now();
          const prev = s.rooms[roomId];
          if (prev) prev.lastVisitedAt = now;
          else s.rooms[roomId] = { createdAt: now, lastVisitedAt: now, starred: false };
        }),
      toggleStar: (roomId) =>
        set((s) => {
          const prev = s.rooms[roomId];
          if (prev) {
            prev.starred = !prev.starred;
          } else {
            const now = Date.now();
            s.rooms[roomId] = { createdAt: now, lastVisitedAt: now, starred: true };
          }
        }),
      setRoomTitleFact: (roomId, title) =>
        set((s) => {
          const prev = s.rooms[roomId];
          if (prev) {
            prev.title = title;
          } else if (title !== undefined) {
            const now = Date.now();
            s.rooms[roomId] = { createdAt: now, lastVisitedAt: now, starred: false, title };
          }
        }),
      absorbServerRooms: (entries) => {
        const pruned: string[] = [];
        set((s) => {
          for (const e of entries) {
            if (e.permission === 'private' && !e.isOwner) {
              delete s.rooms[e.roomId];
              pruned.push(e.roomId);
              continue;
            }
            const prev = s.rooms[e.roomId];
            if (!prev) continue; // update-only — see the action doc above
            if (prev.permission !== e.permission) prev.permission = e.permission;
            if (prev.ownerName !== e.ownerName) prev.ownerName = e.ownerName;
            if (prev.isOwner !== e.isOwner) prev.isOwner = e.isOwner;
          }
        });
        return pruned;
      },
      setRoomPermissionFact: (roomId, permission) =>
        set((s) => {
          const prev = s.rooms[roomId];
          if (prev) prev.permission = permission;
        }),
      setRoomOwnerFact: (roomId, isOwner) =>
        set((s) => {
          const prev = s.rooms[roomId];
          if (prev) prev.isOwner = isOwner;
        }),
      removeRoom: (roomId) =>
        set((s) => {
          delete s.rooms[roomId];
        }),
      clearAllRooms: () =>
        set((s) => {
          s.rooms = {};
        }),
    })),
    {
      name: 'avlo.rooms.v1',
      // v1 = the roomId format pivot (12-char base32 → 14-char base62). Pre-pivot ids
      // fail the new format gate and would sit as dead dashboard rows that bounce to
      // /home — purge them once on rehydrate.
      version: 1,
      migrate: (persisted) => {
        const s = persisted as RoomListState;
        for (const id in s.rooms) if (!ROOM_ID_RE.test(id)) delete s.rooms[id];
        return s;
      },
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ rooms: s.rooms }),
    },
  ),
);

// Stable action refs — defined once inside create(), so destructuring yields references
// that never change (mirrors device-ui-store). Import these directly at call sites.
export const {
  createRoom,
  recordVisit,
  toggleStar,
  setRoomTitleFact,
  absorbServerRooms,
  setRoomPermissionFact,
  setRoomOwnerFact,
  removeRoom,
  clearAllRooms,
} = useRoomListStore.getState();
