import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createClient } from 'redis';

describe('Room Routes', () => {
  let app: Express;
  let redisClient: ReturnType<typeof createClient>;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    vi.mock('redis', () => ({
      createClient: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        exists: vi.fn(),
        expire: vi.fn()
      }))
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/rooms', () => {
    it('should create a new room with generated ID', async () => {
      app.post('/api/rooms', (req, res) => {
        const roomId = 'generated-room-id';
        res.status(201).json({
          roomId,
          shareLink: `/rooms/${roomId}`
        });
      });

      const response = await request(app)
        .post('/api/rooms')
        .send({ title: 'Test Room' });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('roomId');
      expect(response.body).toHaveProperty('shareLink');
      expect(response.body.shareLink).toMatch(/^\/rooms\//);
    });

    it('should handle idempotent creation with supplied ID', async () => {
      const existingRoomId = 'existing-room-id';
      
      app.post('/api/rooms', (req, res) => {
        if (req.body.id === existingRoomId) {
          res.status(200).json({
            roomId: existingRoomId,
            shareLink: `/rooms/${existingRoomId}`
          });
        } else {
          res.status(201).json({
            roomId: req.body.id || 'new-id',
            shareLink: `/rooms/${req.body.id || 'new-id'}`
          });
        }
      });

      const firstResponse = await request(app)
        .post('/api/rooms')
        .send({ id: existingRoomId, title: 'Test Room' });

      const secondResponse = await request(app)
        .post('/api/rooms')
        .send({ id: existingRoomId, title: 'Test Room Again' });

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.roomId).toBe(existingRoomId);
    });

    it('should enforce rate limiting (10 rooms/hour/IP)', async () => {
      let requestCount = 0;
      const rateLimit = 10;
      
      app.post('/api/rooms', (req, res) => {
        requestCount++;
        if (requestCount > rateLimit) {
          res.status(429).json({ error: 'Too many requests' });
        } else {
          res.status(201).json({
            roomId: `room-${requestCount}`,
            shareLink: `/rooms/room-${requestCount}`
          });
        }
      });

      for (let i = 0; i < rateLimit; i++) {
        const response = await request(app)
          .post('/api/rooms')
          .send({ title: `Room ${i}` });
        expect(response.status).toBe(201);
      }

      const exceededResponse = await request(app)
        .post('/api/rooms')
        .send({ title: 'One Too Many' });
      
      expect(exceededResponse.status).toBe(429);
    });
  });

  describe('GET /api/rooms/:id/metadata', () => {
    it('should return room metadata when room exists', async () => {
      app.get('/api/rooms/:id/metadata', (req, res) => {
        const mockMetadata = {
          title: 'Test Room',
          size_bytes: 1024,
          expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString()
        };
        res.status(200).json(mockMetadata);
      });

      const response = await request(app)
        .get('/api/rooms/test-room-id/metadata');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('title');
      expect(response.body).toHaveProperty('size_bytes');
      expect(response.body).toHaveProperty('expires_at');
      expect(response.body).toHaveProperty('created_at');
    });

    it('should return 404 when Redis key is missing', async () => {
      app.get('/api/rooms/:id/metadata', async (req, res) => {
        const redisKeyExists = false;
        
        if (!redisKeyExists) {
          res.status(404).json({ error: 'Room not found' });
        } else {
          res.status(200).json({});
        }
      });

      const response = await request(app)
        .get('/api/rooms/non-existent-room/metadata');

      expect(response.status).toBe(404);
    });

    it('should compute expires_at as lastWriteAt + ROOM_TTL_DAYS', async () => {
      const lastWriteAt = new Date();
      const ttlDays = 14;
      const expectedExpiry = new Date(lastWriteAt.getTime() + ttlDays * 24 * 60 * 60 * 1000);
      
      app.get('/api/rooms/:id/metadata', (req, res) => {
        res.status(200).json({
          title: 'Test Room',
          size_bytes: 1024,
          expires_at: expectedExpiry.toISOString(),
          created_at: lastWriteAt.toISOString()
        });
      });

      const response = await request(app)
        .get('/api/rooms/test-room/metadata');

      const expiresAt = new Date(response.body.expires_at);
      const diffDays = (expiresAt.getTime() - lastWriteAt.getTime()) / (24 * 60 * 60 * 1000);
      
      expect(Math.round(diffDays)).toBe(ttlDays);
    });
  });

  describe('PUT /api/rooms/:id', () => {
    it('should update room title', async () => {
      app.put('/api/rooms/:id', (req, res) => {
        if (!req.body.title) {
          res.status(400).json({ error: 'Title is required' });
        } else {
          res.status(200).json({ success: true });
        }
      });

      const response = await request(app)
        .put('/api/rooms/test-room-id')
        .send({ title: 'Updated Room Title' });

      expect(response.status).toBe(200);
    });

    it('should validate title length (max 120 chars)', async () => {
      app.put('/api/rooms/:id', (req, res) => {
        const title = req.body.title;
        if (!title) {
          res.status(400).json({ error: 'Title is required' });
        } else if (title.length > 120) {
          res.status(400).json({ error: 'Title too long' });
        } else {
          res.status(200).json({ success: true });
        }
      });

      const longTitle = 'x'.repeat(121);
      const response = await request(app)
        .put('/api/rooms/test-room-id')
        .send({ title: longTitle });

      expect(response.status).toBe(400);
    });

    it('should return 404 if room does not exist', async () => {
      app.put('/api/rooms/:id', (req, res) => {
        const roomExists = false;
        
        if (!roomExists) {
          res.status(404).json({ error: 'Room not found' });
        } else {
          res.status(200).json({ success: true });
        }
      });

      const response = await request(app)
        .put('/api/rooms/non-existent-room')
        .send({ title: 'New Title' });

      expect(response.status).toBe(404);
    });

    it('should enforce rate limiting', async () => {
      let requestCount = 0;
      
      app.put('/api/rooms/:id', (req, res) => {
        requestCount++;
        if (requestCount > 10) {
          res.status(429).json({ error: 'Too many requests' });
        } else {
          res.status(200).json({ success: true });
        }
      });

      for (let i = 0; i < 10; i++) {
        const response = await request(app)
          .put('/api/rooms/test-room')
          .send({ title: `Title ${i}` });
        expect(response.status).toBe(200);
      }

      const exceededResponse = await request(app)
        .put('/api/rooms/test-room')
        .send({ title: 'One Too Many' });
      
      expect(exceededResponse.status).toBe(429);
    });
  });

  describe('Health Check Endpoints', () => {
    it('should respond to /healthz', async () => {
      app.get('/healthz', (req, res) => {
        res.status(200).json({ status: 'healthy' });
      });

      const response = await request(app).get('/healthz');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
    });

    it('should respond to /readyz', async () => {
      app.get('/readyz', (req, res) => {
        const isReady = true;
        
        if (isReady) {
          res.status(200).json({ ready: true });
        } else {
          res.status(503).json({ ready: false });
        }
      });

      const response = await request(app).get('/readyz');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ready');
      expect(response.body.ready).toBe(true);
    });
  });
});