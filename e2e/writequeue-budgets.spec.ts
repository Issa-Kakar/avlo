/**
 * Phase 2 Critical Test: WriteQueue Dual Budgets
 * 
 * Surgical test for size constraints:
 * - Per-stroke: ≤128KB after simplification
 * - Per-frame: ≤2MB for any command
 * - Mobile view-only rejection
 * - Command idempotency
 */

import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    testReady: boolean;
    testManager: any;
    lastError: string;
    currentRoomSize: number;
  }
}

test.describe('WriteQueue Dual Budgets', () => {
  test('rejects strokes larger than 128KB', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Create a stroke that exceeds 128KB
    // Each point is 2 numbers (x,y), ~16 bytes in JSON
    // 128KB / 16 = ~8000 points should exceed limit
    const largePoints = await page.evaluate(() => {
      const points = [];
      for (let i = 0; i < 9000; i++) {
        points.push(i * 0.1, i * 0.1); // 18000 numbers
      }
      return points;
    });
    
    // Attempt to write large stroke
    const rejected = await page.evaluate((points) => {
      try {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: 'large-stroke',
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: points,
          bbox: { min: [0, 0], max: [900, 900] },
          scene: 0,
          startedAt: Date.now()
        });
        return false;
      } catch {
        window.lastError = e.message;
        return true;
      }
    }, largePoints);
    
    expect(rejected).toBe(true);
    
    const error = await page.evaluate(() => window.lastError);
    expect(error).toContain('128'); // Should mention the limit
  });

  test('accepts strokes under 128KB', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Create a stroke safely under 128KB
    const accepted = await page.evaluate(() => {
      try {
        const points = [];
        for (let i = 0; i < 1000; i++) { // Well under limit
          points.push(i, i);
        }
        
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: 'normal-stroke',
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: points,
          bbox: { min: [0, 0], max: [1000, 1000] },
          scene: 0,
          startedAt: Date.now()
        });
        return true;
      } catch {
        return false;
      }
    });
    
    expect(accepted).toBe(true);
    
    // Verify stroke was added
    const strokeCount = await page.evaluate(() => 
      window.testManager.currentSnapshot.strokes.length
    );
    expect(strokeCount).toBeGreaterThan(0);
  });

  test('enforces 2MB frame limit for all commands', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Try to create a command that exceeds 2MB
    // Code cell with huge body
    const rejected = await page.evaluate(() => {
      try {
        // Create 2.5MB of data
        const hugeCode = 'x'.repeat(2.5 * 1024 * 1024);
        
        window.testManager.write({
          type: 'CodeUpdate',
          lang: 'javascript',
          body: hugeCode,
          version: 1
        });
        return false;
      } catch {
        window.lastError = e.message;
        return true;
      }
    });
    
    expect(rejected).toBe(true);
    
    const error = await page.evaluate(() => window.lastError);
    expect(error.toLowerCase()).toMatch(/2\s*mb|frame/i);
  });

  test('rejects duplicate commands (idempotency)', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    const strokeId = 'idempotent-stroke';
    
    // First write should succeed
    const firstWrite = await page.evaluate((id) => {
      try {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: id,
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: [0, 0, 10, 10],
          bbox: { min: [0, 0], max: [10, 10] },
          scene: 0,
          startedAt: Date.now()
        });
        return true;
      } catch {
        return false;
      }
    }, strokeId);
    
    expect(firstWrite).toBe(true);
    
    // Second write with same ID should be ignored
    const secondWrite = await page.evaluate((id) => {
      const countBefore = window.testManager.currentSnapshot.strokes.length;
      
      try {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: id, // Same ID
          tool: 'highlighter', // Different data
          color: '#FF0000',
          size: 10,
          opacity: 0.5,
          points: [20, 20, 30, 30],
          bbox: { min: [20, 20], max: [30, 30] },
          scene: 0,
          startedAt: Date.now()
        });
      } catch {
        // Might throw or might silently ignore
      }
      
      const countAfter = window.testManager.currentSnapshot.strokes.length;
      return { countBefore, countAfter };
    }, strokeId);
    
    // Count should not increase
    expect(secondWrite.countAfter).toBe(secondWrite.countBefore);
    
    // Original stroke should be unchanged
    const stroke = await page.evaluate(() => {
      const strokes = window.testManager.currentSnapshot.strokes;
      return strokes.find((s: any) => s.id === 'idempotent-stroke');
    });
    
    expect(stroke.tool).toBe('pen'); // Original tool, not highlighter
    expect(stroke.color).toBe('#000000'); // Original color
  });

  test('mobile view-only rejection', async ({ browser }) => {
    // Create mobile context
    const mobileContext = await browser.newContext({
      ...browser.contexts()[0],
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
    });
    
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto('/test-harness.html');
    await mobilePage.waitForFunction(() => window.testReady === true);
    
    // Try to write from mobile
    const rejected = await mobilePage.evaluate(() => {
      try {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: 'mobile-stroke',
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: [0, 0, 10, 10],
          bbox: { min: [0, 0], max: [10, 10] },
          scene: 0,
          startedAt: Date.now()
        });
        return false;
      } catch {
        window.lastError = e.message;
        return true;
      }
    });
    
    // Mobile writes should be rejected
    expect(rejected).toBe(true);
    
    const error = await mobilePage.evaluate(() => window.lastError);
    expect(error.toLowerCase()).toContain('view');
    
    await mobilePage.close();
    await mobileContext.close();
  });
});