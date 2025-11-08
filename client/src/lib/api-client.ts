import { z } from 'zod';
import { clientConfig } from './config-schema';

// Response schemas
export const RoomMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  lastWriteAt: z.string(),
  sizeBytes: z.number(),
  expiresAt: z.string(),
});

export type RoomMetadata = z.infer<typeof RoomMetadataSchema>;

// API client - STUBBED for Cloudflare migration
// TODO: Implement these in Worker or remove metadata features
class ApiClient {
  async getRoomMetadata(roomId: string): Promise<RoomMetadata> {
    // Return stub data for now
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 14); // 14 days from now

    return {
      id: roomId,
      title: 'Untitled Room',
      createdAt: now.toISOString(),
      lastWriteAt: now.toISOString(),
      sizeBytes: 0,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async createRoom(title?: string): Promise<RoomMetadata> {
    // Generate a random room ID
    const roomId = Math.random().toString(36).substring(2, 15);
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 14);

    return {
      id: roomId,
      title: title || 'Untitled Room',
      createdAt: now.toISOString(),
      lastWriteAt: now.toISOString(),
      sizeBytes: 0,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async renameRoom(roomId: string, title: string): Promise<{ title: string }> {
    // Just return the new title
    return { title };
  }
}

export const apiClient = new ApiClient();
