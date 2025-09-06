/**
 * Basic test to verify server test setup is working
 */
import { describe, it, expect } from 'vitest';
import { createMockRequest, createMockResponse, createMockRedisClient } from './test-utils.js';

describe('Server Test Setup', () => {
  it('should have test environment configured', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('should create mock request object', () => {
    const req = createMockRequest({
      method: 'POST',
      body: { test: 'data' },
    });
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ test: 'data' });
  });

  it('should create mock response object', () => {
    const res = createMockResponse();
    res.status(200).json({ success: true });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('should create mock Redis client', () => {
    const redis = createMockRedisClient();
    expect(redis.connect).toBeDefined();
    expect(redis.get).toBeDefined();
    expect(redis.set).toBeDefined();
  });
});
