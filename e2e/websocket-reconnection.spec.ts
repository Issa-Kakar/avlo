import { test, expect } from '@playwright/test';

test.describe('WebSocket Reconnection', () => {
  test('should show Reconnecting then Online when connection is restored', async ({ page, context }) => {
    await page.goto('/rooms/e2e-reconnect-test');
    
    // Initially should be Online
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Simulate network disconnection
    await context.setOffline(true);
    
    // Should show Offline
    await expect(page.getByTestId('connection-chip')).toContainText('Offline', { timeout: 5000 });
    
    // Restore network
    await context.setOffline(false);
    
    // Should show Reconnecting then Online
    await expect(page.getByTestId('connection-chip')).toContainText('Reconnecting', { timeout: 5000 });
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 30000 }); // Allow time for backoff
  });

  test('should persist data in IndexedDB when offline', async ({ page, context }) => {
    await page.goto('/rooms/e2e-offline-persist');
    
    // Wait for initial connection
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Add some test content (when drawing is implemented)
    // For now, just verify the room loads
    
    // Go offline
    await context.setOffline(true);
    await expect(page.getByTestId('connection-chip')).toContainText('Offline', { timeout: 5000 });
    
    // Reload page while offline
    await page.reload();
    
    // Should still show the room (loaded from IndexedDB)
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('connection-chip')).toContainText('Offline');
    
    // Go back online
    await context.setOffline(false);
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 30000 });
  });

  test('should handle large frame rejection gracefully', async ({ page }) => {
    await page.goto('/rooms/e2e-large-frame');
    
    // Wait for connection
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Try to send a large frame (>2MB)
    await page.evaluate(() => {
      // This would normally be done through Yjs, but for testing we can simulate
      const largeData = new Array(2 * 1024 * 1024 + 1).join('x');
      // Attempt to update the Yjs doc with large data
      if (window.ydoc) {
        const ytext = window.ydoc.getText('test');
        ytext.insert(0, largeData);
      }
    });
    
    // Should show the large frame error message
    await expect(page.getByText('Change too large. Refresh to rejoin.')).toBeVisible({ timeout: 5000 });
  });

  test('should show Read-only when room reaches 10MB', async ({ page }) => {
    await page.goto('/rooms/e2e-readonly-test');
    
    // Wait for connection
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Simulate receiving a room_readonly message
    await page.evaluate(() => {
      // Dispatch a custom event that the app should handle
      window.dispatchEvent(new CustomEvent('room_readonly', { 
        detail: { bytes: 10485760, cap: 10485760 } 
      }));
    });
    
    // Connection chip should show Read-only
    await expect(page.getByTestId('connection-chip')).toContainText('Read-only', { timeout: 5000 });
    
    // Should show read-only banner
    await expect(page.getByText('Board is read-only — size limit reached.')).toBeVisible();
  });
});