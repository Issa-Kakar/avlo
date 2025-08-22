/**
 * SceneCapture - Critical utility for distributed systems causal consistency
 *
 * This class ensures that operations started in one scene complete in that same scene,
 * regardless of concurrent ClearBoard operations by other users. Without this,
 * we'd have temporal paradoxes where strokes could jump between scenes.
 *
 * DISTRIBUTED SYSTEMS PRINCIPLE:
 * In a collaborative CRDT system, the scene where an action BEGINS must be
 * the scene where it COMMITS. This preserves causality and user intent.
 */
export class SceneCapture {
    capturedScene = null;
    captureTime = 0;
    captureId = ''; // For debugging concurrent captures
    /**
     * Capture the current scene at interaction start.
     * MUST be called at: pointerdown, touchstart, stylus contact, keyboard shortcut
     * NEVER call at: pointermove, pointerup, commit time
     */
    capture(snapshot) {
        if (this.capturedScene !== null) {
            console.warn(`[SceneCapture] Overwriting existing capture (scene=${this.capturedScene}, age=${Date.now() - this.captureTime}ms)`);
        }
        this.capturedScene = snapshot.scene;
        this.captureTime = Date.now();
        this.captureId = `${snapshot.scene}_${this.captureTime}`;
        if (process.env.NODE_ENV === 'development') {
            console.log(`[SceneCapture] Captured scene=${this.capturedScene} at t=${this.captureTime} id=${this.captureId}`);
        }
        return this.capturedScene;
    }
    /**
     * Get the captured scene (may be null if not captured)
     */
    get() {
        return this.capturedScene;
    }
    /**
     * Get the captured scene, throwing if not captured.
     * Use this in commit handlers to ensure scene was captured.
     */
    getRequired() {
        if (this.capturedScene === null) {
            throw new Error('[SceneCapture] Scene not captured - MUST call capture() at interaction start (pointerdown/touchstart)');
        }
        // Development assertion: Warn if capture is stale
        if (process.env.NODE_ENV === 'development') {
            const age = Date.now() - this.captureTime;
            if (age > 30000) { // 30 seconds
                console.warn(`[SceneCapture] Using stale capture (age=${age}ms, scene=${this.capturedScene})`);
            }
        }
        return this.capturedScene;
    }
    /**
     * Reset the capture. Call after committing or canceling.
     */
    reset() {
        if (process.env.NODE_ENV === 'development' && this.capturedScene !== null) {
            console.log(`[SceneCapture] Reset capture (was scene=${this.capturedScene}, age=${Date.now() - this.captureTime}ms)`);
        }
        this.capturedScene = null;
        this.captureTime = 0;
        this.captureId = '';
    }
    /**
     * Check if capture is valid (exists and not too old).
     * Used for long-running operations or chunked commits.
     */
    isValid(maxAgeMs = 30000) {
        return (this.capturedScene !== null &&
            (Date.now() - this.captureTime) < maxAgeMs);
    }
    /**
     * Get info about current capture for debugging
     */
    getDebugInfo() {
        return {
            scene: this.capturedScene,
            age: this.capturedScene !== null ? Date.now() - this.captureTime : null,
            id: this.captureId,
        };
    }
    /**
     * Validate that a scene is not from the future.
     * Call this before committing to catch bugs.
     */
    validateNotFuture(currentScene) {
        if (this.capturedScene === null) {
            throw new Error('[SceneCapture] Cannot validate null capture');
        }
        if (this.capturedScene > currentScene) {
            throw new Error(`[SceneCapture] Scene from future detected! captured=${this.capturedScene} > current=${currentScene}`);
        }
    }
}
/**
 * Factory for managing multiple concurrent scene captures
 * (e.g., multi-touch where each finger has independent capture)
 */
export class SceneCaptureManager {
    captures = new Map();
    /**
     * Get or create a capture for a specific pointer/touch
     */
    getCapture(pointerId) {
        let capture = this.captures.get(pointerId);
        if (!capture) {
            capture = new SceneCapture();
            this.captures.set(pointerId, capture);
        }
        return capture;
    }
    /**
     * Remove a capture when pointer/touch ends
     */
    removeCapture(pointerId) {
        const capture = this.captures.get(pointerId);
        if (capture) {
            capture.reset();
            this.captures.delete(pointerId);
        }
    }
    /**
     * Reset all captures (e.g., on tool change)
     */
    resetAll() {
        this.captures.forEach(capture => capture.reset());
        this.captures.clear();
    }
    /**
     * Get debug info for all active captures
     */
    getDebugInfo() {
        const info = new Map();
        this.captures.forEach((capture, id) => {
            info.set(id, capture.getDebugInfo());
        });
        return info;
    }
}
/**
 * Development-only assertions for scene consistency
 */
export function assertSceneConsistency(capturedScene, currentScene, commandType) {
    if (process.env.NODE_ENV !== 'development')
        return;
    // Scene can't be from the future
    if (capturedScene > currentScene) {
        throw new Error(`[Scene] Future scene in ${commandType}: captured=${capturedScene} > current=${currentScene}`);
    }
    // Warn if scene is far in the past (might indicate a bug)
    const sceneDelta = currentScene - capturedScene;
    if (sceneDelta > 10) {
        console.warn(`[Scene] Large scene delta in ${commandType}: delta=${sceneDelta} (captured=${capturedScene}, current=${currentScene})`);
    }
    // Log for debugging
    console.log(`[Scene] ${commandType} consistency check: captured=${capturedScene}, current=${currentScene}, delta=${sceneDelta}`);
}
