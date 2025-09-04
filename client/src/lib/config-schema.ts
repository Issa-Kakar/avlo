import { z } from 'zod';

// Client configuration schema
export const ClientConfigSchema = z.object({
  VITE_WS_BASE: z.string().min(1, 'WebSocket base URL is required'),
  VITE_API_BASE: z.string().min(1, 'API base URL is required'),
  VITE_ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  // Add other client-side configs as needed
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// Validation function with error handling
export function loadClientConfig(): ClientConfig {
  try {
    const config = {
      VITE_WS_BASE: import.meta.env.VITE_WS_BASE || '/ws',
      VITE_API_BASE: import.meta.env.VITE_API_BASE || '/api',
      VITE_ROOM_TTL_DAYS: Number(import.meta.env.VITE_ROOM_TTL_DAYS ?? 14),
    };

    return ClientConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[Config] Validation failed:', error.issues);
      // Show user-friendly error (this would be rendered in UI)
      throw new Error(`Configuration error: ${error.issues[0].message}`);
    }
    throw error;
  }
}

// Export validated config instance
export const clientConfig = loadClientConfig();
