import { test } from '@playwright/test';

test('Debug - show all console logs', async ({ page }) => {
  // Listen for ALL console messages
  page.on('console', (msg) => {
    console.log(`[${msg.type().toUpperCase()}] ${msg.text()}`);
  });

  // Listen for page errors
  page.on('pageerror', (error) => {
    console.log('PAGE ERROR:', error.message);
  });

  console.log('Starting test...');

  await page.goto('/');

  console.log('Loaded landing page, waiting for Phase 9...');

  // Wait for Phase 9 exports
  await page.waitForFunction(() => window.avloPhase9 !== undefined);

  console.log('Phase 9 loaded, creating room...');

  // Create room
  await page
    .getByRole('button', { name: /create room/i })
    .first()
    .click();

  console.log('Clicked create room, waiting for navigation...');

  // Wait for navigation to room page
  await page.waitForURL(/\/rooms\/[A-Za-z0-9_-]+/);

  const url = page.url();
  const roomId = url.split('/rooms/')[1];
  console.log('Navigated to room:', roomId);

  // Wait for room to fully load
  await page.waitForTimeout(2000);

  console.log('Test completed.');
});
