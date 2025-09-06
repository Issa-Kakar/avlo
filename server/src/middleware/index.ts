import express, { Application } from 'express';
import cors from 'cors';
import { ServerEnv } from '../config/env.js';

export function setupMiddleware(app: Application, env: ServerEnv) {
  // Store env in app locals for route access
  app.locals.env = env;

  // CORS with origin allowlist
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, Postman, etc)
        if (!origin) return callback(null, true);

        if (env.ORIGIN_ALLOWLIST.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    }),
  );

  // Body parsing with size limits
  app.use(express.json({ limit: '1mb' }));

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // HSTS (only in production with HTTPS)
    if (process.env.NODE_ENV === 'production' && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  });

  // Request logging in development
  if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
      // Debug: ${req.method} ${req.path}
      next();
    });
  }
}
