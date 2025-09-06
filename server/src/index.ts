import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { setupWebSocketServer } from './websocket-server.js';
import { validateServerEnv } from './config/env.js';
import { setupMiddleware } from './middleware/index.js';
import { roomRoutes } from './routes/rooms.js';
import { healthRoutes } from './routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Validate environment on startup
const env = validateServerEnv();

const app = express();
const httpServer = createServer(app);

// Setup middleware
setupMiddleware(app, env);

// API routes
app.use('/api/rooms', roomRoutes);
app.use('/api', healthRoutes);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../public')));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });
}

// Setup WebSocket server
setupWebSocketServer(httpServer, env);

// Start server
httpServer.listen(env.PORT, () => {
  // Server started on port ${env.PORT}
});
