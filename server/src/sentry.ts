import * as Sentry from '@sentry/node';

export async function initSentry() {
  const integrations: any[] = [];
  try {
    // @ts-expect-error optional dependency
    const mod = await import('@sentry/profiling-node');
    integrations.push(mod.nodeProfilingIntegration());
  } catch {
    // Optional dependency not available, continue without profiling
  }
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: !!process.env.SENTRY_DSN,
    integrations: integrations as any,
  });
}
