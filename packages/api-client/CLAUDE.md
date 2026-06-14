# @avlo/api-client

Browser- and SW-safe typed HTTP-RPC clients for the public Workers (`images`, `unfurl`, `auth`, `users`). Wraps Hono's `hc<AppType>(origin)` — `import type` for AppType (fully erased at build), `hc` from `hono/client` is the only runtime import.

Used anywhere transport is HTTP `fetch` over the public internet: main browser bundle, web workers (`?worker` and bare entries), and the service worker. **Worker-to-Worker is binary RPC via `WorkerEntrypoint`** — different transport, see `workers/CLAUDE.md` §Inter-Worker.

The package publishes TS source directly via `exports` (no dist build).

## Files

| File | Exports |
|---|---|
| `src/index.ts` | Barrel: origins + matchers + clients + AppType types |
| `src/origins.ts` | `AUTH_ORIGIN`, `IMAGES_ORIGIN`, `UNFURL_ORIGIN`, `USERS_ORIGIN`, `SYNC_HOST_PROD` — driven by `import.meta.env.PROD`. Has a file-scoped `/// <reference types="vite/client" />` for `ImportMetaEnv` resolution under path-mapped compilation (e.g., when api-client typechecks in isolation or via a workspace include from outside). |
| `src/sw-matchers.ts` | `isImagesRequest(url, origin)`, `isSyncRequest(url, syncHostProd)` — zero-dep URL matching for the SW fetch handler. |
| `src/auth.ts` | `authClient = hc<AuthApp>(AUTH_ORIGIN, { init: { credentials: 'include' } })` — the `/me` identity resolver; the cookie rides via `credentials:'include'`. Re-exports `MeResponse` (through `AuthApp`). |
| `src/users.ts` | `usersClient = hc<UsersApp>(USERS_ORIGIN)` (credentials:'include') — `GET /rooms` + `PATCH /rooms/:id/permission`. Re-exports `RoomListEntry`/`RoomListResponse`. |
| `src/images.ts` | `imagesClient = hc<ImagesApp>(IMAGES_ORIGIN)` |
| `src/unfurl.ts` | `unfurlClient = hc<UnfurlApp>(UNFURL_ORIGIN)` |

## App-Type Imports — Critical Rule

```ts
// packages/api-client/src/images.ts
import type { ImagesApp } from '../../../workers/images/src/app-type';  // ← app-type, NOT index
```

**Always import the AppType from `…/workers/<name>/src/app-type`, never `…/src/index`.**

The real `src/index.ts` reaches ambient CF runtime types (`Env`, `R2Bucket`, `HTMLRewriter`, `caches.default`) — TS would drag those into client compilation (cascading `TS2304`). The `app-type.ts` mock is the ambient-free public surface; a drift guard inside each worker's real index asserts surface-match against the mock at typecheck time.

See `workers/CLAUDE.md` → App-Type Pattern for the full design.

## Build-Time Discipline

The whole point of the package split is that the SW bundle stays small. Maintained by:

- **AppType imports are `import type` only** — erased at build by `verbatimModuleSyntax: true` in `tsconfig.base.json`.
- **No `@avlo/worker-shared` imports anywhere client-side.** Zod schemas, CSP, SSRF, etc. are server-only. Both `web/tsconfig.json` and `tsconfig.sw.json` deliberately omit `@avlo/worker-shared` from `paths`, so accidental imports fail at typecheck.
- **`hc<App>(...)` instances are constructed once at module scope** — per-event construction in the SW would re-allocate the router on every `fetch` event.
- **CI grep** — `.github/workflows/ci.yml` greps `web/dist/sw.js` for `partyserverMiddleware|HTMLRewriter|R2Bucket|isPrivateHost`. Empty output is the pass condition. Catches any accidental runtime import of server symbols into the SW.

## Binary Bodies vs JSON

`hc.$put({ body: blob })` JSON-encodes by default. For raw `Blob` uploads (the image PUT), use `$url` for the typed URL + plain `fetch` for the body:

```ts
const url = imagesClient[':key'].$url({ param: { key: assetId } });
const resp = await fetch(url, { method: 'PUT', body: blob });
```

JSON-bodied calls (the unfurl GET) use `$get` directly and get full type inference on the response.

## What the SW Uses

Only `IMAGES_ORIGIN` / `SYNC_HOST_PROD` constants and the `isImagesRequest` / `isSyncRequest` matchers. The clients (`imagesClient`, `unfurlClient`) are NOT used in the SW — `hc` is unused there because the SW only *recognizes* request URLs, doesn't *construct* them. The full package is import-safe in the SW anyway (the build-time discipline above keeps it that way), so a future SW use case can pull `imagesClient` in without changing the build invariants.
