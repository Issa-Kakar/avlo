# @avlo/db

Server-only D1 + Durable-Object-SQLite schemas & helpers (Drizzle ORM). **Never imported client-side** — it reaches Cloudflare ambient runtime types (`D1Database`, `DurableObjectStorage`). The omission of an `@avlo/db` path entry from `web/tsconfig*.json` is the guardrail (mirrors `@avlo/worker-shared`).

Publishes TS source directly via `exports` (no dist build). Barrel `.` plus a `./schema-do` subpath — `workers/sync/src/room.ts` wants `import * as schema from '@avlo/db/schema-do'` for `drizzle(ctx.storage, { schema })`.

## Files

| File | Exports |
|---|---|
| `src/schema-d1.ts` | `users`, `rooms`, `roomVisits` (D1 tables — the `users` worker is the sole schema owner). Brand-typed id columns via `$type<UserId\|RoomId>()`; `room_visits` has composite PK `(userId, roomId)` + a recency index, ordered/LWW'd by `last_visited_at` (NO `rev` — recency IS the truth). `rooms` carries `title` (NOT NULL `'Untitled'`, LWW by rev), `rev` (the LWW guard) and `deleted_at` (nullable tombstone timestamp, null = live) + `rooms_by_owner` on `owner_id` **PARTIAL `WHERE deleted_at IS NULL`** — the second-device adopt fan-out enumerates owned-LIVE rooms and we deliberately don't re-own tombstoned ones, so the index pays only on create/migrate/delete (free on every title/rev/permission/updated_at write); the partial `WHERE` is hand-appended to the SQL (Drizzle can't express it). All three tables are `WITHOUT ROWID` — both the `WITHOUT ROWID` clauses AND the partial-index `WHERE` are hand-appended in the migration SQL, re-append after any regenerate. |
| `src/schema-do.ts` | `roomMeta` (one `room_meta` row per room DO — `ownerId`/`permission`/`createdAt`/`updatedAt`/`title`/`rev`/`deletedAt`; roomId PK = `this.name`). `rev` is the per-room monotonic counter, bumped on every meta mutation (mint/permission/title/owner-migrate — NOT the visit projection); `deletedAt` is the nullable persistent tombstone (no delete flow yet). |
| `src/d1.ts` | `getSessionDB(db, bookmark?)` → `{ db, session }` (Sessions API, read-your-writes), `createDB(d1)`, `withRetry(fn)` (transient-only retry), `chunk(rows, size)` + `META_ROWS_MAX` (D1 100-param-cap chunking, shared by the consumer + migration fan-out), `upsertRoomsFromMeta(db, rows)` — THE rev-guarded `rooms` projection upsert (`excluded.rev >` LWW; **owner is rev-LWW** like permission/title, only `createdAt` is first-write-wins), shared by the queue consumer (chunked `db.batch`), the PATCH handlers' direct RYW write, and the second-device migration fan-out. |
| `src/drizzle-{d1,do}.config.ts` | drizzle-kit generate configs. D1 migrations → `workers/users/drizzle/` (CLI-applied); DO migrations → `workers/sync/drizzle/` (bundled as a text module). |

## Notes

- **Two drivers.** D1 queries are async (`.all()`); DO-SQLite (`drizzle-orm/durable-sqlite`) is sync (`.get()`/`.run()`). `getSessionDB` casts the Sessions handle (`D1DatabaseSession` isn't structurally a `D1Database`).
- **Branded ids end-to-end.** Id columns are `$type<RoomId>()`/`$type<UserId>()`, so a query result carries the brand; the `users` queue consumer `safeParse`s wire events into brands before insert.
- **Migrations.** Regenerate via `pnpm --filter @avlo/db db:generate-d1` / `db:generate-do`. The DO generate emits a `migrations.js` importing the `.sql` as a text module (resolved at build by sync's `rules` Text glob + a hand-written `workers/sync/drizzle/migrations.d.ts` shadow). Pre-prod, solo-dev: clearing D1 / resetting the DO covers any schema pivot — no migration shims.
- **Not in the root `typecheck` chain** — checked transitively via the `users` worker (+ a standalone `typecheck` script).
