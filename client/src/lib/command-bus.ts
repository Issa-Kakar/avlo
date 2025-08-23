import { Command, ROOM_CONFIG, PERFORMANCE_CONFIG } from '@avlo/shared';
import * as Y from 'yjs';
import { WriteQueue } from './write-queue';

export interface CommandBusConfig {
  ydoc: Y.Doc;
  writeQueue: WriteQueue;
  getCurrentSize: () => number;
  getHelpers: () => {
    getStrokes: () => Y.Array<any>;
    getTexts: () => Y.Array<any>;
    getCode: () => Y.Map<any>;
    getOutputs: () => Y.Array<any>;
    getSceneTicks: () => Y.Array<number>;
    getCurrentScene: () => number;
  };
  onClearBoard?: () => void; // Callback for size estimator reset
}

export class CommandBus {
  private config: CommandBusConfig;
  private processing = false;
  private processTimer: number = 0;
  private batchWindow = PERFORMANCE_CONFIG.MICRO_BATCH_DEFAULT_MS;

  constructor(config: CommandBusConfig) {
    this.config = config;
  }

  start(): void {
    this.scheduleProcess();
  }

  stop(): void {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = 0;
    }
  }

  // Add method to force immediate processing (for tests)
  async processImmediate(): Promise<void> {
    // Clear any pending timer
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = 0;
    }

    // Process batch immediately
    await this.processBatch();

    // Reschedule for normal operation
    this.scheduleProcess();
  }

  private scheduleProcess(): void {
    if (this.processTimer) return;

    this.processTimer = setTimeout(() => {
      this.processTimer = 0;
      this.processBatch();
      this.scheduleProcess(); // Continue processing
    }, this.batchWindow) as unknown as number;
  }

  private async processBatch(): Promise<void> {
    if (this.processing) return;

    this.processing = true;
    const startTime = performance.now();

    try {
      // Process commands until budget exhausted or queue empty
      const budget = PERFORMANCE_CONFIG.TRANSACT_BUDGET_MS;

      while (this.config.writeQueue.size() > 0) {
        const elapsed = performance.now() - startTime;
        if (elapsed > budget) {
          // Yield to avoid blocking
          await new Promise((resolve) => setTimeout(resolve, 0));
          break;
        }

        // CRITICAL: Re-check room size before each command
        const currentSize = this.config.getCurrentSize();
        if (currentSize >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
          console.warn('[CommandBus] Room became read-only during batch processing');
          // Clear remaining queue to prevent further writes
          while (this.config.writeQueue.size() > 0) {
            this.config.writeQueue.dequeue();
          }
          break;
        }

        const cmd = this.config.writeQueue.dequeue();
        if (!cmd) break;

        await this.executeCommand(cmd);
      }

      // NOTE: Batch window adaptation is handled in RoomDocManager.maybePublish()
      // based on actual publish cost, not command processing time
    } finally {
      this.processing = false;
    }
  }

  private async executeCommand(cmd: Command): Promise<void> {
    const helpers = this.config.getHelpers();

    // CRITICAL: Development assertions for scene consistency
    if (process.env.NODE_ENV === 'development') {
      // Assert scene is not from the future
      if (
        'scene' in cmd &&
        typeof cmd.scene === 'number' &&
        cmd.scene > helpers.getCurrentScene()
      ) {
        throw new Error(
          `[CommandBus] Scene from future: ${cmd.scene} > ${helpers.getCurrentScene()}`,
        );
      }

      // Assert scene is captured (not undefined/null) for commands that need it
      if (cmd.type === 'DrawStrokeCommit' || cmd.type === 'AddText') {
        if (cmd.scene === undefined || cmd.scene === null) {
          throw new Error(`[CommandBus] Scene is required for ${cmd.type}`);
        }
      }

      // Track scene capture metrics
      if ('scene' in cmd && typeof cmd.scene === 'number') {
        performance.mark(`scene-capture-${cmd.type}-${cmd.scene}`);
      }
    }

    // Get userId for transaction origin (needed for undo/redo)
    const userId = 'current-user'; // TODO: Get from awareness/auth in Phase 4

    // CRITICAL: Each command in exactly one transaction with userId as origin
    // Wrap in try-catch for error recovery
    try {
      this.config.ydoc.transact(() => {
      switch (cmd.type) {
        case 'DrawStrokeCommit': {
          const strokes = helpers.getStrokes();

          strokes.push([
            {
              id: cmd.id,
              tool: cmd.tool,
              color: cmd.color,
              size: cmd.size,
              opacity: cmd.opacity,
              points: cmd.points, // Store as plain array
              bbox: cmd.bbox,
              scene: cmd.scene, // CRITICAL: Use captured scene from pointer-down
              createdAt: cmd.startedAt,
              userId: 'current-user', // Will be from awareness later
            },
          ]);
          break;
        }

        case 'EraseObjects': {
          const strokes = helpers.getStrokes();
          const texts = helpers.getTexts();

          // Find and remove strokes
          const strokeArray = strokes.toArray();
          const strokeIndicesToDelete: number[] = [];

          cmd.ids.forEach((id) => {
            const index = strokeArray.findIndex((s: any) => s.id === id);
            if (index !== -1) {
              strokeIndicesToDelete.push(index);
            }
          });

          // Delete in reverse order to maintain indices
          strokeIndicesToDelete.sort((a, b) => b - a);
          strokeIndicesToDelete.forEach((i) => strokes.delete(i, 1));

          // Find and remove texts
          const textArray = texts.toArray();
          const textIndicesToDelete: number[] = [];

          cmd.ids.forEach((id) => {
            const index = textArray.findIndex((t: any) => t.id === id);
            if (index !== -1) {
              textIndicesToDelete.push(index);
            }
          });

          textIndicesToDelete.sort((a, b) => b - a);
          textIndicesToDelete.forEach((i) => texts.delete(i, 1));
          break;
        }

        case 'AddText': {
          const texts = helpers.getTexts();

          texts.push([
            {
              id: cmd.id,
              x: cmd.x,
              y: cmd.y,
              w: cmd.w,
              h: cmd.h,
              content: cmd.content,
              color: cmd.color,
              size: cmd.size,
              scene: cmd.scene, // CRITICAL: Use captured scene from command, never re-read getCurrentScene()
              createdAt: Date.now(),
              userId: 'current-user',
            },
          ]);
          break;
        }

        case 'ClearBoard': {
          const sceneTicks = helpers.getSceneTicks();
          console.log('[CommandBus] Before ClearBoard - sceneTicks:', sceneTicks);
          console.log('[CommandBus] Before ClearBoard - sceneTicks length:', sceneTicks.length);
          console.log('[CommandBus] Before ClearBoard - sceneTicks toArray:', sceneTicks.toArray());
          
          // CRITICAL: Push the timestamp directly as a single value
          // Y.Array<number> expects individual numbers, not arrays
          const timestamp = Date.now();
          sceneTicks.push([timestamp]); // Y.Array push expects array of elements to push
          
          console.log('[CommandBus] After ClearBoard - sceneTicks length:', sceneTicks.length);
          console.log('[CommandBus] After ClearBoard - sceneTicks toArray:', sceneTicks.toArray());
          console.log('[CommandBus] Current scene should be:', sceneTicks.length);
          
          // Reset size estimator baseline after clearing board
          if (this.config.onClearBoard) {
            this.config.onClearBoard();
          }
          break;
        }

        case 'ExtendTTL': {
          // Minimal write to trigger TTL extension
          const code = helpers.getCode();
          const version = (code.get('version') as number) || 0;
          code.set('version', version + 0.001); // Tiny change
          break;
        }

        case 'CodeUpdate': {
          const code = helpers.getCode();
          const currentVersion = code.get('version') as number;

          if (currentVersion !== cmd.version) {
            console.warn('[CommandBus] Code version mismatch');
            return;
          }

          code.set('lang', cmd.lang);
          code.set('body', cmd.body);
          code.set('version', cmd.version + 1);
          break;
        }

        case 'CodeRun': {
          // Code execution will be handled in Phase 7
          // For now, just log
          console.log('[CommandBus] Code run requested');
          break;
        }

        default: {
          // TypeScript exhaustiveness check
          const _exhaustive: never = cmd;
          console.warn('[CommandBus] Unknown command type:', (_exhaustive as any).type);
        }
      }
      }, userId); // CRITICAL: Use userId as origin for undo/redo tracking
    } catch (error) {
      console.error('[CommandBus] Transaction failed:', error);
      // Continue processing - don't let one failure stop the queue
      // TODO: Consider retry logic or error reporting in Phase 4
    }
  }

  destroy(): void {
    this.stop();
  }
}
