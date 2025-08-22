/**
 * Phase 2 Critical Test: Scene Capture for Causal Consistency
 * 
 * CRITICAL: Scene must be captured ONCE at interaction start
 * and preserved through to commit. This prevents the distributed
 * race condition where ClearBoard happens during a gesture.
 */

import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    testReady: boolean;
    testManager: any;
    simulatePointerDown: (strokeId: string) => number;
    simulatePointerUp: (strokeId: string, points?: number[]) => void;
    capturedScenes: Record<string, number>;
    captureScene: () => number;
  }
}

test.describe('Scene Capture Consistency', () => {
  test('scene is captured at pointer-down and preserved through commit', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Capture scene at pointer-down
    const capturedScene = await page.evaluate(() => {
      const strokeId = 'test-stroke-1';
      return window.simulatePointerDown(strokeId);
    });
    
    expect(capturedScene).toBe(0); // Initial scene
    
    // Clear board (increments scene)
    await page.evaluate(() => {
      window.testManager.write({
        type: 'ClearBoard'
      });
    });
    
    // Current scene should now be 1
    const currentScene = await page.evaluate(() => 
      window.testManager.currentSnapshot.scene
    );
    expect(currentScene).toBe(1);
    
    // Complete the stroke (pointer-up)
    await page.evaluate(() => {
      window.simulatePointerUp('test-stroke-1', [0, 0, 100, 100]);
    });
    
    // The stroke should be in scene 0, not scene 1
    const stroke = await page.evaluate(() => {
      const strokes = window.testManager.currentSnapshot.strokes;
      return strokes.find((s: any) => s.id === 'test-stroke-1');
    });
    
    expect(stroke.scene).toBe(0); // Captured scene, not current
  });

  test('concurrent ClearBoard during multiple gestures', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Start multiple strokes in scene 0
    const capturedScenes = await page.evaluate(() => {
      const scenes: Record<string, number> = {};
      scenes['stroke-a'] = window.simulatePointerDown('stroke-a');
      scenes['stroke-b'] = window.simulatePointerDown('stroke-b');
      scenes['stroke-c'] = window.simulatePointerDown('stroke-c');
      return scenes;
    });
    
    expect(capturedScenes['stroke-a']).toBe(0);
    expect(capturedScenes['stroke-b']).toBe(0);
    expect(capturedScenes['stroke-c']).toBe(0);
    
    // Clear board twice while gestures are in progress
    await page.evaluate(() => {
      window.testManager.write({ type: 'ClearBoard' });
      window.testManager.write({ type: 'ClearBoard' });
    });
    
    // Current scene should be 2
    const currentScene = await page.evaluate(() => 
      window.testManager.currentSnapshot.scene
    );
    expect(currentScene).toBe(2);
    
    // Complete all strokes
    await page.evaluate(() => {
      window.simulatePointerUp('stroke-a', [0, 0, 10, 10]);
      window.simulatePointerUp('stroke-b', [20, 20, 30, 30]);
      window.simulatePointerUp('stroke-c', [40, 40, 50, 50]);
    });
    
    // All strokes should be in scene 0 (their captured scene)
    const strokes = await page.evaluate(() => {
      const allStrokes = window.testManager.currentSnapshot.strokes;
      return {
        a: allStrokes.find((s: any) => s.id === 'stroke-a'),
        b: allStrokes.find((s: any) => s.id === 'stroke-b'),
        c: allStrokes.find((s: any) => s.id === 'stroke-c')
      };
    });
    
    expect(strokes.a.scene).toBe(0);
    expect(strokes.b.scene).toBe(0);
    expect(strokes.c.scene).toBe(0);
  });

  test('scene from future is rejected', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Try to commit with scene > currentScene
    const rejected = await page.evaluate(() => {
      try {
        window.testManager.write({
          type: 'DrawStrokeCommit',
          id: 'future-stroke',
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: [0, 0, 10, 10],
          bbox: { min: [0, 0], max: [10, 10] },
          scene: 999, // Future scene
          startedAt: Date.now()
        });
        return false;
      } catch (e) {
        window.lastError = e.message;
        return true;
      }
    });
    
    expect(rejected).toBe(true);
    
    const error = await page.evaluate(() => window.lastError);
    expect(error.toLowerCase()).toMatch(/scene|future/);
  });

  test('text placement captures scene at interaction start', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    // Capture scene when text placement starts
    const capturedScene = await page.evaluate(() => {
      return window.captureScene();
    });
    
    expect(capturedScene).toBe(0);
    
    // Clear board while "typing"
    await page.evaluate(() => {
      window.testManager.write({ type: 'ClearBoard' });
    });
    
    // Commit text with captured scene
    await page.evaluate((scene) => {
      window.testManager.write({
        type: 'AddText',
        id: 'text-1',
        x: 100,
        y: 100,
        w: 200,
        h: 50,
        content: 'Hello World',
        color: '#000000',
        size: 16,
        scene: scene // Use captured scene
      });
    }, capturedScene);
    
    // Text should be in scene 0, not current scene 1
    const text = await page.evaluate(() => {
      const texts = window.testManager.currentSnapshot.texts;
      return texts.find((t: any) => t.id === 'text-1');
    });
    
    expect(text.scene).toBe(0);
  });

  test('rapid scene changes preserve individual captures', async ({ page }) => {
    await page.goto('/test-harness.html');
    await page.waitForFunction(() => window.testReady === true);
    
    const results = await page.evaluate(() => {
      const capturedScenes: number[] = [];
      const finalScenes: number[] = [];
      
      for (let i = 0; i < 5; i++) {
        // Capture scene
        const scene = window.simulatePointerDown(`rapid-${i}`);
        capturedScenes.push(scene);
        
        // Clear board
        window.testManager.write({ type: 'ClearBoard' });
        
        // Complete stroke
        window.simulatePointerUp(`rapid-${i}`, [i*10, i*10, i*10+5, i*10+5]);
      }
      
      // Get final scenes of all strokes
      const strokes = window.testManager.currentSnapshot.strokes;
      for (let i = 0; i < 5; i++) {
        const stroke = strokes.find((s: any) => s.id === `rapid-${i}`);
        if (stroke) {
          finalScenes.push(stroke.scene);
        }
      }
      
      return { capturedScenes, finalScenes };
    });
    
    // Each stroke should be in its captured scene
    expect(results.capturedScenes).toEqual([0, 1, 2, 3, 4]);
    expect(results.finalScenes).toEqual([0, 1, 2, 3, 4]);
  });
});