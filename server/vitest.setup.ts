// Setup file for server vitest tests
import { vi, afterEach, afterAll } from 'vitest';

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Set test environment variables to avoid using real services
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/avlo_test';
process.env.PORT = process.env.PORT || '3001'; // Different port for tests
process.env.ORIGIN_ALLOWLIST =
  process.env.ORIGIN_ALLOWLIST || '["http://localhost:3000","http://localhost:3001"]';
process.env.ROOM_TTL_DAYS = process.env.ROOM_TTL_DAYS || '14';
process.env.WS_MAX_FRAME_BYTES = process.env.WS_MAX_FRAME_BYTES || '2000000';

// Mock Redis client if needed in tests
vi.mock('redis', async () => {
  const actual = await vi.importActual('redis');
  return {
    ...actual,
    createClient: vi.fn(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      ping: vi.fn().mockResolvedValue('PONG'),
      get: vi.fn(),
      set: vi.fn(),
      setEx: vi.fn(),
      exists: vi.fn(),
      del: vi.fn(),
      // Add more methods as needed
    })),
  };
});

// Mock Prisma client for tests
vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => ({
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    roomMetadata: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    // Add more models as needed
  })),
}));

// Mock WebSocket if needed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.WebSocket = vi.fn() as any;

// Cleanup after each test
afterEach(() => {
  vi.clearAllMocks();
});

// Global cleanup after all tests
afterAll(() => {
  vi.restoreAllMocks();
});
