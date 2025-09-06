/**
 * Test utilities for server tests
 */
import { vi } from 'vitest';
import type { Request, Response } from 'express';
import type { Server } from 'http';

/**
 * Create a mock Express request object
 */
export function createMockRequest(overrides?: Partial<Request>): Request {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    method: 'GET',
    url: '/',
    ...overrides,
  } as Request;
}

/**
 * Create a mock Express response object
 */
export function createMockResponse(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res;
}

/**
 * Create a mock Redis client for testing
 */
export function createMockRedisClient() {
  return {
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
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
}

/**
 * Create a mock Redis wrapper for testing (matches import in tests)
 */
export function createMockRedis() {
  return {
    client: createMockRedisClient(),
    pubClient: createMockRedisClient(),
  };
}

/**
 * Create a mock Prisma client for testing
 */
export function createMockPrismaClient() {
  return {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(),
    roomMetadata: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  };
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Create a test server instance
 * Note: This is a placeholder - actual implementation will require
 * exporting app from index.ts or creating a separate test server factory
 */
export async function createTestServer(_port = 0): Promise<{
  server: Server;
  url: string;
  close: () => Promise<void>;
}> {
  // TODO: Implement when app is properly exported from index.ts
  // For now, return a mock implementation
  throw new Error('createTestServer not yet implemented - requires app export from index.ts');
}

/**
 * Mock Y.Doc for testing WebSocket operations
 */
export function createMockYDoc() {
  return {
    guid: 'test-room-id',
    getMap: vi.fn().mockReturnValue({
      get: vi.fn(),
      set: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
    }),
    getArray: vi.fn().mockReturnValue({
      push: vi.fn(),
      get: vi.fn(),
      length: 0,
    }),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    transact: vi.fn((fn) => fn()),
  };
}
