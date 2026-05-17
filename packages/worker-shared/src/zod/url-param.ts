import { normalizeUrl } from '@avlo/shared';
import { z } from 'zod/v4';
import { isPrivateHost } from '../ssrf';

export const unfurlQuery = z.object({
  url: z
    .string()
    .min(1, 'url required')
    .transform((raw) => normalizeUrl(raw))
    .refine((v): v is string => v !== null, 'invalid URL')
    .refine((url) => !isPrivateHost(new URL(url).hostname), 'URL not allowed'),
});
