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
    // Credentialed cross-origin: the SPA calls subdomain workers with
    // `credentials: 'include'` so the `.avlo.io` cookie rides (§12). Requires a
    // specific reflected origin (never `*`) + `Access-Control-Allow-Credentials`.
    credentials: true,
    allowMethods: ['GET', 'PUT', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Content-Length', 'Range', 'If-None-Match', 'If-Modified-Since', 'x-d1-bookmark'],
    exposeHeaders: ['ETag', 'Content-Range', 'x-d1-bookmark'],
    maxAge: 86400,
  });
