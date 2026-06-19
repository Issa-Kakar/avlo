import type { Permission, RoomId, UserId } from '@avlo/shared';
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
    ownerId: text('owner_id').$type<UserId>().notNull(), // FWW on create; rev-LWW on ownership migration (§9 second-device adopt)
    permission: text('permission').$type<Permission>().notNull(), // LWW by rev
    createdAt: integer('created_at').notNull(), // first-write-wins
    updatedAt: integer('updated_at').notNull(), // display/audit (rev is the LWW guard)
    title: text('title').notNull().default('Untitled'), // LWW by rev (rename RPC)
    rev: integer('rev').notNull(), // DO's per-room monotonic counter — the LWW guard
    deletedAt: integer('deleted_at'), // nullable tombstone timestamp (null = live); preserves deletion time, keeps the dashboard query cheap
  },
  // The second-device OAuth adopt fan-out enumerates owned-LIVE rooms
  // (`SELECT room_id WHERE owner_id = ? AND deleted_at IS NULL`), so a PARTIAL index on
  // live rooms is the exact fit — we deliberately do NOT re-own tombstoned rooms (a
  // deleted board staying under a dead anon id is harmless, never listed). The partial
  // predicate is hand-appended to the generated SQL (Drizzle can't express index WHERE);
  // it is maintained only on create / owner-migrate / deleted_at-flip, free on every
  // title/rev/permission/updated_at write. The enumerate query MUST repeat the predicate
  // (`AND deleted_at IS NULL`) or SQLite won't match the partial index.
  (t) => [index('rooms_by_owner').on(t.ownerId)],
);

/** Per-user access + recency list — the dashboard's primary source. Visit facts only. */
export const roomVisits = sqliteTable(
  'room_visits',
  {
    userId: text('user_id').$type<UserId>().notNull(),
    roomId: text('room_id').$type<RoomId>().notNull(),
    lastVisitedAt: integer('last_visited_at').notNull(), // display/sort AND the LWW guard (visits order by recency; rev is a meta-only concept)
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roomId] }), // upsert target + "my visit to room X"
    index('idx_room_visits_user_recent').on(t.userId, t.lastVisitedAt), // dashboard sort
  ],
);
