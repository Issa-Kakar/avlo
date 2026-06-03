import { defineConfig } from 'drizzle-kit';

// D1 migrations → workers/users/drizzle (applied via `wrangler d1 migrations apply DB`).
// Run from packages/db: `npm run db:generate-d1`. Paths are cwd-relative (packages/db).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema-d1.ts',
  out: '../../workers/users/drizzle',
});
