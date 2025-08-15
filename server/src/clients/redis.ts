import { createClient } from 'redis';
import * as Sentry from '@sentry/node';

const client = createClient({
  url: process.env.REDIS_URL,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 2000) },
});

client.on('error', (err) => {
  Sentry.captureMessage('redis_error', {
    level: 'error',
    extra: { code: (err as any)?.code, message: (err as any)?.message },
  });
});

client.connect().catch((err) => {
  Sentry.captureException(err);
});

export const redis = client;
