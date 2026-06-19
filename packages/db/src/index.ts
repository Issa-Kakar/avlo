// @avlo/db — server-only D1 + Durable-Object-SQLite schemas & helpers (Drizzle).
//
// Never imported client-side: it reaches Cloudflare ambient runtime types
// (D1Database, DurableObjectStorage). The omission of an `@avlo/db` path entry
// from web/tsconfig*.json is the guardrail (mirrors @avlo/worker-shared).
//
// The DO subschema is also reachable via the `@avlo/db/schema-do` subpath export
// (room.ts wants `import * as schema from '@avlo/db/schema-do'` for drizzle()).
export { chunk, createDB, getSessionDB, META_ROWS_MAX, upsertRoomsFromMeta, withRetry } from './d1';
export { rooms, roomVisits, users } from './schema-d1';
export { roomMeta } from './schema-do';
