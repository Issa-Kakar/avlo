import { test, expect } from '@playwright/test';

test.describe('Copy Link and Toast Messages', () => {
  test('Copy link shows exact toast "Link copied."', async ({ page, context }) => {
    const roomId = 'test-copy-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    
    // Click copy link button
    const copyButton = page.locator('[data-testid="copy-link"]');
    await copyButton.click();
    
    // Check exact toast text
    const toast = page.locator('.toast');
    await expect(toast).toHaveText('Link copied.');
    
    // Verify clipboard content
    const clipboardText = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    });
    
    if (clipboardText) {
      expect(clipboardText).toBe(page.url());
    }
  });
  
  test('Copy link fallback works when clipboard API denied', async ({ page }) => {
    const roomId = 'test-copy-fallback-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    // Mock clipboard API to fail
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error('Clipboard access denied');
      };
    });
    
    // Click copy link button
    const copyButton = page.locator('[data-testid="copy-link"]');
    await copyButton.click();
    
    // Should still show success toast (fallback used)
    const toast = page.locator('.toast');
    await expect(toast).toHaveText('Link copied.');
  });
  
  test('Create room 429 shows exact toast', async ({ page }) => {
    // Mock API to return 429
    await page.route('**/api/rooms', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'rate_limited' })
        });
      } else {
        await route.continue();
      }
    });
    
    await page.goto('/');
    
    // Click create room
    const createButton = page.locator('[data-testid="create-room"]');
    await createButton.click();
    
    // Check exact toast text
    const toast = page.locator('.toast');
    await expect(toast).toHaveText('Too many requests — try again shortly.');
    
    // Button should be re-enabled after timeout
    await page.waitForTimeout(1200);
    const isDisabled = await createButton.isDisabled();
    expect(isDisabled).toBe(false);
  });
  
  test('Room full shows exact message', async ({ page }) => {
    const roomId = 'test-room-full-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(1000);
    
    // Inject room full message
    await page.evaluate(() => {
      const provider = (window as any).__testProvider;
      if (provider?.ws) {
        const event = new MessageEvent('message', {
          data: JSON.stringify({
            type: 'error',
            code: 'ROOM_FULL',
            message: 'Room is full — create a new room.'
          })
        });
        provider.ws.dispatchEvent(event);
      }
    });
    
    // Check toast
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Room is full — create a new room.');
  });
  
  test('Offline delta too large shows exact message', async ({ page }) => {
    const roomId = 'test-delta-large-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(1000);
    
    // Inject delta too large message
    await page.evaluate(() => {
      const provider = (window as any).__testProvider;
      if (provider?.ws) {
        const event = new MessageEvent('message', {
          data: JSON.stringify({
            type: 'error',
            code: 'DELTA_TOO_LARGE',
            message: 'Change too large. Refresh to rejoin.'
          })
        });
        provider.ws.dispatchEvent(event);
      }
    });
    
    // Check toast
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Change too large. Refresh to rejoin.');
  });
  
  test('Toasts auto-dismiss within 1.2s', async ({ page }) => {
    const roomId = 'test-toast-dismiss-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    // Trigger a toast
    await page.locator('[data-testid="copy-link"]').click();
    
    // Toast should be visible
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    
    // Should auto-dismiss within 1.2s (give a bit of buffer)
    await expect(toast).toBeHidden({ timeout: 1500 });
  });
  
  test('Toasts use aria-live="polite"', async ({ page }) => {
    const roomId = 'test-toast-aria-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    // Trigger a toast
    await page.locator('[data-testid="copy-link"]').click();
    
    // Check aria-live attribute
    const toast = page.locator('.toast');
    const ariaLive = await toast.getAttribute('aria-live');
    expect(ariaLive).toBe('polite');
  });
});