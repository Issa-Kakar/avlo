import { expect, test } from './fixtures';

test('creates a shape via the dev bridge', async ({ page, avlo }) => {
  await avlo.openRoom();
  await page.evaluate(() => window.__avlo?.createShape({ x: 200, y: 200 }));
  await page.evaluate(() => window.__avlo?.settle()); // flush the render/observer pipeline
  expect(await page.evaluate(() => window.__avlo?.count())).toBe(1);
});
