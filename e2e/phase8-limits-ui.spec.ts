import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Enable limits UI for e2e tests
    (window as any).__LIMITS_UI_ENABLED_OVERRIDE = true;
    try {
      window.localStorage.setItem('LIMITS_UI_ENABLED', 'true');
    } catch {
      void 0;
    }
  });
});

async function sendRoomStats(page, bytes: number, cap = 10 * 1024 * 1024) {
  await page.evaluate(
    ({ b, c }) => {
      window.dispatchEvent(new CustomEvent('room-stats-update', { detail: { bytes: b, cap: c } }));
    },
    { b: bytes, c: cap },
  );
}

test.describe('Phase 8 - Limits UI', () => {
  test('shows soft warning pill at ≥8 MB without toasts', async ({ page }) => {
    page.on('console', (msg) => console.warn('Browser', msg.type(), msg.text()));
    await page.goto('/rooms/e2e-phase8-soft');
    await expect(page.getByTestId('connection-chip')).toBeVisible();

    // Wait for test hooks to attach
    await page.waitForTimeout(200); // give React effect a tick
    await page.waitForSelector('[data-testid="connection-chip"]');
    // Poll readiness flag without waitForFunction to avoid CSP eval
    for (let i = 0; i < 25; i++) {
      // up to ~2.5s
      const ready = await page.evaluate(() => (window as any).__phase8TestReady === true);
      if (ready) break;
      await page.waitForTimeout(100);
    }
    // Ensure provider exists so Room has handles
    for (let i = 0; i < 100; i++) {
      // up to ~10s
      const hasProvider = await page.evaluate(() => Boolean((window as any).__testProvider));
      if (hasProvider) break;
      await page.waitForTimeout(100);
    }

    // Dispatch room_stats at 80% of 10 MB
    const cap = 10 * 1024 * 1024;
    const bytes = 8 * 1024 * 1024;
    await sendRoomStats(page, bytes, cap);

    // Pill should appear within ≤5s
    const pill = page.locator('.size-pill');
    await expect(pill).toBeVisible({ timeout: 5000 });
    await expect(pill).toContainText(' / 10');

    // Ensure no error toast is shown (allow brief time window)
    await page.waitForTimeout(500);
    const hasToast = await page
      .locator('.toast')
      .isVisible()
      .catch(() => false);
    // If a toast appears, it should disappear quickly; assert not currently visible
    expect(hasToast).toBeFalsy();
  });

  test('hard cap switches to Read-only, shows banner, and disables tools', async ({ page }) => {
    page.on('console', (msg) => console.warn('Browser', msg.type(), msg.text()));
    await page.goto('/rooms/e2e-phase8-hard');
    await expect(page.getByTestId('connection-chip')).toBeVisible();

    // Wait for test hooks to attach
    await page.waitForTimeout(200);
    await page.waitForSelector('[data-testid="connection-chip"]');
    for (let i = 0; i < 25; i++) {
      const ready = await page.evaluate(() => (window as any).__phase8TestReady === true);
      if (ready) break;
      await page.waitForTimeout(100);
    }
    for (let i = 0; i < 100; i++) {
      const hasProvider = await page.evaluate(() => Boolean((window as any).__testProvider));
      if (hasProvider) break;
      await page.waitForTimeout(100);
    }

    const cap = 10 * 1024 * 1024;
    const bytes = 10 * 1024 * 1024; // at cap
    await sendRoomStats(page, bytes, cap);

    // Connection chip shows Read-only
    await expect(page.getByTestId('connection-chip')).toHaveText(/Read-only/i);

    // Read-only banner visible
    await expect(page.getByText('Board is read-only — size limit reached.')).toBeVisible();

    // Tool buttons are disabled via aria-disabled
    await expect(page.locator('.tool[data-tool="pen"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.tool[data-tool="highlighter"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.locator('.tool[data-tool="eraser"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // Provider remains connected (awareness continues)
    const state = await page.evaluate(() => {
      const p = (window as any).__testProvider;
      return { connected: !!(p && p.wsconnected) };
    });
    expect(state.connected).toBeTruthy();
  });
});
