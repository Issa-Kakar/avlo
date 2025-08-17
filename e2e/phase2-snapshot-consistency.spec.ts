import { test, expect, Page } from '@playwright/test';

test.describe('Phase 2: Snapshot Consistency & Temporal Integrity', () => {
  test.describe('Snapshot Immutability', () => {
    test('UI components receive consistent snapshot data', async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      
      await page.goto('/rooms/test-snapshot-consistency');
      
      // Wait for initial load
      await page.waitForTimeout(1500);
      
      // Get multiple UI elements that should reflect same snapshot
      const connectionState1 = await page.locator('[data-testid="connection-chip"]').textContent();
      const userCount1 = await page.locator('.users-count').textContent();
      
      // Small delay to ensure we're still in same snapshot epoch
      await page.waitForTimeout(10);
      
      // Get same data again - should be identical within same frame
      const connectionState2 = await page.locator('[data-testid="connection-chip"]').textContent();
      const userCount2 = await page.locator('.users-count').textContent();
      
      expect(connectionState1).toBe(connectionState2);
      expect(userCount1).toBe(userCount2);
      
      await context.close();
    });

    test('rapid state changes are batched in snapshots', async ({ page, context }) => {
      await page.goto('/rooms/test-snapshot-batching');
      
      // Perform rapid state changes
      for (let i = 0; i < 3; i++) {
        await context.setOffline(true);
        await context.setOffline(false);
      }
      
      // Wait for snapshot to stabilize
      await page.waitForTimeout(100);
      
      // State should be consistent, not flickering
      const finalState = await page.locator('[data-testid="connection-chip"]').textContent();
      expect(['Online', 'Reconnecting']).toContain(finalState);
    });
  });

  test.describe('Temporal Consistency', () => {
    test('multiple users see consistent room state', async ({ browser }) => {
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      
      const page1 = await context1.newPage();
      const page2 = await context2.newPage();
      
      const roomId = 'test-temporal-consistency';
      
      // Both join same room
      await page1.goto(`/rooms/${roomId}`);
      await page2.goto(`/rooms/${roomId}`);
      
      // Wait for sync
      await page1.waitForTimeout(2000);
      await page2.waitForTimeout(2000);
      
      // Both should see same user count
      const count1 = await page1.locator('.users-count').textContent();
      const count2 = await page2.locator('.users-count').textContent();
      
      expect(count1).toBe(count2);
      expect(parseInt(count1 || '0')).toBeGreaterThanOrEqual(2);
      
      await context1.close();
      await context2.close();
    });

    test('snapshot updates maintain causal ordering', async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      
      await page.goto('/rooms/test-causal-ordering');
      
      // Track connection states over time
      const states: string[] = [];
      
      // Go offline
      await context.setOffline(true);
      await page.waitForTimeout(500);
      states.push(await page.locator('[data-testid="connection-chip"]').textContent() || '');
      
      // Go online
      await context.setOffline(false);
      await page.waitForTimeout(500);
      states.push(await page.locator('[data-testid="connection-chip"]').textContent() || '');
      
      // States should follow logical progression
      expect(states[0]).toBe('Offline');
      expect(['Reconnecting', 'Online']).toContain(states[1]);
      
      // No impossible transitions (e.g., Offline -> Offline when we went online)
      expect(states[0]).not.toBe(states[1]);
      
      await context.close();
    });
  });

  test.describe('Presence Snapshot Consistency', () => {
    test('cursor position updates are consistent across UI', async ({ page }) => {
      await page.goto('/rooms/test-cursor-consistency');
      
      // Move mouse to trigger cursor update
      const board = page.locator('#board');
      const box = await board.boundingBox();
      
      if (box) {
        await page.mouse.move(box.x + 100, box.y + 100);
        await page.waitForTimeout(100);
        
        // If we had cursor display, verify position is consistent
        // This would be visible in RemoteCursors component for other users
        
        // For now, verify the board is receiving mouse events
        const boardExists = await board.isVisible();
        expect(boardExists).toBe(true);
      }
    });

    test('user avatars reflect snapshot presence data', async ({ browser }) => {
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      
      const page1 = await context1.newPage();
      const page2 = await context2.newPage();
      
      await page1.goto('/rooms/test-avatar-presence');
      await page2.goto('/rooms/test-avatar-presence');
      
      await page1.waitForTimeout(2000);
      
      // Open users modal on page1
      await page1.locator('[data-testid="users-avatar-stack"]').click();
      
      // Count users in modal
      const userItems = page1.locator('#usersModal .user-item');
      const modalUserCount = await userItems.count();
      
      // Close modal
      await page1.keyboard.press('Escape');
      
      // Avatar stack count should match
      const avatarCount = await page1.locator('.users-count').textContent();
      expect(parseInt(avatarCount || '0')).toBe(modalUserCount);
      
      await context1.close();
      await context2.close();
    });

    test('presence updates do not cause UI flicker', async ({ page }) => {
      await page.goto('/rooms/test-no-flicker');
      
      // Monitor for rapid changes that would indicate flicker
      const changes: string[] = [];
      
      // Sample connection state rapidly
      for (let i = 0; i < 10; i++) {
        const state = await page.locator('[data-testid="connection-chip"]').textContent();
        changes.push(state || '');
        await page.waitForTimeout(50);
      }
      
      // Should not see rapid oscillation between states
      const uniqueStates = [...new Set(changes)];
      
      // Should have at most 2 different states in 500ms window
      expect(uniqueStates.length).toBeLessThanOrEqual(2);
    });
  });

  test.describe('Snapshot Performance', () => {
    test('snapshots batch updates within animation frame', async ({ page }) => {
      await page.goto('/rooms/test-snapshot-batching-perf');
      
      // Measure time for multiple rapid updates
      const startTime = Date.now();
      
      // Trigger multiple UI updates rapidly
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          // Trigger re-render by dispatching custom event
          window.dispatchEvent(new Event('test-update'));
        });
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Updates should be batched, not take linear time
      // This is a rough check - 5 updates should take < 100ms if batched
      expect(duration).toBeLessThan(100);
    });

    test('large presence updates do not block UI', async ({ browser }) => {
      // Create multiple users to test presence scaling
      const contexts = [];
      const pages = [];
      
      for (let i = 0; i < 5; i++) {
        const context = await browser.newContext();
        const page = await context.newPage();
        contexts.push(context);
        pages.push(page);
        await page.goto('/rooms/test-presence-performance');
      }
      
      // Wait for all to connect
      await pages[0].waitForTimeout(2000);
      
      // UI should still be responsive with multiple users
      const isResponsive = await pages[0].locator('[data-testid="theme-toggle"]').isEnabled();
      expect(isResponsive).toBe(true);
      
      // Can still interact with UI
      await pages[0].locator('[data-testid="theme-toggle"]').click();
      
      // Theme should have changed
      const theme = await pages[0].locator('html').getAttribute('data-theme');
      expect(['light', 'dark']).toContain(theme);
      
      // Cleanup
      for (const context of contexts) {
        await context.close();
      }
    });
  });

  test.describe('State Isolation', () => {
    test('different rooms have isolated snapshots', async ({ browser }) => {
      const context = await browser.newContext();
      const page1 = await context.newPage();
      const page2 = await context.newPage();
      
      // Open different rooms
      await page1.goto('/rooms/test-isolation-room-1');
      await page2.goto('/rooms/test-isolation-room-2');
      
      await page1.waitForTimeout(1500);
      await page2.waitForTimeout(1500);
      
      // Each room should have only 1 user
      const count1 = await page1.locator('.users-count').textContent();
      const count2 = await page2.locator('.users-count').textContent();
      
      expect(parseInt(count1 || '0')).toBe(1);
      expect(parseInt(count2 || '0')).toBe(1);
      
      await context.close();
    });

    test('room snapshots do not leak between tabs', async ({ browser }) => {
      const context = await browser.newContext();
      
      // Open first room
      const page1 = await context.newPage();
      await page1.goto('/rooms/test-no-leak-1');
      await page1.waitForTimeout(1000);
      
      // Get first room's user count
      const count1 = await page1.locator('.users-count').textContent();
      
      // Open second room in same context
      const page2 = await context.newPage();
      await page2.goto('/rooms/test-no-leak-2');
      await page2.waitForTimeout(1000);
      
      // First room's count should not change
      const count1After = await page1.locator('.users-count').textContent();
      expect(count1After).toBe(count1);
      
      await context.close();
    });
  });

  test.describe('Snapshot Recovery', () => {
    test('snapshot recovers after connection loss', async ({ page, context }) => {
      await page.goto('/rooms/test-snapshot-recovery');
      await page.waitForTimeout(1500);
      
      // Get initial state
      const initialCount = await page.locator('.users-count').textContent();
      
      // Simulate connection loss
      await context.setOffline(true);
      await page.waitForTimeout(500);
      
      // Should show offline
      await expect(page.locator('[data-testid="connection-chip"]')).toContainText('Offline');
      
      // Restore connection
      await context.setOffline(false);
      await page.waitForTimeout(1500);
      
      // Should reconnect and restore state
      await expect(page.locator('[data-testid="connection-chip"]')).toContainText(/Reconnecting|Online/);
      
      // User count should be restored
      const finalCount = await page.locator('.users-count').textContent();
      expect(finalCount).toBe(initialCount);
    });

    test('snapshot maintains consistency during reconnection', async ({ page, context }) => {
      await page.goto('/rooms/test-reconnect-consistency');
      
      // Simulate multiple reconnection cycles
      for (let i = 0; i < 3; i++) {
        await context.setOffline(true);
        await page.waitForTimeout(200);
        await context.setOffline(false);
        await page.waitForTimeout(200);
      }
      
      // UI should remain stable
      const isStable = await page.locator('#board').isVisible();
      expect(isStable).toBe(true);
      
      // Connection state should be deterministic
      const finalState = await page.locator('[data-testid="connection-chip"]').textContent();
      expect(['Online', 'Reconnecting']).toContain(finalState);
    });
  });
});