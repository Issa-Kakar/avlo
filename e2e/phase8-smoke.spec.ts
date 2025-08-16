import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const DEV_BASE = process.env.DEV_BASE_URL || 'http://localhost:5173';

async function waitForPhase8Ready(page: Page) {
  // Give React a tick
  await page.waitForTimeout(200);
  // Poll readiness flag set by useRoom test hook
  for (let i = 0; i < 30; i++) {
    const ready = await page.evaluate(() => (window as any).__phase8TestReady === true);
    if (ready) return;
    await page.waitForTimeout(100);
  }
}

async function sendRoomStats(page: Page, bytes: number, cap = 10 * 1024 * 1024) {
  await page.evaluate(
    ({ b, c }) => {
      window.dispatchEvent(new CustomEvent('room-stats-update', { detail: { bytes: b, cap: c } }));
    },
    { b: bytes, c: cap },
  );
}

async function sendGatewayError(page: Page, type: string, details?: unknown) {
  await page.evaluate(
    ({ t, d }) => {
      window.dispatchEvent(new CustomEvent('gateway-error', { detail: { type: t, details: d } }));
    },
    { t: type, d: details },
  );
}

// Enable limits UI explicitly in the page before any scripts run
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__LIMITS_UI_ENABLED_OVERRIDE = true;
    try {
      window.localStorage.setItem('LIMITS_UI_ENABLED', 'true');
    } catch {
      void 0;
    }
  });
});

test.describe('Phase 8 Smoke (dev server)', () => {
  test('soft pill at 8 MB; no toasts', async ({ page }) => {
    await page.goto(`${DEV_BASE}/rooms/phase8-smoke-soft`);
    await expect(page.getByTestId('connection-chip')).toBeVisible();
    await waitForPhase8Ready(page);

    // Below threshold → no pill
    await sendRoomStats(page, 7.9 * 1024 * 1024);
    await page.waitForTimeout(200);
    await expect(page.locator('.size-pill')).toHaveCount(0);

    // At threshold → pill appears within ≤5s
    await sendRoomStats(page, 8 * 1024 * 1024);
    await expect(page.locator('.size-pill')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.size-pill')).toContainText('/ 10');

    // No toast should be visible
    await page.waitForTimeout(300);
    const anyToastVisible = await page
      .locator('.toast')
      .isVisible()
      .catch(() => false);
    expect(anyToastVisible).toBeFalsy();
  });

  test('hard cap → Read-only, banner, tools disabled; awareness continues', async ({ page }) => {
    await page.goto(`${DEV_BASE}/rooms/phase8-smoke-hard`);
    await expect(page.getByTestId('connection-chip')).toBeVisible();
    await waitForPhase8Ready(page);

    await sendRoomStats(page, 10 * 1024 * 1024);

    await expect(page.getByTestId('connection-chip')).toHaveText(/Read-only/i);
    await expect(page.getByText('Board is read-only — size limit reached.')).toBeVisible();

    await expect(page.locator('.tool[data-tool="pen"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.tool[data-tool="highlighter"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.locator('.tool[data-tool="eraser"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // Provider awareness should exist (exposed by Room)
    const hasAwareness = await page.evaluate(() => Boolean((window as any).__testAwareness));
    expect(hasAwareness).toBeTruthy();
  });

  test('gateway errors → toasts/state', async ({ page }) => {
    await page.goto(`${DEV_BASE}/rooms/phase8-smoke-errors`);
    await expect(page.getByTestId('connection-chip')).toBeVisible();
    await waitForPhase8Ready(page);

    // room_full → toast
    await sendGatewayError(page, 'room_full');
    await expect(page.locator('.toast')).toContainText('Room is full — create a new room.');

    // offline_delta_too_large → toast
    await sendGatewayError(page, 'offline_delta_too_large');
    await expect(page.locator('.toast')).toContainText('Change too large. Refresh to rejoin.');

    // room_full_readonly → read-only state (no toast required)
    await sendGatewayError(page, 'room_full_readonly');
    await expect(page.getByTestId('connection-chip')).toHaveText(/Read-only/i);
  });
});
