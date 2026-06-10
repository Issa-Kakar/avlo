/**
 * Local room facts — the client source of truth for per-room data that has no server home
 * yet (or is intentionally local): `createdAt`, `lastVisitedAt`, `starred`. localStorage
 * via Zustand `persist` + `immer` (mirrors device-ui-store): synchronous, so the room
 * route's `recordVisit` and the dashboard merge read it with no async ceremony; reactive;
 * cross-tab via the `storage` event; tiny (one small record per room).
 *
 * The D1 projection (TanStack Query, `query/rooms.ts`) is the OTHER half — server-owned
 * ownership / permission / title. `query/room-list.ts` merges the two by roomId.
 *
 * Keyed by room id as a plain `string` — a RoomId is assignable to string, so branded
 * callers pass through frictionlessly, and a local facts map crosses no trust boundary
 * that would need the brand re-narrowed.
 */
import { ROOM_ID_RE } from '@avlo/shared';
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
export const { createRoom, recordVisit, toggleStar, setRoomTitleFact } = useRoomListStore.getState();
