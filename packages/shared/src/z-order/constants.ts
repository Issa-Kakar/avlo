/** Trigger renorm when any z key in the doc exceeds this length. */
export const Z_RENORM_MAX_KEY_LEN = 48;

/** Jitter entropy per generated key (bits). 30 ≈ 5 base-62 chars of randomness padding. */
export const Z_KEY_JITTER_BITS = 30;

/** Yjs transact origin string used by server-side renormalization. NOT in client UndoManager.trackedOrigins. */
export const Z_RENORM_ORIGIN = 'server-renorm';
