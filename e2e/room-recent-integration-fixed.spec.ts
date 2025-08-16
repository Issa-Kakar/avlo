import { test, expect } from '@playwright/test';

test.describe('Room to Recent Rooms Integration - Fixed', () => {
  test('creating a room should automatically add it to recent rooms list', async ({ page }) => {
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

    // Wait a moment for the recordRoomOpen to complete
    await page.waitForTimeout(500);

    // Go back to landing page
    await page.goto('/');

    // Wait for the page to load
    await page.waitForSelector('.recent-section');

    // The room should now appear in recent rooms because recordRoomOpen() is called
    await expect(page.getByText(`Room ${roomId}`)).toBeVisible();
    await expect(page.getByText(/Expires in \d+ days\./)).toBeVisible();

    // Should show action buttons
    await expect(page.locator('button:has-text("Open")')).toBeVisible();
    await expect(page.locator('button:has-text("Copy link")')).toBeVisible();
    await expect(page.locator('button:has-text("Extend")')).toBeVisible();
  });

  test('navigating to existing room should add it to recent rooms', async ({ page }) => {
    // Start on landing page
    await page.goto('/');

    // Wait for Phase 9 exports
    await page.waitForFunction(() => window.avloPhase9 !== undefined);

    // Navigate directly to a room
    await page.goto('/rooms/test-room-123');

    // Wait for room page to load
    await page.waitForSelector('.tool-rail');

    // Wait for recordRoomOpen to complete
    await page.waitForTimeout(500);

    // Go back to landing page
    await page.goto('/');

    // Should show the room in recent list
    await expect(page.getByText('Room test-room-123')).toBeVisible();
  });
});
