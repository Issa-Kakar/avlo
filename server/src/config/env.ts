import { z } from 'zod';

const ServerEnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  ORIGIN_ALLOWLIST: z
    .string()
    .default('http://localhost:5173,http://localhost:3000')
    .transform((s) => s.split(',').map((o) => o.trim())),
  REDIS_URL: z.string().min(1, 'Redis URL is required'),
  DATABASE_URL: z.string().min(1, 'Database URL is required'),
  ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  WS_MAX_FRAME_BYTES: z.coerce.number().default(2_000_000),
  MAX_CLIENTS_PER_ROOM: z.coerce.number().default(105),
  GZIP_LEVEL: z.coerce.number().min(1).max(9).default(4),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function validateServerEnv(): ServerEnv {
  try {
    return ServerEnvSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Environment validation failed:');
      error.issues.forEach((issue) => {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
}
