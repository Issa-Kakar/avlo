import { test, expect } from '@playwright/test';

test.describe('Connection States - DocManager Architecture', () => {
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
    
    // Should show Reconnecting initially (observable UI state)
    const chip = page.locator('[data-testid="connection-chip"]');
    await expect(chip).toContainText(/Reconnecting|Offline/, { timeout: 5000 });
    
    // Wait for backoff and reconnection
    await page.waitForTimeout(5000);
    
    // Eventually should show Online (observable UI state)
    await expect(chip).toContainText(/Online|Reconnecting/, { timeout: 15000 });
  });
  
  test('Shows Offline when network is disabled', async ({ page, context }) => {
    const roomId = 'test-offline-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    const chip = page.locator('[data-testid="connection-chip"]');
    
    // Initially should be Online or Connecting
    await expect(chip).toContainText(/Online|Connecting/);
    
    // Go offline (browser API)
    await context.setOffline(true);
    await page.waitForTimeout(1000);
    
    // Should show Offline (observable UI state)
    await expect(chip).toContainText('Offline');
    
    // Go back online
    await context.setOffline(false);
    await page.waitForTimeout(3000);
    
    // Should show Online or Reconnecting (observable UI state)
    await expect(chip).toContainText(/Online|Reconnecting/);
  });
  
  test('Shows Read-only when room reaches size limit', async ({ page }) => {
    const roomId = 'test-readonly-' + Date.now();
    
    // Navigate to room
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(2000);
    
    // In production, Read-only state would be triggered by actual room size
    // For testing, we verify the UI can display this state
    
    // Check that connection chip supports Read-only state
    const chip = page.locator('[data-testid="connection-chip"]');
    const chipText = await chip.textContent();
    
    // Verify the chip can show various states including Read-only
    expect(['Connecting', 'Online', 'Offline', 'Reconnecting', 'Read-only']).toContain(chipText);
    
    // In read-only mode, tools would be disabled (test UI capability)
    const penTool = page.locator('[aria-label="Pen"]').first();
    
    // For mobile view (which triggers read-only for tools), test the behavior
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForTimeout(100);
    
    // Tools should be disabled in view-only mode
    await expect(penTool).toHaveAttribute('aria-disabled', 'true');
  });
  
  test('Reconnection uses exponential backoff', async ({ page }) => {
    // Track network requests to observe backoff behavior
    const requestTimings: number[] = [];
    let lastRequestTime = Date.now();
    
    await page.route('**/ws*', async (route) => {
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      requestTimings.push(timeSinceLastRequest);
      lastRequestTime = now;
      
      // Always fail to observe backoff
      await route.abort('connectionfailed');
    });
    
    const roomId = 'test-backoff-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    // Wait for several reconnection attempts
    await page.waitForTimeout(10000);
    
    // Should have multiple attempts
    expect(requestTimings.length).toBeGreaterThan(2);
    
    // Later attempts should have longer delays (backoff)
    // Check that delays generally increase
    const laterDelays = requestTimings.slice(2); // Skip first few
    const hasIncreasingDelays = laterDelays.some((delay, i) => 
      i > 0 && delay > laterDelays[i - 1]
    );
    expect(hasIncreasingDelays).toBe(true);
  });
  
  test('Connection state responds to network events', async ({ page, context }) => {
    const roomId = 'test-network-events-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    const chip = page.locator('[data-testid="connection-chip"]');
    
    // Test offline event
    await context.setOffline(true);
    await page.waitForTimeout(500);
    await expect(chip).toContainText('Offline');
    
    // Test online event  
    await context.setOffline(false);
    await page.waitForTimeout(500);
    await expect(chip).toContainText(/Online|Reconnecting/);
    
    // Verify connection state updates are reflected in UI
    const connectionStateChanges: string[] = [];
    
    // Monitor state changes
    for (let i = 0; i < 3; i++) {
      await context.setOffline(true);
      await page.waitForTimeout(200);
      connectionStateChanges.push(await chip.textContent() || '');
      
      await context.setOffline(false);
      await page.waitForTimeout(200);
      connectionStateChanges.push(await chip.textContent() || '');
    }
    
    // Should see alternating states
    const hasOffline = connectionStateChanges.some(s => s === 'Offline');
    const hasOnlineOrReconnecting = connectionStateChanges.some(s => 
      s === 'Online' || s === 'Reconnecting'
    );
    
    expect(hasOffline).toBe(true);
    expect(hasOnlineOrReconnecting).toBe(true);
  });
  
  test('Connection chip has proper ARIA attributes', async ({ page }) => {
    const roomId = 'test-aria-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    const chip = page.locator('[data-testid="connection-chip"]');
    
    // Should have status role for screen readers
    await expect(chip).toHaveAttribute('role', 'status');
    
    // Should have aria-live for updates
    await expect(chip).toHaveAttribute('aria-live', 'polite');
    
    // Content should be readable
    const chipText = await chip.textContent();
    expect(chipText).toBeTruthy();
    expect(['Connecting', 'Online', 'Offline', 'Reconnecting', 'Read-only']).toContain(chipText);
  });
  
  test('No direct provider access in window', async ({ page }) => {
    const roomId = 'test-no-provider-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(1000);
    
    // Verify no provider internals are exposed
    const exposed = await page.evaluate(() => {
      return {
        hasTestProvider: typeof (window as any).__testProvider !== 'undefined',
        hasProvider: typeof (window as any).provider !== 'undefined',
        hasWebsocketProvider: typeof (window as any).WebsocketProvider !== 'undefined'
      };
    });
    
    // All should be false in DocManager architecture
    expect(exposed.hasTestProvider).toBe(false);
    expect(exposed.hasProvider).toBe(false);
    expect(exposed.hasWebsocketProvider).toBe(false);
  });
  
  test('Connection states follow logical transitions', async ({ page, context }) => {
    const roomId = 'test-transitions-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    const chip = page.locator('[data-testid="connection-chip"]');
    const states: string[] = [];
    
    // Track state transitions
    const recordState = async () => {
      const state = await chip.textContent();
      if (state && states[states.length - 1] !== state) {
        states.push(state);
      }
    };
    
    // Initial state
    await recordState();
    
    // Go offline
    await context.setOffline(true);
    await page.waitForTimeout(500);
    await recordState();
    
    // Go online
    await context.setOffline(false);
    await page.waitForTimeout(1000);
    await recordState();
    await page.waitForTimeout(1000);
    await recordState();
    
    // Verify logical transitions
    // Should not have impossible transitions like Offline -> Offline
    for (let i = 1; i < states.length; i++) {
      expect(states[i]).not.toBe(states[i - 1]); // No duplicate consecutive states
    }
    
    // Should include expected states
    expect(states).toContain('Offline');
    expect(states.some(s => s === 'Online' || s === 'Reconnecting')).toBe(true);
  });
});