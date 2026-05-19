import type * as Y from 'yjs';

/** Top-level `objects` Y.Map — keyed by ULID, values are per-object Y.Maps. */
export type YObjects = Y.Map<Y.Map<unknown>>;
