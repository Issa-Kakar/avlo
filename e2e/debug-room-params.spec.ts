import { test } from '@playwright/test';

test('Debug room parameters and validation', async ({ page }) => {
  // Listen for ALL console messages including Room validation
  page.on('console', (msg) => {
    console.log(`[${msg.type()}] ${msg.text()}`);
  });

  // Listen for page errors
  page.on('pageerror', (error) => {
    console.log('Page error:', error.message);
  });

  await page.goto('/');

  // Wait for Phase 9 exports
  await page.waitForFunction(() => window.avloPhase9 !== undefined);

  // Create room
  await page
    .getByRole('button', { name: /create room/i })
    .first()
    .click();

  // Wait for navigation to room page
  await page.waitForURL(/\/rooms\/[A-Za-z0-9_-]+/);

  const url = page.url();
  const roomId = url.split('/rooms/')[1];
  console.log('Created room:', roomId);

  // Test the room ID validation directly in the browser
  const validationResult = await page.evaluate((roomId) => {
    console.log('[DEBUG] Testing room ID validation for:', roomId);
    const isValid = roomId && /^[A-Za-z0-9_-]+$/.test(roomId);
    console.log('[DEBUG] Room ID valid:', isValid);
    return { roomId, isValid };
  }, roomId);

  console.log('Validation result:', validationResult);

  // Wait longer for any delayed effects
  await page.waitForTimeout(3000);
});
