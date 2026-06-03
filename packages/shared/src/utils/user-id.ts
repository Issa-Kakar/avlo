import type { UserId } from '../types/identifiers';
import { ulid } from './ulid';

/**
 * ULID format — 26 chars Crockford base32, uppercase (the `ulid()` output, which
 * is exactly what `/me` mints into the signed `avlo_anon` cookie). Gates the cookie
 * payload at the wire boundary (`AnonToken`, `@avlo/worker-shared`) so a truncated
 * or legacy token rejects cleanly → re-mint, rather than feeding a half-id
 * downstream. Same alphabet as `ROOM_ID_RE`, length 26 vs 12.
 */
export const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Mint a fresh user id. Server-only path (`/me`) — there is no client-side mint
 * (§9); the brand makes that un-bypassable (a bare `ulid()` is not a `UserId`). The
 * same id is later adopted into the account row at OAuth.
 */
export function generateUserId(): UserId {
  return ulid() as UserId;
}

/**
 * Brand a string already verified as a user id at a trust boundary — the post-HMAC
 * `avlo_anon` payload (format-checked by `USER_ID_RE` in the `AnonToken` schema) or
 * a server-verified session. The `RoomId`/`normalizeRoomId` analog, minus the
 * re-validation the cookie signature already obviates. Never call on untrusted input.
 */
export function asUserId(raw: string): UserId {
  return raw as UserId;
}
