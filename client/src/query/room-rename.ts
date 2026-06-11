/**
 * Room rename mutation — the client end of the standardized meta fan-out (§8), with an
 * offline queue. `setMutationDefaults` (registered at module import — `main.tsx` imports
 * this file BEFORE `restoreQueryCache()` runs, which is load-bearing: hydrated paused
 * mutations resolve their `mutationFn` + callbacks from these defaults, and route-level
 * code splitting means nothing else would register them at restore time).
 *
 * Offline story (verified against @tanstack/query-core 5.101):
 *   • `mutate()` runs `onMutate` immediately even when the retryer pauses (offline), so the
 *     optimistic title paints AND persists (the updated rooms query data + the paused
 *     mutation — including its context — are both dehydrated to IndexedDB).
 *   • On reconnect the mounted QueryClient resumes paused mutations automatically; after a
 *     reload, `restoreQueryCache()` calls `resumePausedMutations()` (fire-and-forget).
 *   • `scope: { id: 'rename-room' }` serializes queued renames in submission order; the
 *     DO's per-room `rev` orders the projection regardless.
 *
 * On success the server returns the canonical (normalized) title + the D1 Sessions
 * bookmark of the direct read-your-writes write — merged into the rooms query data so an
 * instant navigation home reads correct even before the invalidate refetch lands.
 */
import { usersClient } from '@avlo/api-client';
import { useMutation } from '@tanstack/react-query';
import { getActiveRoomId, hasActiveRoom } from '@/runtime/room-runtime';
import { setRoomTitleFact, useRoomListStore } from '@/stores/room-list-store';
import { setRoomTitle, useRoomSessionStore } from '@/stores/room-session-store';
import { queryClient } from './client';
import { ROOMS_QUERY_KEY, type RoomsQueryData } from './rooms';

export const RENAME_ROOM_KEY = ['rename-room'] as const;

export interface RenameRoomVars {
  roomId: string;
  title: string; // pre-normalized by the caller (normalizeRoomTitle)
}

interface RenameRoomResult {
  title: string; // canonical server-normalized title
  bookmark: string; // '' when the direct write failed (queue converges; keep the prior bookmark)
}

/** JSON-serializable — persisted inside the dehydrated paused mutation. */
interface RenameRoomCtx {
  prev?: RoomsQueryData;
  prevSessionTitle: string | null;
  prevFactsTitle?: string;
}

/** HTTP-level rejection. 4xx is deterministic (403 non-owner, 400 invalid) — never
 *  retried; 5xx is transient (DO transport hiccup, failed RPC) — retried like a network
 *  failure. The status split is the server's meta-RPC error contract (`metaRpcFailure`). */
class RenameHttpError extends Error {
  constructor(readonly status: number) {
    super(`PATCH /rooms/:id/title ${status}`);
  }
}

const isActiveRoom = (roomId: string) => hasActiveRoom() && getActiveRoomId() === roomId;

function patchRoomsCache(roomId: string, title: string, bookmark?: string): void {
  queryClient.setQueryData<RoomsQueryData>(ROOMS_QUERY_KEY, (data) =>
    data
      ? {
          rooms: data.rooms.map((r) => (r.roomId === roomId ? { ...r, title } : r)),
          // Never clobber a real bookmark with '' (failed direct write).
          bookmark: bookmark || data.bookmark,
        }
      : data,
  );
}

queryClient.setMutationDefaults(RENAME_ROOM_KEY, {
  scope: { id: 'rename-room' },
  // Network/transient failures (thrown fetch + 5xx) retry (and pause offline without
  // consuming attempts); deterministic 4xx rejections surface immediately and roll back.
  retry: (failureCount, error) => (error instanceof RenameHttpError ? error.status >= 500 : true) && failureCount < 3,
  mutationFn: async ({ roomId, title }: RenameRoomVars): Promise<RenameRoomResult> => {
    const res = await usersClient.rooms[':id'].title.$patch({ param: { id: roomId }, json: { title } });
    if (!res.ok) throw new RenameHttpError(res.status);
    const body = await res.json();
    if ('error' in body) throw new RenameHttpError(res.status);
    return { title: body.title, bookmark: body.bookmark };
  },
  onMutate: async ({ roomId, title }: RenameRoomVars): Promise<RenameRoomCtx> => {
    await queryClient.cancelQueries({ queryKey: ROOMS_QUERY_KEY });
    const ctx: RenameRoomCtx = {
      prev: queryClient.getQueryData<RoomsQueryData>(ROOMS_QUERY_KEY),
      prevSessionTitle: useRoomSessionStore.getState().title,
      prevFactsTitle: useRoomListStore.getState().rooms[roomId]?.title,
    };
    patchRoomsCache(roomId, title);
    if (isActiveRoom(roomId)) setRoomTitle(title);
    setRoomTitleFact(roomId, title);
    return ctx;
  },
  onError: (_err, { roomId }: RenameRoomVars, ctx?: RenameRoomCtx) => {
    // ctx survives persistence (dehydrated with the paused mutation) but guard anyway —
    // a corrupt restore rolls forward via the onSettled invalidate instead.
    if (!ctx) return;
    if (ctx.prev) queryClient.setQueryData(ROOMS_QUERY_KEY, ctx.prev);
    if (isActiveRoom(roomId)) setRoomTitle(ctx.prevSessionTitle);
    setRoomTitleFact(roomId, ctx.prevFactsTitle);
  },
  onSuccess: (data: RenameRoomResult, { roomId }: RenameRoomVars) => {
    // Confirm with the canonical title + the read-your-writes bookmark.
    patchRoomsCache(roomId, data.title, data.bookmark);
    if (isActiveRoom(roomId)) setRoomTitle(data.title);
    setRoomTitleFact(roomId, data.title);
  },
  onSettled: () => queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY }),
});

/** The typed rename hook — all behavior lives in the mutation defaults above. */
export function useRenameRoom() {
  return useMutation<RenameRoomResult, Error, RenameRoomVars, RenameRoomCtx>({ mutationKey: RENAME_ROOM_KEY });
}
