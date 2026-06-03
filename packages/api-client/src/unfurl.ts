import { hc } from 'hono/client';
// See packages/api-client/src/images.ts for why we import from app-type.
import type { UnfurlApp } from '../../../workers/unfurl/src/app-type';
import { UNFURL_ORIGIN } from './origins';

// `credentials: 'include'` baked in: the unfurl GET is auth-gated (H13), so the
// `.avlo.io` cookie must ride cross-origin (same-origin in dev sends it anyway).
export const unfurlClient = hc<UnfurlApp>(UNFURL_ORIGIN, { init: { credentials: 'include' } });
export type { UnfurlApp };
