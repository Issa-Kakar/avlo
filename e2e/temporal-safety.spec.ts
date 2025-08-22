/**
 * Phase 2 Critical Test: Temporal Wormhole Prevention
 * 
 * Ensures async operations are discarded when state changes,
 * preventing stale work from being applied to new state.
 */

import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    testReady: boolean;
    testManager: any;
    lastError: string;
  }
}

test.describe('Temporal Safety (svKey Validation)', () => {
  test('svKey changes only on Y.Doc modifications', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    const initialSvKey = await page.evaluate(() => 
      window.testManager.currentSnapshot.svKey
    );
    
    // No change without modification
    await page.waitForTimeout(100);
    let currentSvKey = await page.evaluate(() => 
      window.testManager.currentSnapshot.svKey
    );
    expect(currentSvKey).toBe(initialSvKey);
    
    // Change after modification
    await page.evaluate(() => {
      window.testManager.write({
        type: 'DrawStrokeCommit',
        id: 'svkey-test',
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
    
    currentSvKey = await page.evaluate(() => 
      window.testManager.currentSnapshot.svKey
    );
    expect(currentSvKey).not.toBe(initialSvKey);
  });

  test('async work is discarded on svKey mismatch', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Simulate async export operation
    const result = await page.evaluate(() => {
      return new Promise((resolve) => {
        // Capture svKey at start of async work
        const capturedSvKey = window.testManager.currentSnapshot.svKey;
        
        // Simulate async work (export, network call, etc.)
        setTimeout(() => {
          // State changed while we were async
          window.testManager.write({
            type: 'DrawStrokeCommit',
            id: 'concurrent-change',
            tool: 'pen',
            color: '#000000',
            size: 2,
            opacity: 1,
            points: [0, 0, 10, 10],
            bbox: { min: [0, 0], max: [10, 10] },
            scene: 0,
            startedAt: Date.now()
          });
          
          // Now check if we should apply async result
          const currentSvKey = window.testManager.currentSnapshot.svKey;
          
          if (capturedSvKey !== currentSvKey) {
            // Correctly discard stale work
            resolve({ discarded: true, reason: 'svKey mismatch' });
          } else {
            // Would apply (but shouldn't happen in this test)
            resolve({ discarded: false });
          }
        }, 50);
      });
    });
    
    expect(result.discarded).toBe(true);
    expect(result.reason).toBe('svKey mismatch');
  });

  test('multiple async operations handle svKey correctly', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Start multiple async operations
    const results = await page.evaluate(() => {
      const operations = [];
      
      // Operation 1: Will complete after state change
      operations.push(new Promise((resolve) => {
        const svKey1 = window.testManager.currentSnapshot.svKey;
        setTimeout(() => {
          const valid = svKey1 === window.testManager.currentSnapshot.svKey;
          resolve({ id: 'op1', valid, svKey: svKey1 });
        }, 100);
      }));
      
      // Operation 2: Will complete before state change
      operations.push(new Promise((resolve) => {
        const svKey2 = window.testManager.currentSnapshot.svKey;
        setTimeout(() => {
          const valid = svKey2 === window.testManager.currentSnapshot.svKey;
          resolve({ id: 'op2', valid, svKey: svKey2 });
        }, 10);
      }));
      
      // Change state after 50ms
      setTimeout(() => {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: 'state-change',
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: [0, 0, 10, 10],
          bbox: { min: [0, 0], max: [10, 10] },
          scene: 0,
          startedAt: Date.now()
        });
      }, 50);
      
      return Promise.all(operations);
    });
    
    // Op2 completes before state change - valid
    const op2 = results.find((r: any) => r.id === 'op2');
    expect(op2.valid).toBe(true);
    
    // Op1 completes after state change - invalid
    const op1 = results.find((r: any) => r.id === 'op1');
    expect(op1.valid).toBe(false);
  });

  test('command idempotency prevents duplicate execution', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    const commandId = 'idempotent-command';
    
    // Execute command twice with same ID
    const results = await page.evaluate((id) => {
      const results = [];
      
      // First execution
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
        results.push({ success: true, strokeCount: window.testManager.currentSnapshot.strokes.length });
      } catch (e) {
        results.push({ success: false, error: e.message });
      }
      
      // Second execution (duplicate)
      try {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: id, // Same ID
          tool: 'highlighter', // Different properties
          color: '#FF0000',
          size: 5,
          opacity: 0.5,
          points: [20, 20, 30, 30],
          bbox: { min: [20, 20], max: [30, 30] },
          scene: 0,
          startedAt: Date.now()
        });
        results.push({ success: true, strokeCount: window.testManager.currentSnapshot.strokes.length });
      } catch (e) {
        results.push({ success: false, error: e.message, strokeCount: window.testManager.currentSnapshot.strokes.length });
      }
      
      return results;
    }, commandId);
    
    // First should succeed
    expect(results[0].success).toBe(true);
    expect(results[0].strokeCount).toBe(1);
    
    // Second should not increase stroke count
    expect(results[1].strokeCount).toBe(1);
    
    // Verify original properties preserved
    const stroke = await page.evaluate((id) => {
      const strokes = window.testManager.currentSnapshot.strokes;
      return strokes.find((s: any) => s.id === id);
    }, commandId);
    
    expect(stroke.tool).toBe('pen'); // Not highlighter
    expect(stroke.color).toBe('#000000'); // Not red
  });

  test('snapshot arrays are new references after update', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Capture initial references
    await page.evaluate(() => {
      const snap = window.testManager.currentSnapshot;
      window.initialRefs = {
        strokes: snap.strokes,
        texts: snap.texts,
        svKey: snap.svKey
      };
      return true;
    });
    
    // Make a change
    await page.evaluate(() => {
      window.testManager.write({
        type: 'DrawStrokeCommit',
        id: 'ref-test',
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
    
    // Check that references changed
    const refsChanged = await page.evaluate(() => {
      const snap = window.testManager.currentSnapshot;
      return {
        strokesChanged: snap.strokes !== window.initialRefs.strokes,
        textsChanged: snap.texts !== window.initialRefs.texts,
        svKeyChanged: snap.svKey !== window.initialRefs.svKey
      };
    });
    
    expect(refsChanged.strokesChanged).toBe(true);
    expect(refsChanged.textsChanged).toBe(true);
    expect(refsChanged.svKeyChanged).toBe(true);
  });
});