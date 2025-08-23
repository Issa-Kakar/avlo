/**
 * Size estimation utilities for enforcing distributed system constraints
 * 
 * This module provides:
 * 1. Actual gzip measurement for precise 2MB frame cap enforcement
 * 2. Rolling compression ratio (EWMA) for efficient doc size estimation
 * 3. Platform-agnostic implementation (browser/Node)
 */

/**
 * Compress data using gzip in the browser
 * Uses the native CompressionStream API
 */
export async function gzipSizeBrowser(input: Uint8Array | string): Promise<number> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  
  // CompressionStream is supported on modern browsers
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  
  const compressed = await new Response(cs.readable).arrayBuffer();
  return compressed.byteLength;
}

/**
 * Compress data using gzip in Node.js/tests
 * Uses zlib for synchronous compression
 */
export function gzipSizeNode(input: Uint8Array | string): number {
  // Dynamic import to avoid bundling in browser
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { gzipSync } = require('zlib');
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return gzipSync(bytes).byteLength;
}

/**
 * Platform-agnostic gzip size measurement
 * Automatically selects browser or Node implementation
 */
export async function getGzipSize(input: Uint8Array | string): Promise<number> {
  // Check for CompressionStream availability (browser)
  if (typeof CompressionStream !== 'undefined') {
    return gzipSizeBrowser(input);
  } else {
    // In Node/tests, wrap sync call in Promise for consistent API
    return Promise.resolve(gzipSizeNode(input));
  }
}

/**
 * Rolling compression ratio estimator using EWMA (Exponentially Weighted Moving Average)
 * 
 * This estimator tracks the compression ratio of document deltas to predict
 * the total compressed document size without compressing the entire document
 * on every write (which would be too expensive).
 * 
 * The estimator maintains:
 * - A rolling compression ratio (ĉ) updated via EWMA
 * - Running estimate of total compressed doc size
 * - Adaptive sampling to balance accuracy and performance
 */
export class RollingGzipEstimator {
  private ratioEWMA = 0.5;           // Start conservative (50% compression)
  private readonly alpha = 0.2;      // Smoothing factor (0..1)
  private readonly minRatio = 0.15;  // Floor: best case compression
  private readonly maxRatio = 1.0;   // Ceiling: no compression
  private _docEstGzBytes = 0;        // Estimated compressed doc size
  private sampleCounter = 0;         // Track samples for policy
  
  /**
   * Get current estimated compressed document size in bytes
   */
  get docEstGzBytes(): number { 
    return this._docEstGzBytes; 
  }
  
  /**
   * Get current compression ratio estimate
   */
  get ratio(): number { 
    return this.ratioEWMA; 
  }
  
  /**
   * Observe a delta (change) to the document
   * 
   * @param rawDeltaBytes - Uncompressed size of the delta in bytes
   * @param gzDeltaBytes - Optional actual compressed size of the delta
   */
  observeDelta(rawDeltaBytes: number, gzDeltaBytes?: number): void {
    if (rawDeltaBytes <= 0) return;
    
    // Update ratio if we have actual measurement
    if (gzDeltaBytes != null && gzDeltaBytes > 0) {
      const measuredRatio = gzDeltaBytes / rawDeltaBytes;
      const clampedRatio = Math.min(this.maxRatio, Math.max(this.minRatio, measuredRatio));
      
      // EWMA update: new estimate = α * measured + (1 - α) * old estimate
      this.ratioEWMA = this.alpha * clampedRatio + (1 - this.alpha) * this.ratioEWMA;
    }
    
    // Estimate compressed size of this delta
    const estGzDelta = gzDeltaBytes ?? Math.ceil(this.ratioEWMA * rawDeltaBytes);
    
    // Update total doc size estimate
    this._docEstGzBytes = Math.max(0, this._docEstGzBytes + estGzDelta);
    
    this.sampleCounter++;
  }
  
  /**
   * Reset baseline after semantic reset (e.g., ClearBoard)
   * Keeps the learned ratio but resets doc size to a small baseline
   * 
   * @param baselineGz - New baseline size in bytes (default: 64KB)
   */
  resetBaseline(baselineGz = 64 * 1024): void {
    this._docEstGzBytes = baselineGz;
    // Keep ratioEWMA but nudge slightly upward to be conservative
    this.ratioEWMA = Math.min(this.maxRatio, this.ratioEWMA * 1.05);
    this.sampleCounter = 0;
  }
  
  /**
   * Snap to authoritative server size (for future server integration)
   * 
   * @param authoritativeBytes - Server-reported compressed doc size
   * @param lastDeltaRatio - Optional ratio from last delta to seed EWMA
   */
  snapToAuthority(authoritativeBytes: number, lastDeltaRatio?: number): void {
    this._docEstGzBytes = authoritativeBytes;
    
    if (lastDeltaRatio != null) {
      // Seed ratio with server observation for faster convergence
      const clampedRatio = Math.min(this.maxRatio, Math.max(this.minRatio, lastDeltaRatio));
      this.ratioEWMA = this.alpha * clampedRatio + (1 - this.alpha) * this.ratioEWMA;
    }
  }
  
  /**
   * Determine if we should sample (actually compress) this delta
   * Balances accuracy vs performance
   * 
   * @param rawDeltaBytes - Size of the delta
   * @returns true if we should measure actual compression
   */
  shouldSample(rawDeltaBytes: number): boolean {
    // Always sample large deltas
    if (rawDeltaBytes >= 16 * 1024) return true;
    
    // Sample periodically (every 10 writes)
    if (this.sampleCounter % 10 === 0) return true;
    
    // Sample when approaching thresholds
    if (this._docEstGzBytes > 7.5 * 1024 * 1024) return true; // Near 8MB warning
    if (this._docEstGzBytes > 9.5 * 1024 * 1024) return true; // Near 10MB readonly
    
    return false;
  }
}

/**
 * Frame size validator
 * Ensures frames don't exceed transport limits (2MB)
 */
export async function validateFrameSize(
  frameBytes: Uint8Array | string,
  maxBytes = 2_000_000
): Promise<{ valid: boolean; compressedSize: number; reason?: string }> {
  const compressedSize = await getGzipSize(frameBytes);
  
  if (compressedSize > maxBytes) {
    return {
      valid: false,
      compressedSize,
      reason: `Frame exceeds ${maxBytes} bytes: ${compressedSize} bytes compressed`,
    };
  }
  
  return { valid: true, compressedSize };
}