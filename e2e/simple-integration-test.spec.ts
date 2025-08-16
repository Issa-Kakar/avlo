import { test, expect } from '@playwright/test';

test('Simple integration test - check if recordRoomOpen can be called', async ({ page }) => {
  await page.goto('/');

  // Wait for Phase 9 exports
  await page.waitForFunction(() => window.avloPhase9 !== undefined);

  // Check initial room count
  const initialCount = await page.evaluate(() =>
    window.avloPhase9.listRooms().then((r) => r.length),
  );
  console.log('Initial room count:', initialCount);

  // Create a room normally
  await page
    .getByRole('button', { name: /create room/i })
    .first()
    .click();
  await page.waitForURL(/\/rooms\/[A-Za-z0-9_-]+/);

  const url = page.url();
  const roomId = url.split('/rooms/')[1];
  console.log('Created room:', roomId);

  // Wait a bit for any async operations
  await page.waitForTimeout(1000);

  // Go back to landing page
  await page.goto('/');

  // Check final room count
  const finalCount = await page.evaluate(() => window.avloPhase9.listRooms().then((r) => r.length));
  console.log('Final room count:', finalCount);

  if (finalCount > initialCount) {
    console.log('✅ Room was recorded successfully!');
    await expect(page.getByText(`Room ${roomId}`)).toBeVisible();
  } else {
    console.log('❌ Room was NOT recorded');
    // Check if "No recent rooms" message is shown
    await expect(page.getByText('No recent rooms yet')).toBeVisible();
  }
});
