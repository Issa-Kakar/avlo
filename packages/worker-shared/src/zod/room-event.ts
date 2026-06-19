import { asRoomId, asUserId, Permission, ROOM_ID_RE, USER_ID_RE } from '@avlo/shared';
import { z } from 'zod/v4';

/**
 * Queue event schemas (§6) — the room DO is the sole producer of events about itself;
 * the `users` consumer `safeParse`s each message so a poison body acks-drops to that
 * queue's DLQ instead of crashing the batch. The queue NAME is the discriminator, so
 * these are two flat schemas with no `type` field. Server-only (`@avlo/worker-shared`).
 *
 * `userId`/`roomId` are format-gated then branded on parse, so a malformed projection
 * (truncated id, wrong case) drops cleanly rather than writing a half-id into D1.
 */

const userId = z.string().regex(USER_ID_RE).transform(asUserId);
const roomId = z.string().regex(ROOM_ID_RE).transform(asRoomId);

/** The DO's per-room monotonic counter — bumped on every meta mutation (mint/permission/
 *  title/owner-migrate), so each D1 `rooms` row's rev subsequence is monotonic and
 *  `excluded.rev >` resolves ordering exactly (wall-clock can stall or tie in Workers; a
 *  counter cannot). Meta-only — visits order by `visitedAt`, not rev. */
const rev = z.number().int().nonnegative();

/** High-volume per-connect recency (room-visits queue). Ordering resolves by `visitedAt` (recency IS the truth). */
export const VisitEvent = z.object({
  userId,
  roomId,
  visitedAt: z.number(),
});
export type VisitEvent = z.infer<typeof VisitEvent>;

/** Rare room creation + permission flip + owner migration (room-meta queue). createdAt first-write-wins, the rest (incl. ownerId) LWW by `rev`. */
export const MetaEvent = z.object({
  roomId,
  ownerId: userId,
  permission: Permission,
  createdAt: z.number(),
  updatedAt: z.number(),
  title: z.string(),
  rev,
  deletedAt: z.number().nullable(),
});
export type MetaEvent = z.infer<typeof MetaEvent>;

/** Second-device ownership migration (room-migrate queue). The SWEEP instruction form: the
 *  consumer re-enumerates live rooms owned by `prevOwner` and re-fans-out to each room DO's
 *  `migrateOwner` (which mints the rev — the queue can't pre-compute it). Idempotent: the
 *  DO's `ownerId === prevOwner` guard no-ops an already-migrated room. Used for cap overflow
 *  + post-retry failures from the synchronous fan-out. */
export const RoomMigrateEvent = z.object({
  prevOwner: userId,
  nextOwner: userId,
});
export type RoomMigrateEvent = z.infer<typeof RoomMigrateEvent>;
