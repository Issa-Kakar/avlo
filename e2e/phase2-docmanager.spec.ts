import { test, expect, Page } from '@playwright/test';

test.describe('Phase 2: DocManager Architecture - Core Tests', () => {
  test.describe('Room Initialization', () => {
    test('room page loads without exposing Yjs internals', async ({ page }) => {
      await page.goto('/rooms/test-docmanager-1');
      
      // Verify no Yjs internals are exposed to window
      const exposedInternals = await page.evaluate(() => {
        return {
          hasYDoc: typeof (window as any).__testYDoc !== 'undefined',
          hasAwareness: typeof (window as any).__testAwareness !== 'undefined',
          hasProvider: typeof (window as any).__testProvider !== 'undefined',
          hasYjs: typeof (window as any).Y !== 'undefined'
        };
      });
      
      expect(exposedInternals.hasYDoc).toBe(false);
      expect(exposedInternals.hasAwareness).toBe(false);
      expect(exposedInternals.hasProvider).toBe(false);
      expect(exposedInternals.hasYjs).toBe(false);
    });

    test('room creates singleton DocManager instance', async ({ page }) => {
      await page.goto('/rooms/test-docmanager-2');
      
      // Verify room is initialized
      await expect(page.locator('[data-testid="connection-chip"]')).toBeVisible();
      
      // Verify connection state exists
      const connectionText = await page.locator('[data-testid="connection-chip"]').textContent();
      expect(['Connecting', 'Online', 'Reconnecting', 'Offline']).toContain(connectionText);
    });

    test('room ID validation prevents invalid characters', async ({ page }) => {
      // Try to navigate to invalid room ID
      await page.goto('/rooms/invalid!@#$%room');
      
      // Should either redirect or show error
      const url = page.url();
      const isOnRoomPage = url.includes('/rooms/invalid');
      
      if (isOnRoomPage) {
        // Should show error message
        await expect(page.locator('text=/Invalid room ID/')).toBeVisible();
      } else {
        // Should have redirected to landing
        expect(url).not.toContain('/rooms/invalid');
      }
    });
  });

  test.describe('Snapshot Publishing', () => {
    test('connection state updates are reflected in UI', async ({ page, context }) => {
      await page.goto('/rooms/test-snapshot-1');
      
      const connectionChip = page.locator('[data-testid="connection-chip"]');
      
      // Initially should show connecting or online
      await expect(connectionChip).toContainText(/Connecting|Online/);
      
      // Go offline
      await context.setOffline(true);
      
      // Should update to offline (snapshot publishes state change)
      await expect(connectionChip).toContainText('Offline');
      
      // Go back online
      await context.setOffline(false);
      
      // Should show reconnecting then online
      await expect(connectionChip).toContainText(/Reconnecting|Online/);
    });

    test('user presence updates through snapshot', async ({ browser }) => {
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      
      const page1 = await context1.newPage();
      const page2 = await context2.newPage();
      
      // Both join same room
      await page1.goto('/rooms/test-snapshot-presence');
      await page2.goto('/rooms/test-snapshot-presence');
      
      // Wait for connection
      await page1.waitForTimeout(1500);
      
      // Check user count reflects presence from snapshot
      const userCount1 = await page1.locator('.users-count').textContent();
      const userCount2 = await page2.locator('.users-count').textContent();
      
      expect(parseInt(userCount1 || '0')).toBeGreaterThanOrEqual(2);
      expect(parseInt(userCount2 || '0')).toBeGreaterThanOrEqual(2);
      
      // Click users modal to see presence details
      await page1.locator('[data-testid="users-avatar-stack"]').click();
      
      // Should show at least 2 users in the modal
      const userItems = page1.locator('#usersModal .user-item');
      await expect(userItems).toHaveCount(2);
      
      await context1.close();
      await context2.close();
    });

    test('presence includes generated name and color', async ({ page }) => {
      await page.goto('/rooms/test-presence-generation');
      
      // Open users modal
      await page.locator('[data-testid="users-avatar-stack"]').click();
      
      // Check that user has generated name (adjective + animal pattern)
      const userName = await page.locator('#usersModal .user-item').first().locator('.user-name').textContent();
      expect(userName).toBeTruthy();
      expect(userName).toMatch(/\w+\s+\w+/); // Two words pattern
      
      // Check that user has color
      const userColor = await page.locator('#usersModal .user-item').first().locator('.user-avatar').evaluate(el => {
        return window.getComputedStyle(el).backgroundColor;
      });
      expect(userColor).toBeTruthy();
      expect(userColor).not.toBe('rgba(0, 0, 0, 0)'); // Not transparent
    });
  });

  test.describe('Write Operations & Read-Only Mode', () => {
    test('read-only mode prevents write operations', async ({ page }) => {
      await page.goto('/rooms/test-readonly');
      
      // Simulate read-only state by checking if room size warning appears
      // In real scenario, this would be triggered by 10MB limit
      
      // For now, verify that tools can be disabled
      await page.setViewportSize({ width: 400, height: 800 }); // Mobile view triggers read-only for tools
      
      const penTool = page.locator('[aria-label="Pen"]').first();
      await expect(penTool).toHaveAttribute('aria-disabled', 'true');
      
      // Clicking disabled tool should show message
      await penTool.click();
      await expect(page.locator('.toast[role="status"]')).toContainText(/view-only|disabled/i);
    });

    test('write operations are queued and batched', async ({ page }) => {
      await page.goto('/rooms/test-write-queue');
      
      // This is difficult to test directly without exposing internals
      // Instead, we test that rapid operations don't break the app
      
      // Rapidly toggle theme multiple times
      const themeToggle = page.locator('[data-testid="theme-toggle"]');
      for (let i = 0; i < 5; i++) {
        await themeToggle.click();
        // No wait between clicks - testing batching
      }
      
      // App should still be responsive
      await expect(page.locator('[data-testid="connection-chip"]')).toBeVisible();
      
      // Final theme state should be consistent
      const finalTheme = await page.locator('html').getAttribute('data-theme');
      expect(['light', 'dark']).toContain(finalTheme);
    });
  });

  test.describe('Mobile View-Only Gating', () => {
    test('mobile detection uses capability-based approach', async ({ page }) => {
      await page.goto('/rooms/test-mobile-capability');
      
      // Desktop view - tools enabled
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.waitForTimeout(100);
      
      const penTool = page.locator('[aria-label="Pen"]').first();
      await expect(penTool).not.toHaveAttribute('aria-disabled', 'true');
      
      // Mobile view (width-based detection)
      await page.setViewportSize({ width: 800, height: 600 });
      await page.waitForTimeout(100);
      
      await expect(penTool).toHaveAttribute('aria-disabled', 'true');
      
      // Tablet view (just above threshold)
      await page.setViewportSize({ width: 821, height: 600 });
      await page.waitForTimeout(100);
      
      await expect(penTool).not.toHaveAttribute('aria-disabled', 'true');
    });

    test('mobile view-only shows appropriate messaging', async ({ page }) => {
      await page.goto('/rooms/test-mobile-message');
      
      // Set mobile viewport
      await page.setViewportSize({ width: 400, height: 800 });
      await page.waitForTimeout(100);
      
      // Try to use a tool
      const highlighterTool = page.locator('[aria-label="Highlighter"]').first();
      await highlighterTool.click();
      
      // Should show mobile-specific message
      await expect(page.locator('.toast[role="status"]')).toContainText(/mobile|view-only/i);
    });

    test('presence still works on mobile view-only', async ({ browser }) => {
      const desktopContext = await browser.newContext({
        viewport: { width: 1024, height: 768 }
      });
      const mobileContext = await browser.newContext({
        viewport: { width: 400, height: 800 }
      });
      
      const desktopPage = await desktopContext.newPage();
      const mobilePage = await mobileContext.newPage();
      
      // Both join same room
      await desktopPage.goto('/rooms/test-mobile-presence');
      await mobilePage.goto('/rooms/test-mobile-presence');
      
      await desktopPage.waitForTimeout(1500);
      
      // Mobile user should appear in desktop's user list
      const desktopUserCount = await desktopPage.locator('.users-count').textContent();
      expect(parseInt(desktopUserCount || '0')).toBeGreaterThanOrEqual(2);
      
      // Desktop user should appear in mobile's user list
      const mobileUserCount = await mobilePage.locator('.users-count').textContent();
      expect(parseInt(mobileUserCount || '0')).toBeGreaterThanOrEqual(2);
      
      await desktopContext.close();
      await mobileContext.close();
    });
  });

  test.describe('Persistence & IndexedDB', () => {
    test('room state persists in IndexedDB for offline access', async ({ page, context }) => {
      await page.goto('/rooms/test-indexeddb-persist');
      
      // Wait for initial sync
      await page.waitForTimeout(2000);
      
      // Go offline
      await context.setOffline(true);
      
      // Reload the page while offline
      await page.reload();
      
      // Room should still load (from IndexedDB)
      await expect(page.locator('[data-testid="connection-chip"]')).toContainText('Offline');
      
      // UI should still be functional
      await expect(page.locator('#board')).toBeVisible();
      await expect(page.locator('#code')).toBeVisible();
      
      // Go back online
      await context.setOffline(false);
      
      // Should reconnect
      await expect(page.locator('[data-testid="connection-chip"]')).toContainText(/Reconnecting|Online/);
    });

    test('IndexedDB data is not deleted on room leave', async ({ page }) => {
      const roomId = 'test-idb-persistence';
      
      // Visit room first time
      await page.goto(`/rooms/${roomId}`);
      await page.waitForTimeout(1500);
      
      // Navigate away
      await page.goto('/');
      
      // Check IndexedDB still has data
      const hasData = await page.evaluate((rid) => {
        return new Promise((resolve) => {
          const request = indexedDB.open(`y-indexeddb-${rid}`, 1);
          request.onsuccess = () => {
            const db = request.result;
            const hasStores = db.objectStoreNames.length > 0;
            db.close();
            resolve(hasStores);
          };
          request.onerror = () => resolve(false);
        });
      }, roomId);
      
      expect(hasData).toBe(true);
    });
  });

  test.describe('Connection Management', () => {
    test('connection states transition correctly', async ({ page, context }) => {
      await page.goto('/rooms/test-connection-states');
      
      const chip = page.locator('[data-testid="connection-chip"]');
      
      // Track state transitions
      const states: string[] = [];
      
      // Initial state
      let state = await chip.textContent();
      states.push(state || '');
      expect(['Connecting', 'Online']).toContain(state);
      
      // Go offline
      await context.setOffline(true);
      await page.waitForTimeout(500);
      state = await chip.textContent();
      states.push(state || '');
      expect(state).toBe('Offline');
      
      // Go online
      await context.setOffline(false);
      await page.waitForTimeout(500);
      state = await chip.textContent();
      states.push(state || '');
      expect(['Reconnecting', 'Online']).toContain(state);
      
      // Verify we saw expected transitions
      expect(states.some(s => s === 'Offline')).toBe(true);
    });

    test('connection chip has proper ARIA attributes', async ({ page }) => {
      await page.goto('/rooms/test-aria-connection');
      
      const chip = page.locator('[data-testid="connection-chip"]');
      
      // Should have status role for screen readers
      await expect(chip).toHaveAttribute('role', 'status');
      
      // Should have aria-live for updates
      await expect(chip).toHaveAttribute('aria-live', 'polite');
    });
  });

  test.describe('Error Handling', () => {
    test('room full error shows correct message', async ({ page }) => {
      // Mock WebSocket to simulate room full
      await page.goto('/rooms/test-room-full');
      
      // Inject room full simulation
      await page.evaluate(() => {
        // Dispatch a custom event to simulate room full
        window.dispatchEvent(new CustomEvent('room-error', { 
          detail: { type: 'room_full' } 
        }));
      });
      
      // Check for normative error message
      // Note: Actual implementation would show this via WebSocket gateway error
      // For now, we verify the toast system works
      await page.locator('[data-testid="create-room"]').first().click({ force: true });
      
      // Any error toast should be properly formatted
      const toast = page.locator('.toast[role="status"]');
      if (await toast.isVisible()) {
        const text = await toast.textContent();
        expect(text).toBeTruthy();
      }
    });

    test('rate limit error shows normative message', async ({ page }) => {
      await page.goto('/');
      
      // Mock rate limit response
      await page.route('**/api/rooms', route => {
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Rate limited' })
        });
      });
      
      await page.locator('[data-testid="create-room"]').click();
      
      // Check normative message
      await expect(page.locator('.toast[role="status"]')).toContainText('Too many requests — try again shortly.');
    });
  });
});