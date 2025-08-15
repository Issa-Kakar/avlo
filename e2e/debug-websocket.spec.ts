import { test, expect } from '@playwright/test';

test.describe('Debug WebSocket', () => {
  test('basic connection test', async ({ page }) => {
    // Add console listener to see all client-side logs
    page.on('console', msg => {
      console.log(`Browser ${msg.type()}:`, msg.text());
    });

    // Navigate to a room
    await page.goto('/rooms/debug-test-room');
    
    // Check if we're on the right page
    const url = page.url();
    console.log('Current URL:', url);
    
    // Wait a bit for initial render
    await page.waitForTimeout(2000);
    
    // Check what the connection chip shows
    const chipText = await page.getByTestId('connection-chip').textContent();
    console.log('Connection chip shows:', chipText);
    
    // Check if Y.Doc is available
    const hasYDoc = await page.evaluate(() => {
      return !!(window as any).__testYDoc;
    });
    console.log('Y.Doc available:', hasYDoc);
    
    // Check if provider is available
    const hasProvider = await page.evaluate(() => {
      return !!(window as any).__testProvider;
    });
    console.log('Provider available:', hasProvider);
    
    // Check WebSocket state if provider exists
    if (hasProvider) {
      const wsState = await page.evaluate(() => {
        const provider = (window as any).__testProvider;
        return {
          connected: provider.wsconnected,
          synced: provider.synced,
          url: provider.url,
          roomname: provider.roomname,
        };
      });
      console.log('WebSocket state:', wsState);
    }
    
    // Check awareness
    const hasAwareness = await page.evaluate(() => {
      return !!(window as any).__testAwareness;
    });
    console.log('Awareness available:', hasAwareness);
    
    if (hasAwareness) {
      const awarenessInfo = await page.evaluate(() => {
        const awareness = (window as any).__testAwareness;
        try {
          return {
            clientID: awareness.clientID || 'undefined',
            statesSize: awareness.getStates ? awareness.getStates().size : 0,
          };
        } catch (e) {
          return { error: e.message };
        }
      });
      console.log('Awareness info:', awarenessInfo);
    }
    
    // Wait a bit more to see if connection establishes
    await page.waitForTimeout(3000);
    
    // Check connection chip again
    const finalChipText = await page.getByTestId('connection-chip').textContent();
    console.log('Final connection chip shows:', finalChipText);
    
    // This test is just for debugging, so we don't assert anything
    expect(true).toBe(true);
  });
});