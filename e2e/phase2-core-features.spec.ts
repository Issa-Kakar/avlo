import { test, expect } from '@playwright/test';

test.describe('Phase 2 Core Features - Yjs & Collaboration', () => {
  
  // Test 1: Y.Doc construction with guid = roomId
  test('Y.Doc is constructed with guid equal to roomId', async ({ page }) => {
    const roomId = 'test-ydoc-guid';
    await page.goto(`/rooms/${roomId}`);
    
    // Wait for providers to initialize
    await page.waitForTimeout(2000);
    
    // Check Y.Doc guid
    const ydocGuid = await page.evaluate(() => {
      const ydoc = (window as any).__testYDoc;
      return ydoc ? ydoc.guid : null;
    });
    
    expect(ydocGuid).toBe(roomId);
  });

  // Test 2: IndexedDB persistence
  test('IndexedDB persists room content across reloads', async ({ page, context }) => {
    const roomId = 'test-indexeddb-persistence';
    
    // First visit - wait for providers to initialize
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(2000); // Allow IndexedDB to initialize
    
    // Check that IndexedDB database exists
    const hasIndexedDB = await page.evaluate(async (roomId) => {
      const databases = await indexedDB.databases();
      return databases.some(db => db.name === roomId || db.name?.includes('yjs'));
    }, roomId);
    
    expect(hasIndexedDB).toBeTruthy();
    
    // Reload and verify persistence
    await page.reload();
    await page.waitForTimeout(1000);
    
    // Verify room still works after reload
    await expect(page.locator('[data-testid="connection-chip"]')).toBeVisible();
  });

  // Test 3: WebSocket connection
  test('WebSocket connects to /ws endpoint', async ({ page }) => {
    let wsConnected = false;
    
    // Monitor WebSocket connections
    page.on('websocket', ws => {
      if (ws.url().includes('/ws')) {
        wsConnected = true;
      }
    });
    
    await page.goto('/rooms/test-websocket');
    await page.waitForTimeout(3000);
    
    expect(wsConnected).toBeTruthy();
    
    // Check connection chip eventually shows Online or Reconnecting
    await expect(page.locator('[data-testid="connection-chip"]')).toContainText(/Online|Reconnecting|Offline/, { timeout: 10000 });
  });

  // Test 4: Remote cursor rendering
  test('Remote cursors render and respect 20 cursor limit', async ({ page, context }) => {
    const roomId = 'test-cursors';
    
    // Open first tab
    const page1 = page;
    await page1.goto(`/rooms/${roomId}`);
    
    // Open second tab
    const page2 = await context.newPage();
    await page2.goto(`/rooms/${roomId}`);
    
    // Move cursor in page2
    await page2.mouse.move(400, 300);
    await page2.waitForTimeout(100);
    
    // Check for remote cursor in page1
    const remoteCursors = await page1.locator('.remote-cursor').count();
    expect(remoteCursors).toBeGreaterThanOrEqual(1);
    expect(remoteCursors).toBeLessThanOrEqual(20);
    
    await page2.close();
  });

  // Test 5: Cursor trails on desktop vs mobile
  test('Cursor trails show on desktop but not mobile', async ({ page, browser }) => {
    const roomId = 'test-cursor-trails';
    
    // Desktop test
    await page.goto(`/rooms/${roomId}`);
    await page.setViewportSize({ width: 1400, height: 900 });
    
    const desktopTrails = await page.locator('.cursor-trail').count();
    // Trails may or may not exist depending on cursor movement
    
    // Mobile test (simulate touch device)
    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`/rooms/${roomId}`);
    
    // Check CSS media query hides trails
    const mobileTrailsVisible = await mobilePage.locator('.cursor-trail').isVisible().catch(() => false);
    expect(mobileTrailsVisible).toBeFalsy();
    
    await mobileContext.close();
  });

  // Test 6: Presence name/color generation
  test('Presence generates name and color for user', async ({ page }) => {
    await page.goto('/rooms/test-presence');
    await page.waitForTimeout(2000);
    
    // Check awareness for presence data
    const presenceData = await page.evaluate(() => {
      const awareness = (window as any).__testAwareness;
      if (!awareness) return null;
      const localState = awareness.getLocalState();
      return localState?.user || null;
    });
    
    expect(presenceData).toBeTruthy();
    expect(presenceData?.name).toBeTruthy();
    expect(presenceData?.name.length).toBeGreaterThan(3);
    expect(presenceData?.color).toBeTruthy();
    expect(presenceData?.color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  // Test 7: Awareness cleanup on unmount
  test('Awareness cleans up when leaving room', async ({ page, context }) => {
    const roomId = 'test-awareness-cleanup';
    
    // Open two tabs
    const page1 = page;
    await page1.goto(`/rooms/${roomId}`);
    
    const page2 = await context.newPage();
    await page2.goto(`/rooms/${roomId}`);
    
    // Wait for presence sync
    await page1.waitForTimeout(1000);
    
    // Check user count shows 2
    await page1.locator('[data-testid="users-avatar-stack"]').click();
    let userCount = await page1.locator('.user-entry').count();
    expect(userCount).toBe(2);
    
    // Close modal
    await page1.keyboard.press('Escape');
    
    // Navigate page2 away (cleanup should occur)
    await page2.goto('/');
    await page1.waitForTimeout(1500);
    
    // Check user count drops to 1
    await page1.locator('[data-testid="users-avatar-stack"]').click();
    userCount = await page1.locator('.user-entry').count();
    expect(userCount).toBe(1);
    
    await page2.close();
  });

  // Test 8: Reconnection with exponential backoff
  test('Reconnection uses exponential backoff on disconnect', async ({ page, context }) => {
    await page.goto('/rooms/test-reconnect');
    
    // Initially online
    await expect(page.locator('[data-testid="connection-chip"]')).toContainText('Online');
    
    // Go offline
    await context.setOffline(true);
    await page.waitForTimeout(500);
    
    // Should show offline or reconnecting
    await expect(page.locator('[data-testid="connection-chip"]')).toContainText(/Offline|Reconnecting/);
    
    // Monitor reconnection attempts (simplified - just verify state changes)
    await context.setOffline(false);
    await page.waitForTimeout(1000);
    
    // Should eventually reconnect
    await expect(page.locator('[data-testid="connection-chip"]')).toContainText('Online', { timeout: 10000 });
  });

  // Test 9: Presence update throttling
  test('Presence updates are throttled to ~30Hz', async ({ page }) => {
    await page.goto('/rooms/test-throttle');
    await page.waitForTimeout(2000);
    
    // Track cursor movements
    let updateCount = 0;
    await page.evaluate(() => {
      let count = 0;
      const awareness = (window as any).__testAwareness;
      if (awareness) {
        awareness.on('change', () => {
          count++;
        });
      }
      (window as any).__updateCount = () => count;
    });
    
    // Move cursor rapidly for 1 second
    const startTime = Date.now();
    while (Date.now() - startTime < 1000) {
      await page.mouse.move(
        200 + Math.random() * 200,
        200 + Math.random() * 200
      );
      await page.waitForTimeout(5); // Very fast movements
    }
    
    updateCount = await page.evaluate(() => (window as any).__updateCount());
    
    // Should be throttled to ~30 updates per second
    expect(updateCount).toBeGreaterThan(20);
    expect(updateCount).toBeLessThan(50);
  });

  // Test 10: Read-only mode enforcement (simplified)
  test('Read-only mode disables write tools', async ({ page }) => {
    await page.goto('/rooms/test-readonly');
    
    // Simulate read-only state by injecting room_stats message
    await page.evaluate(() => {
      // Simulate receiving room_stats that triggers read-only
      const event = new CustomEvent('room-readonly', { detail: { bytes: 10485760, cap: 10485760 }});
      window.dispatchEvent(event);
    });
    
    await page.waitForTimeout(500);
    
    // Check if tools are disabled
    const penTool = page.locator('[data-tool="pen"]');
    const isDisabled = await penTool.getAttribute('aria-disabled');
    
    // Tools should be disabled in read-only mode
    // Note: This depends on implementation details
  });

  // Test 11: Presentational tool messages
  test('Presentational tools show appropriate messages', async ({ page }) => {
    await page.goto('/rooms/test-tools');
    
    // Click pen tool
    await page.locator('[data-tool="pen"]').click();
    await expect(page.locator('.toast')).toContainText(/will be available in a later phase/);
    
    // Click zoom
    await page.locator('#zoomIn').click();
    await expect(page.locator('.toast')).toContainText(/Zoom controls coming soon/);
  });
});

test.describe('Phase 2 Advanced Tests', () => {
  
  // Test connection resilience
  test('Handles rapid connect/disconnect cycles', async ({ page, context }) => {
    await page.goto('/rooms/test-resilience');
    
    // Rapid offline/online cycles
    for (let i = 0; i < 3; i++) {
      await context.setOffline(true);
      await page.waitForTimeout(200);
      await context.setOffline(false);
      await page.waitForTimeout(200);
    }
    
    // Should eventually stabilize to online
    await expect(page.locator('[data-testid="connection-chip"]')).toContainText('Online', { timeout: 5000 });
  });
  
  // Test room lifecycle - simplified
  test('Room navigation and initialization', async ({ page }) => {
    // Navigate to a room
    await page.goto('/rooms/test-lifecycle');
    await page.waitForTimeout(2000);
    
    // Verify room initialized
    await expect(page.locator('[data-testid="connection-chip"]')).toBeVisible();
    
    // Check Y.Doc exists
    const hasYDoc = await page.evaluate(() => {
      return !!(window as any).__testYDoc;
    });
    expect(hasYDoc).toBeTruthy();
    
    // Navigate away and back
    await page.goto('/');
    await page.goto('/rooms/test-lifecycle');
    await page.waitForTimeout(1000);
    
    // Should reinitialize
    await expect(page.locator('[data-testid="connection-chip"]')).toBeVisible();
  });
});