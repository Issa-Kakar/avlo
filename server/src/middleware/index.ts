// Stub for middleware setup - will be implemented in Phase 6B.7
import express, { Application } from 'express';
import cors from 'cors';
import { ServerEnv } from '../config/env.js';

export function setupMiddleware(app: Application, env: ServerEnv) {
  // Store env in app locals for route access
  app.locals.env = env;

  // Basic middleware
  app.use(cors());
  app.use(express.json());

  console.log('[Middleware] Basic setup - full implementation pending Phase 6B.7');
}