import { z } from 'zod/v4';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const contentLengthBound = (max: number) =>
  z.object({
    'content-length': z
      .string({ message: 'Content-Length required' })
      .regex(/^\d+$/, 'Content-Length must be integer')
      .transform((s) => parseInt(s, 10))
      .refine((n) => n > 0, 'Content-Length must be positive')
      .refine((n) => n <= max, `Content-Length exceeds ${max} bytes`),
  });
