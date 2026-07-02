// Reusable Playwright harness for headless verification of the avlo canvas.
//
// The point: an imperative canvas is slow to drive by synthesizing pointer drags, so
// this harness seeds a dev identity into localStorage (the returning-visitor sync path
// in `query/me.ts`), which lets `/room/:id` load against `pnpm dev:web` ALONE — no auth
// or sync worker required — and then drives object creation through `window.__avlo`
// (see web/src/dev/test-bridge.ts). Deterministic, worker-free, cheap on tokens.
//
// Usage:
//   import { launch } from './browser.mjs'
//   const h = await launch()
//   await h.openRoom()
//   await h.page.evaluate(() => window.__avlo.createShape({ x: 200, y: 200 }))
//   await h.snap('one-shape')
//   await h.close()
//
// Env knobs: BASE_URL (default http://localhost:3000), HEADED=1, SLOWMO=<ms>.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
export const VERIFY_DIR = resolve(REPO_ROOT, '.verify');

// A synthetic, obviously-fake identity that satisfies USER_ID_RE (26-char Crockford ULID).
// Seeding it makes `ensureIdentity()` resolve synchronously → the room route never blocks
// on `/me`, so no auth worker is needed.
export const DEV_USER_ID = '0123456789ABCDEFGHJKMNPQRS';
// A valid 14-char base62 room id (ROOM_ID_RE). Any local room works offline (empty Y.Doc).
export const DEV_ROOM_ID = '0123456789ABCD';

// Known-benign dev-only console noise, excluded from `errors` so "no errors" means "no APP
// errors". In dev, `/sw.js` isn't built (it's a prod-only Rollup input), so the service-worker
// registration fetch resolves to index.html → "unsupported MIME type ('text/html')". Harmless
// (the registration .catch()es it); unrelated to the removed preload warning.
const IGNORED_ERRORS = [/unsupported MIME type/i];
const isBenign = (text) => IGNORED_ERRORS.some((re) => re.test(text));

const AUTH_STORE_SEED = JSON.stringify({
  state: { userId: DEV_USER_ID, isAnon: true, name: 'Verify Bot', color: '#2563eb' },
  version: 0,
});

export async function launch(opts = {}) {
  const baseUrl = opts.baseUrl ?? process.env.BASE_URL ?? 'http://localhost:3000';
  const headed = opts.headed ?? process.env.HEADED === '1';
  const slowMo = opts.slowMo ?? (process.env.SLOWMO ? Number(process.env.SLOWMO) : 0);

  const browser = await chromium.launch({ headless: !headed, slowMo });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Runs before any page script on every navigation → identity is present when Zustand's
  // persist middleware rehydrates during store creation.
  await context.addInitScript((seed) => {
    localStorage.setItem('avlo.auth.v1', seed);
  }, AUTH_STORE_SEED);

  const page = await context.newPage();

  const logs = [];
  const errors = [];
  page.on('console', (msg) => {
    const entry = { type: msg.type(), text: msg.text() };
    logs.push(entry);
    if (msg.type() === 'error' && !isBenign(entry.text)) errors.push(entry.text);
  });
  page.on('pageerror', (err) => {
    if (!isBenign(String(err))) errors.push(String(err));
  });

  async function goto(path = '/') {
    await page.goto(baseUrl + path, { waitUntil: 'load' });
  }

  async function waitForBridge() {
    await page.waitForFunction(() => typeof window.__avlo !== 'undefined', null, { timeout: 15_000 });
  }

  /** Navigate to a canvas room and wait until the room + render loop are ready.
   * `connectRoom` runs in `beforeLoad`, so `hasRoom()` flips true before the Canvas
   * mounts; we additionally wait for the <canvas> element (⇒ the render loop's start()
   * has run) so objects created next actually paint. */
  async function openRoom(roomId = DEV_ROOM_ID) {
    await goto(`/room/${roomId}`);
    await waitForBridge();
    await page.waitForFunction(() => window.__avlo?.hasRoom() === true, null, { timeout: 15_000 });
    await page.waitForSelector('canvas', { timeout: 15_000 });
    await page.waitForTimeout(300);
  }

  async function snap(name) {
    await mkdir(VERIFY_DIR, { recursive: true });
    const path = resolve(VERIFY_DIR, name.endsWith('.png') ? name : `${name}.png`);
    await page.screenshot({ path });
    return path;
  }

  async function close() {
    await browser.close();
  }

  return { browser, context, page, logs, errors, baseUrl, goto, waitForBridge, openRoom, snap, close };
}
