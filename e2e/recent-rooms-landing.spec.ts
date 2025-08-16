import { test, expect } from '@playwright/test';

test.describe('Recent Rooms on Landing Page', () => {
  test('shows empty state when no rooms exist', async ({ page }) => {
    await page.goto('/');

    // Wait for the recent section to be visible
    await expect(page.locator('.recent-section')).toBeVisible();

    // Should show empty state message
    await expect(
      page.getByText("No recent rooms yet. Create or join a room and it'll appear here."),
    ).toBeVisible();
  });

  test('displays recent rooms when they exist in IndexedDB', async ({ page }) => {
    await page.goto('/');

    // Wait for Phase 9 exports to be available
    await page.waitForFunction(() => window.avloPhase9 !== undefined);

    // Add a test room to IndexedDB
    await page.evaluate(async () => {
      const testRoom = {
        roomId: 'test-room-123',
        title: 'Test Room',
        last_opened: new Date().toISOString(),
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days from now
      };
      await window.avloPhase9.upsertVisit('test-room-123', {
        title: 'Test Room',
        expires_at: testRoom.expires_at,
      });
    });

    // Trigger the refresh manually via exposed function
    await page.evaluate(async () => {
      // Force a refresh of the rooms list
      await window.avloPhase9.listRooms();
    });

    // Reload the page to trigger the useEffect that loads rooms
    await page.reload();

    // Wait for the recent section to be visible
    await expect(page.locator('.recent-section')).toBeVisible();

    // Should show the room
    await expect(page.getByText('Test Room')).toBeVisible();
    await expect(page.getByText(/Expires in \d+ days\./)).toBeVisible();

    // Debug: Log the page content
    const pageContent = await page.content();
    console.log('Page contains recent-rooms-list:', pageContent.includes('recent-rooms-list'));

    // Should show recent rooms list
    await expect(page.locator('.recent-rooms-list')).toBeVisible();

    // Should show action buttons
    await expect(page.locator('button:has-text("Open")')).toBeVisible();
    await expect(page.locator('button:has-text("Copy link")')).toBeVisible();
    await expect(page.locator('button:has-text("Extend")')).toBeVisible();
    await expect(page.locator('summary:has-text("•••")')).toBeVisible();
  });

  test('handles room actions correctly', async ({ page }) => {
    await page.goto('/');

    // Wait for Phase 9 exports to be available
    await page.waitForFunction(() => window.avloPhase9 !== undefined);

    // Add a test room
    await page.evaluate(async () => {
      await window.avloPhase9.upsertVisit('test-room-456', {
        title: 'Action Test Room',
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
    });

    // Reload to show the room
    await page.reload();

    // Wait for room to appear
    await expect(page.getByText('Action Test Room')).toBeVisible();

    // Test menu functionality
    await page.locator('summary:has-text("•••")').click();
    await expect(page.getByText('Remove from list')).toBeVisible();
    await expect(page.getByText('Delete local copy')).toBeVisible();

    // Test remove from list
    await page.getByText('Remove from list').click();

    // Should show success toast (though we can't easily test toast content in this setup)
    // The room should disappear from the list
    await expect(page.getByText('Action Test Room')).not.toBeVisible();
    await expect(
      page.getByText("No recent rooms yet. Create or join a room and it'll appear here."),
    ).toBeVisible();
  });
});
