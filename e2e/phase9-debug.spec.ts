import { test, expect } from '@playwright/test';

test.describe('Phase 9 - Debug Tests', () => {
  
  test('Check if app loads and Phase 9 exports are available', async ({ page }) => {
    // Navigate to a page to load the app
    await page.goto('/');
    
    // Wait a moment for the app to load
    await page.waitForTimeout(2000);
    
    // Check console logs
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(msg.text());
    });
    
    // Check what's actually available on the window object
    const debugInfo = await page.evaluate(() => {
      return {
        windowKeys: Object.keys(window),
        hasAvloPhase9: typeof (window as any).avloPhase9 !== 'undefined',
        avloPhase9Keys: (window as any).avloPhase9 ? Object.keys((window as any).avloPhase9) : null,
        isDevMode: typeof (window as any).ENV !== 'undefined' ? (window as any).ENV : 'unknown',
        documentTitle: document.title,
        currentUrl: location.href
      };
    });
    
    console.log('Debug info:', JSON.stringify(debugInfo, null, 2));
    console.log('Console logs:', consoleLogs);
    
    // Basic test - check if the app loaded
    expect(debugInfo.currentUrl).toContain('localhost:3000');
  });
  
  test('Try loading Phase 9 modules directly', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    
    const moduleTest = await page.evaluate(async () => {
      try {
        // Try to manually create IndexedDB instances
        const result = await new Promise((resolve) => {
          const request = indexedDB.open('test-phase9-debug', 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('test')) {
              db.createObjectStore('test', { keyPath: 'id' });
            }
          };
          request.onsuccess = () => {
            resolve({ success: true, dbName: request.result.name });
          };
          request.onerror = () => {
            resolve({ success: false, error: request.error?.message });
          };
        });
        
        return { indexedDbWorks: true, result };
      } catch (error) {
        return { 
          indexedDbWorks: false, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        };
      }
    });
    
    console.log('Module test result:', JSON.stringify(moduleTest, null, 2));
    expect(moduleTest.indexedDbWorks).toBe(true);
  });
});