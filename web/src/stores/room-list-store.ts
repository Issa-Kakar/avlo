/**
 * Local room state — the client source of truth for per-room data that has no server home
 * yet (or is intentionally local). Two orthogonal slices, both localStorage via Zustand
 * `persist` + `immer` (mirrors device-ui-store): synchronous, so the room route's
 * `recordVisit` and the dashboard merge read with no async ceremony; reactive; cross-tab
 * via the `storage` event; tiny.
 *
 *   • `rooms` — per-room FACTS for rooms this device has INTERACTED with (created / visited /
 *     renamed): `lastVisitedAt`, the optional `createdAt` (set only by a genuine local create
 *     or corrected down to server truth via `absorbServerRooms` — a visit/rename is NOT a
 *     creation), the local `title` fallback, and the server-fact mirrors
 *     `permission`/`ownerName`/`isOwner`. Every row is born from a real interaction, so its
 *     timestamps are always real epoch-ms — never a sentinel (the merge relies on this).
 *   • `starredIds` — the user's STAR preferences as a plain id set. A star is a preference,
 *     not a timestamped fact, so it must NOT live in `RoomFacts`: coupling it there forced a
 *     fabricated created/visited timestamp on every star of a server-only room, jumping the row
 *     to the top of the date sorts. Kept as a separate overlay the merge reads independently —
 *     starring touches no timestamp and stars a projection-only room (no local facts) cleanly.
 *
 * The D1 projection (TanStack Query, `query/rooms.ts`) is the OTHER half — server-owned
 * ownership / permission / title. `query/room-list.ts` merges projection + facts + stars by
 * roomId. The optional `permission`/`ownerName`/`isOwner` mirrors below are the persisted local
 * copy of those server facts (stamped by `absorbServerRooms` on every `/rooms` fetch + the room
 * DO's `perm:`/`owner:` pushes), so an offline dashboard renders them too.
 *
 * Keyed by room id as a plain `string` — a RoomId is assignable to string, so branded callers
 * pass through frictionlessly, and a local map crosses no trust boundary that would need the
 * brand re-narrowed.
 */
import type { RoomListEntry } from '@avlo/api-client';
import { type Permission, ROOM_ID_RE } from '@avlo/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

export interface RoomFacts {
  /** This device's knowledge of a REAL creation, epoch-ms — set only by a genuine local
   *  create (`createRoom`), or corrected down to server truth via `absorbServerRooms`
   *  (`min` with the server `createdAt`). A *visit* or *rename* is NOT a creation, so those
   *  paths no longer stamp it — hence optional. The merge prefers the earliest known value
   *  and falls back to `lastVisitedAt` only when this is absent. Never a sentinel. */
  createdAt?: number;
  lastVisitedAt: number;
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
  /** Star preferences as an id set (presence = starred) — a separate overlay from `rooms`, so a
   *  star never implies a RoomFacts row or a timestamp. The dashboard merge reads it independently. */
  starredIds: Record<string, true>;
}

interface RoomListActions {
  /** Stamp a freshly-created room (New Canvas). Idempotent — never clobbers existing facts. */
  createRoom(roomId: string): void;
  /** Record a visit (room route). Upserts lastVisitedAt only — a visit is NOT a creation,
   *  so it never stamps `createdAt` (server truth flows in via `absorbServerRooms`). */
  recordVisit(roomId: string): void;
  /** Toggle a room's star (dashboard). Flips the `starredIds` overlay only — never touches `rooms`/timestamps. */
  toggleStar(roomId: string): void;
  /** Stamp the last locally-given title (rename mutation). Back-fills facts; `undefined` clears (rollback). */
  setRoomTitleFact(roomId: string, title: string | undefined): void;
  /**
   * Absorb the `/rooms` projection into the local mirrors. UPDATE-ONLY — never creates a
   * row (server-only rooms read straight off the query entry in the merge). Folds the
   * server FWW `createdAt` into an existing row via `min` — correcting an absent local value
   * up to server truth while preserving an EARLIER offline-created time. Per-field assignment
   * keeps an unchanged refetch a true no-op (no localStorage churn). Private rooms the caller
   * doesn't own are PRUNED (facts + any dangling star); returns the pruned ids so the caller
   * can drop their per-room doc DBs.
   */
  absorbServerRooms(entries: readonly RoomListEntry[]): string[];
  /** Mirror a `perm:` push / optimistic permission flip. Update-only; `undefined` clears (rollback). */
  setRoomPermissionFact(roomId: string, permission: Permission | undefined): void;
  /** Mirror an `owner:` push. Update-only. */
  setRoomOwnerFact(roomId: string, isOwner: boolean): void;
  /** Drop one room's facts + star (the 4403 eviction path). */
  removeRoom(roomId: string): void;
  /** Drop everything — facts + stars (sign-out purge). */
  clearAllRooms(): void;
}

export type RoomListStore = RoomListState & RoomListActions;

export const useRoomListStore = create<RoomListStore>()(
  persist(
    immer((set) => ({
      rooms: {},
      starredIds: {},
      createRoom: (roomId) =>
        set((s) => {
          if (s.rooms[roomId]) return;
          const now = Date.now();
          s.rooms[roomId] = { createdAt: now, lastVisitedAt: now };
        }),
      recordVisit: (roomId) =>
        set((s) => {
          const now = Date.now();
          const prev = s.rooms[roomId];
          if (prev) prev.lastVisitedAt = now;
          // New row from a visit: lastVisitedAt only. A visit is NOT a creation — `createdAt`
          // stays absent until a genuine local create or the server's FWW value via absorb.
          else s.rooms[roomId] = { lastVisitedAt: now };
        }),
      toggleStar: (roomId) =>
        set((s) => {
          // A star is a preference overlay, NOT a room fact — flip membership in the id set and touch
          // nothing in `rooms`. This is the whole point of the separate slice: starring a server-only
          // room (no local facts) no longer fabricates a created/visited timestamp that would jump the
          // row to the top of the Last-opened / Last-created sorts.
          if (s.starredIds[roomId]) delete s.starredIds[roomId];
          else s.starredIds[roomId] = true;
        }),
      setRoomTitleFact: (roomId, title) =>
        set((s) => {
          const prev = s.rooms[roomId];
          if (prev) {
            prev.title = title;
          } else if (title !== undefined) {
            // A rename is NOT a creation — new row carries no `createdAt` (server FWW fills it
            // in via absorb; the merge falls back to lastVisitedAt meanwhile).
            s.rooms[roomId] = { lastVisitedAt: Date.now(), title };
          }
        }),
      absorbServerRooms: (entries) => {
        const pruned: string[] = [];
        set((s) => {
          for (const e of entries) {
            if (e.permission === 'private' && !e.isOwner) {
              delete s.rooms[e.roomId];
              delete s.starredIds[e.roomId]; // lost access → drop the now-dangling star too
              pruned.push(e.roomId);
              continue;
            }
            const prev = s.rooms[e.roomId];
            if (!prev) continue; // update-only — see the action doc above
            if (prev.permission !== e.permission) prev.permission = e.permission;
            if (prev.ownerName !== e.ownerName) prev.ownerName = e.ownerName;
            if (prev.isOwner !== e.isOwner) prev.isOwner = e.isOwner;
            // Fold server FWW `createdAt`: correct a previously-absent value up to server truth,
            // but PRESERVE an earlier offline-created time (the device knew the real creation
            // before the DO minted meta). min() does both.
            const merged = prev.createdAt != null ? Math.min(prev.createdAt, e.createdAt) : e.createdAt;
            if (prev.createdAt !== merged) prev.createdAt = merged;
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
          delete s.starredIds[roomId];
        }),
      clearAllRooms: () =>
        set((s) => {
          s.rooms = {};
          s.starredIds = {};
        }),
    })),
    {
      name: 'avlo.rooms.v1', // localStorage key (unrelated to the migration `version` below)
      // version 2 (v1→v2): stars moved out of `RoomFacts` into the dedicated `starredIds`
      // slice — a star is a preference, not a timestamped fact. Hoist any legacy `starred:true`
      // row into the new slice and strip the dead key. v1's job survives: the 12→14-char roomId
      // format pivot still purges pre-pivot ids (and any star that pointed at one).
      version: 2,
      migrate: (persisted) => {
        const s = persisted as {
          rooms?: Record<string, RoomFacts & { starred?: boolean }>;
          starredIds?: Record<string, true>;
        };
        const rooms = s.rooms ?? {};
        const starredIds = s.starredIds ?? {};
        for (const id in rooms) {
          if (!ROOM_ID_RE.test(id)) {
            delete rooms[id];
            continue;
          }
          if (rooms[id].starred) starredIds[id] = true;
          delete rooms[id].starred;
        }
        return { rooms, starredIds } as RoomListState;
      },
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ rooms: s.rooms, starredIds: s.starredIds }),
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
