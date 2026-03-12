import * as Y from 'yjs';
import { YServer } from 'y-partyserver';
import type { Env } from '../index';
import type { Connection } from 'partyserver';

// One canonical head per room, V2-encoded at rest
const headKey = (room: string) => `rooms/${room}/head.v2.bin`;

export class RoomDurableObject extends YServer<Env> {
  // R2-friendly cadence: fewer, bigger writes
  static callbackOptions = { debounceWait: 5000, debounceMaxWait: 15000 };
  static options = {
    hibernate: true,
  };
  /**
   * Ensure hydration completes before the first sync step.
   * YServer awaits onStart(), then onLoad(), installs debounced onSave(), then accepts sockets.
   */
  async onStart(): Promise<void> {
    return super.onStart();
  }

  /**
   * Hydrate from R2 (V2 bytes).
   * Brand-new rooms have no head object yet — that's fine.
   */
  async onLoad(): Promise<void> {
    const obj = await this.env.DOCS.get(headKey(this.name));
    if (!obj) return;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.byteLength === 0) return;
    Y.applyUpdateV2(this.document, bytes);
  }

  /**
   * Debounced persistence: write a V2 snapshot to R2 as the canonical head.
   */
  async onSave(): Promise<void> {
    const updateV2 = Y.encodeStateAsUpdateV2(this.document);
    await this.env.DOCS.put(headKey(this.name), updateV2, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { ts: String(Date.now()) },
    });
  }

  /**
   * Hard flush when the last user leaves the room.
   * This complements the debounced persistence and prevents "lost last edits"
   * when users close their tabs right after a change.
   */
  async onClose(
    connection: Connection<unknown>,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    // First let YServer prune the connection and awareness state.
    await super.onClose(connection, code, reason, wasClean);

    // If the room is now empty, flush the doc immediately (non-debounced).
    // getConnections() yields only OPEN sockets; after super.onClose() the
    // departing socket is already excluded.
    if (this.getConnections()[Symbol.iterator]().next().done) {
      // One microturn in case a final Yjs update just landed
      await Promise.resolve();
      try {
        await this.onSave();
      } catch (err) {
        console.error('flush-on-last-disconnect failed:', err);
      }
    }
  }
}
