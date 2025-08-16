import { test, expect } from '@playwright/test';

test('Direct recordRoomOpen test', async ({ page }) => {
  await page.goto('/');

  // Wait for Phase 9 exports
  await page.waitForFunction(() => window.avloPhase9 !== undefined);

  // Directly call recordRoomOpen from the browser
  const result = await page.evaluate(async () => {
    // Get the recordRoomOpen function
    const module = await import('./app/features/myrooms/integrations.js');
    const { recordRoomOpen } = module;

    try {
      // Call it with test data
      await recordRoomOpen({
        roomId: 'test-direct-123',
        title: 'Direct Test Room',
      });

      // Check if it was stored
      const rooms = await window.avloPhase9.listRooms();
      return { success: true, rooms, roomCount: rooms.length };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  console.log('Direct test result:', result);

  // The room should now be in the list
  await page.goto('/');
  await expect(page.getByText('Direct Test Room')).toBeVisible();
});
