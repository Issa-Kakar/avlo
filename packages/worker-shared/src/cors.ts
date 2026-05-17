import { cors } from 'hono/cors';

const ALLOWED_PROD = new Set<string>(['https://avlo.io', 'https://www.avlo.io']);

export const createCors = (_serviceName: string) =>
  cors({
    origin: (origin) => {
      if (!origin) return null;
      if (origin.startsWith('http://localhost:')) return origin;
      if (ALLOWED_PROD.has(origin)) return origin;
      return null;
    },
    allowMethods: ['GET', 'PUT', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Content-Length', 'Range', 'If-None-Match', 'If-Modified-Since'],
    exposeHeaders: ['ETag', 'Content-Range'],
    maxAge: 86400,
  });
