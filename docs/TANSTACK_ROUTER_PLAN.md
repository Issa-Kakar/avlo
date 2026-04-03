# TanStack Router Migration & Room Lifecycle Redesign

Final architecture for room connection lifecycle, routing, code splitting, and component loading. Replaces react-router-dom, kills the registry/provider/ref-counting pattern, moves RoomDocManager construction to route level.

---

## Table of Contents

1. [Core Design Decisions](#core-design-decisions)
2. [loader vs beforeLoad — Why beforeLoad](#loader-vs-beforeload)
3. [Loading Model — Y.js vs HTTP Apps](#loading-model)
4. [File-Based Routing + Vite Plugin + Code Splitting](#file-based-routing--vite-plugin--code-splitting)
5. [Architecture Overview](#architecture-overview)
6. [Router Events](#router-events)
7. [File Changes](#file-changes)
8. [Deleted Files](#deleted-files)
9. [Package & Config Changes](#package--config-changes)
10. [Migration Checklist](#migration-checklist)

---

## Core Design Decisions

### 1. Route owns data lifecycle, component owns DOM lifecycle

Room connection happens in `beforeLoad` — before any component renders. Cleanup happens in component `useEffect` as a safety net, but the primary teardown path is `connectRoom()` disconnecting the previous room when a new one starts.

### 2. Module singleton over route context

`room-runtime.ts` remains the single source of truth. Tools, render loops, event handlers all call `getActiveRoomDoc()` imperatively. Route context would create a second access path for the same data — unnecessary indirection. `loader` data (`useLoaderData`) is only used for things React components need directly.

### 3. Key-based remount for room transitions

`<RoomCanvas key={roomId} />` forces full unmount/remount of Canvas + all UI when roomId changes. Eliminates stale subscriptions, avoids re-subscription logic, lets hooks use empty deps `[]`.

### 4. File-based routing with Vite plugin for automatic code splitting

Three route files, auto-generated route tree, automatic lazy-loading per route. The room chunk (Y.js + CodeMirror + Tiptap + Canvas + tools) only downloads when navigating to a room.

### 5. No StrictMode

Canvas + Y.js providers are incompatible with double-mount. Not used, won't change.

---

## loader vs beforeLoad

TanStack Router has two route-level hooks that run before a component renders. They have fundamentally different execution models:

```
Navigation starts
  ↓
beforeLoad (parent) → beforeLoad (child)     ← SEQUENTIAL, blocks everything
  ↓
loader (parent) + loader (child)             ← PARALLEL, start simultaneously
  ↓
Component renders
```

### beforeLoad: Sequential guards + context

- Runs parent-first, child-second — **serial**
- Blocks ALL loaders from starting until every `beforeLoad` in the chain resolves
- Return value merges into **route context** — available to child routes via `context` param
- Accessed in components via `Route.useRouteContext()`
- Purpose: auth checks, redirects, infrastructure setup, building shared context

### loader: Parallel data fetching

- ALL matched route loaders fire **simultaneously** once beforeLoad chain completes
- Parent and child loaders run in parallel — no waterfall
- Return value is **route-scoped data** — only available to that route's component
- Accessed in components via `Route.useLoaderData()`
- Purpose: fetching data that a specific route needs to render
- Supports **deferred/streaming**: return unawaited promises → render with Suspense

### Why room connection uses beforeLoad, not loader

Room connection is **infrastructure**, not data:

```typescript
beforeLoad: ({ params }) => {
  // Creates Y.Doc, starts IDB + WS providers, sets module singleton.
  // Tools, render loops, and Canvas all need this BEFORE they mount.
  // This is a guard — "ensure room exists" — not a data fetch.
  connectRoom(params.roomId);
};
```

If this were in `loader`:

- It would run in parallel with other loaders — fine, but there are no other loaders to parallelize with
- The return value would need to go through `useLoaderData()` — but tools/render loops can't call React hooks
- The module singleton pattern (`getActiveRoomDoc()`) works regardless of where we call `connectRoom` — `beforeLoad` just guarantees it happens first

**Rule of thumb:** `beforeLoad` for things that must exist before anything renders. `loader` for data that a specific component needs to display.

### Where loader WOULD be useful (future)

If we later need data from an HTTP API before the room page renders:

```typescript
// room.$roomId.tsx
export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: ({ params }) => {
    connectRoom(params.roomId); // Infrastructure — must be first
  },
  loader: async ({ params }) => {
    // These run IN PARALLEL after beforeLoad completes:
    const [roomMeta, userPrefs] = await Promise.all([
      fetchRoomMetadata(params.roomId), // Room name, permissions, etc.
      fetchUserPreferences(params.roomId), // User's settings for this room
    ]);
    return { roomMeta, userPrefs };
  },
  pendingComponent: RoomSkeleton, // Shows while loader runs
  component: RoomPage,
});

// In component:
function RoomPage() {
  const { roomMeta, userPrefs } = Route.useLoaderData();
  // ...
}
```

Currently there's no HTTP data to fetch before rendering, so `loader` is unused. The slot exists when we need it.

---

## Loading Model

### Y.js apps vs HTTP apps — fundamentally different

TanStack Router's `loader`, `pendingComponent`, `Suspense`, and deferred data patterns are designed for the HTTP fetch-then-render model:

```
HTTP app:  fetch data → receive response → render with data
Y.js app:  render empty → IDB syncs (~50ms) → WS syncs → observers push updates
```

In this app, every component renders immediately with empty/default state. Data arrives via Y.Doc observers — not HTTP responses. There's no Promise to await, no Suspense boundary to trigger, no pending state to show.

### What each component actually depends on

| Component             | Data source                             | Available when                 | Loading pattern                       |
| --------------------- | --------------------------------------- | ------------------------------ | ------------------------------------- |
| **TopBar**            | Nothing (static)                        | Instantly                      | Renders immediately                   |
| **ToolPanel**         | `device-ui-store` (Zustand, persisted)  | Instantly (localStorage)       | Renders immediately                   |
| **ZoomControls**      | `camera-store` (Zustand)                | Instantly (default state)      | Renders immediately                   |
| **Canvas**            | `getActiveRoomDoc()` (module singleton) | After `beforeLoad`             | Renders empty, populates via observer |
| **UserAvatarCluster** | `usePresence()` → awareness             | After WS connects (~100-500ms) | Renders empty, populates via observer |

None of these need a `loader`. None benefit from `pendingComponent` or Suspense. They all render instantly and update reactively.

### Where the real loading optimization is: code splitting

The room route is heavy:

- Y.js + y-indexeddb + y-partyserver: ~80KB
- CodeMirror: ~120KB
- Tiptap: ~90KB
- Canvas runtime + tools + renderers: ~60KB
- Total room chunk: **~350KB+ gzipped**

With code splitting, this chunk only downloads when navigating to `/room/$roomId`. Any future pages (landing, auth, settings) load instantly without room code.

### Viewport persistence (per-room camera state)

The user plans to persist viewport keyed by roomId. This is a **store concern**, not a route loader concern:

```typescript
// camera-store.ts — Zustand with per-room persistence
// On room connect: load viewport from localStorage/IDB keyed by roomId
// On viewport change: persist to localStorage/IDB keyed by roomId
// Synchronous read from localStorage — no async needed
```

This happens inside `connectRoom()` or as a camera-store side effect of room change. No `loader` needed — localStorage reads are synchronous, IDB reads complete during the ~50ms IDB sync window.

---

## File-Based Routing + Vite Plugin + Code Splitting

### Why file-based routing

Even with only 2-3 routes, file-based routing gives us:

1. **Automatic code splitting** via the Vite plugin — each route file becomes its own chunk
2. **Generated route tree** — type-safe, no manual `createRoute` boilerplate
3. **Convention over configuration** — route structure is visible in the file system
4. **Automatic lazy loading** — `autoCodeSplitting: true` wraps components + loaders in `lazy()` automatically

### Route file structure

```
client/src/routes/
  __root.tsx              # Root layout — just <Outlet />
  index.tsx               # / → redirect to /room/dev
  room.$roomId.tsx        # /room/$roomId → room page (heavy chunk, lazy-loaded)
```

Three files. The Vite plugin generates `client/src/routeTree.gen.ts` automatically.

### How auto code splitting works

With `autoCodeSplitting: true`, the Vite plugin transforms:

```typescript
// What you write in room.$roomId.tsx:
export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: ({ params }) => {
    connectRoom(params.roomId);
  },
  component: RoomPage,
});
```

Into (conceptually):

```typescript
// What the plugin generates:
export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: ({ params }) => {
    connectRoom(params.roomId);
  },
  component: lazy(() => import('./room.$roomId').then((m) => m.RoomPage)),
});
```

Vite sees the dynamic `import()` and creates a separate chunk for the room page component and everything it imports. The route's `beforeLoad` stays in the main bundle (it's lightweight — just calls `connectRoom`). The heavy component tree (Canvas, tools, CodeMirror, Tiptap) loads on demand.

**Important note on `beforeLoad` and code splitting:** `beforeLoad` is NOT code-split — it stays in the critical route definition. This is correct for us: `connectRoom` should start IDB/WS providers immediately on navigation, not wait for a chunk to download. The room is connecting while the component chunk downloads in parallel.

```
User clicks /room/foo
  ↓ (parallel)
  ├─ beforeLoad: connectRoom('foo')     ← runs immediately (in main bundle)
  │    └─ IDB provider starts syncing
  │    └─ WS provider starts connecting
  └─ Vite downloads room chunk          ← component code downloads
  ↓ (both complete)
  Component renders with data already arriving from IDB
```

This is optimal: infrastructure starts immediately, component code loads in parallel.

### Code splitting vs the Service Worker cache

The app's SW (`sw.ts`) uses **runtime caching** — cache-first for `/assets/*`, but only for assets that have been previously fetched. There is NO precache manifest that pre-downloads all chunks on install. The SW does NOT "install everything on disk":

```
First visit (cold, SW not yet installed):
  Browser downloads main bundle → parses → router matches
  → beforeLoad runs → room chunk requested → downloads from network
  → SW installs in background via skipWaiting/claim
  → Both chunks now cached in avlo-shell-v1 for future visits

Returning visit (SW active):
  Main bundle → served from SW cache (~1ms)
  Room chunk → served from SW cache (~1ms)
  Parse/compile still happens for each chunk
```

Code splitting genuinely reduces first-visit download size. But since every route currently IS a room route, the room chunk always downloads immediately after the main bundle. The practical benefit today is:

1. **Smaller main bundle** → faster parse before room chunk even loads
2. **Parallel download + connect** → room chunk downloads while `connectRoom` starts IDB/WS
3. **Architectural** → clean route boundaries, each route is self-contained

The bigger payoff comes when non-room routes exist (landing page, auth, settings). Those pages load without downloading room code at all. The architecture is ready for that — no changes needed, just add route files.

### Vite plugin configuration

```typescript
// client/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'path';

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  // ... rest unchanged
});
```

The plugin:

- Watches `src/routes/` for file changes (dev mode)
- Generates `src/routeTree.gen.ts` with typed route tree
- Transforms route files for code splitting at build time
- Zero runtime cost — all work happens at build time

### Generated route tree

The plugin generates `client/src/routeTree.gen.ts` — **do not edit manually**. It contains the route tree structure, type declarations for type-safe params/context/loader data, and module augmentation for the `Register` interface.

**Commit this file to git.** Despite being generated, `routeTree.gen.ts` is essential to the app's runtime — `router.ts` imports it directly. It must exist for type checking, CI builds, and for other developers to work without running the dev server first. The Vite plugin regenerates it automatically when route files change in dev mode, but the checked-in version ensures the app works from a clean clone.

---

## Architecture Overview

```
main.tsx
  └─ RouterProvider(router)

router.ts
  └─ createRouter({ routeTree })  ← from generated routeTree.gen.ts

routes/
  __root.tsx              → <Outlet /> (minimal)
  index.tsx               → redirect to /room/dev
  room.$roomId.tsx        → beforeLoad: connectRoom(roomId)
                            component: RoomPage  [CODE-SPLIT CHUNK]

RoomPage (route component)
  ├─ useEffect cleanup: disconnectRoom(roomId)
  ├─ ErrorBoundary
  ├─ ToastProvider
  └─ RoomCanvas key={roomId}
        ├─ Canvas          (pure DOM + CanvasRuntime, zero room knowledge)
        ├─ TopBar           (static, no deps)
        ├─ UserAvatarCluster  (reads from module singleton via usePresence())
        ├─ ToolPanel        (reads from device-ui-store)
        └─ ZoomControls     (reads from camera-store)
```

### Navigation Sequence: `/room/A` → `/room/B`

```
1. Router matches /room/B
2. beforeLoad runs → connectRoom('B')
     → detects activeRoom is 'A'
     → calls disconnectRoom() internally (destroys A)
     → creates RoomDocManagerImpl('B')
     → sets module singleton to B
     → IDB + WS providers start connecting in background
3. Component chunk already cached (same route, different params) → no download
4. React re-renders RoomPage (same route, new params)
5. key={roomId} changed → RoomCanvas unmounts (key=A) and remounts (key=B)
6. Old Canvas cleanup: runtime.stop() — unsubscribes from destroyed A (no-ops)
7. Old useEffect cleanup: disconnectRoom('A') — no-op (activeRoom is B)
8. New Canvas mounts: new CanvasRuntime().start() — subscribes to B via getActiveRoomDoc()
9. New useEffect: registers cleanup for disconnectRoom('B')
```

### First Visit to `/room/foo` (cold)

```
1. Router matches /room/foo
2. beforeLoad runs → connectRoom('foo')
     → RoomDocManagerImpl created
     → IDB starts syncing (~50ms)
     → WS starts connecting (~100-500ms)
3. Vite downloads room chunk (first visit — not cached yet)
     → Runs in PARALLEL with step 2
4. Chunk loaded → RoomPage renders
     → Canvas mounts empty (white canvas)
     → IDB sync completes → observer fires → snapshot published → canvas renders local data
     → WS connects → synced → canvas updated with remote data
```

### Navigation Away (leaving all room routes)

```
1. RoomPage unmounts
2. useEffect cleanup: disconnectRoom(roomId) — destroys active room
3. Canvas cleanup: runtime.stop()
```

---

## Router Events

TanStack Router exposes lifecycle events on the router instance. Available events:

| Event                | When                            | Use case                             |
| -------------------- | ------------------------------- | ------------------------------------ |
| `onBeforeNavigate`   | User initiates navigation       | Progress bar start, analytics        |
| `onBeforeLoad`       | After beforeLoad, before loader | —                                    |
| `onLoad`             | All loaders resolved            | —                                    |
| `onResolved`         | Ready to render                 | Progress bar end, page view tracking |
| `onBeforeRouteMount` | Before component mounts         | —                                    |

### Useful patterns

```typescript
// router.ts — after createRouter()

// Progress bar (NProgress, topbar, etc.)
router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
  if (pathChanged) NProgress.start();
});
router.subscribe('onResolved', () => {
  NProgress.done();
});

// Analytics
router.subscribe('onResolved', ({ toLocation }) => {
  analytics.pageView(toLocation.pathname);
});
```

### NOT for room lifecycle

Router events should **not** manage room connection/disconnection. The `beforeLoad` + component cleanup pattern is more reliable — it's tied to the specific route match, not global navigation events. Router events are for cross-cutting concerns (progress bars, analytics, logging).

---

## File Changes

### New Files

#### `client/src/routes/__root.tsx`

```typescript
import { createRootRoute, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: () => <Outlet />,
});
```

Minimal root. No providers wrapping — ToastProvider lives inside RoomPage (scoped to room).

#### `client/src/routes/index.tsx`

```typescript
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/room/$roomId', params: { roomId: 'dev' } });
  },
});
```

#### `client/src/routes/room.$roomId.tsx`

```typescript
import { createFileRoute } from '@tanstack/react-router';
import { connectRoom } from '@/canvas/room-runtime';
import RoomPage from '@/components/RoomPage';

export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: ({ params }) => {
    connectRoom(params.roomId);
  },
  component: RoomPage,
});
```

`beforeLoad` stays in the main bundle (fast, runs immediately). `RoomPage` and its entire import tree are code-split into a separate chunk by the Vite plugin.

#### `client/src/router.ts`

```typescript
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: () => {
    // Redirect unknown routes to default room
    window.location.href = '/room/dev';
    return null;
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
```

Lean — imports the auto-generated route tree, creates router, registers types. No manual route definitions.

---

### Modified Files

#### `client/src/main.tsx`

```typescript
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import './index.css';
import { ensureFontsLoaded } from './lib/text/font-loader';
import { resetFontMetrics } from './lib/text/text-system';

async function init() {
  try {
    await ensureFontsLoaded();
    resetFontMetrics();
  } catch (error) {
    console.error('[init] Font loading failed:', error);
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <RouterProvider router={router} />,
  );
}

init();
```

Removes: `BrowserRouter`, `App` component import.

#### `client/src/canvas/room-runtime.ts`

Add `connectRoom()` / `disconnectRoom()`. Remove `setActiveRoom()`. All existing getters unchanged.

```typescript
import type { RoomId } from '@avlo/shared';
import type { Snapshot } from '@/types/snapshot';
import type { PresenceView } from '@/types/awareness';
import { RoomDocManagerImpl, type IRoomDocManager } from '@/lib/room-doc-manager';

interface RoomContext {
  roomId: RoomId;
  roomDoc: IRoomDocManager;
}

let activeRoom: RoomContext | null = null;

/**
 * Connect to a room. Idempotent — returns existing if same roomId.
 * Disconnects previous room if switching.
 */
export function connectRoom(roomId: RoomId): IRoomDocManager {
  if (activeRoom?.roomId === roomId) return activeRoom.roomDoc;
  if (activeRoom) disconnectRoom();

  const roomDoc = new RoomDocManagerImpl(roomId);
  activeRoom = { roomId, roomDoc };
  return roomDoc;
}

/**
 * Disconnect from the active room. Idempotent.
 * Optional roomId guard prevents stale cleanup from destroying a newer room.
 */
export function disconnectRoom(roomId?: RoomId): void {
  if (!activeRoom) return;
  if (roomId && activeRoom.roomId !== roomId) return;
  activeRoom.roomDoc.destroy();
  activeRoom = null;
}

// --- Existing getters (unchanged) ---

export function getActiveRoom(): RoomContext {
  if (!activeRoom) {
    throw new Error('getActiveRoom(): no active room');
  }
  return activeRoom;
}

export function getActiveRoomDoc(): IRoomDocManager {
  return getActiveRoom().roomDoc;
}

export function getActiveRoomId(): RoomId {
  return getActiveRoom().roomId;
}

export function hasActiveRoom(): boolean {
  return activeRoom !== null;
}

export function getCurrentSnapshot(): Snapshot {
  return getActiveRoomDoc().currentSnapshot;
}

export function getCurrentPresence(): PresenceView {
  return getActiveRoomDoc().currentPresence;
}

export function updatePresenceCursor(worldX: number, worldY: number): void {
  getActiveRoomDoc().updateCursor(worldX, worldY);
}

export function clearPresenceCursor(): void {
  getActiveRoomDoc().updateCursor(undefined, undefined);
}

export function getObjects(): ReturnType<typeof getActiveRoomDoc>['objects'] {
  return getActiveRoomDoc().objects;
}

export { getConnectorsForShape, hasConnectorLookup } from '../lib/connectors';
```

What changed:

- `setActiveRoom()` removed — replaced by `connectRoom()`/`disconnectRoom()`
- `connectRoom()` constructs `RoomDocManagerImpl` directly (no registry)
- `disconnectRoom()` takes optional `roomId` guard for safe stale cleanup
- Import of `RoomDocManagerImpl` added (was only in registry before)

#### `client/src/components/RoomPage.tsx`

```typescript
import { useEffect } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { ErrorBoundary } from './ErrorBoundary';
import { Canvas } from '../canvas/Canvas';
import { TopBar } from './TopBar';
import { ToolPanel } from './ToolPanel';
import { ZoomControls } from './ZoomControls';
import { UserAvatarCluster } from './UserAvatarCluster';
import { ToastProvider, useToast } from './Toast';
import { disconnectRoom } from '../canvas/room-runtime';
import './RoomPage.css';

const route = getRouteApi('/room/$roomId');

function RoomCanvas() {
  const { showToast } = useToast();

  const handleInvite = async () => {
    try {
      await navigator.clipboard?.writeText(window.location.href);
      showToast('Link copied to clipboard!');
    } catch {
      showToast('Failed to copy link');
    }
  };

  return (
    <div className="app-container">
      <div className="workspace">
        <div className="canvas-container">
          <div className="canvas-grid" />
          <Canvas className="canvas" />
          <TopBar />
          <div className="micro-cluster-right">
            <UserAvatarCluster />
            <button className="micro micro-invite" onClick={handleInvite} title="Copy invite link">
              Invite
            </button>
          </div>
          <ToolPanel />
          <ZoomControls />
        </div>
      </div>
    </div>
  );
}

export default function RoomPage() {
  const { roomId } = route.useParams();

  useEffect(() => {
    return () => disconnectRoom(roomId);
  }, [roomId]);

  return (
    <ErrorBoundary>
      <ToastProvider>
        <RoomCanvas key={roomId} />
      </ToastProvider>
    </ErrorBoundary>
  );
}
```

What changed:

- `getRouteApi('/room/$roomId')` for type-safe params (no generic needed)
- `roomId` no longer passed as prop to Canvas or UserAvatarCluster
- `key={roomId}` on RoomCanvas forces full remount on room switch
- `useEffect` cleanup calls `disconnectRoom(roomId)` with guard
- No `roomId` validation needed — TanStack Router guarantees `$roomId` matches

#### `client/src/canvas/Canvas.tsx`

```typescript
import React, { useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { CanvasRuntime } from './CanvasRuntime';
import { contextMenuController } from './ContextMenuController';
import { ContextMenu } from '@/components/context-menu/ContextMenu';

export interface CanvasProps {
  className?: string;
}

/**
 * Canvas - Thin React wrapper for CanvasRuntime.
 *
 * Pure DOM lifecycle — mounts elements, creates/destroys runtime.
 * Zero room knowledge. CanvasRuntime reads room state from module singletons.
 */
export const Canvas: React.FC<CanvasProps> = ({ className }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const editorHost = editorHostRef.current;
    if (!container || !baseCanvas || !overlayCanvas || !editorHost) return;

    const runtime = new CanvasRuntime();
    runtime.start({ container, baseCanvas, overlayCanvas, editorHost });
    return () => runtime.stop();
  }, []);

  useLayoutEffect(() => {
    const el = document.getElementById('context-menu-portal');
    if (el) contextMenuController.init(el);
    return () => contextMenuController.destroy();
  }, []);

  return (
    <>
      <div
        ref={containerRef}
        className="relative w-full h-full overflow-hidden"
        style={{ backgroundColor: '#FFFFFF' }}
      >
        <canvas
          ref={baseCanvasRef}
          className={className}
          style={{
            position: 'absolute', inset: 0, zIndex: 1,
            display: 'block', width: '100%', height: '100%',
            touchAction: 'none', backgroundColor: '#f8f9fa',
          }}
        />
        <canvas
          ref={overlayCanvasRef}
          style={{
            position: 'absolute', inset: 0, zIndex: 2,
            display: 'block', width: '100%', height: '100%',
            pointerEvents: 'none',
          }}
        />
        <div
          ref={editorHostRef}
          className="dom-overlay-root"
          style={{
            position: 'absolute', inset: 0, zIndex: 3,
            pointerEvents: 'none',
          }}
        />
      </div>
      {createPortal(<ContextMenu />, document.getElementById('context-menu-portal')!)}
    </>
  );
};
```

What changed:

- Removed `roomId` prop and `RoomId` import
- Removed `useRoomDoc(roomId)` call
- Removed `setActiveRoom()` useLayoutEffect — `connectRoom()` in `beforeLoad` already did this
- Canvas is now zero-room-awareness — pure DOM + CanvasRuntime lifecycle

#### `client/src/hooks/use-presence.ts`

```typescript
import { useEffect, useState } from 'react';
import type { PresenceView } from '@/types/awareness';
import { getActiveRoomDoc } from '@/canvas/room-runtime';

/**
 * Subscribe to presence updates from the active room.
 * Must be rendered inside a keyed subtree that remounts on room change.
 */
export function usePresence(): PresenceView {
  const [presence, setPresence] = useState<PresenceView>(() => getActiveRoomDoc().currentPresence);

  useEffect(() => {
    return getActiveRoomDoc().subscribePresence(setPresence);
  }, []);

  return presence;
}
```

What changed:

- Removed `roomId` param — reads from module singleton
- Removed `useRoomDoc` import and call
- Empty deps `[]` — safe because parent remounts via `key={roomId}`

#### `client/src/components/UserAvatarCluster.tsx`

Remove `roomId` prop and interface. `usePresence()` called without args:

```typescript
import { useMemo } from 'react';
import { usePresence } from '@/hooks/use-presence';

export function UserAvatarCluster() {
  const presence = usePresence();
  // ... rest unchanged
```

---

## Deleted Files

| File                                           | Reason                                                          |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `client/src/App.tsx`                           | Routes moved to `routes/`, no registry provider needed          |
| `client/src/lib/room-doc-registry.ts`          | Registry class — replaced by `connectRoom()`/`disconnectRoom()` |
| `client/src/lib/room-doc-registry-context.tsx` | React context provider — no longer needed                       |
| `client/src/hooks/use-room-doc.ts`             | Registry-based hook — no longer needed                          |
| `client/src/hooks/use-snapshot.ts`             | Zero consumers                                                  |

---

## Package & Config Changes

### Dependencies

```bash
# From client/ directory:
npm uninstall react-router-dom
npm install @tanstack/react-router
npm install -D @tanstack/router-plugin
```

### Vite config

```typescript
// client/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'path';

const clientPort = parseInt(process.env.VITE_PORT || '3000', 10);
const workerPort = parseInt(process.env.WORKER_PORT || '8787', 10);

const proxyConfig = {
  '/parties': {
    target: `ws://localhost:${workerPort}`,
    ws: true,
    changeOrigin: true,
  },
  '/parties/*': {
    target: `http://localhost:${workerPort}`,
    changeOrigin: true,
  },
  '/api': {
    target: `http://localhost:${workerPort}`,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src'),
    },
  },
  server: {
    port: clientPort,
    proxy: proxyConfig,
  },
  preview: {
    port: clientPort,
    proxy: proxyConfig,
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        sw: path.resolve(__dirname, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
```

`TanStackRouterVite` MUST be listed before `react()` in the plugins array — it needs to transform route files before React processes JSX.

### tsconfig.json

No changes needed — `"moduleResolution": "bundler"` is already set, which TanStack Router requires.

---

## What Stays Unchanged

- **RoomDocManagerImpl** — class, constructor, interface, all internals untouched
- **CanvasRuntime** — reads from `getActiveRoomDoc()` as before
- **tool-registry.ts** — tools still self-construct as module-level singletons
- **All tools** — still call `getActiveRoomDoc()`, `getCurrentSnapshot()`, etc.
- **All stores** — camera-store, device-ui-store, selection-store unchanged
- **All render loops** — RenderLoop, OverlayRenderLoop unchanged
- **Imperative access pattern** — `getActiveRoomDoc()`, `getCurrentSnapshot()`, `getObjects()` all unchanged

The ONLY thing that changes is WHO creates/destroys the RoomDocManager, WHEN, and how routes are defined. Everything downstream is untouched.

---

## Test Impact

Grep for imports from deleted files:

- `room-doc-registry` — tests that create managers should use `new RoomDocManagerImpl()` directly
- `room-doc-registry-context` — tests that render with providers should use `RouterProvider` or render without routing
- `use-room-doc` — test components should mock `getActiveRoomDoc()` or call `connectRoom()` in test setup

The `RoomDocManagerImpl` constructor and `IRoomDocManager` interface are unchanged — test code that creates managers directly needs zero changes.

---

## Migration Checklist

1. `npm install @tanstack/react-router @tanstack/router-plugin` (in client/), `npm uninstall react-router-dom`
2. Update `vite.config.ts` — add `TanStackRouterVite` plugin (before react())
3. Create `client/src/routes/__root.tsx`, `index.tsx`, `room.$roomId.tsx`
4. Create `client/src/router.ts` importing generated route tree
5. Rewrite `client/src/main.tsx` — `RouterProvider` instead of `BrowserRouter` + `App`
6. Add `connectRoom()`/`disconnectRoom()` to `room-runtime.ts`, remove `setActiveRoom()`
7. Rewrite `RoomPage.tsx` — TanStack params, `key={roomId}`, cleanup effect
8. Simplify `Canvas.tsx` — remove room lifecycle, keep DOM + runtime only
9. Simplify `use-presence.ts` — remove roomId param
10. Simplify `UserAvatarCluster.tsx` — remove roomId prop
11. Delete: `App.tsx`, `room-doc-registry.ts`, `room-doc-registry-context.tsx`, `use-room-doc.ts`, `use-snapshot.ts`
12. Run `npm run typecheck` from root — fix any remaining imports
13. Commit `routeTree.gen.ts` (generated but required at runtime — not gitignored)
14. Verify dev server loads correctly, room connects, canvas renders
15. Check code splitting: run `npm run build`, verify room chunk is separate in `dist/assets/`

---

## Why This Is Final

This architecture has minimal moving parts:

- **One function** creates a room (`connectRoom`)
- **One function** destroys a room (`disconnectRoom`)
- **One module** stores the active room (`room-runtime.ts`)
- **One route hook** triggers connection (`beforeLoad`)
- **One React key** handles room transitions (`key={roomId}`)
- **One Vite plugin** handles code splitting automatically

No registry, no ref counting, no React context for room state, no acquire/release. The room lifecycle is a flat sequence: connect → use → disconnect. There's nothing left to abstract or simplify.

Extension points that require zero architectural changes:

| Future need                   | Where it goes                                              | What changes                |
| ----------------------------- | ---------------------------------------------------------- | --------------------------- |
| Await IDB before first paint  | `beforeLoad` → async + `pendingComponent`                  | 2 lines                     |
| Room access validation        | `beforeLoad` → `throw redirect(...)` or `throw notFound()` | 3 lines                     |
| Room metadata from API        | Add `loader` to route                                      | New function                |
| Per-route loading skeletons   | `pendingComponent` on route                                | New component               |
| Progress bar on navigation    | `router.subscribe('onBeforeNavigate', ...)`                | New subscription            |
| Analytics / page tracking     | `router.subscribe('onResolved', ...)`                      | New subscription            |
| Landing page / auth page      | New route files in `routes/`                               | New files (auto code-split) |
| Viewport persistence per room | Camera store keyed by roomId                               | Store change (not router)   |

The component tree is pure rendering. The module singletons are pure state. The router is pure lifecycle. The Vite plugin handles optimization. Each concern lives in exactly one place.
