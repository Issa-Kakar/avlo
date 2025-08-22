/**
 * Scene Capture Integration Guide for WriteQueue and CommandBus
 *
 * This file provides integration patterns and migration helpers for
 * properly implementing scene capture in phases 2.4 and 2.5.
 *
 * CRITICAL: This ensures distributed systems causal consistency.
 */
import { assertSceneConsistency } from './scene-capture';
/**
 * Migration helper for commands missing scene field.
 * This is a TEMPORARY shim - remove once all clients are updated.
 */
export class CommandSceneMigrator {
    missingSceneMetrics = new Map();
    /**
     * Add scene to commands that are missing it.
     * Logs warnings and tracks metrics for monitoring migration progress.
     */
    ensureScene(cmd, getCurrentScene) {
        // Commands that require scene
        if (cmd.type === 'DrawStrokeCommit' || cmd.type === 'AddText') {
            if (!('scene' in cmd) || cmd.scene === undefined || cmd.scene === null) {
                // Track missing scene for metrics
                const count = this.missingSceneMetrics.get(cmd.type) || 0;
                this.missingSceneMetrics.set(cmd.type, count + 1);
                console.warn(`[Migration] Command ${cmd.type} missing scene, using current scene as fallback. ` +
                    `This is a BUG - scene should be captured at interaction start!`);
                // Add current scene as fallback (not ideal but prevents crashes)
                const currentScene = getCurrentScene();
                return { ...cmd, scene: currentScene };
            }
        }
        return cmd;
    }
    /**
     * Get metrics on missing scenes for monitoring migration
     */
    getMetrics() {
        let total = 0;
        this.missingSceneMetrics.forEach(count => {
            total += count;
        });
        return {
            total,
            byType: new Map(this.missingSceneMetrics),
        };
    }
    /**
     * Check if migration is complete (no missing scenes)
     */
    isMigrationComplete() {
        return this.getMetrics().total === 0;
    }
}
/**
 * Scene validation for WriteQueue integration
 */
export class SceneValidator {
    /**
     * Validate scene in command before enqueueing
     */
    static validateCommand(cmd, currentScene) {
        // Only validate commands that have scene
        if ('scene' in cmd && cmd.scene !== undefined) {
            // Scene can't be from the future
            if (cmd.scene > currentScene) {
                return {
                    valid: false,
                    error: `Scene from future: cmd.scene=${cmd.scene} > current=${currentScene}`,
                };
            }
            // Warn if scene is very old (might indicate a bug)
            const sceneDelta = currentScene - cmd.scene;
            if (sceneDelta > 10) {
                console.warn(`[SceneValidator] Large scene delta: ${sceneDelta} (cmd=${cmd.scene}, current=${currentScene})`);
            }
        }
        return { valid: true };
    }
}
/**
 * CommandBus integration helper
 */
export class CommandBusSceneHelper {
    /**
     * Execute command with scene consistency checks
     */
    static executeWithSceneCheck(cmd, currentScene, execute) {
        // Development assertions
        if (process.env.NODE_ENV === 'development') {
            if ('scene' in cmd && cmd.scene !== undefined) {
                assertSceneConsistency(cmd.scene, currentScene, cmd.type);
            }
        }
        // Track scene usage metrics
        if ('scene' in cmd) {
            performance.mark(`scene-capture-${cmd.type}-${cmd.scene}`);
        }
        // Execute the command
        execute();
        // Log execution for debugging
        if (process.env.NODE_ENV === 'development') {
            console.log(`[CommandBus] Executed ${cmd.type} with scene=${'scene' in cmd ? cmd.scene : 'N/A'} (current=${currentScene})`);
        }
    }
}
/**
 * Template for proper WriteQueue validation with scene checking
 */
export function createWriteQueueValidator(getCurrentScene, getCurrentSize, isMobile) {
    const migrator = new CommandSceneMigrator();
    return {
        validate(cmd) {
            // 1. Mobile check
            if (isMobile) {
                return { valid: false, reason: 'view_only' };
            }
            // 2. Size check
            if (getCurrentSize() >= 10485760) { // 10MB
                return { valid: false, reason: 'read_only' };
            }
            // 3. Migrate missing scenes (temporary)
            const migratedCmd = migrator.ensureScene(cmd, getCurrentScene);
            // 4. Validate scene consistency
            const sceneValidation = SceneValidator.validateCommand(migratedCmd, getCurrentScene());
            if (!sceneValidation.valid) {
                return { valid: false, reason: sceneValidation.error };
            }
            // 5. Log migration metrics periodically
            const metrics = migrator.getMetrics();
            if (metrics.total > 0 && metrics.total % 100 === 0) {
                console.warn(`[Migration] ${metrics.total} commands missing scene`, Object.fromEntries(metrics.byType));
            }
            return { valid: true };
        },
        getMigrationMetrics: () => migrator.getMetrics(),
    };
}
export function createSceneAwareExecutor(getHelpers) {
    return {
        execute(cmd) {
            const helpers = getHelpers();
            const currentScene = helpers.getCurrentScene();
            CommandBusSceneHelper.executeWithSceneCheck(cmd, currentScene, () => {
                switch (cmd.type) {
                    case 'DrawStrokeCommit': {
                        // CRITICAL: Use cmd.scene, NEVER re-read current scene
                        const strokes = helpers.getStrokes();
                        strokes.push([{
                                // ... other fields ...
                                scene: cmd.scene, // Use captured scene from command
                            }]);
                        break;
                    }
                    case 'AddText': {
                        // CRITICAL: Use cmd.scene, NEVER re-read current scene
                        const texts = helpers.getTexts();
                        texts.push([{
                                // ... other fields ...
                                scene: cmd.scene, // Use captured scene from command
                            }]);
                        break;
                    }
                    // Other commands that don't need scene
                    default:
                        // Execute normally
                        break;
                }
            });
        },
    };
}
/**
 * Development-only scene capture debugger
 */
export class SceneCaptureDebugger {
    captureLog = [];
    logCapture(event, scene, details) {
        this.captureLog.push({
            timestamp: Date.now(),
            event,
            scene,
            details,
        });
        // Keep only last 100 entries
        if (this.captureLog.length > 100) {
            this.captureLog.shift();
        }
    }
    getRecentCaptures(count = 10) {
        return this.captureLog.slice(-count);
    }
    findAnomalies() {
        const anomalies = [];
        for (let i = 1; i < this.captureLog.length; i++) {
            const prev = this.captureLog[i - 1];
            const curr = this.captureLog[i];
            // Check for scene going backwards
            if (prev.scene !== null &&
                curr.scene !== null &&
                curr.scene < prev.scene &&
                curr.event === 'capture') {
                anomalies.push({
                    issue: 'Scene went backwards',
                    entry: curr,
                });
            }
            // Check for capture without reset
            if (prev.event === 'capture' &&
                curr.event === 'capture' &&
                prev.scene !== null) {
                anomalies.push({
                    issue: 'Capture without reset',
                    entry: curr,
                });
            }
        }
        return anomalies;
    }
}
