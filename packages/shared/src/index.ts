// Re-export all types
export * from './types/identifiers';
export * from './types/room';
export * from './types/awareness';
export * from './types/commands';
export * from './types/snapshot';
export * from './types/validation';
export * from './types/room-stats';
export * from './types/objects';

// Export config
export * from './config';
export {
  ROOM_CONFIG,
  STROKE_CONFIG,
  TEXT_CONFIG,
  WEBRTC_CONFIG,
  BACKOFF_CONFIG,
  RATE_LIMIT_CONFIG,
  PERFORMANCE_CONFIG,
  QUEUE_CONFIG,
  OFFLINE_THRESHOLD_CONFIG,
  PWA_CONFIG,
  SERVER_CONFIG,
  PROTOCOL_CONFIG,
  DEBUG_CONFIG,
  isRoomReadOnly,
  isRoomSizeWarning,
  calculateAwarenessInterval,
  applyJitter,
  getRoomSizePercentage,
} from './config';

// Export schemas
export * from './schemas';

// Export utilities
export { ulid } from './utils/ulid';

// Export spatial indexing
export { ObjectSpatialIndex } from './spatial';
export type { IndexEntry } from './spatial';

// Export bbox utilities
export { computeBBoxFor, bboxEquals, bboxToBounds } from './utils/bbox';
