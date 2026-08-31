import { asRoomId, asUserId, PERMISSIONS, ROOM_ID_RE, USER_ID_RE } from '@avlo/shared';
import { z } from 'zod/v4';

/**
 * Queue event schemas (§6) — the room DO is the sole producer of MetaEvent/VisitEvent about
 * itself; the `users` consumer `safeParse`s each message so a poison body acks-drops to that
 * queue's DLQ instead of crashing the batch. The queue NAME is the discriminator, so these
 * are flat schemas with no `type` field. `MigrateEvent` is the one the `users` worker both
 * produces (adopt-migration overflow/retry) and consumes. Server-only (`@avlo/worker-shared`).
 *
 * `userId`/`roomId` are format-gated then branded on parse, so a malformed projection
 * (truncated id, wrong case) drops cleanly rather than writing a half-id into D1.
 */

const userId = z.string().regex(USER_ID_RE).transform(asUserId);
const roomId = z.string().regex(ROOM_ID_RE).transform(asRoomId);

/** The DO's per-room monotonic counter — bumped on every meta mutation (NOT on visits, which
 *  resolve by `visitedAt`), so each `rooms` row's rev subsequence is monotonic and
 *  `excluded.rev >` resolves ordering exactly (wall-clock can stall or tie in Workers; a
 *  counter cannot). Meta-mutation-only is what keeps owner rev-LWW reasoning clean. */
const rev = z.number().int().nonnegative();

/** High-volume per-connect recency (room-visits queue). Ordering resolves by `visitedAt`
 *  (display-only recency; ties/clock-stalls are acceptable for a sort key — a deliberate
 *  decision now that visits no longer bump the DO rev). */
export const VisitEvent = z.object({
  userId,
  roomId,
  visitedAt: z.number(),
});
export type VisitEvent = z.infer<typeof VisitEvent>;

/** Rare room creation + permission/title/owner mutation (room-meta queue). `createdAt`
 *  first-write-wins, the rest (incl. `ownerId` — the adopt migration re-owns) LWW by `rev`. */
export const MetaEvent = z.object({
  roomId,
  ownerId: userId,
  permission: z.enum(PERMISSIONS),
  createdAt: z.number(),
  title: z.string(),
  rev,
  deletedAt: z.number().nullable(),
});
export type MetaEvent = z.infer<typeof MetaEvent>;

/** OAuth adopt-migration unit of work (room-migrate queue) — re-own one room from a device's
 *  anon id `from` to the account id `to`. The consumer calls the DO's idempotent `migrateOwner`
 *  (which enqueues a MetaEvent), so redelivery is a no-op. Produced by `UsersRpc.migrateOwnedRooms`
 *  for rooms beyond the synchronous CAP or that hit a transient failure inline. */
export const MigrateEvent = z.object({
  roomId,
  from: userId,
  to: userId,
});
export type MigrateEvent = z.infer<typeof MigrateEvent>;
