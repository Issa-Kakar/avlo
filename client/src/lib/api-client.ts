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

// API client
class ApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = clientConfig.VITE_API_BASE;
  }

  private async fetchJson<T>(
    path: string,
    options?: globalThis.RequestInit,
    schema?: z.ZodSchema<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Room not found or expired');
      }
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    if (schema) {
      return schema.parse(data);
    }

    return data as T;
  }

  async getRoomMetadata(roomId: string): Promise<RoomMetadata> {
    return this.fetchJson(`/rooms/${roomId}/metadata`, undefined, RoomMetadataSchema);
  }

  async createRoom(title?: string): Promise<RoomMetadata> {
    return this.fetchJson(
      '/rooms',
      {
        method: 'POST',
        body: JSON.stringify({ title }),
      },
      RoomMetadataSchema,
    );
  }

  async renameRoom(roomId: string, title: string): Promise<{ title: string }> {
    return this.fetchJson(`/rooms/${roomId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ title }),
    });
  }
}

export const apiClient = new ApiClient();
