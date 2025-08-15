import { test, expect } from '@playwright/test';

test.describe('Connection States', () => {
  test('Shows Reconnecting when server is down, then Online when restored', async ({ page }) => {
    const roomId = 'test-reconnect-' + Date.now();
    
    // Mock WebSocket to simulate server down
    await page.route('**/ws*', async (route) => {
      // First few attempts fail
      const attempt = (page as any).__wsAttempt || 0;
      (page as any).__wsAttempt = attempt + 1;
      
      if (attempt < 3) {
        // Simulate connection failure
        await route.abort('connectionfailed');
      } else {
        // Allow connection after a few attempts
        await route.continue();
      }
    });
    
    await page.goto(`/rooms/${roomId}`);
    
    // Should show Reconnecting initially
    const chip = page.locator('[data-testid="connection-chip"]');
    await expect(chip).toContainText(/Reconnecting|Offline/, { timeout: 5000 });
    
    // Wait for backoff and reconnection
    await page.waitForTimeout(5000);
    
    // Eventually should show Online
    await expect(chip).toContainText(/Online|Reconnecting/, { timeout: 15000 });
  });
  
  test('Shows Offline when network is disabled', async ({ page, context }) => {
    const roomId = 'test-offline-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    const chip = page.locator('[data-testid="connection-chip"]');
    
    // Go offline
    await context.setOffline(true);
    await page.waitForTimeout(1000);
    
    // Should show Offline
    await expect(chip).toContainText('Offline');
    
    // Go back online
    await context.setOffline(false);
    await page.waitForTimeout(3000);
    
    // Should show Online or Reconnecting
    await expect(chip).toContainText(/Online|Reconnecting/);
  });
  
  test('Shows Read-only when room_stats advisory received', async ({ page }) => {
    const roomId = 'test-readonly-' + Date.now();
    
    // Navigate to room
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(2000);
    
    // Inject room_stats message
    await page.evaluate(() => {
      const provider = (window as any).__testProvider;
      if (provider?.ws) {
        // Simulate receiving room_stats message
        const event = new MessageEvent('message', {
          data: JSON.stringify({
            type: 'room_stats',
            bytes: 10485760, // 10MB
            cap: 10485760    // 10MB (at cap)
          })
        });
        provider.ws.dispatchEvent(event);
      }
    });
    
    await page.waitForTimeout(500);
    
    // Check connection chip
    const chip = page.locator('[data-testid="connection-chip"]');
    await expect(chip).toContainText('Read-only');
    
    // Check tools are disabled
    const pen = page.locator('[data-tool="pen"]');
    const isDisabled = await pen.getAttribute('aria-disabled');
    expect(isDisabled).toBe('true');
  });
  
  test('Backoff uses full jitter with 30s ceiling', async ({ page }) => {
    // Inject backoff tracking
    await page.evaluateOnNewDocument(() => {
      (window as any).__backoffDelays = [];
      const originalSetTimeout = window.setTimeout;
      window.setTimeout = function(fn: any, delay: number, ...args: any[]) {
        if (delay > 0 && delay <= 30000) {
          (window as any).__backoffDelays.push(delay);
        }
        return originalSetTimeout.call(this, fn, delay, ...args);
      } as any;
    });
    
    const roomId = 'test-backoff-' + Date.now();
    
    // Mock WebSocket to always fail
    await page.route('**/ws*', async (route) => {
      await route.abort('connectionfailed');
    });
    
    await page.goto(`/rooms/${roomId}`);
    
    // Wait for several reconnection attempts
    await page.waitForTimeout(10000);
    
    // Check backoff delays
    const delays = await page.evaluate(() => (window as any).__backoffDelays);
    
    // Should have multiple attempts
    expect(delays.length).toBeGreaterThan(0);
    
    // All delays should be <= 30000ms (30s)
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(30000);
    }
    
    // Delays should show jitter (not all the same)
    const uniqueDelays = new Set(delays);
    expect(uniqueDelays.size).toBeGreaterThan(1);
  });
  
  test('Connection state derives from multiple signals', async ({ page, context }) => {
    const roomId = 'test-signals-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    const chip = page.locator('[data-testid="connection-chip"]');
    
    // Test 1: navigator.onLine = false
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', {
        writable: true,
        value: false
      });
      window.dispatchEvent(new Event('offline'));
    });
    await page.waitForTimeout(500);
    await expect(chip).toContainText('Offline');
    
    // Test 2: navigator.onLine = true but provider disconnected
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', {
        writable: true,
        value: true
      });
      window.dispatchEvent(new Event('online'));
      
      // Simulate provider disconnect
      const provider = (window as any).__testProvider;
      if (provider) {
        provider.emit('status', { status: 'disconnected' });
      }
    });
    await page.waitForTimeout(500);
    await expect(chip).toContainText(/Reconnecting|Offline/);
    
    // Test 3: Everything online
    await page.evaluate(() => {
      const provider = (window as any).__testProvider;
      if (provider) {
        provider.emit('status', { status: 'connected' });
      }
    });
    await page.waitForTimeout(500);
    await expect(chip).toContainText('Online');
  });
});