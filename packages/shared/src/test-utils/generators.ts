import { randomBytes } from 'crypto';
import type { RoomId, StrokeId, UserId } from '@avlo/shared';

// Generate test room data
// Note: Room type will be defined when persistence layer is implemented in Phase 5
export function generateTestRoom() {
  const id: RoomId = `room-${randomBytes(8).toString('hex')}`;
  return {
    id,
    title: `Test Room ${id}`,
    createdAt: new Date(),
    lastWriteAt: new Date(),
    size_bytes: 0,
  };
}

// Generate test stroke data
export function generateTestStroke() {
  const strokeId: StrokeId = `stroke-${randomBytes(8).toString('hex')}`;
  return {
    id: strokeId,
    tool: 'pen' as const,
    color: '#000000',
    size: 2,
    opacity: 1,
    points: [100, 100, 150, 150, 200, 100], // Simple test path
    bbox: [100, 100, 200, 150] as [number, number, number, number],
    scene: 0,
    createdAt: Date.now(),
    userId: 'test-user' as UserId,
  };
}

// Generate test user/awareness data
export function generateTestUser() {
  const userId: UserId = `user-${randomBytes(8).toString('hex')}`;
  return {
    userId,
    name: `User ${userId.slice(0, 6)}`,
    color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
    cursor: { x: Math.random() * 1000, y: Math.random() * 600 },
    activity: 'idle' as const,
    seq: 0,
    ts: Date.now(),
  };
}
