import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN || undefined,
  environment: process.env.NODE_ENV || 'development',
  release: process.env.APP_VERSION,
  tracesSampleRate: 0.02,
  sendDefaultPii: false,
  beforeSend(event) {
    if (event.request) {
      delete (event.request as any).data;
      delete (event.request as any).headers;
    }
    return event;
  },
});

export const sentry = Sentry;
const Handlers = (Sentry as any).Handlers;
export const sentryHandlers = {
  request: Handlers?.requestHandler() ?? ((_req: any, _res: any, next: any) => next()),
  error: Handlers?.errorHandler() ?? ((err: any, _req: any, _res: any, next: any) => next(err)),
};
