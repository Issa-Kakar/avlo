import {
  Command,
  ValidationResult,
  ROOM_CONFIG,
  STROKE_CONFIG,
  TEXT_CONFIG,
  QUEUE_CONFIG,
  RATE_LIMIT_CONFIG,
  BACKOFF_CONFIG,
} from '@avlo/shared';
import { validateFrameSize } from './size-estimator';

export interface WriteQueueConfig {
  maxPending: number;
  isMobile: boolean;
  getCurrentSize: () => number; // Get current doc size in bytes (compressed)
  getCurrentScene: () => number; // Get current scene for validation
}

export class WriteQueue {
  private queue: Command[] = [];
  private processing = false;
  private idempotencyMap = new Map<string, number>(); // key -> timestamp
  private rateLimitMap = new Map<string, number>(); // command type -> last execution
  private config: WriteQueueConfig;
  private cleanupInterval: number;

  constructor(config: WriteQueueConfig) {
    this.config = config;

    // Clean up old idempotency entries periodically
    this.cleanupInterval = setInterval(() => this.cleanupIdempotency(), 60000) as unknown as number;
  }

  async validate(cmd: Command): Promise<ValidationResult> {
    // 1. Check mobile view-only
    if (this.config.isMobile) {
      return { valid: false, reason: 'view_only', details: 'Mobile devices are view-only' };
    }

    // 2. Check room read-only (≥10MB)
    const currentSize = this.config.getCurrentSize();
    if (currentSize >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
      return { valid: false, reason: 'read_only', details: 'Room size limit exceeded' };
    }

    // 3. Check idempotency
    const idempotencyKey = this.getIdempotencyKey(cmd);
    if (this.idempotencyMap.has(idempotencyKey)) {
      return { valid: false, reason: 'invalid_data', details: 'Duplicate command' };
    }

    // 4. Check rate limits
    if (!this.checkRateLimit(cmd)) {
      return { valid: false, reason: 'rate_limited', details: 'Command rate limited' };
    }

    // 5. Command-specific validation
    const specificValidation = this.validateCommand(cmd);
    if (!specificValidation.valid) {
      return specificValidation;
    }

    // 6. Validate frame size with actual gzip measurement
    // Serialize command to get actual wire format
    const frameBytes = JSON.stringify(cmd);
    const frameValidation = await validateFrameSize(frameBytes, ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES);
    
    if (!frameValidation.valid) {
      return { 
        valid: false, 
        reason: 'oversize', 
        details: `Frame exceeds 2MB limit: ${frameValidation.compressedSize} bytes compressed` 
      };
    }

    return { valid: true };
  }

  async enqueue(cmd: Command): Promise<boolean> {
    // Check queue capacity
    if (this.queue.length >= this.config.maxPending) {
      console.warn('[WriteQueue] Queue full, dropping command');
      return false;
    }

    // Validate
    const validation = await this.validate(cmd);
    if (!validation.valid) {
      console.warn('[WriteQueue] Validation failed:', validation);
      return false;
    }

    // Add to queue
    this.queue.push(cmd);

    // Track idempotency
    const idempotencyKey = this.getIdempotencyKey(cmd);
    this.idempotencyMap.set(idempotencyKey, Date.now());

    return true;
  }

  dequeue(): Command | null {
    return this.queue.shift() || null;
  }

  size(): number {
    return this.queue.length;
  }

  isBackpressured(): boolean {
    return this.queue.length > QUEUE_CONFIG.WRITE_QUEUE_HIGH_WATER;
  }

  private getIdempotencyKey(cmd: Command): string {
    switch (cmd.type) {
      case 'DrawStrokeCommit':
        return cmd.id;
      case 'AddText':
        return cmd.id;
      case 'EraseObjects':
        return cmd.idempotencyKey;
      case 'ClearBoard':
        return cmd.idempotencyKey;
      case 'ExtendTTL':
        return cmd.idempotencyKey;
      case 'CodeUpdate':
        return cmd.idempotencyKey;
      case 'CodeRun':
        return cmd.idempotencyKey;
      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = cmd;
        return `${(_exhaustive as any).type}_${Date.now()}`;
      }
    }
  }

  private checkRateLimit(cmd: Command): boolean {
    const now = Date.now();

    switch (cmd.type) {
      case 'ClearBoard': {
        const lastClear = this.rateLimitMap.get('ClearBoard') || 0;
        if (now - lastClear < RATE_LIMIT_CONFIG.CLEAR_BOARD_COOLDOWN_MS) {
          return false;
        }
        this.rateLimitMap.set('ClearBoard', now);
        return true;
      }

      case 'ExtendTTL': {
        const lastExtend = this.rateLimitMap.get('ExtendTTL') || 0;
        if (now - lastExtend < BACKOFF_CONFIG.TTL_EXTEND_COOLDOWN_MS) {
          return false;
        }
        this.rateLimitMap.set('ExtendTTL', now);
        return true;
      }

      default:
        return true;
    }
  }

  private validateCommand(cmd: Command): ValidationResult {
    switch (cmd.type) {
      case 'DrawStrokeCommit': {
        // Check for required fields
        if (!cmd.points || !Array.isArray(cmd.points)) {
          return {
            valid: false,
            reason: 'invalid_data',
            details: 'Points array is required',
          };
        }
        
        // Check points limit
        if (cmd.points.length / 2 > STROKE_CONFIG.MAX_POINTS_PER_STROKE) {
          return {
            valid: false,
            reason: 'invalid_data',
            details: `Too many points: ${cmd.points.length / 2}`,
          };
        }

        // CRITICAL: Check 128KB per-stroke budget (after simplification)
        const estimatedSize = this.estimateEncodedSize(cmd);
        if (estimatedSize > STROKE_CONFIG.MAX_STROKE_UPDATE_BYTES) {
          return {
            valid: false,
            reason: 'oversize',
            details: `Stroke update exceeds 128KB: ${estimatedSize} bytes`,
          };
        }

        // CRITICAL: Validate scene is present
        if (cmd.scene === undefined || cmd.scene === null) {
          return {
            valid: false,
            reason: 'invalid_data',
            details: 'Scene is required for DrawStrokeCommit',
          };
        }

        // CRITICAL: Validate scene is not from the future
        const currentScene = this.config.getCurrentScene();
        if (cmd.scene > currentScene) {
          return {
            valid: false,
            reason: 'invalid_data',
            details: `Scene from future: ${cmd.scene} > ${currentScene}`,
          };
        }

        return { valid: true };
      }

      case 'AddText': {
        if (cmd.content.length > TEXT_CONFIG.MAX_TEXT_LENGTH) {
          return {
            valid: false,
            reason: 'invalid_data',
            details: `Text too long: ${cmd.content.length} chars`,
          };
        }

        // CRITICAL: Validate scene is present
        if (cmd.scene === undefined || cmd.scene === null) {
          return {
            valid: false,
            reason: 'invalid_data',
            details: 'Scene is required for AddText',
          };
        }

        // CRITICAL: Validate scene is not from the future
        const currentScene = this.config.getCurrentScene();
        if (cmd.scene > currentScene) {
          return {
            valid: false,
            reason: 'invalid_data',
            details: `Scene from future: ${cmd.scene} > ${currentScene}`,
          };
        }

        return { valid: true };
      }

      case 'CodeUpdate': {
        const bytes = new TextEncoder().encode(cmd.body).length;
        if (bytes > TEXT_CONFIG.MAX_CODE_BODY_BYTES) {
          return {
            valid: false,
            reason: 'invalid_data',
            details: `Code too large: ${bytes} bytes`,
          };
        }
        return { valid: true };
      }

      default:
        return { valid: true };
    }
  }

  private estimateEncodedSize(cmd: Command): number {
    // More accurate estimation for different command types
    if (cmd.type === 'DrawStrokeCommit') {
      // For strokes, the points array dominates the size
      // Each point is 2-3 floats (x, y, optional pressure)
      // In JSON: ~15-20 chars per coordinate, plus metadata
      const pointsSize = cmd.points.length * 8; // 8 bytes per float in binary
      const metadataSize = 200; // Estimated metadata overhead
      const yOverhead = 1.3; // Y.js encoding overhead
      return Math.ceil((pointsSize + metadataSize) * yOverhead);
    }
    
    // For other commands, use JSON estimation
    const json = JSON.stringify(cmd);
    const overhead = 1.5; // Y.js encoding overhead estimate
    return Math.ceil(json.length * overhead);
  }

  private cleanupIdempotency(): void {
    const cutoff = Date.now() - 5 * 60 * 1000; // 5 minutes
    for (const [key, timestamp] of this.idempotencyMap) {
      if (timestamp < cutoff) {
        this.idempotencyMap.delete(key);
      }
    }
  }

  destroy(): void {
    this.queue = [];
    this.idempotencyMap.clear();
    this.rateLimitMap.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}