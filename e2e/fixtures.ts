import { test as base, expect } from '@playwright/test';

// Ported from scripts/verify/browser.mjs: a synthetic ULID identity (USER_ID_RE)
// seeded into localStorage makes ensureIdentity() resolve synchronously, so
// /room/:id loads against `pnpm dev:web` ALONE — no auth/sync worker needed.
const DEV_USER_ID = '0123456789ABCDEFGHJKMNPQRS';
const DEV_ROOM_ID = '0123456789ABCD'; // valid 14-char base62 room id (ROOM_ID_RE)
const AUTH_STORE_SEED = JSON.stringify({
  state: { userId: DEV_USER_ID, isAnon: true, name: 'Verify Bot', color: '#2563eb' },
  version: 0,
});

interface AvloFixture {
  /** Navigate to a canvas room and wait until the room + render loop are ready. */
  openRoom(roomId?: string): Promise<void>;
}

export const test = base.extend<{ avlo: AvloFixture }>({
  avlo: async ({ page, context }, use) => {
    // Runs before any page script on every navigation → identity is present when
    // Zustand's persist middleware rehydrates during store creation.
    await context.addInitScript((seed) => {
      localStorage.setItem('avlo.auth.v1', seed);
    }, AUTH_STORE_SEED);

    await use({
      async openRoom(roomId = DEV_ROOM_ID) {
        await page.goto(`/room/${roomId}`);
        await page.waitForFunction(() => window.__avlo !== undefined);
        await page.waitForFunction(() => window.__avlo?.hasRoom() === true);
        await page.waitForSelector('canvas');
      },
    });
  },
});

export { expect };
