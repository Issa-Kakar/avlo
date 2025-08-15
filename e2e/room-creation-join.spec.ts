import { test, expect } from '@playwright/test';

test.describe('Room Creation and Join UX', () => {
  test('Create Room should POST to /api/rooms and navigate', async ({ page }) => {
    await page.goto('/');
    
    // Set up request interception
    const createRoomPromise = page.waitForRequest(req => 
      req.url().includes('/api/rooms') && req.method() === 'POST'
    );
    
    // Click Create Room button
    await page.getByTestId('create-room').click();
    
    // Verify POST request was made
    const request = await createRoomPromise;
    expect(request.method()).toBe('POST');
    
    // Should navigate to the new room
    await page.waitForURL(/\/rooms\/[A-Za-z0-9_-]+/);
    
    // Should be connected
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
  });

  test('Create Room throttling should show correct toast', async ({ page }) => {
    await page.goto('/');
    
    // Mock the API to return 429
    await page.route('/api/rooms', async route => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests' })
      });
    });
    
    // Click Create Room
    await page.getByTestId('create-room').click();
    
    // Should show the exact normative toast text
    await expect(page.getByText('Too many requests — try again shortly.')).toBeVisible();
  });

  test('Join Room should NOT POST to /api/rooms', async ({ page }) => {
    await page.goto('/');
    
    // Set up request interception to detect any POST to /api/rooms
    let postRequestMade = false;
    page.on('request', request => {
      if (request.url().includes('/api/rooms') && request.method() === 'POST') {
        postRequestMade = true;
      }
    });
    
    // Click Join Room and enter a room ID
    await page.getByTestId('join-room').click();
    
    // If there's an input field, fill it
    const roomInput = page.getByPlaceholder(/room.*id/i);
    if (await roomInput.isVisible()) {
      await roomInput.fill('test-room-id');
      await roomInput.press('Enter');
    }
    
    // Should navigate without making a POST request
    await page.waitForURL('/rooms/test-room-id');
    expect(postRequestMade).toBe(false);
  });

  test('Copy Link should show exact normative toast', async ({ page }) => {
    await page.goto('/rooms/e2e-copy-link');
    
    // Wait for connection
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Click Copy Link
    await page.getByTestId('copy-link').click();
    
    // Should show exact normative toast text (with period)
    await expect(page.getByText('Link copied.')).toBeVisible();
  });

  test('Copy Link with clipboard denied should still show toast', async ({ page, context }) => {
    // Deny clipboard permissions
    await context.grantPermissions([], { origin: 'http://localhost:5173' });
    
    await page.goto('/rooms/e2e-copy-fallback');
    
    // Wait for connection
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Click Copy Link
    await page.getByTestId('copy-link').click();
    
    // Should still show the same toast (fallback mechanism)
    await expect(page.getByText('Link copied.')).toBeVisible();
  });
});