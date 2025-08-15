import { test, expect } from '@playwright/test';

test.describe('WebSocket Connectivity', () => {
  test('two tabs in same room should show presence and cursors', async ({ browser }) => {
    // Create two browser contexts (like separate users)
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    
    // Open first tab
    const page1 = await context1.newPage();
    await page1.goto('/rooms/e2e-presence-test');
    
    // Wait for connection
    await expect(page1.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Open second tab
    const page2 = await context2.newPage();
    await page2.goto('/rooms/e2e-presence-test');
    
    // Wait for connection
    await expect(page2.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Both should show 2 users
    await expect(page1.getByTestId('users-avatar-stack')).toContainText('2');
    await expect(page2.getByTestId('users-avatar-stack')).toContainText('2');
    
    // Move cursor in page1 and verify it appears in page2
    await page1.mouse.move(400, 300);
    await page1.waitForTimeout(100);
    
    // Check for remote cursor in page2 (should see 1 remote cursor)
    const remoteCursors = page2.locator('.remote-cursor');
    await expect(remoteCursors).toHaveCount(1, { timeout: 5000 });
    
    // Clean up
    await context1.close();
    await context2.close();
  });

  test('cursor update rate should be throttled to ~30Hz', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    
    await page1.goto('/rooms/e2e-throttle-test');
    await page2.goto('/rooms/e2e-throttle-test');
    
    // Wait for both to be online
    await expect(page1.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    await expect(page2.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Track cursor updates
    let updateCount = 0;
    await page2.evaluateOnNewDocument(() => {
      window.cursorUpdateCount = 0;
      const observer = new MutationObserver(() => {
        window.cursorUpdateCount++;
      });
      window.setupCursorObserver = () => {
        const cursor = document.querySelector('.remote-cursor');
        if (cursor) {
          observer.observe(cursor, { attributes: true, attributeFilter: ['style'] });
        }
      };
    });
    
    await page2.evaluate(() => window.setupCursorObserver());
    
    // Move cursor rapidly for 1 second
    const startTime = Date.now();
    while (Date.now() - startTime < 1000) {
      await page1.mouse.move(
        300 + Math.random() * 200,
        200 + Math.random() * 200
      );
      await page1.waitForTimeout(10); // Move every 10ms (100Hz)
    }
    
    // Get update count
    updateCount = await page2.evaluate(() => window.cursorUpdateCount);
    
    // Should be throttled to approximately 30 updates per second
    expect(updateCount).toBeGreaterThan(20);
    expect(updateCount).toBeLessThan(40);
    
    await context1.close();
    await context2.close();
  });

  test('room capacity should reject 106th client', async ({ browser }) => {
    const contexts = [];
    const pages = [];
    
    // Create 105 connections (max capacity)
    for (let i = 0; i < 105; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('/rooms/e2e-capacity-test', { waitUntil: 'domcontentloaded' });
      contexts.push(context);
      pages.push(page);
      
      // Add small delay to avoid overwhelming the server
      if (i % 10 === 0) {
        await page.waitForTimeout(100);
      }
    }
    
    // Verify first client is still connected
    await expect(pages[0].getByTestId('connection-chip')).toContainText('Online');
    
    // Try to connect 106th client
    const extraContext = await browser.newContext();
    const extraPage = await extraContext.newPage();
    await extraPage.goto('/rooms/e2e-capacity-test');
    
    // Should show room full message
    await expect(extraPage.getByText('Room is full — create a new room.')).toBeVisible({ timeout: 5000 });
    
    // Clean up
    await extraContext.close();
    for (const context of contexts) {
      await context.close();
    }
  });

  test('should enforce 8 WebSocket connections per IP', async ({ browser }) => {
    const contexts = [];
    
    // Create 8 connections (max per IP)
    for (let i = 0; i < 8; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`/rooms/e2e-ip-limit-${i}`);
      contexts.push(context);
      await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 5000 });
    }
    
    // Try 9th connection from same IP
    const extraContext = await browser.newContext();
    const extraPage = await extraContext.newPage();
    await extraPage.goto('/rooms/e2e-ip-limit-9');
    
    // Should fail to connect or show error
    await expect(extraPage.getByTestId('connection-chip')).not.toContainText('Online', { timeout: 5000 });
    
    // Clean up
    await extraContext.close();
    for (const context of contexts) {
      await context.close();
    }
  });
});