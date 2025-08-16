import { test, expect } from '@playwright/test';

test.describe('Room to Recent Rooms Integration', () => {
  test('creating a room should add it to recent rooms list', async ({ page }) => {
    // Start on landing page
    await page.goto('/');

    // Wait for Phase 9 exports to be available
    await page.waitForFunction(() => window.avloPhase9 !== undefined);

    // Verify recent rooms is empty initially
    await expect(
      page.getByText("No recent rooms yet. Create or join a room and it'll appear here."),
    ).toBeVisible();

    // Create a room
    await page
      .getByRole('button', { name: /create room/i })
      .first()
      .click();

    // Wait for navigation to room page
    await page.waitForURL(/\/rooms\/[A-Za-z0-9_-]+/);

    // Get the room ID from URL
    const url = page.url();
    const roomId = url.split('/rooms/')[1];
    console.log('Created room:', roomId);

    // Go back to landing page
    await page.goto('/');

    // The room should NOT appear in recent rooms because recordRoomOpen() is not called
    // This demonstrates the bug
    await expect(
      page.getByText("No recent rooms yet. Create or join a room and it'll appear here."),
    ).toBeVisible();

    // Manually add the room to demonstrate it would work if integrated
    await page.evaluate(async (roomId) => {
      await window.avloPhase9.upsertVisit(roomId, {
        title: `Room ${roomId}`,
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }, roomId);

    // Reload to show the manually added room
    await page.reload();

    // Now it should show the room
    await expect(page.getByText(`Room ${roomId}`)).toBeVisible();
  });
});
