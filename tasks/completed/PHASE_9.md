# Phase 9 — **AGENT TASKFILE** ("My Rooms", device-only)

---

## A. Objective → What you are building

Implement a **device-local** "My Rooms" feature with two IndexedDB maps (`rooms`, `aliases`), provisional **offline** room ids (`local-<ulid>`), **publish→alias** merge, **Extend TTL** (tiny Yjs write, throttled), **Copy link** post-publish, and safe **Delete local copy** that only clears the room's per-room IndexedDB doc. No server changes. &#x20;

**⚠️ PHASE DEPENDENCIES**: This phase has critical dependencies on other phases. See **Section C.1** for implementation timeline.

---

## B. Stop conditions (when to stop coding)

Stop when every item in **Section Q** passes locally. Do **not** modify server endpoints, WS gateway, Yjs schema beyond the tiny keep-alive field, or any phases other than Phase 9. Keep this feature **additive** and **device-only**.&#x20;

---

## C. Tooling & prerequisites (no guessing)

* **Client runtime**: existing React + TypeScript app from Phase 2+ (no new global libs required).
* **Local storage**: use **IndexedDB** directly (wrapper below) for `rooms` and `aliases`. Per-room Y.Doc persistence continues to be handled by **y-indexeddb** (unchanged).&#x20;
* **Optional**: `ulid` for readable provisional ids (`npm i ulid`), or use `crypto.randomUUID()`; spec shows `local-<ulid>` as an example (non-normative).&#x20;

**Environment**: Reuse server's `ROOM_TTL_DAYS` semantics for display, but **show expiry from metadata** (`expires_at`) when online. Views/presence **do not** extend TTL. &#x20;

### C.1 IMPLEMENTATION PHASES — CRITICAL DEPENDENCIES

**✅ CAN IMPLEMENT NOW (Phase 0-1 complete):**
- IndexedDB wrapper (`idb.ts`) — ✅ Ready
- Alias resolution logic (`alias.ts`) — ✅ Ready  
- Core store CRUD operations (`store.ts`) — ✅ Ready
- UI components structure (but cannot wire up) — ✅ Ready

**🟡 PARTIAL IMPLEMENTATION (missing Phase 2 deps):**
- Integration hooks (`integrations.ts`) — Can write interfaces, cannot connect
- UI Panel (`MyRoomsPanel.tsx`) — Can build component, cannot integrate

**❌ BLOCKED until Phase 2 completion:**
- **Router integration** — `/rooms/:id` routing needed for alias resolution
- **y-indexeddb provider** — Required for per-room document persistence  
- **Full wire-up** — Cannot connect to room pages without Phase 2 foundation
- **Offline→online publish flow** — Needs y-websocket provider from Phase 2

**❌ BLOCKED until Phase 3 completion:**
- **TTL extend functionality** (`extend-ttl.ts`) — Needs `meta` schema and Y.Doc structure
- **Undo exclusion** — Needs Y.UndoManager from Phase 3

**❌ BLOCKED until Phase 5 completion:**
- **Copy link to clipboard** — Needs Clipboard API integration from Phase 5

**RECOMMENDATION**: Implement storage layer and data structures now. Defer integration until Phase 2 complete.

---

## D. Git hygiene (run)

```bash
git checkout -b feat/phase-9-my-rooms
```

---

## E. Create file layout (exactly)

```
client/
  src/
    features/
      myrooms/
        idb.ts                # tiny IndexedDB wrapper (rooms, aliases)
        store.ts              # CRUD, throttles, alias resolution, integration API
        alias.ts              # pure helpers for alias logic
        extend-ttl.ts         # tiny Yjs write (keep-alive), undo-safe
        integrations.ts       # hooks to call from router/room page
        ui/
          MyRoomsPanel.tsx    # simple list + actions
```

All files below are **verbatim**.

---

## F. Data model (device-local only)

* Object stores:

  * `rooms`: `{ roomId: string, title: string, last_opened: string, expires_at?: string, provisional?: boolean, aliasOf?: string }` (ISO timestamps)
  * `aliases`: `{ provisionalId: string, serverId: string }` (keyed by `provisionalId`)
    These mirror the spec. **Do not** sync them to server/Yjs.&#x20;

---

## G. Non-negotiable rules (must follow)

1. **Device-only.** Do not add server fields or new endpoints; “My Rooms” lives in IndexedDB only.&#x20;
2. **Two maps only.** Exactly the `rooms` and `aliases` maps above.&#x20;
3. **Never mutate Y.Doc `guid`.** If a provisional room is published, join the server doc by its real id; do not retag the existing doc. &#x20;
4. **TTL extends only on accepted writes.** “Extend” performs a tiny Yjs write; throttle to \~24h; presence/views **never** extend TTL. &#x20;
5. **Delete local copy ≠ delete server data.** It clears that room’s **per-room IndexedDB Y.Doc** only; list removal must not clear the Y.Doc. &#x20;
6. **Share link uses server id.** After publish/merge, mint share link for the **server id** and enable **Copy link**. &#x20;
7. **Canonical UI strings.** Use exactly: “Expires in X days.”, “Room extended to ….”, “Link copied.” (and the existing header/limit strings).&#x20;

---

## H. IndexedDB wrapper

**File:** `client/src/features/myrooms/idb.ts`

```ts
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

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> {
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
```

---

## I. Alias + routing helpers

**File:** `client/src/features/myrooms/alias.ts`

```ts
import { aliasStore } from './idb';

export async function resolveAlias(id: string): Promise<string> {
  // If it's a local provisional id, try to map to server id
  if (id.startsWith('local-')) {
    const mapped = await aliasStore.get(id);
    if (mapped) return mapped;
  }
  return id;
}

// Save mapping after publish
export async function setAlias(provisionalId: string, serverId: string) {
  if (provisionalId.startsWith('local-') && provisionalId !== serverId) {
    await aliasStore.set(provisionalId, serverId);
  }
}
```

**Behavioral reference:** provisional `local-…` → join server `:id` and update alias map; visiting `/rooms/local-…` when online should resolve to `/rooms/:serverId`.&#x20;

---

## J. Extend TTL (tiny Yjs write, throttle) — ❌ BLOCKED (Phase 3)

**File:** `client/src/features/myrooms/extend-ttl.ts`

**⚠️ IMPLEMENTATION BLOCKED**: This module requires Phase 3 completion for:
- Yjs document `meta` schema definition
- Y.UndoManager setup for undo exclusion
- Established Y.Doc structure patterns

**PLACEHOLDER IMPLEMENTATION** (implement after Phase 3):

```ts
import * as Y from 'yjs';

const ONE_DAY = 24 * 60 * 60 * 1000;
const EXTEND_KEY = 'avlo:lastExtendAt'; // device-local throttle

export function canExtendNow(): boolean {
  const last = Number(localStorage.getItem(EXTEND_KEY) || '0');
  return Date.now() - last >= ONE_DAY;
}

export function markExtendedNow() {
  localStorage.setItem(EXTEND_KEY, String(Date.now()));
}

/**
 * Perform a tiny Yjs write to extend TTL. This change should be excluded from global Undo history.
 * Convention: meta.keepAliveCounter++ (or update a meta.lastExtended timestamp).
 * 
 * ⚠️ REQUIRES PHASE 3: meta schema must be defined first
 */
export function extendTtl(ydoc: Y.Doc) {
  // tiny mutation - IMPLEMENT AFTER PHASE 3 SCHEMA IS DEFINED
  const meta = ydoc.getMap('meta');
  const prev = (meta.get('keepAliveCounter') as number) || 0;
  meta.set('keepAliveCounter', prev + 1);
}
```

**Why:** TTL extends **only on accepted writes**; throttle to \~24 h; views/presence do not extend TTL. Show **"Room extended to …."** after success. (The actual toast/UI is wired in the panel below.) &#x20;

---

## K. Core store (CRUD, visits, metadata, cleanup)

**File:** `client/src/features/myrooms/store.ts`

```ts
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
  roomId: string,
  destroyYjsPersistence: () => Promise<void>
) {
  await destroyYjsPersistence(); // clears only this room’s local doc
  // Keep the list entry unless the UI also chooses to remove it
}

/** List rooms for UI (most recent first) */
export async function listRooms(): Promise<RoomRow[]> {
  const rows = await roomsStore.all();
  return rows.sort((a, b) => (b.last_opened > a.last_opened ? 1 : -1));
}
```

**Why:** mirrors spec (two maps, visit tracking, publish alias, delete-local-copy contract). Do **not** assume internal details of `y-indexeddb`; the page must provide the clearing function. &#x20;

---

## L. Router/page integrations (minimal hooks) — 🟡 PARTIAL (Phase 2)

**File:** `client/src/features/myrooms/integrations.ts`

**⚠️ PARTIAL IMPLEMENTATION**: Interface can be defined now, but integration requires Phase 2 router setup.

```ts
import { upsertVisit } from './store';

/**
 * Call this whenever the user navigates to /rooms/:id.
 * If online, provide server metadata.expires_at and a fresh title to store for display.
 * 
 * ⚠️ INTEGRATION BLOCKED: Requires React Router from Phase 2
 */
export async function recordRoomOpen(params: {
  roomId: string;
  title?: string;
  expires_at?: string; // ISO from GET /api/rooms/:id/metadata
  provisional?: boolean;
}) {
  return upsertVisit(params.roomId, {
    title: params.title,
    expires_at: params.expires_at,
    provisional: params.provisional,
  });
}
```

**Why:** Show **"Expires in X days"** from server metadata; the list persists offline and refreshes when online.&#x20;

---

## M. UI panel — 🟡 PARTIAL (Phase 2, 3, 5)

**File:** `client/src/features/myrooms/ui/MyRoomsPanel.tsx`

**⚠️ PARTIAL IMPLEMENTATION**: Component can be built now, but functionality is limited:
- ✅ Basic UI structure and list rendering
- ❌ "Open" button (needs Phase 2 router)
- ❌ "Extend" button (needs Phase 3 TTL extend)
- ❌ "Copy link" button (needs Phase 5 clipboard API)
- 🟡 "Delete local copy" (interface ready, needs y-indexeddb integration from Phase 2)

```tsx
import React, { useEffect, useState } from 'react';
import { listRooms, removeFromList, deleteLocalCopy } from '../store';

type Row = Awaited<ReturnType<typeof listRooms>>[number];

export default function MyRoomsPanel(props: {
  onOpen: (roomId: string) => void;
  onCopyLink: (roomId: string) => Promise<void>; // must use server id;
  onExtend: (roomId: string) => Promise<Date>;   // returns new expiry
  destroyYjsPersistence: (roomId: string) => Promise<void>; // per-room
}) {
  const [rows, setRows] = useState<Row[]>([]);
  async function refresh() { setRows(await listRooms()); }
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="p-3 space-y-2">
      {rows.map((r) => (
        <div key={r.roomId} className="flex items-center justify-between rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <div className="font-medium truncate">{r.title}</div>
            <div className="text-sm opacity-70">
              {r.expires_at ? `Expires in ${daysUntil(r.expires_at)} days.` : '—'}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={()=>props.onOpen(r.roomId)} className="px-2 py-1 border rounded">Open</button>
            <button onClick={async ()=>{
              await props.onCopyLink(r.roomId);
              toast('Link copied.'); // use app’s toast system
            }} className="px-2 py-1 border rounded">Copy link</button>
            <button onClick={async ()=>{
              const newExpiry = await props.onExtend(r.roomId);
              toast(`Room extended to ${newExpiry.toLocaleDateString()}.`);
              await refresh();
            }} className="px-2 py-1 border rounded">Extend</button>
            <Menu roomId={r.roomId} onAfter={refresh} destroyYjsPersistence={props.destroyYjsPersistence} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Menu(props: { roomId: string; onAfter: ()=>void; destroyYjsPersistence: (roomId: string)=>Promise<void> }) {
  return (
    <div className="relative">
      {/* replace with your menu component */}
      <details>
        <summary className="px-2 py-1 border rounded">•••</summary>
        <div className="absolute right-0 mt-1 w-48 rounded border bg-white shadow">
          <button className="block w-full text-left px-3 py-2 hover:bg-gray-100"
            onClick={async ()=>{ await removeFromList(props.roomId); toast('Removed from list'); props.onAfter(); }}>
            Remove from list
          </button>
          <button className="block w-full text-left px-3 py-2 hover:bg-gray-100"
            onClick={async ()=>{ await deleteLocalCopy(props.roomId, ()=>props.destroyYjsPersistence(props.roomId)); toast('Local copy deleted'); }}>
            Delete local copy
          </button>
        </div>
      </details>
    </div>
  );
}

function daysUntil(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24*60*60*1000)));
}

function toast(_msg: string) { /* hook into app's canonical toast system */ }
```

**Strings required:** “Expires in X days.”, “Link copied.”, “Room extended to ….” (use canonical toasts).&#x20;

---

## N. Wire-up notes (how to integrate without breaking other phases) — ❌ BLOCKED (Phase 2+)

**⚠️ ALL INTEGRATION BLOCKED** until prerequisite phases complete:

* **Room page (`/rooms/:id`)** — ❌ BLOCKED (Phase 2 routing required)

  * On mount (and when server metadata arrives), call `recordRoomOpen({ roomId, title, expires_at, provisional })`.&#x20;
  * For **Extend**: ❌ BLOCKED (Phase 3) - check throttle; call `extendTtl(ydoc)` then fetch metadata (or compute locally via `ROOM_TTL_DAYS`) and show "Room extended to ….". Presence/views **must not** extend TTL.&#x20;
  * For **Copy link**: ❌ BLOCKED (Phase 5) - ensure you resolve **server id** via alias first; never mint links for provisional ids.&#x20;
  * For **Delete local copy**: 🟡 PARTIAL (Phase 2) - expose a `destroyYjsPersistence(roomId)` that clears only **that room's** y-indexeddb data; do not clear other rooms. The panel will call it.&#x20;

* **Publishing flow (auto on reconnect or manual "Make shareable")** — ❌ BLOCKED (Phase 2)
  After server returns `serverId`: join `/rooms/:serverId`, merge, call `handlePublish(provisionalId, serverId)`, then enable Copy Link in UI. &#x20;

---

## O. UI/UX guardrails (strings & limits)

* **Limits (read-only, capacity, frame cap)** already exist; do not alter behaviors or strings here. Awareness continues while read-only.&#x20;
* **Normative strings** (must match):
  “Link copied.”, “Room extended to ….”, “Expires in X days.”.&#x20;

---

## P. Error shapes & offline

* **Metadata unavailable (offline or 404)**: keep showing the last known `expires_at` if present; otherwise show “—” (no toasts). Redis presence defines existence; 404 is valid if key expired.&#x20;
* **Create-room 429**: unrelated to Phase 9 panel, but if surfaced from your publish UI, use the canonical toast.&#x20;

---

## Q. Run & verify (local) — Acceptance checklist

**CURRENT PHASE (Can test now with Phase 0-1):**

1. **✅ Device-only persistence (storage layer)**
   * IndexedDB wrapper creates databases correctly
   * CRUD operations work for `rooms` and `aliases` stores
   * Data persists across browser reloads

**PHASE 2 REQUIREMENTS (cannot test until Phase 2 complete):**

2. **❌ Alias redirect**
   * Create `/rooms/local-…` offline; later publish. When online, visiting `/rooms/local-…` routes to `/rooms/:serverId`; list shows canonical server entry.&#x20;

3. **🟡 Delete local copy (scoped)**
   * "Delete local copy" removes **only** that room's per-room y-indexeddb; other rooms remain intact. Re-open the room → it re-syncs from server.&#x20;

**PHASE 3 REQUIREMENTS (cannot test until Phase 3 complete):**

4. **❌ Extend TTL behavior**
   * Press "Extend" → perform tiny Yjs write; show **"Room extended to …."**; throttle to \~24h (subsequent clicks within 24h no-op UI). Viewing/presence alone never changes expiry. &#x20;

**PHASE 5 REQUIREMENTS (cannot test until Phase 5 complete):**

5. **❌ Copy link post-publish**
   * After publish/merge, Copy Link is enabled; toast shows **"Link copied."**; link uses **server id**. &#x20;

**ONGOING (can test with available APIs):**

6. **🟡 Expiry display**
   * Online: panel shows **"Expires in X days."** using `expires_at` from `/api/rooms/:id/metadata`. Offline: shows last known or "—". &#x20;

---

## R. Done = merge-ready — ⚠️ PHASED COMPLETION

**PHASE 0-1 COMPLETION (Available now):**
* Storage layer acceptance checks pass (IndexedDB wrapper, CRUD operations)
* No server code changes
* Data structures and interfaces defined

**FULL FEATURE COMPLETION (Requires Phase 2+):**
* All acceptance checks in **Q** pass on Chrome/Firefox (only storage layer testable now)
* Integration with React Router, y-indexeddb, Y.Doc schema
* Canonical strings and semantics match the spec (TTL, aliasing, delete-local-copy)

---

## S. Critical implementation notes (MUST READ)

* **Strict Alias Discipline:** share links **must** use server ids; never surface `local-…` in copy-link UI.&#x20;
* **No hidden TTL bumps:** Extend **only** via the explicit button (tiny write) and throttle locally; **views/presence not allowed** to extend TTL.&#x20;
* **Undo-exclusion:** the keep-alive write (e.g., `meta.keepAliveCounter++`) is considered a system tick and should not clutter user undo history. (Spec: exclude extend writes from Undo.)&#x20;
* **Per-room cleanup contract:** The panel **asks** the room page to clear its y-indexeddb instance (don’t guess DB names). This keeps Phase 9 isolated and respects the persistence layer.&#x20;

---

**End of AGENT TASKFILE (Phase 9).**
