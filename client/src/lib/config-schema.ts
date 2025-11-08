import { z } from 'zod';

// Client configuration schema
export const ClientConfigSchema = z.object({
  VITE_API_BASE: z.string().optional(), // Optional - API endpoints will be stubbed for now
  VITE_ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  // Optional: PartyServer host override (defaults to window.location.host)
  VITE_PARTY_HOST: z.string().optional(), // Host for PartyServer connection
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// Validation function with error handling
export function loadClientConfig(): ClientConfig {
  try {
    const config = {
      VITE_API_BASE: import.meta.env.VITE_API_BASE, // Optional
      VITE_ROOM_TTL_DAYS: Number(import.meta.env.VITE_ROOM_TTL_DAYS ?? 14),
      VITE_PARTY_HOST: import.meta.env.VITE_PARTY_HOST, // Optional, defaults to window.location.host
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
