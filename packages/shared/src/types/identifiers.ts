// Type aliases for strong typing and clarity
export type StrokeId = string; // ULID format
export type TextId = string; // ULID format

/**
 * User id — a branded string. 26-char ULID (Crockford base32, uppercase): the
 * anonymous identity carried by the signed `avlo_anon` cookie today, the same id
 * promoted into an account row after OAuth (§2). Constructed ONLY by
 * `generateUserId()` (mint) or `asUserId()` (brand a value already verified at a
 * trust boundary — the `AnonToken` cookie schema, a server-verified session), so a
 * raw string is un-assignable and every `UserId` is validated at its source. There
 * is no client-side mint (§9) — the brand makes that contract un-bypassable. Still
 * assignable TO `string` (Y.Doc undo origin, awareness wire, `ownerId` slot).
 */
export type UserId = string & { readonly __userId: unique symbol };

/**
 * Room id — a branded string. 12-char Crockford base32, canonical uppercase.
 * Constructed ONLY by `generateRoomId()` / `normalizeRoomId()` (`utils/room-id.ts`),
 * so the brand makes a raw string un-assignable and every `RoomId` is validated at
 * its source. Still assignable TO `string` (Y.Doc guid, IDB db name, camera-store key).
 */
export type RoomId = string & { readonly __roomId: unique symbol };
