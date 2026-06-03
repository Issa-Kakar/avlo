// Hand-written declaration shadowing the drizzle-kit-generated `migrations.js`. That
// file imports the `.sql` as a text module + `meta/_journal.json` — both resolved at
// BUILD time (esbuild json loader + wrangler's `**/*.sql` Text rule), invisible to tsc.
// Typing the default export to the durable-sqlite migrator's `MigrationConfig` lets
// room.ts's `migrate(this.db, migrations)` typecheck without tsc reading the .js/.sql.
// Regenerate the .js/.sql with `npm run -w packages/db db:generate-do`; this stays.
declare const migrations: {
  journal: { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] };
  migrations: Record<string, string>;
};
export default migrations;
