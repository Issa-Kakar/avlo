import { z } from 'zod';

// Environment validation
export const EnvSchema = z.object({
  ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  DEBUG_MODE: z.coerce.boolean().default(false),
  MAX_CLIENTS_PER_ROOM: z.coerce.number().min(1).max(200).default(105),
  ROOM_SIZE_WARNING_BYTES: z.coerce.number().default(13 * 1024 * 1024), // 13MB
  ROOM_SIZE_READONLY_BYTES: z.coerce.number().default(15 * 1024 * 1024), // 15MB
});

// WebSocket control frames
export const WSControlFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('persist_ack'),
    sizeBytes: z.number(),
    timestamp: z.string().datetime(),
    roomId: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('capacity_update'),
    currentClients: z.number(),
    maxClients: z.number(),
    readOnly: z.boolean(),
  }),
]);

// HTTP API schemas
export const CreateRoomSchema = z.object({
  title: z.string().max(100).optional(),
  provisional: z.boolean().optional(),
});

export const RoomMetadataSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastWriteAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sizeBytes: z.number(),
  clientCount: z.number(),
});

// Type exports
export type Env = z.infer<typeof EnvSchema>;
export type WSControlFrame = z.infer<typeof WSControlFrameSchema>;
export type CreateRoomRequest = z.infer<typeof CreateRoomSchema>;
export type RoomMetadata = z.infer<typeof RoomMetadataSchema>;