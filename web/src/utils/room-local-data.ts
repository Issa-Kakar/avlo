/**
 * Per-room local persistence cleanup. Each room's Y.Doc persists in its own IndexedDB
 * database (`avlo.v1.rooms.<roomId>`, opened by y-indexeddb in `room-doc-manager.ts`);
 * these helpers delete those DBs when access is revoked (4403 / privatized rooms) or on
 * sign-out. Deletion requests are fire-and-forget — a blocked delete (open connection)
 * just pends, which is why callers must skip the active room.
 */

/** The y-indexeddb database-name prefix — the single source for the template
 *  `room-doc-manager.ts` opens with. */
export const ROOM_DOC_DB_PREFIX = 'avlo.v1.rooms.';

/** Delete one room's Y.Doc database. Fire-and-forget. */
export function deleteRoomDocDB(roomId: string): void {
  indexedDB.deleteDatabase(ROOM_DOC_DB_PREFIX + roomId);
}

/**
 * Delete EVERY room doc DB — the sign-out purge (pre-mount only, so no y-indexeddb
 * connection is open to block a delete). Union of `indexedDB.databases()` (not
 * universal — Firefox lacks it) and the caller's known ids, so rooms whose facts
 * were already dropped still get swept where enumeration is available.
 */
export async function purgeAllRoomDocDBs(knownIds: readonly string[]): Promise<void> {
  const names = new Set(knownIds.map((id) => ROOM_DOC_DB_PREFIX + id));
  if (typeof indexedDB.databases === 'function') {
    try {
      for (const db of await indexedDB.databases()) {
        if (db.name?.startsWith(ROOM_DOC_DB_PREFIX)) names.add(db.name);
      }
    } catch {
      // enumeration failed — the known ids still cover every facts-listed room
    }
  }
  for (const name of names) indexedDB.deleteDatabase(name);
}
