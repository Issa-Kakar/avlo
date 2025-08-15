import { test, expect } from '@playwright/test';

test.describe('SplitPane and Accessibility', () => {
  test('SplitPane has 70/30 default ratio', async ({ page }) => {
    const roomId = 'test-split-default-' + Date.now();
    
    // Clear localStorage to ensure default
    await page.goto(`/rooms/${roomId}`);
    await page.evaluate(() => localStorage.removeItem('room-split'));
    await page.reload();
    await page.waitForTimeout(1000);
    
    // Check split ratio
    const ratio = await page.evaluate(() => {
      const splitContainer = document.querySelector('.split-container') as HTMLElement;
      if (!splitContainer) return null;
      
      const leftPane = splitContainer.querySelector('.split-left') as HTMLElement;
      const containerWidth = splitContainer.offsetWidth;
      const leftWidth = leftPane?.offsetWidth;
      
      return leftWidth ? leftWidth / containerWidth : null;
    });
    
    // Should be approximately 70%
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(0.75);
  });
  
  test('SplitPane resizer has correct ARIA attributes', async ({ page }) => {
    const roomId = 'test-split-aria-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    const resizer = page.locator('[data-testid="split-resizer"]');
    
    // Check ARIA attributes
    const role = await resizer.getAttribute('role');
    const orientation = await resizer.getAttribute('aria-orientation');
    const tabIndex = await resizer.getAttribute('tabindex');
    
    expect(role).toBe('separator');
    expect(orientation).toBe('vertical');
    expect(tabIndex).toBe('0');
  });
  
  test('SplitPane resizer responds to keyboard', async ({ page }) => {
    const roomId = 'test-split-keyboard-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    const resizer = page.locator('[data-testid="split-resizer"]');
    
    // Focus the resizer
    await resizer.focus();
    
    // Get initial ratio
    const initialRatio = await page.evaluate(() => {
      const splitContainer = document.querySelector('.split-container') as HTMLElement;
      const leftPane = splitContainer?.querySelector('.split-left') as HTMLElement;
      return leftPane?.offsetWidth / splitContainer?.offsetWidth;
    });
    
    // Press ArrowLeft to decrease
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(100);
    
    const decreasedRatio = await page.evaluate(() => {
      const splitContainer = document.querySelector('.split-container') as HTMLElement;
      const leftPane = splitContainer?.querySelector('.split-left') as HTMLElement;
      return leftPane?.offsetWidth / splitContainer?.offsetWidth;
    });
    
    expect(decreasedRatio).toBeLessThan(initialRatio || 0);
    
    // Press ArrowRight to increase
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    
    const increasedRatio = await page.evaluate(() => {
      const splitContainer = document.querySelector('.split-container') as HTMLElement;
      const leftPane = splitContainer?.querySelector('.split-left') as HTMLElement;
      return leftPane?.offsetWidth / splitContainer?.offsetWidth;
    });
    
    expect(increasedRatio).toBeGreaterThan(decreasedRatio || 0);
    
    // Press Escape to blur
    await page.keyboard.press('Escape');
    const isFocused = await resizer.evaluate(el => el === document.activeElement);
    expect(isFocused).toBe(false);
  });
  
  test('SplitPane ratio persists to localStorage', async ({ page, context }) => {
    const roomId = 'test-split-persist-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    
    // Drag resizer to change ratio
    const resizer = page.locator('[data-testid="split-resizer"]');
    const box = await resizer.boundingBox();
    
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2);
      await page.mouse.up();
    }
    
    await page.waitForTimeout(500);
    
    // Check localStorage
    const storedRatio = await page.evaluate(() => {
      return localStorage.getItem('room-split');
    });
    
    expect(storedRatio).toBeTruthy();
    const ratio = parseFloat(storedRatio || '0');
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
    
    // Reload and check persistence
    await page.reload();
    await page.waitForTimeout(1000);
    
    const restoredRatio = await page.evaluate(() => {
      const splitContainer = document.querySelector('.split-container') as HTMLElement;
      const leftPane = splitContainer?.querySelector('.split-left') as HTMLElement;
      return leftPane?.offsetWidth / splitContainer?.offsetWidth;
    });
    
    // Should be close to stored ratio
    expect(Math.abs(restoredRatio - ratio)).toBeLessThan(0.05);
  });
  
  test('Mobile view-only disables authoring controls', async ({ browser }) => {
    const roomId = 'test-mobile-controls-' + Date.now();
    
    // Mobile context
    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`/rooms/${roomId}`);
    
    // Check tool aria-disabled
    const tools = [
      '[data-tool="pen"]',
      '[data-tool="highlighter"]',
      '[data-tool="eraser"]',
      '[data-tool="undo"]',
      '[data-tool="redo"]'
    ];
    
    for (const selector of tools) {
      const tool = mobilePage.locator(selector);
      if (await tool.isVisible()) {
        const disabled = await tool.getAttribute('aria-disabled');
        expect(disabled).toBe('true');
      }
    }
    
    // Run button should be disabled
    const runButton = mobilePage.locator('[data-testid="run"]');
    const runDisabled = await runButton.getAttribute('aria-disabled');
    expect(runDisabled).toBe('true');
    
    // Export should be disabled
    const exportButton = mobilePage.locator('[data-testid="export"]');
    const exportDisabled = await exportButton.getAttribute('aria-disabled');
    expect(exportDisabled).toBe('true');
    
    await mobileContext.close();
  });
  
  test('Users modal has focus trap', async ({ page }) => {
    const roomId = 'test-modal-focus-' + Date.now();
    await page.goto(`/rooms/${roomId}`);
    await page.waitForTimeout(2000);
    
    // Open users modal
    const usersButton = page.locator('[data-testid="users-avatar-stack"]');
    if (await usersButton.isVisible()) {
      await usersButton.click();
      
      const modal = page.locator('#usersModal');
      await expect(modal).toBeVisible();
      
      // Check focus is within modal
      const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
      expect(focusedElement).toBeTruthy();
      
      // Press Tab multiple times - focus should stay in modal
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        const isInModal = await page.evaluate(() => {
          const modal = document.getElementById('usersModal');
          return modal?.contains(document.activeElement) || false;
        });
        if (!isInModal) {
          // If focus escaped, that's a bug
          expect(isInModal).toBe(true);
          break;
        }
      }
      
      // Escape closes modal
      await page.keyboard.press('Escape');
      await expect(modal).not.toBeVisible();
      
      // Focus returns to trigger button
      const buttonFocused = await usersButton.evaluate(el => el === document.activeElement);
      expect(buttonFocused).toBe(true);
    }
  });
});