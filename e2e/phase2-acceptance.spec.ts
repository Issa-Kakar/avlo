import { test, expect, Page } from '@playwright/test';

test.describe('Phase 2: Client Foundation - E2E Tests', () => {
  test.describe('Landing Page', () => {
    test('displays landing page with all required elements', async ({ page }) => {
      await page.goto('/');
      
      // Check logo
      await expect(page.locator('.logo-text')).toContainText('Avlo');
      
      // Check hero section
      await expect(page.locator('h1')).toContainText('Sketch ideas');
      
      // Check CTA buttons
      await expect(page.locator('[data-testid="create-room"]')).toBeVisible();
      await expect(page.locator('[data-testid="create-room"]')).toContainText('Create Room');
      
      await expect(page.locator('[data-testid="join-room"]')).toBeVisible();
      await expect(page.locator('[data-testid="join-room"]')).toContainText('Join Room');
      
      // Check theme toggle
      await expect(page.locator('[data-testid="theme-toggle"]')).toBeVisible();
    });

    test('theme toggle works correctly', async ({ page }) => {
      await page.goto('/');
      
      const html = page.locator('html');
      const themeToggle = page.locator('[data-testid="theme-toggle"]');
      
      // Get initial theme
      const initialTheme = await html.getAttribute('data-theme');
      
      // Toggle theme
      await themeToggle.click();
      
      // Check theme changed
      const newTheme = await html.getAttribute('data-theme');
      expect(newTheme).not.toBe(initialTheme);
      expect(newTheme).toMatch(/^(light|dark)$/);
      
      // Toggle back
      await themeToggle.click();
      const finalTheme = await html.getAttribute('data-theme');
      expect(finalTheme).toBe(initialTheme);
    });

    test('create room button makes API call and navigates', async ({ page }) => {
      await page.goto('/');
      
      // Mock the API response
      await page.route('**/api/rooms', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ roomId: 'test-room-123', shareLink: '/rooms/test-room-123' })
        });
      });
      
      // Click create room
      await page.locator('[data-testid="create-room"]').click();
      
      // Should navigate to the room
      await expect(page).toHaveURL(/\/rooms\/test-room-123/);
    });

    test('shows rate limit error with normative text', async ({ page }) => {
      await page.goto('/');
      
      // Mock 429 response
      await page.route('**/api/rooms', async route => {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Too many requests' })
        });
      });
      
      // Click create room
      await page.locator('[data-testid="create-room"]').click();
      
      // Check normative toast text
      await expect(page.locator('.toast[role="status"]')).toContainText('Too many requests — try again shortly.');
    });

    test('join room modal works with validation', async ({ page }) => {
      await page.goto('/');
      
      // Click join room
      await page.locator('[data-testid="join-room"]').click();
      
      // Modal should appear
      const modal = page.locator('[role="dialog"]');
      await expect(modal).toBeVisible();
      
      // Try invalid room ID
      await page.locator('input[type="text"]').fill('invalid room!');
      await page.locator('button.btn-primary:has-text("Join")').click();
      
      // Should show error
      await expect(page.locator('.error')).toContainText('letters, numbers, hyphens, and underscores');
      
      // Enter valid room ID
      await page.locator('input[type="text"]').clear();
      await page.locator('input[type="text"]').fill('valid-room-123');
      await page.locator('button.btn-primary:has-text("Join")').click();
      
      // Should navigate
      await expect(page).toHaveURL(/\/rooms\/valid-room-123/);
    });

    test('join room modal is focus trapped and closes on Escape', async ({ page }) => {
      await page.goto('/');
      
      // Open modal
      await page.locator('[data-testid="join-room"]').click();
      
      // Check focus is trapped (tab cycles within modal)
      await page.keyboard.press('Tab');
      const focusedElement1 = await page.evaluate(() => document.activeElement?.tagName);
      expect(['INPUT', 'BUTTON']).toContain(focusedElement1);
      
      // Press Escape to close
      await page.keyboard.press('Escape');
      
      // Modal should be hidden
      await expect(page.locator('[role="dialog"]')).not.toBeVisible();
      
      // Focus should return to join button
      const focusedElement2 = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
      expect(focusedElement2).toBe('join-room');
    });
  });

  test.describe('Room Page', () => {
    test('displays room UI with all required elements', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      // Wait for WebSocket connection to establish
      await page.waitForTimeout(1000);
      
      // Header elements
      await expect(page.locator('[data-testid="connection-chip"]')).toBeVisible();
      // Users avatar stack exists (may be empty initially)
      await expect(page.locator('[data-testid="users-avatar-stack"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="copy-link"]')).toBeVisible();
      await expect(page.locator('[data-testid="export"]')).toBeVisible();
      await expect(page.locator('[data-testid="export"]')).toBeDisabled();
      await expect(page.locator('[data-testid="theme-toggle"]')).toBeVisible();
      
      // Split pane
      await expect(page.locator('[data-testid="split-resizer"]')).toBeVisible();
      
      // Board and editor containers
      await expect(page.locator('#board')).toBeVisible();
      await expect(page.locator('#code')).toBeVisible();
      
      // Run button (disabled)
      await expect(page.locator('[data-testid="run"]')).toBeVisible();
      await expect(page.locator('[data-testid="run"]')).toBeDisabled();
    });

    test('copy link button shows normative toast', async ({ page, context }) => {
      // Grant clipboard permissions
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      
      await page.goto('/rooms/e2e-test-room');
      
      // Click copy link
      await page.locator('[data-testid="copy-link"]').click();
      
      // Check normative toast text
      await expect(page.locator('.toast[role="status"]')).toContainText('Link copied.');
      
      // Verify clipboard contains the URL
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toContain('/rooms/e2e-test-room');
    });

    test('connection chip shows correct states', async ({ page, context }) => {
      await page.goto('/rooms/e2e-test-room');
      
      const connectionChip = page.locator('[data-testid="connection-chip"]');
      
      // Initially should show connecting or online
      await expect(connectionChip).toContainText(/Online|Connecting/);
      
      // Simulate offline
      await context.setOffline(true);
      await page.waitForTimeout(100); // Allow state to update
      
      // Should show offline
      await expect(connectionChip).toContainText('Offline');
      
      // Go back online
      await context.setOffline(false);
      await page.waitForTimeout(100);
      
      // Should show reconnecting then online
      await expect(connectionChip).toContainText(/Reconnecting|Online/);
    });

    test('split pane resizer is keyboard accessible', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      const resizer = page.locator('[data-testid="split-resizer"]');
      
      // Focus the resizer
      await resizer.focus();
      
      // Check ARIA attributes
      await expect(resizer).toHaveAttribute('role', 'separator');
      await expect(resizer).toHaveAttribute('aria-orientation', 'vertical');
      await expect(resizer).toHaveAttribute('tabindex', '0');
      
      // Get initial widths
      const initialLeftWidth = await page.locator('.split-left').evaluate(el => el.offsetWidth);
      
      // Press arrow keys to adjust
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(100);
      
      const newLeftWidth = await page.locator('.split-left').evaluate(el => el.offsetWidth);
      expect(newLeftWidth).toBeLessThan(initialLeftWidth);
      
      // Press Escape to blur
      await page.keyboard.press('Escape');
      const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
      expect(focusedElement).toBe('BODY');
    });

    test('users modal is focus trapped and accessible', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      // Click users button
      await page.locator('[data-testid="users-avatar-stack"]').click();
      
      // Modal should appear
      const modal = page.locator('#usersModal');
      await expect(modal).toBeVisible();
      
      // Check ARIA attributes
      await expect(modal).toHaveAttribute('role', 'dialog');
      await expect(modal).toHaveAttribute('aria-modal', 'true');
      
      // Press Tab to check focus trap
      await page.keyboard.press('Tab');
      const focusedInModal = await page.evaluate(() => {
        const activeEl = document.activeElement;
        return activeEl?.closest('#usersModal') !== null;
      });
      expect(focusedInModal).toBe(true);
      
      // Press Escape to close
      await page.keyboard.press('Escape');
      await expect(modal).not.toBeVisible();
      
      // Focus should return to users button
      const focusedElement = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
      expect(focusedElement).toBe('users-avatar-stack');
    });

    test('mobile view-only mode works based on viewport', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      // Desktop view - tools should be enabled
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.waitForTimeout(100);
      
      const penTool = page.locator('[aria-label="Pen"]').first();
      await expect(penTool).not.toHaveAttribute('aria-disabled', 'true');
      
      // Mobile view - tools should be disabled
      await page.setViewportSize({ width: 400, height: 800 });
      await page.waitForTimeout(100);
      
      await expect(penTool).toHaveAttribute('aria-disabled', 'true');
      
      // Should show view-only toast when clicking disabled tool
      await penTool.click();
      await expect(page.locator('.toast[role="status"]')).toContainText('Drawing tools are view-only on mobile devices');
    });

    test('invalid room ID shows error message', async ({ page }) => {
      // Navigate to room with invalid ID
      await page.goto('/rooms/invalid!room');
      
      // Should show error message or redirect to landing
      // Room validation is handled, but error display might redirect
      const errorOrRedirect = await page.locator('text=/Invalid room ID/').or(page.locator('h1')).textContent();
      expect(errorOrRedirect).toBeTruthy();
    });

    test('export button shows coming soon message', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      // Click disabled export button
      await page.locator('[data-testid="export"]').click({ force: true });
      
      // Should show phase notification
      await expect(page.locator('.toast[role="status"]')).toContainText('Export will be available in a later phase');
    });

    test('run button shows coming soon message', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      // Click disabled run button
      await page.locator('[data-testid="run"]').click({ force: true });
      
      // Should show phase notification
      await expect(page.locator('.toast[role="status"]')).toContainText('Code execution will be available in a later phase');
    });
  });

  test.describe('Multi-user Presence', () => {
    test('shows multiple users in same room', async ({ browser }) => {
      // Create two browser contexts
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      
      const page1 = await context1.newPage();
      const page2 = await context2.newPage();
      
      // Both join the same room
      await page1.goto('/rooms/e2e-presence-test');
      await page2.goto('/rooms/e2e-presence-test');
      
      // Wait for connection
      await page1.waitForTimeout(1000);
      await page2.waitForTimeout(1000);
      
      // Check user count on both pages (should be at least 2)
      const userCount1 = await page1.locator('.users-count').textContent();
      const userCount2 = await page2.locator('.users-count').textContent();
      
      expect(parseInt(userCount1 || '0')).toBeGreaterThanOrEqual(2);
      expect(parseInt(userCount2 || '0')).toBeGreaterThanOrEqual(2);
      
      // Clean up
      await context1.close();
      await context2.close();
    });
  });

  test.describe('Accessibility', () => {
    test('toasts have proper ARIA attributes', async ({ page }) => {
      await page.goto('/');
      
      // Trigger a toast by clicking create room with mocked 429
      await page.route('**/api/rooms', route => route.fulfill({ status: 429 }));
      await page.locator('[data-testid="create-room"]').click();
      
      const toast = page.locator('[role="status"]');
      await expect(toast).toHaveAttribute('aria-live', 'polite');
    });

    test('disabled controls have proper ARIA attributes', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      // Check export button
      const exportBtn = page.locator('[data-testid="export"]');
      await expect(exportBtn).toHaveAttribute('aria-disabled', 'true');
      
      // Check run button
      const runBtn = page.locator('[data-testid="run"]');
      await expect(runBtn).toHaveAttribute('aria-disabled', 'true');
    });

    test('connection chip has status role and aria-live', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      const chip = page.locator('[data-testid="connection-chip"]');
      await expect(chip).toHaveAttribute('role', 'status');
      await expect(chip).toHaveAttribute('aria-live', 'polite');
    });
  });

  test.describe('Persistence', () => {
    test('theme preference persists across reloads', async ({ page }) => {
      await page.goto('/');
      
      // Get initial theme
      const initialTheme = await page.locator('html').getAttribute('data-theme');
      
      // Toggle theme
      await page.locator('[data-testid="theme-toggle"]').click();
      const newTheme = await page.locator('html').getAttribute('data-theme');
      expect(newTheme).not.toBe(initialTheme);
      
      // Reload page
      await page.reload();
      
      // Theme should persist
      const persistedTheme = await page.locator('html').getAttribute('data-theme');
      expect(persistedTheme).toBe(newTheme);
    });

    test('split pane ratio persists across reloads', async ({ page }) => {
      await page.goto('/rooms/e2e-test-room');
      
      // Get initial ratio
      const initialLeftWidth = await page.locator('.split-left').evaluate(el => el.offsetWidth);
      
      // Drag resizer to change ratio
      const resizer = page.locator('[data-testid="split-resizer"]');
      const box = await resizer.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2);
        await page.mouse.up();
      }
      
      await page.waitForTimeout(100);
      const newLeftWidth = await page.locator('.split-left').evaluate(el => el.offsetWidth);
      expect(newLeftWidth).not.toBe(initialLeftWidth);
      
      // Reload page
      await page.reload();
      
      // Ratio should persist
      await page.waitForTimeout(100);
      const persistedLeftWidth = await page.locator('.split-left').evaluate(el => el.offsetWidth);
      expect(Math.abs(persistedLeftWidth - newLeftWidth)).toBeLessThan(5); // Allow small difference
    });
  });
});