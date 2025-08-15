import * as Sentry from '@sentry/node';

export async function initSentry() {
  const integrations: any[] = [];
  try {
    // @ts-ignore optional dependency
    const mod = await import('@sentry/profiling-node');
    integrations.push(mod.nodeProfilingIntegration());
  } catch {}
  Sentry.init({ 
    dsn: process.env.SENTRY_DSN, 
    enabled: !!process.env.SENTRY_DSN, 
    integrations 
  });
}