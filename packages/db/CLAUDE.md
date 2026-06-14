# @avlo/db

Server-only D1 + Durable-Object-SQLite schemas & helpers (Drizzle ORM). **Never imported client-side** — it reaches Cloudflare ambient runtime types (`D1Database`, `DurableObjectStorage`). The omission of an `@avlo/db` path entry from `client/tsconfig*.json` is the guardrail (mirrors `@avlo/worker-shared`).

Publishes TS source directly via `exports` (no dist build). Barrel `.` plus a `./schema-do` subpath — `workers/sync/src/room.ts` wants `import * as schema from '@avlo/db/schema-do'` for `drizzle(ctx.storage, { schema })`.

## Files

| File | Exports |
|---|---|
| `src/schema-d1.ts` | `users`, `rooms`, `roomVisits` (D1 tables — the `users` worker is the sole schema owner). Brand-typed id columns via `$type<UserId\|RoomId>()`; `room_visits` has composite PK `(userId, roomId)` + a recency index. `rooms` carries `title` (NOT NULL `'Untitled'`, LWW by rev), `rev` (the LWW guard) and `deleted` (tombstone projection) + `idx_rooms_owner` on `owner_id` (FULL index, deliberately not partial-on-not-deleted — reserved for the OAuth promote/adopt ownership fan-out, whose UPDATE must touch tombstoned rows too); `room_visits` carries `rev`. All three tables are `WITHOUT ROWID` — hand-appended in the migration SQL, re-append after any regenerate. |
| `src/schema-do.ts` | `roomMeta` (one `room_meta` row per room DO — `ownerId`/`permission`/`createdAt`/`updatedAt`/`title`/`rev`/`deleted`; roomId PK = `this.name`). `rev` is the per-room monotonic counter, bumped + persisted before EVERY queue send; `deleted` is the persistent tombstone (no delete flow yet). |
| `src/d1.ts` | `getSessionDB(db, bookmark?)` → `{ db, session }` (Sessions API, read-your-writes), `createDB(d1)`, `withRetry(fn)` (transient-only retry), `upsertRoomsFromMeta(db, rows)` — THE rev-guarded `rooms` projection upsert (`excluded.rev >` LWW; owner/createdAt first-write-wins), shared by the queue consumer (chunked `db.batch`) and the users worker's direct read-your-writes write after a DO meta RPC. |
| `src/drizzle-{d1,do}.config.ts` | drizzle-kit generate configs. D1 migrations → `workers/users/drizzle/` (CLI-applied); DO migrations → `workers/sync/drizzle/` (bundled as a text module). |

## Notes

- **Two drivers.** D1 queries are async (`.all()`); DO-SQLite (`drizzle-orm/durable-sqlite`) is sync (`.get()`/`.run()`). `getSessionDB` casts the Sessions handle (`D1DatabaseSession` isn't structurally a `D1Database`).
- **Branded ids end-to-end.** Id columns are `$type<RoomId>()`/`$type<UserId>()`, so a query result carries the brand; the `users` queue consumer `safeParse`s wire events into brands before insert.
- **Migrations.** Regenerate via `npm run -w packages/db db:generate-d1` / `db:generate-do`. The DO generate emits a `migrations.js` importing the `.sql` as a text module (resolved at build by sync's `rules` Text glob + a hand-written `workers/sync/drizzle/migrations.d.ts` shadow). Pre-prod, solo-dev: clearing D1 / resetting the DO covers any schema pivot — no migration shims.
- **Not in the root `typecheck` chain** — checked transitively via the `users` worker (+ a standalone `typecheck` script).
