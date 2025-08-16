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

async function sendGatewayError(page, type: string, details?: any) {
  await page.evaluate(
    ({ t, d }) => {
      window.dispatchEvent(new CustomEvent('gateway-error', { detail: { type: t, details: d } }));
    },
    { t: type, d: details },
  );
}

test.describe('Phase 8 - Gateway error mapping', () => {
  test('room_full → toast', async ({ page }) => {
    page.on('console', (msg) => console.warn('Browser', msg.type(), msg.text()));
    await page.goto('/rooms/e2e-phase8-roomfull');
    await expect(page.getByTestId('connection-chip')).toBeVisible();
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

    await sendGatewayError(page, 'room_full');

    await expect(page.getByText('Room is full — create a new room.')).toBeVisible();
  });

  test('offline_delta_too_large → toast', async ({ page }) => {
    page.on('console', (msg) => console.warn('Browser', msg.type(), msg.text()));
    await page.goto('/rooms/e2e-phase8-delta');
    await expect(page.getByTestId('connection-chip')).toBeVisible();
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

    await sendGatewayError(page, 'offline_delta_too_large');

    await expect(page.getByText('Change too large. Refresh to rejoin.')).toBeVisible();
  });

  test('room_full_readonly → switches to read-only (banner via state)', async ({ page }) => {
    page.on('console', (msg) => console.warn('Browser', msg.type(), msg.text()));
    await page.goto('/rooms/e2e-phase8-readonly');
    await expect(page.getByTestId('connection-chip')).toBeVisible();
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

    await sendGatewayError(page, 'room_full_readonly');

    // Connection should flip to Read-only after handler sets readOnly=true
    await expect(page.getByTestId('connection-chip')).toHaveText(/Read-only/i);
  });
});
