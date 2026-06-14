/**
 * Room permission mutation — mirror of `room-rename.ts` (the standardized meta fan-out,
 * §8) for `PATCH /rooms/:id/permission`, with the same offline queue: defaults registered
 * at module import (`main.tsx` imports this file BEFORE `init()` so hydrated paused
 * mutations resolve their `mutationFn` from here), `scope` serializes queued flips,
 * transient-only retry via the HttpError status split.
 *
 * Optimistic across the rooms cache row + the session store (when the active room) + the
 * permission fact. Rollback context is PER-ROW (the one row's prior permission, never a
 * whole-cache snapshot) — a persisted whole-snapshot restore replayed after a
 * sign-out/sign-in could resurrect the previous account's entire rooms list.
 */
import { usersClient } from '@avlo/api-client';
import type { Permission } from '@avlo/shared';
import { useMutation } from '@tanstack/react-query';
import { getActiveRoomId, hasActiveRoom } from '@/runtime/room-runtime';
import { setRoomPermissionFact, useRoomListStore } from '@/stores/room-list-store';
import { setRoomPermission, useRoomSessionStore } from '@/stores/room-session-store';
import { queryClient } from './client';
import { ROOMS_QUERY_KEY, type RoomsQueryData } from './rooms';

export const SET_PERMISSION_KEY = ['set-permission'] as const;

export interface SetPermissionVars {
  roomId: string;
  permission: Permission;
}

interface SetPermissionResult {
  bookmark: string; // '' when the direct write failed (queue converges; keep the prior bookmark)
}

/** JSON-serializable — persisted inside the dehydrated paused mutation. Per-row only. */
interface SetPermissionCtx {
  prevPermission?: Permission; // the one cache row's prior value (undefined = row absent)
  prevSessionPermission: Permission | null;
  prevFactsPermission?: Permission;
}

/** HTTP-level rejection. 4xx is deterministic (403 non-owner) — never retried; 5xx is
 *  transient (DO transport hiccup) — retried like a network failure. The status split is
 *  the server's meta-RPC error contract (`metaRpcFailure`). */
class PermissionHttpError extends Error {
  constructor(readonly status: number) {
    super(`PATCH /rooms/:id/permission ${status}`);
  }
}

const isActiveRoom = (roomId: string) => hasActiveRoom() && getActiveRoomId() === roomId;

function patchRoomsCache(roomId: string, permission: Permission, bookmark?: string): void {
  queryClient.setQueryData<RoomsQueryData>(ROOMS_QUERY_KEY, (data) =>
    data
      ? {
          rooms: data.rooms.map((r) => (r.roomId === roomId ? { ...r, permission } : r)),
          // Never clobber a real bookmark with '' (failed direct write).
          bookmark: bookmark || data.bookmark,
        }
      : data,
  );
}

queryClient.setMutationDefaults(SET_PERMISSION_KEY, {
  scope: { id: 'set-permission' },
  // Network/transient failures (thrown fetch + 5xx) retry (and pause offline without
  // consuming attempts); deterministic 4xx rejections surface immediately and roll back.
  retry: (failureCount, error) => (error instanceof PermissionHttpError ? error.status >= 500 : true) && failureCount < 3,
  mutationFn: async ({ roomId, permission }: SetPermissionVars): Promise<SetPermissionResult> => {
    const res = await usersClient.rooms[':id'].permission.$patch({ param: { id: roomId }, json: { permission } });
    if (!res.ok) throw new PermissionHttpError(res.status);
    const body = await res.json();
    if ('error' in body) throw new PermissionHttpError(res.status);
    return { bookmark: body.bookmark };
  },
  onMutate: async ({ roomId, permission }: SetPermissionVars): Promise<SetPermissionCtx> => {
    await queryClient.cancelQueries({ queryKey: ROOMS_QUERY_KEY });
    const ctx: SetPermissionCtx = {
      prevPermission: queryClient.getQueryData<RoomsQueryData>(ROOMS_QUERY_KEY)?.rooms.find((r) => r.roomId === roomId)?.permission,
      prevSessionPermission: useRoomSessionStore.getState().permission,
      prevFactsPermission: useRoomListStore.getState().rooms[roomId]?.permission,
    };
    patchRoomsCache(roomId, permission);
    if (isActiveRoom(roomId)) setRoomPermission(permission);
    setRoomPermissionFact(roomId, permission);
    return ctx;
  },
  onError: (_err, { roomId }: SetPermissionVars, ctx?: SetPermissionCtx) => {
    // ctx survives persistence (dehydrated with the paused mutation) but guard anyway —
    // a corrupt restore rolls forward via the onSettled invalidate instead.
    if (!ctx) return;
    if (ctx.prevPermission !== undefined) patchRoomsCache(roomId, ctx.prevPermission);
    if (isActiveRoom(roomId)) setRoomPermission(ctx.prevSessionPermission);
    setRoomPermissionFact(roomId, ctx.prevFactsPermission);
  },
  onSuccess: (data: SetPermissionResult, { roomId, permission }: SetPermissionVars) => {
    // Confirm with the read-your-writes bookmark (the optimistic value IS canonical).
    patchRoomsCache(roomId, permission, data.bookmark);
  },
  onSettled: () => queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY }),
});

/** The typed permission hook — all behavior lives in the mutation defaults above. */
export function useSetPermission() {
  return useMutation<SetPermissionResult, Error, SetPermissionVars, SetPermissionCtx>({ mutationKey: SET_PERMISSION_KEY });
}
