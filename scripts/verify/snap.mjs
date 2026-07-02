// One-off screenshot of any app route. Usage:
//   node scripts/verify/snap.mjs <path> [outName]
//   node scripts/verify/snap.mjs /home home
//   node scripts/verify/snap.mjs /room/0123456789AB room
//
// Prints any console errors and (for /room/*) the live object count, then writes
// .verify/<outName>.png. Assumes a dev server is up (pnpm dev:web for client-only,
// or pnpm dev for the full stack). Env: BASE_URL to point elsewhere.

import { launch } from './browser.mjs';

const path = process.argv[2] ?? '/home';
const outName = process.argv[3] ?? (path.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'snap');

const h = await launch();
try {
  if (path.startsWith('/room/')) {
    await h.openRoom(path.slice('/room/'.length));
    const count = await h.page.evaluate(() => window.__avlo?.count() ?? 0);
    console.log(`room ready — ${count} object(s)`);
  } else {
    await h.goto(path);
  }
  const file = await h.snap(outName);
  console.log(`screenshot → ${file}`);
  if (h.errors.length) {
    console.log(`\n⚠ ${h.errors.length} console error(s):`);
    for (const e of h.errors) console.log(`  · ${e}`);
  } else {
    console.log('no console errors');
  }
} finally {
  await h.close();
}
