import type { IncomingMessage } from 'http';
export function getClientIp(req: IncomingMessage) {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return fwd || (req.socket as any).remoteAddress || '';
}