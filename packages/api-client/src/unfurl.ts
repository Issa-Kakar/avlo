import { hc } from 'hono/client';
// See packages/api-client/src/images.ts for why we import from app-type.
import type { UnfurlApp } from '../../../workers/unfurl/src/app-type';
import { UNFURL_ORIGIN } from './origins';

export const unfurlClient = hc<UnfurlApp>(UNFURL_ORIGIN);
export type { UnfurlApp };
