// Synthetic cache keys must be per-service. caches.default is keyed by full URL;
// cross-service collision is otherwise impossible since real URLs include the
// request host, but synthetic keys are bare and easy to clash.
export const syntheticCacheUrl = (service: string, key: string): string => `https://${service}.cache.avlo.internal/${key}`;
