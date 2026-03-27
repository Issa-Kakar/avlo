// Re-export all types
export * from './types/identifiers';
export * from './types/room';
export * from './types/awareness';
export * from './types/commands';
export * from './types/snapshot';
export * from './types/validation';
export * from './types/geometry';
export * from './types/objects';

// Export config
export * from './config';
export {
  STROKE_CONFIG,
  TEXT_CONFIG,
  WEBRTC_CONFIG,
  BACKOFF_CONFIG,
  RATE_LIMIT_CONFIG,
  PERFORMANCE_CONFIG,
  QUEUE_CONFIG,
  OFFLINE_THRESHOLD_CONFIG,
  PWA_CONFIG,
  DEBUG_CONFIG,
  AWARENESS_CONFIG,
  CANVAS_STYLE_CONFIG,
  calculateAwarenessInterval,
  applyJitter,
} from './config';

// Export utilities
export { ulid } from './utils/ulid';

// Export spatial indexing
export { ObjectSpatialIndex } from './spatial';
export type { IndexEntry } from './spatial';

// Export bbox utilities
export {
  computeBBoxFor,
  computeConnectorBBoxFromPoints,
  bboxEquals,
  bboxToBounds,
} from './utils/bbox';

// Export image validation
export { validateImage, isSvg, parseImageDimensions } from './utils/image-validation';

// Export URL utilities
export { normalizeUrl, isValidHttpUrl, extractDomain } from './utils/url-utils';

// Export object accessors
export * from './accessors/object-accessors';
