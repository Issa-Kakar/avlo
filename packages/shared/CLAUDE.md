# @avlo/shared

Cross-runtime utilities and types used by client and Cloudflare Workers.

## Subsystems

- `types/identifiers.ts` — branded ids (`RoomId`/`UserId`/`StrokeId`/`TextId` + brand symbols).
  `types/permission.ts` — `Permission` (`z.enum(['public','readonly','private'])`; value + type).
  `types/y-doc.ts` — Y.Doc shape alias (`YObjects`).
- `z-order/` — fractional z-key generation + renorm. **`ZKey` is opaque; never construct by hand.**
  Algorithm + branded type + jittered FI wrappers live here so both client (hot-path sort,
  hydrate, observer) and server (`workers/main/src/room.ts` renormalization) consume one
  implementation.
- **Identity primitives** (server-resolved; the client never mints a `userId`):
  `utils/user-id.ts` (`generateUserId` — auth `/me` only, `asUserId`, `USER_ID_RE`),
  `utils/room-id.ts` (`generateRoomId`, `normalizeRoomId`, `asRoomId`, `ROOM_ID_RE`),
  `utils/user-profile.ts` (`nameForUserId`/`colorForUserId`/`userProfileFor` — deterministic
  from `userId`; `PRESENCE_COLORS`).
- `utils/` — ULID, image validation, URL helpers (`normalizeUrl`/`isValidHttpUrl`/`extractDomain`/`prettifyDomain`).

## Invariants

- **No browser or Cloudflare globals.** Pure TS — both runtimes consume it.
- **`yjs` is a `peerDependency`** (with a dev fallback). Consumers bring their own copy;
  this package imports types only, so client + worker bundles each link a single Yjs.
- **`ZKey` is brand-symbol opaque** (`unique symbol`). Raw strings cannot be assigned;
  the only validating coercion exposed is `isZKey(v)`. Compare keys lex via `<`/`>` only —
  never parse, slice, or arithmetic on them.
