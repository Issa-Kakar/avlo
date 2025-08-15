import { sentry } from './sentry.js';
export const crumb = (
  message: string,
  category = 'gateway',
  level: 'info' | 'warning' | 'error' = 'info',
) => sentry.addBreadcrumb({ message, category, level });
export const capture = (err: unknown, hint?: string) => {
  if (hint) crumb(hint, 'error', 'error');
  sentry.captureException(err);
};
