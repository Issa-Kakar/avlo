import { test, expect } from '@playwright/test';

test.describe('Join Room Flow', () => {
  test('Join Room does not POST to create a new room', async ({ page }) => {
    // Mock/intercept API calls
    const apiCalls: string[] = [];
    await page.route('**/api/rooms', async (route) => {
      apiCalls.push(route.request().method());
      if (route.request().method() === 'POST') {
        // Should not happen during join
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ roomId: 'should-not-create', shareLink: '/rooms/should-not-create' })
        });
      } else {
        await route.continue();
      }
    });

    // Go to landing page
    await page.goto('/');
    
    // Click Join Room button
    await page.locator('[data-testid="join-room"]').click();
    
    // Enter a room ID
    const roomId = 'existing-room-test';
    await page.fill('input[placeholder="Enter room ID"]', roomId);
    
    // Submit join
    await page.locator('text=Join').last().click();
    
    // Wait for navigation
    await page.waitForURL(`**/rooms/${roomId}`, { timeout: 5000 });
    
    // Verify no POST was made
    expect(apiCalls.filter(method => method === 'POST')).toHaveLength(0);
    
    // Should be on the room page
    expect(page.url()).toContain(`/rooms/${roomId}`);
  });
  
  test('Join Room handles non-existent room gracefully', async ({ page }) => {
    const roomId = 'non-existent-room-' + Date.now();
    
    // Mock metadata endpoint to return 404
    await page.route(`**/api/rooms/${roomId}/metadata`, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not_found' })
      });
    });
    
    // Navigate directly to room
    await page.goto(`/rooms/${roomId}`);
    
    // Should still render the room page (client will create local room)
    await expect(page.locator('#board')).toBeVisible({ timeout: 5000 });
    
    // No stack traces in UI
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toContain('Error:');
    expect(bodyText).not.toContain('TypeError');
    expect(bodyText).not.toContain('stack');
  });
  
  test('Join Room validates room ID format', async ({ page }) => {
    await page.goto('/');
    
    // Click Join Room button
    await page.locator('[data-testid="join-room"]').click();
    
    // Try invalid room ID
    await page.fill('input[placeholder="Enter room ID"]', 'invalid room!@#');
    await page.locator('text=Join').last().click();
    
    // Should show error toast
    await expect(page.locator('.toast')).toContainText('Invalid room ID format');
    
    // Should not navigate
    expect(page.url()).toContain('/');
  });
});