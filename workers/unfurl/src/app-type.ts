// Public API surface for `hc<UnfurlApp>(...)`. See workers/images/src/app-type.ts
// for the architectural rationale. The drift guard at the bottom of ./index.ts
// keeps this aligned with the real `typeof app`.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod/v4';

const urlQuery = z.object({ url: z.string() });

// Wire-level response shape — what hc<UnfurlApp>['index']['$get'] resp.json() returns.
// Mirrors the real handler's response keys (see ./unfurl.ts handleUnfurl). Optional
// fields reflect "may be absent" rather than "may be null".
type UnfurlResponse = {
  url: string;
  domain: string;
  title?: string;
  description?: string;
  ogImageAssetId?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  faviconAssetId?: string;
  faviconSvgBase64?: string;
};

const app = new Hono().get('/', zValidator('query', urlQuery), (c) => c.json({} as UnfurlResponse));

export type UnfurlApp = typeof app;
