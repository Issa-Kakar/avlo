import { test, expect } from '@playwright/test';

test.describe('Presence and Cursors', () => {
  test('Users count equals rendered remote cursors (max 20)', async ({ browser }) => {
    const roomId = 'test-cursor-count-' + Date.now();
    const contexts = [];
    const pages = [];
    
    try {
      // Create 3 users
      for (let i = 0; i < 3; i++) {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        pages.push(page);
        await page.goto(`/rooms/${roomId}`);
        await page.waitForTimeout(2000);
      }
      
      // Check users count on first page
      const firstPage = pages[0];
      
      // Wait for avatar stack to show count
      const avatarStack = firstPage.locator('[data-testid="users-avatar-stack"]');
      await expect(avatarStack).toBeVisible({ timeout: 5000 });
      
      // Get user count from avatar stack
      const userCountText = await avatarStack.textContent();
      const userCount = parseInt(userCountText?.match(/\d+/)?.[0] || '0');
      
      // Count rendered cursor elements
      const cursorCount = await firstPage.evaluate(() => {
        // Look for cursor elements (adjust selector based on actual implementation)
        const cursors = document.querySelectorAll('.remote-cursor');
        return cursors.length;
      });
      
      // Users count should equal rendered cursors (up to 20)
      expect(cursorCount).toBeLessThanOrEqual(20);
      expect(cursorCount).toBe(Math.min(userCount - 1, 20)); // -1 for self
      
    } finally {
      // Clean up
      for (const context of contexts) {
        await context.close();
      }
    }
  });
  
  test('Presence updates at ~30Hz cadence', async ({ page, context }) => {
    const roomId = 'test-presence-cadence-' + Date.now();
    
    // Add debug hook for presence updates
    await page.evaluateOnNewDocument(() => {
      (window as any).__awareness_debug__ = {
        updateCount: 0,
        startTime: Date.now(),
      };
    });
    
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(2000);
    
    // Hook into awareness updates
    await page.evaluate(() => {
      const awareness = (window as any).__testAwareness;
      if (awareness) {
        const originalSetLocalStateField = awareness.setLocalStateField.bind(awareness);
        awareness.setLocalStateField = function(...args: any[]) {
          (window as any).__awareness_debug__.updateCount++;
          return originalSetLocalStateField(...args);
        };
      }
    });
    
    // Move mouse around to trigger cursor updates
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(100 + i * 50, 100 + i * 30);
      await page.waitForTimeout(100);
    }
    
    // Check update rate
    const stats = await page.evaluate(() => {
      const debug = (window as any).__awareness_debug__;
      const elapsed = Date.now() - debug.startTime;
      const rate = (debug.updateCount / elapsed) * 1000; // updates per second
      return { updateCount: debug.updateCount, rate };
    });
    
    // Should be throttled to approximately 30Hz (allowing some variance)
    expect(stats.rate).toBeLessThanOrEqual(35);
    expect(stats.rate).toBeGreaterThan(0);
  });
  
  test('Cursors are hidden on mobile', async ({ browser }) => {
    const roomId = 'test-mobile-cursors-' + Date.now();
    
    // Desktop context with cursor
    const desktopContext = await browser.newContext({
      viewport: { width: 1400, height: 900 }
    });
    const desktopPage = await desktopContext.newPage();
    await desktopPage.goto(`/rooms/${roomId}`);
    
    // Mobile context
    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`/rooms/${roomId}`);
    await mobilePage.waitForTimeout(2000);
    
    // Move desktop cursor
    await desktopPage.mouse.move(200, 200);
    await desktopPage.waitForTimeout(500);
    
    // Check cursor visibility on mobile
    const mobileCursors = await mobilePage.evaluate(() => {
      const cursors = document.querySelectorAll('.remote-cursor');
      return Array.from(cursors).map(c => {
        const style = window.getComputedStyle(c as HTMLElement);
        return {
          display: style.display,
          visibility: style.visibility,
        };
      });
    });
    
    // Cursors should be hidden on mobile
    for (const cursor of mobileCursors) {
      expect(cursor.display === 'none' || cursor.visibility === 'hidden').toBeTruthy();
    }
    
    await desktopContext.close();
    await mobileContext.close();
  });
  
  test('Presence persists across reconnection', async ({ page, context }) => {
    const roomId = 'test-presence-reconnect-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(2000);
    
    // Get initial presence
    const initialPresence = await page.evaluate(() => {
      const awareness = (window as any).__testAwareness;
      return awareness?.getLocalState()?.user;
    });
    
    expect(initialPresence).toBeTruthy();
    expect(initialPresence?.name).toBeTruthy();
    
    // Simulate disconnect
    await context.setOffline(true);
    await page.waitForTimeout(1000);
    
    // Reconnect
    await context.setOffline(false);
    await page.waitForTimeout(3000);
    
    // Check presence is restored
    const restoredPresence = await page.evaluate(() => {
      const awareness = (window as any).__testAwareness;
      return awareness?.getLocalState()?.user;
    });
    
    // Should have same name/color
    expect(restoredPresence?.name).toBe(initialPresence?.name);
    expect(restoredPresence?.color).toBe(initialPresence?.color);
  });
});