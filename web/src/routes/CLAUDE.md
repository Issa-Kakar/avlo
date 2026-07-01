# Routing (`routes/` — TanStack Router)

File-based, auto code-split; the tree is generated (`routeTree.gen.ts`) and wired in `router.ts`. Only two things here matter to code outside this folder: **how a component reads `roomId`**, and **how the room lifecycle (`connectRoom`/`disconnectRoom`) is driven by the route**. Everything about identity/cache boot ordering lives in `query/CLAUDE.md`; the imperative room getters (`getHandle`, `transact`, …) live in the root's *Room Runtime* section.

## Route tree

| Route | File | Role |
|-------|------|------|
| `__root` | `__root.tsx` | Supplies `context.queryClient` to every loader + wraps a plain `QueryClientProvider`. `beforeLoad` warms `/me` (`void ensureIdentity()` — non-blocking, no-op while fresh). |
| `/` | `index.tsx` | `beforeLoad` throws `redirect({ to: '/home' })`. |
| `/home` | `home.tsx` | Dashboard. Loader is fully non-blocking (`void prefetchQuery(roomsQueryOptions())`); **no `beforeLoad`** so the logo can intent-preload it safely. |
| `/room/$roomId` | `room.$roomId.tsx` | The canvas. `beforeLoad` drives the room lifecycle (below). |

## Reading `roomId` in a component

```ts
const route = getRouteApi('/room/$roomId');
// inside the component:
const { roomId } = route.useParams();
```

`getRouteApi('/room/$roomId')` is created at module scope (see `RoomPage`, `RoomTitle`, `ShareModal`); `useParams()` is the only supported way to get the active `roomId` in room-scoped UI. `roomId` from params is validate-only — pass it through `normalizeRoomId(...)` before using it as a `RoomId` off the router (e.g. the `disconnectRoom` guard).

## Room lifecycle (the load-bearing wiring)

- **Enter** — `/room/$roomId` `beforeLoad`: `normalizeRoomId` (validate; redirect to `/home` if bad) → `await ensureIdentity()` (a signed cookie + `userId` MUST exist before connect — `RoomDocManagerImpl`'s ctor reads `getUserId()` synchronously and throws if unresolved) → **`connectRoom(roomId)`** → seed session-store `title`/`isOwner`/`permission` from the rooms cache + facts (skipped on a same-room re-nav so WS truth isn't clobbered) → `recordVisit(roomId)` (AFTER connect, so the still-mounted dashboard doesn't flash a re-sort on the way out).
- **Leave** — `RoomPage`'s cleanup effect calls **`disconnectRoom(normalizeRoomId(roomId) ?? undefined)`** on unmount. `<RoomCanvas key={roomId}>` forces a full remount (fresh canvas + runtime) on a room→room switch.
- **Contract** (`runtime/room-runtime.ts`): one active room at a time; `connectRoom` is idempotent (same id = no-op) and auto-disconnects the previous room's Y.Doc first; `disconnectRoom`'s id guard prevents a stale unmount from tearing down a newer room. Don't call either outside this route wiring.

## Invariant: room preload is forbidden

`connectRoom` is **destructive** — it destroys the active room's Y.Doc and opens a fresh IndexedDB + WebSocket provider. Route intent-preloading runs `beforeLoad`, so preloading `/room/$roomId` would fire that on mere hover. Hence `router.ts` sets `defaultPreload: false` and preload is opt-in **per `<Link>`** — only ever enable it for side-effect-free routes (today just `/home`). A `defaultPreloadStaleTime` reuse means even an `if (!preload)` guard wouldn't save you; keep room links un-preloaded.
