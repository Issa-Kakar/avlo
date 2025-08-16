import { sentry } from './sentry.js';

// Counter for tracking various metrics
const counters = new Map<string, number>();

export const crumb = (
  message: string,
  category = 'gateway',
  level: 'info' | 'warning' | 'error' = 'info',
) => sentry.addBreadcrumb({ message, category, level });

export const capture = (err: unknown, hint?: string) => {
  if (hint) crumb(hint, 'error', 'error');
  sentry.captureException(err);
};

// Increment counter and optionally log as breadcrumb
export const count = (name: string, category = 'metrics', logBreadcrumb = false) => {
  const current = counters.get(name) || 0;
  counters.set(name, current + 1);

  if (logBreadcrumb) {
    crumb(`${name}: ${current + 1}`, category, 'info');
  }
};

// Get counter value
export const getCount = (name: string): number => counters.get(name) || 0;

// Flush timing metrics (for p50/p95 calculation)
const flushTimings: number[] = [];

export const recordFlushTiming = (durationMs: number) => {
  flushTimings.push(durationMs);
  // Keep only last 1000 measurements for memory efficiency
  if (flushTimings.length > 1000) {
    flushTimings.shift();
  }

  // Log percentiles periodically
  if (flushTimings.length % 50 === 0) {
    const sorted = [...flushTimings].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];

    crumb(`flush_p50: ${p50}ms, flush_p95: ${p95}ms`, 'performance', 'info');
  }
};

// Export timing data for metrics
export const getFlushMetrics = () => {
  if (flushTimings.length === 0) return { p50: 0, p95: 0, count: 0 };

  const sorted = [...flushTimings].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
    count: flushTimings.length,
  };
};
