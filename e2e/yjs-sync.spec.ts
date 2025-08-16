import { test, expect } from '@playwright/test';

test.describe('Yjs WebSocket Sync', () => {
  test('should establish WebSocket connection and sync', async ({ page }) => {
    // Navigate to a room
    await page.goto('/rooms/e2e-sync-test');
    
    // Wait for the connection indicator to show "Online"
    await expect(page.getByText('Online')).toBeVisible({ timeout: 10000 });
    
    // Verify that the Yjs document is available in the page context
    const hasYjsDoc = await page.evaluate(() => {
      return !!(window as any).ydoc;
    });
    expect(hasYjsDoc).toBe(true);
    
    // Test that data can be synced
    const testData = await page.evaluate(() => {
      const ydoc = (window as any).ydoc;
      if (!ydoc) return null;
      
      const ymap = ydoc.getMap('test');
      ymap.set('e2e-test', 'Hello from E2E');
      return ymap.get('e2e-test');
    });
    
    expect(testData).toBe('Hello from E2E');
  });

  test('should sync data between two tabs', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    
    const roomId = 'e2e-sync-multi-' + Date.now();
    
    // Both pages navigate to the same room
    await page1.goto(`/rooms/${roomId}`);
    await page2.goto(`/rooms/${roomId}`);
    
    // Wait for both to be online
    await expect(page1.getByText('Online')).toBeVisible({ timeout: 10000 });
    await expect(page2.getByText('Online')).toBeVisible({ timeout: 10000 });
    
    // Page 1 sets data
    await page1.evaluate(() => {
      const ydoc = (window as any).ydoc;
      if (ydoc) {
        const ymap = ydoc.getMap('test');
        ymap.set('message', 'Hello from Page 1');
      }
    });
    
    // Wait a moment for sync
    await page2.waitForTimeout(1000);
    
    // Page 2 should see the data
    const receivedData = await page2.evaluate(() => {
      const ydoc = (window as any).ydoc;
      if (ydoc) {
        const ymap = ydoc.getMap('test');
        return ymap.get('message');
      }
      return null;
    });
    
    expect(receivedData).toBe('Hello from Page 1');
    
    await context1.close();
    await context2.close();
  });
});