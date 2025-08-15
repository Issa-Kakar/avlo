import { test, expect } from '@playwright/test';

test.describe('Accessibility', () => {
  test('split pane resizer should be keyboard operable', async ({ page }) => {
    await page.goto('/rooms/e2e-a11y-split');
    
    // Wait for room to load
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Focus the resizer
    const resizer = page.getByTestId('split-resizer');
    await resizer.focus();
    
    // Should have correct ARIA attributes
    await expect(resizer).toHaveAttribute('role', 'separator');
    await expect(resizer).toHaveAttribute('aria-orientation', 'vertical');
    await expect(resizer).toHaveAttribute('tabindex', '0');
    
    // Get initial position
    const initialBox = await resizer.boundingBox();
    const initialX = initialBox?.x || 0;
    
    // Press arrow keys to adjust
    await resizer.press('ArrowLeft');
    await page.waitForTimeout(100);
    await resizer.press('ArrowLeft');
    await page.waitForTimeout(100);
    
    // Position should have changed
    const newBox = await resizer.boundingBox();
    const newX = newBox?.x || 0;
    expect(newX).toBeLessThan(initialX);
    
    // Press Escape to blur
    await resizer.press('Escape');
    await expect(resizer).not.toBeFocused();
  });

  test('users modal should trap focus and return focus on close', async ({ page }) => {
    await page.goto('/rooms/e2e-a11y-modal');
    
    // Wait for room to load
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Click users button to open modal
    const usersButton = page.getByTestId('users-avatar-stack');
    await usersButton.click();
    
    // Modal should be visible
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    
    // Focus should be trapped within modal
    // Try to tab through elements
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    
    // Focus should still be within modal
    const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
    const modalContainsFocus = await modal.evaluate((el, focused) => {
      return el.contains(document.querySelector(focused));
    }, focusedElement);
    expect(modalContainsFocus).toBeTruthy();
    
    // Press Escape to close
    await page.keyboard.press('Escape');
    
    // Modal should close
    await expect(modal).not.toBeVisible();
    
    // Focus should return to the trigger button
    await expect(usersButton).toBeFocused();
  });

  test('toasts should be announced via aria-live', async ({ page }) => {
    await page.goto('/rooms/e2e-a11y-toast');
    
    // Wait for room to load
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Click copy link to trigger toast
    await page.getByTestId('copy-link').click();
    
    // Toast should have aria-live attribute
    const toast = page.getByText('Link copied.');
    await expect(toast).toBeVisible();
    
    const toastContainer = toast.locator('..');
    await expect(toastContainer).toHaveAttribute('aria-live', 'polite');
  });

  test('disabled controls should have proper ARIA attributes', async ({ page }) => {
    await page.goto('/rooms/e2e-a11y-disabled');
    
    // Wait for room to load
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Export button should be disabled
    const exportButton = page.getByTestId('export');
    await expect(exportButton).toHaveAttribute('aria-disabled', 'true');
    
    // Run button should be disabled
    const runButton = page.getByTestId('run');
    await expect(runButton).toHaveAttribute('aria-disabled', 'true');
    
    // Disabled buttons should not be in tab order
    await exportButton.focus();
    await page.keyboard.press('Tab');
    // Focus should skip to next enabled element, not the run button
    const focusedAfterTab = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    expect(focusedAfterTab).not.toBe('run');
  });

  test('connection chip should have status role and aria-live', async ({ page }) => {
    await page.goto('/rooms/e2e-a11y-status');
    
    const connectionChip = page.getByTestId('connection-chip');
    
    // Should have correct ARIA attributes
    await expect(connectionChip).toHaveAttribute('role', 'status');
    await expect(connectionChip).toHaveAttribute('aria-live', 'polite');
    
    // Content should update when status changes
    await expect(connectionChip).toContainText('Online', { timeout: 10000 });
  });
});