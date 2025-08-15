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
export const sentryHandlers = {
  request: Sentry.Handlers?.requestHandler() || ((req: any, res: any, next: any) => next()),
  error:
    Sentry.Handlers?.errorHandler() || ((err: any, req: any, res: any, next: any) => next(err)),
};
