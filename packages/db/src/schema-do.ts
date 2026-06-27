import type { Permission, RoomId, UserId } from '@avlo/shared';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable-Object SQLite schema (§5) — the room DO's authoritative `room_meta` (one row),
 * living alongside YServer's own storage in the same `ctx.storage` (different tables, no
 * conflict). This IS the source of truth the connect/authz path reads; D1's `rooms` row
 * is its lagging projection (§0). Brand-typed ids so `setPermission(caller)` compares
 * `UserId === UserId` and the meta object threads `Permission` through `isReadOnly`.
 */
export const roomMeta = sqliteTable('room_meta', {
  roomId: text('room_id').$type<RoomId>().primaryKey(),
  ownerId: text('owner_id').$type<UserId>().notNull(),
  permission: text('permission').$type<Permission>().notNull(),
  createdAt: integer('created_at').notNull(),
  title: text('title').notNull().default('Untitled'), // owner-only rename via the DO's setTitle RPC
  rev: integer('rev').notNull(), // monotonic per-room counter — bumped on EVERY meta mutation (create/permission/title/migrate), NOT on visits; the projection's ordering resolver
  deletedAt: integer('deleted_at'), // nullable epoch-ms tombstone (NULL = live); persistent (no delete flow yet)
});
