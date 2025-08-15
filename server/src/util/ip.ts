import type { IncomingMessage } from 'http';
import type { Socket } from 'net';

export function getClientIp(req: IncomingMessage) {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return fwd || (req.socket as Socket)?.remoteAddress || '';
}
