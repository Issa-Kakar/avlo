import type { Permission, RoomId, UserId } from '@avlo/shared';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * D1 schema (§4) — the eventually-consistent relational projection owned exclusively by
 * the `users` worker. NEVER consulted for authorization (the room DO is the authority,
 * §0). Timestamps are epoch-ms INTEGER; ids are TEXT, brand-typed via `$type<>()` so a
 * query selects `UserId`/`RoomId` rather than a bare string. Schema is single-sourced
 * here so the worker and drizzle-kit agree; pre-prod → no migration chains (§5).
 *
 * All three tables are `WITHOUT ROWID` — TEXT (or composite-TEXT) PKs, narrow rows,
 * every write a PK upsert: the textbook fit (one PK-clustered B-tree instead of a rowid
 * tree + a duplicate PK unique index). Drizzle can't express it, so it is HAND-APPENDED
 * to each CREATE TABLE in the generated migration SQL — re-append after any
 * `db:generate-d1` regenerate.
 */

/** Durable account directory. Anonymous users are NOT rows here (stateless, §2). */
export const users = sqliteTable('users', {
  userId: text('user_id').$type<UserId>().primaryKey(), // ULID; == the promoted anon id (§2)
  googleSub: text('google_sub').notNull().unique(), // UNIQUE → race-free promote/adopt (§9)
  email: text('email').notNull(),
  name: text('name').notNull(),
  avatarHash: text('avatar_hash'), // nullable — 32-hex `avatars/` R2 key suffix (content hash), NOT a URL; null when ingest failed or Google omitted the picture
  createdAt: integer('created_at').notNull(),
});

/** Eventually-consistent projection of each room DO's authority. DISPLAY ONLY. */
export const rooms = sqliteTable(
  'rooms',
  {
    roomId: text('room_id').$type<RoomId>().primaryKey(), // 14-char base62 (§13)
    ownerId: text('owner_id').$type<UserId>().notNull(), // rev-LWW (the OAuth adopt migration re-owns; see d1.ts upsert)
    permission: text('permission').$type<Permission>().notNull(), // LWW by rev
    createdAt: integer('created_at').notNull(), // first-write-wins (the ONLY FWW field — surfaced by GET /rooms)
    title: text('title').notNull().default('Untitled'), // LWW by rev (rename RPC)
    rev: integer('rev').notNull(), // DO's per-room monotonic counter — the LWW guard (meta-mutation-only; see room.ts)
    deletedAt: integer('deleted_at'), // nullable epoch-ms tombstone (NULL = live); DO tombstone projection (no delete flow yet)
  },
  // One-time cost per room creation; serves the OAuth adopt ownership fan-out, which
  // enumerates `WHERE owner_id = old AND deleted_at IS NULL`. PARTIAL index (matching that
  // predicate) BECAUSE a tombstoned room is intentionally never re-owned — a deleted room's
  // owner is irrelevant. This is the verified WITHOUT-ROWID win: a title/perm/rev write
  // touches neither `owner_id` nor `deleted_at`, so the index entry is byte-identical
  // and skipped; only create/migrate/soft-delete pay.
  (t) => [index('idx_rooms_owner').on(t.ownerId).where(sql`deleted_at IS NULL`)],
);

/** Per-user access + recency list — the dashboard's primary source. Visit facts only. */
export const roomVisits = sqliteTable(
  'room_visits',
  {
    userId: text('user_id').$type<UserId>().notNull(),
    roomId: text('room_id').$type<RoomId>().notNull(),
    lastVisitedAt: integer('last_visited_at').notNull(), // display/sort key — ordering resolves by `last_visited_at` itself (no rev; ties/clock-stalls acceptable for a recency sort)
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roomId] }), // upsert target + "my visit to room X"
    index('idx_room_visits_user_recent').on(t.userId, t.lastVisitedAt), // dashboard sort
  ],
);
