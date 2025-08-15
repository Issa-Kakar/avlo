import { test, expect } from '@playwright/test';

test.describe('Debug Detailed', () => {
  test('check room creation', async ({ page }) => {
    // Add console listener
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]:`, msg.text());
    });

    // Navigate to a room
    await page.goto('/rooms/testroom123');
    
    // Wait for React to render
    await page.waitForTimeout(1000);
    
    // Check if we're on the room page
    const url = page.url();
    console.log('Current URL:', url);
    
    // Check if room ID is being passed correctly
    const roomId = await page.evaluate(() => {
      // Try to get room ID from React Router
      const pathname = window.location.pathname;
      const match = pathname.match(/\/rooms\/(.+)/);
      return match ? match[1] : null;
    });
    console.log('Room ID from URL:', roomId);
    
    // Check if the Room component is rendered
    const hasBoard = await page.locator('#board').count();
    console.log('Board element exists:', hasBoard > 0);
    
    // Check connection chip
    const chipExists = await page.getByTestId('connection-chip').count();
    console.log('Connection chip exists:', chipExists > 0);
    
    if (chipExists > 0) {
      const chipText = await page.getByTestId('connection-chip').textContent();
      console.log('Connection chip text:', chipText);
    }
    
    // Check if room handles are created
    const roomInfo = await page.evaluate(() => {
      const testYDoc = (window as any).__testYDoc;
      const testProvider = (window as any).__testProvider;
      const testAwareness = (window as any).__testAwareness;
      
      return {
        hasYDoc: !!testYDoc,
        hasProvider: !!testProvider,
        hasAwareness: !!testAwareness,
        // Try to get more info about why they might not exist
        windowKeys: Object.keys(window).filter(k => k.startsWith('__test')),
      };
    });
    console.log('Room info:', roomInfo);
    
    // Try to check React component state if possible
    const componentInfo = await page.evaluate(() => {
      // Check if React DevTools hook is available
      const reactHook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (reactHook) {
        const renderers = reactHook.renderers;
        if (renderers && renderers.size > 0) {
          return {
            hasReact: true,
            renderersCount: renderers.size,
          };
        }
      }
      return { hasReact: false };
    });
    console.log('React info:', componentInfo);
    
    expect(true).toBe(true);
  });
});