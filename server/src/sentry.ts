import * as Sentry from '@sentry/node';

export async function initSentry() {
  const integrations: any[] = [];
  try {
    const mod = await import('@sentry/profiling-node');
    // @ts-ignore optional
    integrations.push(mod.nodeProfilingIntegration());
  } catch {}
  Sentry.init({ 
    dsn: process.env.SENTRY_DSN, 
    enabled: !!process.env.SENTRY_DSN, 
    integrations 
  });
}