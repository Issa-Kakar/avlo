import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Enable limits UI for e2e tests
    (window as any).__LIMITS_UI_ENABLED_OVERRIDE = true;
    try {
      window.localStorage.setItem('LIMITS_UI_ENABLED', 'true');
      console.log('[Test] localStorage LIMITS_UI_ENABLED set to true, override flag set');
    } catch (e) {
      console.error('[Test] Failed to set localStorage:', e);
    }
  });
});

test.describe('Phase 8 - Debug', () => {
  test('check if limits UI is enabled', async ({ page }) => {
    page.on('console', (msg) => console.log('Browser', msg.type(), msg.text()));

    await page.goto('/rooms/e2e-phase8-debug');
    await expect(page.getByTestId('connection-chip')).toBeVisible();

    // Wait for page to load
    await page.waitForTimeout(1000);

    // Check if limits UI is enabled
    const limitsEnabled = await page.evaluate(() => {
      // Check localStorage directly
      const localValue = window.localStorage.getItem('LIMITS_UI_ENABLED');
      console.log('[Debug] localStorage LIMITS_UI_ENABLED value:', localValue);

      // Check if isLimitsUIEnabled function exists and what it returns
      const funcExists = typeof (window as any).isLimitsUIEnabled === 'function';
      console.log('[Debug] isLimitsUIEnabled function exists:', funcExists);

      // Check if __phase8TestReady is set
      const testReady = (window as any).__phase8TestReady;
      console.log('[Debug] __phase8TestReady:', testReady);

      // Check room handles
      const hasProvider = Boolean((window as any).__testProvider);
      const hasYDoc = Boolean((window as any).__testYDoc);
      const hasAwareness = Boolean((window as any).__testAwareness);
      console.log(
        '[Debug] Test handles - provider:',
        hasProvider,
        'ydoc:',
        hasYDoc,
        'awareness:',
        hasAwareness,
      );

      return {
        localValue,
        funcExists,
        testReady,
        hasProvider,
        hasYDoc,
        hasAwareness,
      };
    });

    console.log('Limits UI debug info:', limitsEnabled);

    // Test dispatching a custom event directly
    await page.evaluate(() => {
      console.log('[Debug] Dispatching test room-stats-update event');
      window.dispatchEvent(
        new CustomEvent('room-stats-update', {
          detail: { bytes: 8 * 1024 * 1024, cap: 10 * 1024 * 1024 },
        }),
      );
    });

    await page.waitForTimeout(500);

    // Check if the size pill appeared
    const hasSizePill = await page
      .locator('.size-pill')
      .isVisible()
      .catch(() => false);
    console.log('Size pill visible:', hasSizePill);

    // Check what's in the header center
    const headerCenterContent = await page.locator('.header-center').innerHTML();
    console.log('Header center content:', headerCenterContent);
  });
});
