// @avlo/db — server-only D1 + Durable-Object-SQLite schemas & helpers (Drizzle).
//
// Never imported client-side: it reaches Cloudflare ambient runtime types
// (D1Database, DurableObjectStorage). The omission of an `@avlo/db` path entry
// from client/tsconfig*.json is the guardrail (mirrors @avlo/worker-shared).
//
// Populated across the platform build:
//   • step 4 — schema-d1.ts (users/rooms/room_visits) + d1.ts (getSessionDB/withRetry)
//   • step 6 — schema-do.ts (room_meta, lives in the room DO's ctx.storage)
export {};
