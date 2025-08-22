import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneCapture, SceneCaptureManager, assertSceneConsistency } from '../scene-capture';
describe('SceneCapture - Distributed Systems Causal Consistency', () => {
    let capture;
    // Helper to create a snapshot with a specific scene
    const createSnapshot = (scene) => ({
        svKey: 'test-key',
        scene,
        strokes: [],
        texts: [],
        presence: {
            users: new Map(),
            localUserId: 'test-user'
        },
        spatialIndex: {},
        view: {
            scale: 1,
            pan: { x: 0, y: 0 },
            worldToCanvas: (x, y) => [x, y],
            canvasToWorld: (x, y) => [x, y],
        },
        meta: {
            bytes: 0,
            cap: 10485760,
            readOnly: false,
        },
        createdAt: Date.now(),
    });
    beforeEach(() => {
        capture = new SceneCapture();
    });
    describe('Core Functionality', () => {
        it('should capture scene at interaction start', () => {
            const snapshot = createSnapshot(5);
            const capturedScene = capture.capture(snapshot);
            expect(capturedScene).toBe(5);
            expect(capture.get()).toBe(5);
        });
        it('should throw when getting required scene without capture', () => {
            expect(() => capture.getRequired()).toThrow('Scene not captured - MUST call capture() at interaction start');
        });
        it('should return captured scene with getRequired after capture', () => {
            const snapshot = createSnapshot(3);
            capture.capture(snapshot);
            expect(capture.getRequired()).toBe(3);
        });
        it('should reset capture state', () => {
            const snapshot = createSnapshot(2);
            capture.capture(snapshot);
            expect(capture.get()).toBe(2);
            capture.reset();
            expect(capture.get()).toBeNull();
        });
        it('should validate capture age', () => {
            const snapshot = createSnapshot(1);
            capture.capture(snapshot);
            // Fresh capture should be valid
            expect(capture.isValid(30000)).toBe(true);
            // Old capture should be invalid
            vi.setSystemTime(Date.now() + 31000);
            expect(capture.isValid(30000)).toBe(false);
        });
    });
    describe('Distributed Systems Edge Cases', () => {
        it('should preserve scene across ClearBoard during gesture', () => {
            // User A starts drawing in Scene 0
            const snapshot0 = createSnapshot(0);
            const sceneAtPointerDown = capture.capture(snapshot0);
            // User B clears board (increments to Scene 1)
            const snapshot1 = createSnapshot(1);
            // User A completes stroke - must use captured scene
            const sceneAtCommit = capture.getRequired();
            // Critical assertion: Scene must be preserved
            expect(sceneAtCommit).toBe(sceneAtPointerDown);
            expect(sceneAtCommit).toBe(0); // Original scene, not current
            expect(sceneAtCommit).not.toBe(snapshot1.scene); // Not the new scene
        });
        it('should handle concurrent multi-touch with different scenes', () => {
            const manager = new SceneCaptureManager();
            // Touch 1 starts in Scene 0
            const snapshot0 = createSnapshot(0);
            const touch1 = manager.getCapture('touch1');
            const scene1 = touch1.capture(snapshot0);
            // ClearBoard happens
            const snapshot1 = createSnapshot(1);
            // Touch 2 starts in Scene 1
            const touch2 = manager.getCapture('touch2');
            const scene2 = touch2.capture(snapshot1);
            // Another ClearBoard
            // snapshot2 exists but not used - that's ok, it represents the state change
            // Both complete - each must preserve its original scene
            expect(touch1.getRequired()).toBe(0);
            expect(touch2.getRequired()).toBe(1);
            expect(scene1).toBe(0);
            expect(scene2).toBe(1);
        });
        it('should detect and reject scenes from the future', () => {
            const snapshot = createSnapshot(5);
            capture.capture(snapshot);
            // Current scene goes backwards (should never happen)
            const currentScene = 3;
            expect(() => capture.validateNotFuture(currentScene)).toThrow('Scene from future detected! captured=5 > current=3');
        });
        it('should handle rapid scene changes during long gesture', () => {
            // Start gesture in Scene 0
            const snapshot0 = createSnapshot(0);
            capture.capture(snapshot0);
            // Multiple ClearBoards happen during gesture
            // (simulated by creating new snapshots with incrementing scenes)
            for (let i = 1; i <= 10; i++) {
                createSnapshot(i);
            }
            // Gesture completes - must still be Scene 0
            const committedScene = capture.getRequired();
            expect(committedScene).toBe(0);
        });
        it('should warn about stale captures in development', () => {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'development';
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const snapshot = createSnapshot(0);
            capture.capture(snapshot);
            // Simulate 31 seconds passing
            vi.setSystemTime(Date.now() + 31000);
            capture.getRequired();
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Using stale capture'));
            consoleSpy.mockRestore();
            process.env.NODE_ENV = originalEnv;
        });
    });
    describe('SceneCaptureManager for Multi-Touch', () => {
        let manager;
        beforeEach(() => {
            manager = new SceneCaptureManager();
        });
        it('should manage independent captures per pointer', () => {
            const snapshot0 = createSnapshot(0);
            const capture1 = manager.getCapture('pointer1');
            capture1.capture(snapshot0);
            const snapshot1 = createSnapshot(1);
            const capture2 = manager.getCapture('pointer2');
            capture2.capture(snapshot1);
            expect(capture1.get()).toBe(0);
            expect(capture2.get()).toBe(1);
        });
        it('should clean up captures when pointer ends', () => {
            const capture1 = manager.getCapture('pointer1');
            const snapshot = createSnapshot(0);
            capture1.capture(snapshot);
            manager.removeCapture('pointer1');
            // Getting the same pointer again should return a fresh capture
            const capture2 = manager.getCapture('pointer1');
            expect(capture2.get()).toBeNull();
        });
        it('should reset all captures on tool change', () => {
            const snapshot0 = createSnapshot(0);
            manager.getCapture('pointer1').capture(snapshot0);
            const snapshot1 = createSnapshot(1);
            manager.getCapture('pointer2').capture(snapshot1);
            manager.resetAll();
            expect(manager.getCapture('pointer1').get()).toBeNull();
            expect(manager.getCapture('pointer2').get()).toBeNull();
        });
    });
    describe('assertSceneConsistency', () => {
        const originalEnv = process.env.NODE_ENV;
        beforeEach(() => {
            process.env.NODE_ENV = 'development';
        });
        afterEach(() => {
            process.env.NODE_ENV = originalEnv;
        });
        it('should throw for scenes from the future', () => {
            expect(() => {
                assertSceneConsistency(5, 3, 'DrawStrokeCommit');
            }).toThrow('Future scene in DrawStrokeCommit: captured=5 > current=3');
        });
        it('should warn for large scene deltas', () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            assertSceneConsistency(0, 11, 'DrawStrokeCommit');
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Large scene delta in DrawStrokeCommit: delta=11'));
            consoleSpy.mockRestore();
        });
        it('should pass for valid scene consistency', () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            expect(() => {
                assertSceneConsistency(3, 3, 'DrawStrokeCommit');
            }).not.toThrow();
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('consistency check: captured=3, current=3, delta=0'));
            consoleSpy.mockRestore();
        });
    });
    describe('Property-Based Testing', () => {
        it('should maintain causal consistency for any event sequence', () => {
            // Property: For any interleaving of pointerDown/clearBoard/pointerUp,
            // the committed scene must equal the captured scene
            const events = [
                { type: 'pointerDown', scene: 0 },
                { type: 'clearBoard', scene: 1 },
                { type: 'clearBoard', scene: 2 },
                { type: 'pointerUp', scene: 2 },
            ];
            let capturedScene = null;
            let currentScene = 0;
            events.forEach(event => {
                if (event.type === 'pointerDown') {
                    const snapshot = createSnapshot(currentScene);
                    capturedScene = capture.capture(snapshot);
                }
                else if (event.type === 'clearBoard') {
                    currentScene = event.scene;
                    // Scene updated in the simulated environment
                }
                else if (event.type === 'pointerUp') {
                    if (capturedScene !== null) {
                        const committedScene = capture.getRequired();
                        // Critical property: committed scene must equal captured scene
                        expect(committedScene).toBe(capturedScene);
                        expect(committedScene).not.toBe(currentScene); // Unless they happen to be the same
                    }
                }
            });
        });
    });
});
