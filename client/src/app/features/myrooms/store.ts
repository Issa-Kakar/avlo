import { roomsStore, type RoomRow } from './idb';
import { resolveAlias, setAlias } from './alias';

export type UpsertVisitOpts = {
  title?: string;
  provisional?: boolean;
  // optionally pass server metadata when online
  expires_at?: string; // ISO
};

/** Call on room open/visit (resolved id allowed) */
export async function upsertVisit(roomIdRaw: string, opts: UpsertVisitOpts = {}) {
  const roomId = await resolveAlias(roomIdRaw);
  const prev = await roomsStore.get(roomId);
  const nowIso = new Date().toISOString();
  const row: RoomRow = {
    roomId,
    title: opts.title ?? prev?.title ?? roomId,
    last_opened: nowIso,
    expires_at: opts.expires_at ?? prev?.expires_at,
    provisional: opts.provisional ?? false,
    aliasOf: undefined,
  };
  await roomsStore.put(row);
  return row;
}

/** When a provisional room is published, map local-… → serverId and update rows. */
export async function handlePublish(provisionalId: string, serverId: string, title?: string) {
  await setAlias(provisionalId, serverId);
  // Keep canonical entry under serverId
  const nowIso = new Date().toISOString();
  await roomsStore.put({
    roomId: serverId,
    title: title ?? serverId,
    last_opened: nowIso,
  });
}

/** Remove from list only (do not delete room's Y.Doc). */
export async function removeFromList(roomId: string) {
  await roomsStore.del(roomId);
}

/**
 * Delete local copy: the caller must supply a function that clears the per-room y-indexeddb state.
 * This avoids making assumptions about the persistence instance.
 */
export async function deleteLocalCopy(
  _roomId: string,
  destroyYjsPersistence: () => Promise<void>
) {
  await destroyYjsPersistence(); // clears only this room's local doc
  // Keep the list entry unless the UI also chooses to remove it
}

/** List rooms for UI (most recent first) */
export async function listRooms(): Promise<RoomRow[]> {
  const rows = await roomsStore.all();
  return rows.sort((a, b) => (b.last_opened > a.last_opened ? 1 : -1));
}