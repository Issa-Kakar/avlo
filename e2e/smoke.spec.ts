import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('app loads and displays title', async ({ page }) => {
    // Navigate to the home page
    await page.goto('/');

    // Check that the page title is correct
    await expect(page).toHaveTitle(/Avlo/);

    // Check that the main heading is visible
    await expect(page.locator('h1')).toContainText('Avlo');
  });

  test('health endpoint responds', async ({ request }) => {
    // Check the health endpoint
    const response = await request.get('/health');

    // Should return 200 status
    expect(response.ok()).toBeTruthy();

    // Should return JSON with status field
    const json = await response.json();
    expect(json.status).toBe('ok');
    expect(json.timestamp).toBeTruthy();
  });

  test('can navigate to a room URL', async ({ page }) => {
    // Navigate to a room URL pattern that will be used in the app
    await page.goto('/rooms/test-room');

    // Should still show the app (SPA routing)
    await expect(page).toHaveTitle(/Avlo/);
  });
});
