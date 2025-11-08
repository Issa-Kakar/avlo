import * as Y from 'yjs';
import { YServer } from 'y-partyserver';
import type { Env } from '../index';

export class RoomDurableObject extends YServer<Env> {
  static callbackOptions = { debounceWait: 1000, debounceMaxWait: 5000 };

  async onLoad(): Promise<void> {
    // Table for the single snapshot (legacy or small docs)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ydoc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Safe read: zero rows OK
    const cur = this.ctx.storage.sql.exec(
      'SELECT state FROM ydoc_state WHERE id = 1 LIMIT 1'
    );
    const row = cur.toArray()[0] as { state?: ArrayBuffer | Uint8Array } | undefined;

    if (row?.state) {
      const buf = row.state instanceof Uint8Array ? row.state : new Uint8Array(row.state);
      Y.applyUpdate(this.document, buf);
    }

  }

  async onSave(): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.document);

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO ydoc_state (id, state, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      state, now
    );
  }

}

