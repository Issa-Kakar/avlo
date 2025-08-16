// Minimal IndexedDB wrapper (no external deps)
const DB_NAME = 'avlo-myrooms';
const DB_VERSION = 1;
const ROOMS = 'rooms';
const ALIASES = 'aliases';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROOMS)) {
        const s = db.createObjectStore(ROOMS, { keyPath: 'roomId' });
        s.createIndex('last_opened', 'last_opened');
      }
      if (!db.objectStoreNames.contains(ALIASES)) {
        db.createObjectStore(ALIASES, { keyPath: 'provisionalId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: 'readonly' | 'readwrite', fn: (s: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    fn(s).then((val) => { t.oncomplete = () => resolve(val); }).catch(reject);
    t.onerror = () => reject(t.error);
  });
}

export type RoomRow = {
  roomId: string;
  title: string;
  last_opened: string; // ISO string
  expires_at?: string; // ISO
  provisional?: boolean;
  aliasOf?: string;
};

export const roomsStore = {
  async get(roomId: string): Promise<RoomRow | undefined> {
    return tx(ROOMS, 'readonly', (s) => new Promise((res, rej) => {
      const r = s.get(roomId); r.onsuccess = () => res(r.result || undefined); r.onerror = () => rej(r.error);
    }));
  },
  async put(row: RoomRow) {
    return tx(ROOMS, 'readwrite', (s) => new Promise<void>((res, rej) => {
      const r = s.put(row); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    }));
  },
  async all(): Promise<RoomRow[]> {
    return tx(ROOMS, 'readonly', (s) => new Promise((res, rej) => {
      const r = s.getAll(); r.onsuccess = () => res(r.result as RoomRow[]); r.onerror = () => rej(r.error);
    }));
  },
  async del(roomId: string) {
    return tx(ROOMS, 'readwrite', (s) => new Promise<void>((res, rej) => {
      const r = s.delete(roomId); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    }));
  },
};

export const aliasStore = {
  async get(provisionalId: string): Promise<string | undefined> {
    return tx(ALIASES, 'readonly', (s) => new Promise((res, rej) => {
      const r = s.get(provisionalId); r.onsuccess = () => res(r.result?.serverId); r.onerror = () => rej(r.error);
    }));
  },
  async set(provisionalId: string, serverId: string) {
    return tx(ALIASES, 'readwrite', (s) => new Promise<void>((res, rej) => {
      const r = s.put({ provisionalId, serverId }); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    }));
  },
  async del(provisionalId: string) {
    return tx(ALIASES, 'readwrite', (s) => new Promise<void>((res, rej) => {
      const r = s.delete(provisionalId); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    }));
  },
};