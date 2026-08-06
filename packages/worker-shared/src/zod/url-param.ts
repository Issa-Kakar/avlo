import { normalizeUrl } from '@avlo/shared';
import { z } from 'zod/v4';
import { isPrivateHost } from '../ssrf';

export const unfurlQuery = z.object({
  url: z
    .string()
    .min(1, 'url required')
    .transform((raw) => normalizeUrl(raw))
    // `abort` is load-bearing: zod v4 keeps running later checks after a failure, so
    // without it the SSRF refine below executes `new URL(null)` and throws — turning
    // every unparseable URL into a 500 instead of a 400.
    .refine((v): v is string => v !== null, { message: 'invalid URL', abort: true })
    .refine((url) => !isPrivateHost(new URL(url).hostname), 'URL not allowed'),
});
