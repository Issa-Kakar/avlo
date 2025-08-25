/**
 * Room statistics for size and capacity tracking
 */
export interface RoomStats {
  bytes: number;      // Compressed size in bytes
  cap: number;        // Capacity limit (15MB)
  expiresAt?: number; // Optional expiry timestamp
}