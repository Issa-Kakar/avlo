import { test } from '@playwright/test';

test('Debug room integration console', async ({ page }) => {
  // Listen for ALL console messages
  page.on('console', (msg) => {
    if (
      msg.text().includes('[Room]') ||
      msg.type() === 'error' ||
      msg.text().includes('recordRoomOpen') ||
      msg.text().includes('Phase 9') ||
      msg.text().includes('Failed')
    ) {
      console.log(`[${msg.type()}] ${msg.text()}`);
    }
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

  // Wait longer for recordRoomOpen to complete
  await page.waitForTimeout(2000);

  // Check if the room was actually recorded
  const wasRecorded = await page.evaluate(async () => {
    const rooms = await window.avloPhase9.listRooms();
    console.log('Rooms found:', rooms);
    return rooms.length > 0;
  });

  console.log('Room was recorded:', wasRecorded);

  // Go back to landing page
  await page.goto('/');

  // Check the DOM for recent rooms content
  const recentContent = await page.locator('.recent-content').innerHTML();
  console.log('Recent content HTML:', recentContent);
});
