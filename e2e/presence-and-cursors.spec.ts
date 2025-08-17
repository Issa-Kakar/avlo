import { test, expect } from '@playwright/test';

test.describe('Presence and Cursors - DocManager Architecture', () => {
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
      
      // Get user count from avatar stack (UI element)
      const userCountElement = firstPage.locator('.users-count');
      const userCountText = await userCountElement.textContent();
      const userCount = parseInt(userCountText || '0');
      
      // Count rendered cursor elements (UI elements)
      const cursorCount = await firstPage.evaluate(() => {
        // Look for cursor elements in the UI
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
  
  test('Presence updates are throttled (observable behavior)', async ({ page }) => {
    const roomId = 'test-presence-throttle-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(2000);
    
    // Track cursor position changes in UI
    let positionChanges = 0;
    let lastPosition = { x: 0, y: 0 };
    
    // Monitor cursor position updates through UI observation
    await page.evaluateOnNewDocument(() => {
      let updateCount = 0;
      let lastTime = Date.now();
      
      // Use MutationObserver to track cursor updates in the DOM
      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastTime > 30) { // ~30Hz check
          updateCount++;
          lastTime = now;
        }
      });
      
      // Start observing once board is ready
      setTimeout(() => {
        const board = document.querySelector('#board');
        if (board) {
          observer.observe(board, { 
            childList: true, 
            subtree: true, 
            attributes: true 
          });
        }
      }, 1000);
      
      (window as any).getUpdateCount = () => updateCount;
    });
    
    await page.reload();
    await page.waitForTimeout(2000);
    
    // Move mouse continuously for 1 second
    const board = page.locator('#board');
    const box = await board.boundingBox();
    
    if (box) {
      const startTime = Date.now();
      while (Date.now() - startTime < 1000) {
        await page.mouse.move(
          box.x + Math.random() * box.width,
          box.y + Math.random() * box.height
        );
        await page.waitForTimeout(10);
      }
    }
    
    // Check that updates are happening but throttled
    const updateCount = await page.evaluate(() => (window as any).getUpdateCount?.() || 0);
    
    // Should have some updates but not excessive (throttled)
    expect(updateCount).toBeGreaterThan(0);
    expect(updateCount).toBeLessThan(100); // Should be throttled
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
    
    // Check cursor visibility on mobile through CSS
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
  
  test('Presence persists across reconnection (UI verification)', async ({ page, context }) => {
    const roomId = 'test-presence-reconnect-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(2000);
    
    // Get initial presence from UI
    await page.locator('[data-testid="users-avatar-stack"]').click();
    
    // Get user name from modal
    const initialName = await page.locator('#usersModal .user-item').first().locator('.user-name').textContent();
    
    // Get user color from avatar
    const initialColor = await page.locator('#usersModal .user-item').first().locator('.user-avatar').evaluate(el => {
      return window.getComputedStyle(el).backgroundColor;
    });
    
    // Close modal
    await page.keyboard.press('Escape');
    
    expect(initialName).toBeTruthy();
    expect(initialColor).toBeTruthy();
    
    // Simulate disconnect
    await context.setOffline(true);
    await page.waitForTimeout(1000);
    
    // Verify offline state
    await expect(page.locator('[data-testid="connection-chip"]')).toContainText('Offline');
    
    // Reconnect
    await context.setOffline(false);
    await page.waitForTimeout(3000);
    
    // Verify reconnected
    await expect(page.locator('[data-testid="connection-chip"]')).toContainText(/Reconnecting|Online/);
    
    // Check presence is restored in UI
    await page.locator('[data-testid="users-avatar-stack"]').click();
    
    const restoredName = await page.locator('#usersModal .user-item').first().locator('.user-name').textContent();
    const restoredColor = await page.locator('#usersModal .user-item').first().locator('.user-avatar').evaluate(el => {
      return window.getComputedStyle(el).backgroundColor;
    });
    
    // Should have same name/color
    expect(restoredName).toBe(initialName);
    expect(restoredColor).toBe(initialColor);
  });
  
  test('No direct Yjs access in window', async ({ page }) => {
    await page.goto('/rooms/test-no-yjs-window');
    await page.waitForTimeout(1000);
    
    // Verify no Yjs internals are exposed
    const exposed = await page.evaluate(() => {
      return {
        hasTestAwareness: typeof (window as any).__testAwareness !== 'undefined',
        hasTestYDoc: typeof (window as any).__testYDoc !== 'undefined',
        hasTestProvider: typeof (window as any).__testProvider !== 'undefined',
        hasYjs: typeof (window as any).Y !== 'undefined'
      };
    });
    
    // All should be false in DocManager architecture
    expect(exposed.hasTestAwareness).toBe(false);
    expect(exposed.hasTestYDoc).toBe(false);
    expect(exposed.hasTestProvider).toBe(false);
    expect(exposed.hasYjs).toBe(false);
  });
});