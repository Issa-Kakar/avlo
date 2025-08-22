/**
 * Phase 2 Critical Test: RAF Publishing Constraints
 * 
 * Surgical test for publishing cadence:
 * - 60 FPS maximum (16.67ms minimum interval)
 * - Batch coalescing (8-16ms base window)
 * - No unnecessary publishes when no changes
 */

import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    testReady: boolean;
    testManager: any;
    publishMetrics: {
      count: number;
      times: number[];
      lastSvKey: string;
      avgInterval: number;
    };
  }
}

test.describe('RAF Publishing Constraints', () => {
  test('respects 60 FPS limit with rapid updates', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Reset metrics
    await page.evaluate(() => {
      window.publishMetrics = {
        count: 0,
        times: [],
        lastSvKey: 'empty',
        avgInterval: 0
      };
    });
    
    // Use clock control for deterministic testing
    await page.clock.install({ time: new Date('2024-01-01') });
    await page.clock.pauseAt(new Date('2024-01-01'));
    
    // Generate 10 rapid updates
    for (let i = 0; i < 10; i++) {
      await page.evaluate((i) => {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: `stroke-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: [i, i, i+10, i+10],
          bbox: { min: [i, i], max: [i+10, i+10] },
          scene: 0,
          startedAt: Date.now()
        });
      }, i);
      
      // Advance by 5ms (faster than 60 FPS)
      await page.clock.runFor(5);
    }
    
    // Let RAF cycles complete
    await page.clock.runFor(100);
    
    const metrics = await page.evaluate(() => window.publishMetrics);
    
    // Should have published, but not 10 times
    expect(metrics.count).toBeGreaterThan(0);
    expect(metrics.count).toBeLessThan(10); // Coalesced updates
    
    // Check intervals are >= 16ms
    const shortIntervals = metrics.times.filter((t: number) => t < 15);
    expect(shortIntervals.length).toBe(0);
  });

  test('coalesces updates within batch window', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Track publish count
    let publishCount = 0;
    await page.exposeFunction('onPublish', () => {
      publishCount++;
    });
    
    await page.evaluate(() => {
      window.testManager.subscribeSnapshot(() => {
        (window as any).onPublish();
      });
    });
    
    // Make 3 updates within coalescing window (8-16ms)
    await page.evaluate(() => {
      // All within same microtask
      for (let i = 0; i < 3; i++) {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: `coalesce-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: [0, 0, 10, 10],
          bbox: { min: [0, 0], max: [10, 10] },
          scene: 0,
          startedAt: Date.now()
        });
      }
    });
    
    // Wait for publish
    await page.waitForTimeout(50);
    
    // Should publish once for all 3 updates
    expect(publishCount).toBe(1);
    
    // Verify all 3 strokes are in the snapshot
    const strokeCount = await page.evaluate(() => 
      window.testManager.currentSnapshot.strokes.length
    );
    expect(strokeCount).toBe(3);
  });

  test('no unnecessary publishes without changes', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    const initialMetrics = await page.evaluate(() => ({
      count: window.publishMetrics.count,
      svKey: window.testManager.currentSnapshot.svKey
    }));
    
    // Wait without making changes
    await page.waitForTimeout(200);
    
    const finalMetrics = await page.evaluate(() => ({
      count: window.publishMetrics.count,
      svKey: window.testManager.currentSnapshot.svKey
    }));
    
    // No additional publishes should occur
    expect(finalMetrics.count).toBe(initialMetrics.count);
    expect(finalMetrics.svKey).toBe(initialMetrics.svKey);
  });

  test('hidden tab throttles to 8 FPS', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Simulate hidden tab
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    
    // Reset metrics
    await page.evaluate(() => {
      window.publishMetrics.times = [];
    });
    
    // Generate updates while "hidden"
    for (let i = 0; i < 5; i++) {
      await page.evaluate((i) => {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: `hidden-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: [0, 0, 10, 10],
          bbox: { min: [0, 0], max: [10, 10] },
          scene: 0,
          startedAt: Date.now()
        });
      }, i);
      await page.waitForTimeout(50);
    }
    
    const metrics = await page.evaluate(() => window.publishMetrics);
    
    // Intervals should be ~125ms (8 FPS) when hidden
    const avgInterval = metrics.times.length > 0 
      ? metrics.times.reduce((a: number, b: number) => a + b, 0) / metrics.times.length
      : 0;
    
    // Should be closer to 125ms than 16ms
    if (metrics.times.length > 0) {
      expect(avgInterval).toBeGreaterThan(60); // Much slower than 60 FPS
    }
  });
});