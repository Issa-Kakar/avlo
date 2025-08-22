/**
 * Phase 2 Critical Test: Snapshot Immutability & Never Null
 * 
 * Surgical test for the most fundamental invariant:
 * - Snapshots are NEVER null (EmptySnapshot on init)
 * - Snapshots are immutable (frozen in dev)
 * - svKey changes only on Y.Doc updates
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
    initialArrays: {
      strokes: any[];
      texts: any[];
    };
  }
}

test.describe('Snapshot Immutability', () => {
  test('EmptySnapshot exists immediately on creation', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Manager should create EmptySnapshot synchronously
    const hasSnapshot = await page.evaluate(() => {
      return window.testManager && 
             window.testManager.currentSnapshot !== null &&
             window.testManager.currentSnapshot !== undefined;
    });
    
    expect(hasSnapshot).toBe(true);
    
    // EmptySnapshot should have correct initial state
    const snapshot = await page.evaluate(() => {
      const snap = window.testManager.currentSnapshot;
      return {
        scene: snap.scene,
        strokesLength: snap.strokes.length,
        textsLength: snap.texts.length,
        svKey: snap.svKey
      };
    });
    
    expect(snapshot.scene).toBe(0);
    expect(snapshot.strokesLength).toBe(0);
    expect(snapshot.textsLength).toBe(0);
    expect(snapshot.svKey).toBeTruthy(); // Should have an svKey even when empty
  });

  test('svKey remains stable without Y.Doc changes', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    const initialSvKey = await page.evaluate(() => 
      window.testManager.currentSnapshot.svKey
    );
    
    // Wait and check multiple times - svKey should NOT change
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(100);
      const currentSvKey = await page.evaluate(() => 
        window.testManager.currentSnapshot.svKey
      );
      expect(currentSvKey).toBe(initialSvKey);
    }
  });

  test('svKey changes only when Y.Doc is modified', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    const initialSvKey = await page.evaluate(() => 
      window.testManager.currentSnapshot.svKey
    );
    
    // Make a write to Y.Doc
    await page.evaluate(() => {
      window.testManager.write({
        type: 'DrawStrokeCommit',
        id: 'test-stroke-1',
        tool: 'pen',
        color: '#000000',
        size: 2,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: { min: [0, 0], max: [10, 10] },
        scene: 0,
        startedAt: Date.now()
      });
    });
    
    // Wait for snapshot update
    await page.waitForFunction((oldKey) => 
      window.testManager.currentSnapshot.svKey !== oldKey,
      initialSvKey
    );
    
    const newSvKey = await page.evaluate(() => 
      window.testManager.currentSnapshot.svKey
    );
    
    expect(newSvKey).not.toBe(initialSvKey);
  });

  test('snapshots are frozen in development', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Try to mutate snapshot - should fail in dev
    const isFrozen = await page.evaluate(() => {
      const snap = window.testManager.currentSnapshot;
      try {
        // These mutations should throw in dev (Object.freeze)
        snap.scene = 999;
        snap.strokes.push({ id: 'hack' });
        return false; // If we get here, it's not frozen
      } catch {
        return true; // Frozen as expected
      }
    });
    
    // Note: This will only be true in development builds
    // In production, snapshots won't be frozen for performance
    if (process.env.NODE_ENV === 'development') {
      expect(isFrozen).toBe(true);
    }
  });

  test('new arrays are created per publish', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Capture initial array references
    await page.evaluate(() => {
      window.initialArrays = {
        strokes: window.testManager.currentSnapshot.strokes,
        texts: window.testManager.currentSnapshot.texts
      };
    });
    
    // Trigger an update
    await page.evaluate(() => {
      window.testManager.write({
        type: 'DrawStrokeCommit',
        id: 'test-stroke-arrays',
        tool: 'pen',
        color: '#000000',
        size: 2,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: { min: [0, 0], max: [10, 10] },
        scene: 0,
        startedAt: Date.now()
      });
    });
    
    // Wait for update
    await page.waitForTimeout(50);
    
    // Check that arrays are different references
    const arraysChanged = await page.evaluate(() => {
      const current = window.testManager.currentSnapshot;
      return {
        strokesChanged: current.strokes !== window.initialArrays.strokes,
        textsChanged: current.texts !== window.initialArrays.texts
      };
    });
    
    expect(arraysChanged.strokesChanged).toBe(true);
    expect(arraysChanged.textsChanged).toBe(true);
  });
});