declare module '@y/websocket-server/utils' {
  import type * as Y from 'yjs';
  export function setupWSConnection(...args: any[]): void;
  export function setPersistence(p: {
    bindState: (name: string, doc: Y.Doc) => Promise<void>;
    writeState: (name: string, doc: Y.Doc) => Promise<void>;
  }): void;
}
