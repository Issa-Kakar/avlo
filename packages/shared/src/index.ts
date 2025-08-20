// Shared types between client and server
// This file will be expanded in Phase 2 with actual data models

export type RoomId = string;
export type UserId = string;
export type StrokeId = string;
export type TextId = string;
export type SceneIdx = number;

// Placeholder types that will be properly defined in Phase 2
export interface Room {
  id: RoomId;
  title: string;
  createdAt: Date;
  lastWriteAt: Date;
  size_bytes: number;
}
