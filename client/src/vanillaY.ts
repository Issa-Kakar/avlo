import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

export function connectVanilla(roomId: string) {
  const ydoc = new Y.Doc({ guid: roomId });
  const provider = new WebsocketProvider('ws://localhost:3001/ws', roomId, ydoc, { connect: true });

  provider.on('status', (e: { status: string }) => {
    console.log('[status]', e.status);
  });

  provider.on('sync', (b: boolean) => {
    console.log('[sync]', b);
  });

  provider.on('connection-close', (e: CloseEvent | null, _provider: WebsocketProvider) => {
    console.log('[connection-close]', e?.code, e?.reason);
  });

  provider.on('connection-error', (e: Event) => {
    console.log('[connection-error]', e);
  });

  // Add awareness logging
  provider.awareness.on('update', () => {
    console.log('[awareness-update] clients:', provider.awareness.getStates().size);
  });

  // Make it global for testing
  (window as any).vanillaY = { ydoc, provider };

  return { ydoc, provider };
}
