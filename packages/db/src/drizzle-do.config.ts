import { defineConfig } from 'drizzle-kit';

// Durable-Object SQLite migrations → workers/main/drizzle (bundled + auto-applied via
// `migrate(this.db, migrations)` in the RoomDurableObject constructor, §5). The
// `durable-sqlite` driver emits a `migrations.js` importing the `.sql` as text modules —
// hence main's wrangler `rules` Text glob for `**/*.sql`. Run: `npm run db:generate-do`.
export default defineConfig({
  dialect: 'sqlite',
  driver: 'durable-sqlite',
  schema: './src/schema-do.ts',
  out: '../../workers/main/drizzle',
});
