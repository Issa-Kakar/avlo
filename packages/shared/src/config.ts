/**
 * Centralized configuration for Avlo
 * All constants live here with environment variable overrides
 * As specified in IMPLEMENTATION.MD & OVERVIEW.MD global conventions
 */

// Handle both browser and Node environments
// Use globalThis to avoid TypeScript errors
declare const globalThis: {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

// Declare window for browser environment
declare const window: any;

const getEnv = (): Record<string, string | undefined> => {
  // In browser, use import.meta.env (Vite)
  if (typeof window !== 'undefined' && typeof (import.meta as any)?.env !== 'undefined') {
    return (import.meta as any).env as Record<string, string | undefined>;
  }
  // In Node.js, use process.env
  if (typeof globalThis !== 'undefined' && globalThis.process?.env) {
    return globalThis.process.env;
  }
  // Fallback to empty object
  return {};
};

const env = getEnv();

// Helper to parse environment variables with defaults
const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = env[key];
  return value ? Number(value) : defaultValue;
};

const getEnvString = (key: string, defaultValue: string): string => {
  return env[key] || defaultValue;
};

const getEnvBoolean = (key: string, defaultValue: boolean): boolean => {
  const value = env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
};

// ============================================
// ROOM & PERSISTENCE CONFIGURATION
// ============================================

export const ROOM_CONFIG = {
  // TTL for rooms in Redis (days)
  ROOM_TTL_DAYS: getEnvNumber('ROOM_TTL_DAYS', 14),

  // Room size limits (bytes)
  ROOM_SIZE_WARNING_BYTES: getEnvNumber('ROOM_SIZE_WARNING_BYTES', 13 * 1024 * 1024), // 13 MB
  ROOM_SIZE_READONLY_BYTES: getEnvNumber('ROOM_SIZE_READONLY_BYTES', 15 * 1024 * 1024), // 15 MB

  // Capacity limits
  MAX_CLIENTS_PER_ROOM: getEnvNumber('MAX_CLIENTS_PER_ROOM', 105),
  MAX_CONCURRENT_PER_IP: getEnvNumber('MAX_CONCURRENT_PER_IP', 8),

  // Frame size limits
  MAX_INBOUND_FRAME_BYTES: getEnvNumber('MAX_INBOUND_FRAME_BYTES', 2 * 1024 * 1024), // 2 MB

  // Compression
  GZIP_LEVEL: getEnvNumber('GZIP_LEVEL', 4),
} as const;

// ============================================
// STROKE & DRAWING CONFIGURATION
// ============================================

export const STROKE_CONFIG = {
  // Maximum points per stroke
  MAX_POINTS_PER_STROKE: getEnvNumber('MAX_POINTS_PER_STROKE', 10_000),

  // Maximum total strokes in a room
  MAX_TOTAL_STROKES: getEnvNumber('MAX_TOTAL_STROKES', 5_000),

  // Simplification tolerances (in pixels)
  PEN_SIMPLIFICATION_TOLERANCE: getEnvNumber('PEN_SIMPLIFICATION_TOLERANCE', 0.80),
  HIGHLIGHTER_SIMPLIFICATION_TOLERANCE: getEnvNumber('HIGHLIGHTER_SIMPLIFICATION_TOLERANCE', 0.5),
  SIMPLIFICATION_TOLERANCE_MULTIPLIER: getEnvNumber('SIMPLIFICATION_TOLERANCE_MULTIPLIER', 1.5),
  HIGHLIGHTER_TOLERANCE_MAX_MULTIPLIER: getEnvNumber('HIGHLIGHTER_TOLERANCE_MAX_MULTIPLIER', 1.5),

  // Aliases for backward compatibility with tests
  SIMPLIFY_TOLERANCE_PEN: getEnvNumber('PEN_SIMPLIFICATION_TOLERANCE', 0.0),
  SIMPLIFY_TOLERANCE_HIGHLIGHTER: getEnvNumber('HIGHLIGHTER_SIMPLIFICATION_TOLERANCE', 0.5),

  // Update size limits
  MAX_ENCODED_UPDATE_BYTES: getEnvNumber('MAX_ENCODED_UPDATE_BYTES', 128 * 1024), // 128 KB (DEPRECATED - use MAX_STROKE_UPDATE_BYTES)
  MAX_STROKE_UPDATE_BYTES: getEnvNumber('MAX_STROKE_UPDATE_BYTES', 128 * 1024), // 128 KB per-stroke limit

  // Opacity defaults
  HIGHLIGHTER_DEFAULT_OPACITY: getEnvNumber('HIGHLIGHTER_DEFAULT_OPACITY', 0.45), // Increased for better visibility
  CURSOR_PREVIEW_OPACITY: getEnvNumber('CURSOR_PREVIEW_OPACITY', 1.0), // Preview matches commit opacity
  // Preview now matches commit opacity (no lightening)
  HIGHLIGHTER_PREVIEW_OPACITY: getEnvNumber('HIGHLIGHTER_PREVIEW_OPACITY', 0.45),
} as const;

// ============================================
// CANVAS STYLE CONFIGURATION
// ============================================

export const CANVAS_STYLE_CONFIG = {
  // Background
  BACKGROUND_COLOR: '#f8f9fa',

  // Dot grid
  GRID_ENABLED: getEnvBoolean('GRID_ENABLED', false), // Toggle grid on/off
  GRID_COLOR: '#DADADA',
  GRID_DOT_RADIUS_PX: 1.0, // fixed CSS px (screen-space)

  // Opacity curve (subtle, with 0.24 at 1x zoom)
  GRID_OPACITY_AT_025X: 0.12,
  GRID_OPACITY_AT_05X: 0.18,
  GRID_OPACITY_AT_1X: 0.90, // Much more subtle than original 0.6
  GRID_OPACITY_AT_2X: 0.9,

  // Spacing tiers (at 100% zoom)
  GRID_SPACING_SUB_10: 8, // ≥ 2x zoom
  GRID_SPACING_BASE_20: 20, // 1x
  GRID_SPACING_BIG_40: 50, // ≤ 0.5x

  // Zoom thresholds
  GRID_HIDE_BELOW: 0.15, // < 0.25x → hide
  GRID_SWITCH_TO_40_AT: 0.4, // ≤ 0.5x → 40 px
  GRID_SWITCH_TO_10_AT: 1.8, // ≥ 2x   → 10 px

  // Crossfade bands around thresholds (removes pops)
  GRID_BAND_NEAR_025: 0.05,
  GRID_BAND_NEAR_05: 0.08,
  GRID_BAND_NEAR_2: 0.2,

  // Optional: grow dots above 1x with cap (OFF by default)
  GRID_DOT_SCALE_ABOVE_1X: false,
  GRID_DOT_RADIUS_CAP_PX: 2.5,
} as const;

// ============================================
// TEXT & CODE CONFIGURATION
// ============================================

export const TEXT_CONFIG = {
  // Text limits
  MAX_TEXT_LENGTH: getEnvNumber('MAX_TEXT_LENGTH', 500),

  // Code cell limits
  MAX_CODE_BODY_BYTES: getEnvNumber('MAX_CODE_BODY_BYTES', 200 * 1024), // 200 KB
  MAX_OUTPUT_BYTES_PER_RUN: getEnvNumber('MAX_OUTPUT_BYTES_PER_RUN', 10 * 1024), // 10 KB
  MAX_OUTPUTS_COUNT: getEnvNumber('MAX_OUTPUTS_COUNT', 10),
  MAX_TOTAL_OUTPUT_BYTES: getEnvNumber('MAX_TOTAL_OUTPUT_BYTES', 128 * 1024), // 128 KB

  // Code execution
  CODE_EXECUTION_TIMEOUT_MS: getEnvNumber('CODE_EXECUTION_TIMEOUT_MS', 5000), // 5 seconds
} as const;

// ============================================
// WEBRTC & AWARENESS CONFIGURATION
// ============================================

export const WEBRTC_CONFIG = {
  // Peer limits
  MAX_WEBRTC_PEERS: getEnvNumber('MAX_WEBRTC_PEERS', 15),
  WEBRTC_START_THRESHOLD: getEnvNumber('WEBRTC_START_THRESHOLD', 12),
  MAX_WEBRTC_CONNECTIONS: getEnvNumber('MAX_WEBRTC_CONNECTIONS', 15),

  // Probe settings
  WEBRTC_PROBE_DURATION_MS: getEnvNumber('WEBRTC_PROBE_DURATION_MS', 2500),
  WEBRTC_RTT_WIN_THRESHOLD_MS: getEnvNumber('WEBRTC_RTT_WIN_THRESHOLD_MS', 20),
  WEBRTC_WS_SLOW_THRESHOLD_MS: getEnvNumber('WEBRTC_WS_SLOW_THRESHOLD_MS', 70),

  // ICE configuration
  ICE_CANDIDATE_POOL_SIZE: getEnvNumber('ICE_CANDIDATE_POOL_SIZE', 2),
  ICE_FAIL_GRACE_MS: getEnvNumber('ICE_FAIL_GRACE_MS', 5000),

  // Awareness rates (Hz)
  AWARENESS_HZ_BASE_RTC: getEnvNumber('AWARENESS_HZ_BASE_RTC', 25), // 20-30 Hz range
  AWARENESS_HZ_BASE_WS: getEnvNumber('AWARENESS_HZ_BASE_WS', 15), // 13-17 Hz range
  AWARENESS_HZ_DEGRADED: getEnvNumber('AWARENESS_HZ_DEGRADED', 8),

  // Awareness intervals
  AWARENESS_BASE_INTERVAL_MS: getEnvNumber('AWARENESS_BASE_INTERVAL_MS', 50),
  AWARENESS_MAX_INTERVAL_MS: getEnvNumber('AWARENESS_MAX_INTERVAL_MS', 150),
  AWARENESS_JITTER_MS: getEnvNumber('AWARENESS_JITTER_MS', 10),
  AWARENESS_PEER_CHANGE_THRESHOLD: getEnvNumber('AWARENESS_PEER_CHANGE_THRESHOLD', 0.15), // 15% change

  // Buffer thresholds
  DATACHANNEL_BUFFER_HIGH_BYTES: getEnvNumber('DATACHANNEL_BUFFER_HIGH_BYTES', 128 * 1024),
  WEBSOCKET_BUFFER_HIGH_BYTES: getEnvNumber('WEBSOCKET_BUFFER_HIGH_BYTES', 64 * 1024),
  WEBSOCKET_BUFFER_CRITICAL_BYTES: getEnvNumber('WEBSOCKET_BUFFER_CRITICAL_BYTES', 256 * 1024),

  // Signaling
  SIGNALING_URLS: getEnvString('Y_SIGNALING_URLS', 'wss://signaling.yjs.dev').split(','),
  TURN_URL: getEnvString('Y_TURN_URL', ''),
  TURN_USERNAME: getEnvString('Y_TURN_USER', ''),
  TURN_PASSWORD: getEnvString('Y_TURN_PASS', ''),
  RTC_PASSWORD_SALT: getEnvString('Y_RTC_PASSWORD_SALT', 'avlo-rtc-salt'),
} as const;

// Alias for Phase 7 WS-only awareness implementation
// Re-exports only awareness-relevant fields from WEBRTC_CONFIG
export const AWARENESS_CONFIG = {
  // WS cadence knobs used in Phase 7
  AWARENESS_HZ_BASE_WS: WEBRTC_CONFIG.AWARENESS_HZ_BASE_WS,
  AWARENESS_HZ_DEGRADED: WEBRTC_CONFIG.AWARENESS_HZ_DEGRADED,

  // Interval helpers
  AWARENESS_BASE_INTERVAL_MS: WEBRTC_CONFIG.AWARENESS_BASE_INTERVAL_MS,
  AWARENESS_MAX_INTERVAL_MS: WEBRTC_CONFIG.AWARENESS_MAX_INTERVAL_MS,
  AWARENESS_JITTER_MS: WEBRTC_CONFIG.AWARENESS_JITTER_MS,

  // WS backpressure thresholds (Phase 7)
  WEBSOCKET_BUFFER_HIGH_BYTES: WEBRTC_CONFIG.WEBSOCKET_BUFFER_HIGH_BYTES,
  WEBSOCKET_BUFFER_CRITICAL_BYTES: WEBRTC_CONFIG.WEBSOCKET_BUFFER_CRITICAL_BYTES,
} as const;

// ============================================
// BACKOFF & RETRY CONFIGURATION
// ============================================

export const BACKOFF_CONFIG = {
  // WebSocket reconnect
  WS_BASE_MS: getEnvNumber('WS_BACKOFF_BASE_MS', 300),
  WS_MAX_MS: getEnvNumber('WS_BACKOFF_MAX_MS', 20_000),
  WS_JITTER: getEnvNumber('WS_BACKOFF_JITTER', 0.2),
  WS_STABLE_CONNECTION_MS: getEnvNumber('WS_STABLE_CONNECTION_MS', 30_000),

  // RTC reconnect
  RTC_BASE_MS: getEnvNumber('RTC_BACKOFF_BASE_MS', 1000),
  RTC_MAX_MS: getEnvNumber('RTC_BACKOFF_MAX_MS', 30_000),
  RTC_JITTER: getEnvNumber('RTC_BACKOFF_JITTER', 0.2),
  RTC_MAX_TRIES: getEnvNumber('RTC_MAX_TRIES', 5),
  RTC_FLAP_DEBOUNCE_MS: getEnvNumber('RTC_FLAP_DEBOUNCE_MS', 10_000),

  // TTL extension
  TTL_EXTEND_COOLDOWN_MS: getEnvNumber('TTL_EXTEND_COOLDOWN_MS', 10 * 60 * 1000), // 10 minutes

  // Awareness deduplication
  AWARENESS_WS_DROP_WINDOW_MS: getEnvNumber('AWARENESS_WS_DROP_WINDOW_MS', 100),
} as const;

// ============================================
// RATE LIMITING CONFIGURATION
// ============================================

export const RATE_LIMIT_CONFIG = {
  // Room operations
  ROOMS_PER_HOUR_PER_IP: getEnvNumber('ROOMS_PER_HOUR_PER_IP', 10),
  ROOM_RENAMES_PER_MINUTE: getEnvNumber('ROOM_RENAMES_PER_MINUTE', 5),

  // Clear board
  CLEAR_BOARD_COOLDOWN_MS: getEnvNumber('CLEAR_BOARD_COOLDOWN_MS', 15_000), // 15 seconds
  CLEAR_BOARD_UNDO_WINDOW_MS: getEnvNumber('CLEAR_BOARD_UNDO_WINDOW_MS', 10_000), // 10 seconds

  // PTT (Push-to-Talk) - optional feature
  PTT_REQUEST_COOLDOWN_MS: getEnvNumber('PTT_REQUEST_COOLDOWN_MS', 2000),
  PTT_HOLD_MAX_MS: getEnvNumber('PTT_HOLD_MAX_MS', 60_000),
  PTT_HEARTBEAT_INTERVAL_MS: getEnvNumber('PTT_HEARTBEAT_INTERVAL_MS', 5000),
  PTT_MAX_QUEUE_SIZE: getEnvNumber('PTT_MAX_QUEUE_SIZE', 8),
} as const;

// ============================================
// PERFORMANCE & RENDERING CONFIGURATION
// ============================================

export const PERFORMANCE_CONFIG = {
  // Frame rates
  MAX_FPS: getEnvNumber('MAX_FPS', 60),
  HIDDEN_TAB_FPS: getEnvNumber('HIDDEN_TAB_FPS', 8),

  // Micro-batching windows (ms)
  MICRO_BATCH_MIN_MS: getEnvNumber('MICRO_BATCH_MIN_MS', 8),
  MICRO_BATCH_DEFAULT_MS: getEnvNumber('MICRO_BATCH_DEFAULT_MS', 16),
  MICRO_BATCH_MAX_MS: getEnvNumber('MICRO_BATCH_MAX_MS', 32),

  // Work budgets (ms)
  RENDER_BUDGET_MS: getEnvNumber('RENDER_BUDGET_MS', 16),
  RENDER_PREP_BUDGET_MS: getEnvNumber('RENDER_PREP_BUDGET_MS', 6),
  TRANSACT_BUDGET_MS: getEnvNumber('TRANSACT_BUDGET_MS', 8),

  // Export settings
  EXPORT_MAX_EDGE_PX: getEnvNumber('EXPORT_MAX_EDGE_PX', 8192),
  EXPORT_PADDING_PX: getEnvNumber('EXPORT_PADDING_PX', 24),
  EXPORT_TIMEOUT_MS: getEnvNumber('EXPORT_TIMEOUT_MS', 2000),

  // Zoom limits
  MIN_ZOOM: getEnvNumber('MIN_ZOOM', 0.05),
  MAX_ZOOM: getEnvNumber('MAX_ZOOM', 5),
  MAX_PAN_DISTANCE: getEnvNumber('MAX_PAN_DISTANCE', 1_000_000), // Maximum pan distance from origin in world units

  // Canvas size limits (prevent memory exhaustion)
  MAX_CANVAS_DIMENSION: getEnvNumber('MAX_CANVAS_DIMENSION', 16384), // Max width or height in pixels

  // Spatial index
  RBUSH_REBUILD_THRESHOLD_COUNT: getEnvNumber('RBUSH_REBUILD_THRESHOLD_COUNT', 256),
  RBUSH_REBUILD_THRESHOLD_AREA: getEnvNumber('RBUSH_REBUILD_THRESHOLD_AREA', 0.15),

  // Cursor trails
  CURSOR_TRAIL_MAX_POINTS: getEnvNumber('CURSOR_TRAIL_MAX_POINTS', 24),
  CURSOR_TRAIL_MAX_AGE_MS: getEnvNumber('CURSOR_TRAIL_MAX_AGE_MS', 600),
  CURSOR_TRAIL_DECAY_TAU_MS: getEnvNumber('CURSOR_TRAIL_DECAY_TAU_MS', 280),
  CURSOR_TRAIL_DISABLE_PEER_THRESHOLD: getEnvNumber('CURSOR_TRAIL_DISABLE_PEER_THRESHOLD', 25),
} as const;

// ============================================
// QUEUE & BUFFER CONFIGURATION
// ============================================

export const QUEUE_CONFIG = {
  // Write queue
  WRITE_QUEUE_MAX_PENDING: getEnvNumber('WRITE_QUEUE_MAX_PENDING', 100),
  WRITE_QUEUE_HIGH_WATER: getEnvNumber('WRITE_QUEUE_HIGH_WATER', 80),

  // Persist queue
  PERSIST_BATCH_INTERVAL_MS: getEnvNumber('PERSIST_BATCH_INTERVAL_MS', 2500), // 2-3 seconds
  PERSIST_FLUSH_GRACE_MS: getEnvNumber('PERSIST_FLUSH_GRACE_MS', 3000),

  // IDB chunking
  IDB_CHUNK_SIZE: getEnvNumber('IDB_CHUNK_SIZE', 3000), // 1k-5k range
  IDB_BATCH_THRESHOLD: getEnvNumber('IDB_BATCH_THRESHOLD', 1000),
  IDB_TIMEOUT_MS: getEnvNumber('IDB_TIMEOUT_MS', 2000),
} as const;

// ============================================
// THRESHOLDS FOR OFFLINE DELTA
// ============================================

export const OFFLINE_THRESHOLD_CONFIG = {
  MAX_OFFLINE_DELTA_BYTES: getEnvNumber('MAX_OFFLINE_DELTA_BYTES', 2 * 1024 * 1024), // 2 MB
  MAX_OFFLINE_MINUTES: getEnvNumber('MAX_OFFLINE_MINUTES', 15),
  MAX_OFFLINE_OPS: getEnvNumber('MAX_OFFLINE_OPS', 10_000),
} as const;

// ============================================
// SERVICE WORKER & PWA CONFIGURATION
// ============================================

export const PWA_CONFIG = {
  // Cache limits
  AVATARS_CACHE_MAX_ENTRIES: getEnvNumber('AVATARS_CACHE_MAX_ENTRIES', 400),
  AVATARS_CACHE_MAX_AGE_DAYS: getEnvNumber('AVATARS_CACHE_MAX_AGE_DAYS', 7),
  MEDIA_CACHE_MAX_ENTRIES: getEnvNumber('MEDIA_CACHE_MAX_ENTRIES', 300),
  MEDIA_CACHE_MAX_AGE_DAYS: getEnvNumber('MEDIA_CACHE_MAX_AGE_DAYS', 14),

  // Storage constraints
  MIN_FREE_STORAGE_MB: getEnvNumber('MIN_FREE_STORAGE_MB', 200),
} as const;

// ============================================
// API & SERVER CONFIGURATION
// ============================================

export const SERVER_CONFIG = {
  PORT: getEnvNumber('PORT', 3001),
  NODE_ENV: getEnvString('NODE_ENV', 'development'),

  // Database
  DATABASE_URL: getEnvString('DATABASE_URL', ''),
  REDIS_URL: getEnvString('REDIS_URL', ''),

  // Connection pooling
  PG_POOL_MIN: getEnvNumber('PG_POOL_MIN', 10),
  PG_POOL_MAX: getEnvNumber('PG_POOL_MAX', 20),

  // Monitoring
  SENTRY_DSN: getEnvString('SENTRY_DSN', ''),

  // CORS
  ALLOWED_ORIGINS: getEnvString('ALLOWED_ORIGINS', 'http://localhost:3000').split(','),
} as const;

// ============================================
// PROTOCOL VERSIONS
// ============================================

export const PROTOCOL_CONFIG = {
  WS_PROTOCOL_VERSION: getEnvNumber('WS_PROTOCOL_VERSION', 1),
  AWARENESS_VERSION: getEnvNumber('AWARENESS_VERSION', 1),
} as const;

// ============================================
// TYPE EXPORTS FOR TYPE SAFETY
// ============================================

export type RoomConfig = typeof ROOM_CONFIG;
export type StrokeConfig = typeof STROKE_CONFIG;
export type TextConfig = typeof TEXT_CONFIG;
export type WebRTCConfig = typeof WEBRTC_CONFIG;
export type BackoffConfig = typeof BACKOFF_CONFIG;
export type RateLimitConfig = typeof RATE_LIMIT_CONFIG;
export type PerformanceConfig = typeof PERFORMANCE_CONFIG;
export type QueueConfig = typeof QUEUE_CONFIG;
export type OfflineThresholdConfig = typeof OFFLINE_THRESHOLD_CONFIG;
export type PWAConfig = typeof PWA_CONFIG;
export type ServerConfig = typeof SERVER_CONFIG;
export type ProtocolConfig = typeof PROTOCOL_CONFIG;

// ============================================
// COMPUTED VALUES & UTILITIES
// ============================================

/**
 * Calculate awareness send interval based on peer count
 * Formula: 50ms * (1 + max(0, (N-10)/20))
 * Clamped between 50ms and 150ms
 */
export function calculateAwarenessInterval(peerCount: number): number {
  const base = WEBRTC_CONFIG.AWARENESS_BASE_INTERVAL_MS * (1 + Math.max(0, (peerCount - 10) / 20));
  return Math.min(
    Math.max(base, WEBRTC_CONFIG.AWARENESS_BASE_INTERVAL_MS),
    WEBRTC_CONFIG.AWARENESS_MAX_INTERVAL_MS,
  );
}

/**
 * Apply jitter to a timing value
 */
export function applyJitter(value: number, jitterFactor: number): number {
  const jitter = (Math.random() - 0.5) * 2 * jitterFactor;
  return value * (1 + jitter);
}

/**
 * Check if room size is at warning threshold
 */
export function isRoomSizeWarning(sizeBytes: number): boolean {
  return sizeBytes >= ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES;
}

/**
 * Check if room size is at read-only threshold
 */
export function isRoomReadOnly(sizeBytes: number | undefined): boolean {
  if (sizeBytes === undefined) return false;
  return sizeBytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES;
}

/**
 * Get room size percentage (0-100)
 */
export function getRoomSizePercentage(sizeBytes: number): number {
  return Math.min(100, (sizeBytes / ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) * 100);
}

// ============================================
// DEVELOPMENT & DEBUG FLAGS
// ============================================

export const DEBUG_CONFIG = {
  // Enable verbose logging
  DEBUG_MODE: getEnvBoolean(
    'DEBUG_MODE',
    getEnvString('NODE_ENV', 'development') === 'development',
  ),

  // Enable performance profiling
  ENABLE_PROFILING: getEnvBoolean('ENABLE_PROFILING', false),

  // Force specific modes for testing
  FORCE_OFFLINE: getEnvBoolean('FORCE_OFFLINE', false),
  FORCE_READONLY: getEnvBoolean('FORCE_READONLY', false),
  DISABLE_WEBRTC: getEnvBoolean('DISABLE_WEBRTC', false),
} as const;

// ============================================
// FREEZE ALL CONFIGS IN DEVELOPMENT
// ============================================

if (getEnvString('NODE_ENV', 'development') !== 'production') {
  // Freeze all config objects to prevent accidental mutation
  Object.freeze(ROOM_CONFIG);
  Object.freeze(STROKE_CONFIG);
  Object.freeze(TEXT_CONFIG);
  Object.freeze(WEBRTC_CONFIG);
  Object.freeze(AWARENESS_CONFIG);
  Object.freeze(BACKOFF_CONFIG);
  Object.freeze(RATE_LIMIT_CONFIG);
  Object.freeze(PERFORMANCE_CONFIG);
  Object.freeze(QUEUE_CONFIG);
  Object.freeze(OFFLINE_THRESHOLD_CONFIG);
  Object.freeze(PWA_CONFIG);
  Object.freeze(SERVER_CONFIG);
  Object.freeze(PROTOCOL_CONFIG);
  Object.freeze(DEBUG_CONFIG);
}

// Default export for convenience
export default {
  ROOM: ROOM_CONFIG,
  STROKE: STROKE_CONFIG,
  TEXT: TEXT_CONFIG,
  WEBRTC: WEBRTC_CONFIG,
  BACKOFF: BACKOFF_CONFIG,
  RATE_LIMIT: RATE_LIMIT_CONFIG,
  PERFORMANCE: PERFORMANCE_CONFIG,
  QUEUE: QUEUE_CONFIG,
  OFFLINE_THRESHOLD: OFFLINE_THRESHOLD_CONFIG,
  PWA: PWA_CONFIG,
  SERVER: SERVER_CONFIG,
  PROTOCOL: PROTOCOL_CONFIG,
  DEBUG: DEBUG_CONFIG,

  // Utility functions
  calculateAwarenessInterval,
  applyJitter,
  isRoomSizeWarning,
  isRoomReadOnly,
  getRoomSizePercentage,
} as const;
