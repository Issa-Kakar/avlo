import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Recording stand-ins for avlo-users' `UsersRpc` and avlo-images' `ImagesRpc`, used as
 * miniflare auxiliary workers by the AUTH suite (its OAuth callback calls both). Each
 * records calls in module scope and exposes an RPC control surface (`_reset`/`_calls`/
 * `_set`) the test reads through the same service binding — no fetch endpoint needed.
 *
 * The auth suite's vitest config registers this ONE script under BOTH aux worker names
 * (avlo-users / avlo-images). Those are separate isolates, so each instance only ever
 * touches its own slice of `state` — the sharing is source-level, not runtime.
 *
 * Result knobs (via `_set`):
 *  - linkAccountResult: 'throw' | { userId, avatarHash, bookmark } | null (null ⇒ echo
 *    promote: keep currentUserId, pass avatarHash through)
 *  - migrateResult:     { bookmark, migrated, queued }
 *  - ingestResult:      'throw' | 32-hex string | null
 */

const state = {
  linkAccountCalls: [],
  migrateCalls: [],
  ingestCalls: [],
  linkAccountResult: null,
  migrateResult: { bookmark: 'stub-bookmark', migrated: 0, queued: 0 },
  ingestResult: null,
};

export class UsersRpc extends WorkerEntrypoint {
  async linkAccount(currentUserId, googleSub, profile) {
    state.linkAccountCalls.push({ currentUserId, googleSub, profile });
    if (state.linkAccountResult === 'throw') throw new Error('stub-users: forced linkAccount failure');
    return state.linkAccountResult ?? { userId: currentUserId, avatarHash: profile.avatarHash, bookmark: 'stub-bookmark' };
  }

  async migrateOwnedRooms(from, to, priorityRoomId) {
    state.migrateCalls.push({ from, to, priorityRoomId: priorityRoomId ?? null });
    return state.migrateResult;
  }

  async _reset() {
    state.linkAccountCalls = [];
    state.migrateCalls = [];
    state.linkAccountResult = null;
    state.migrateResult = { bookmark: 'stub-bookmark', migrated: 0, queued: 0 };
  }

  async _calls() {
    return { linkAccount: state.linkAccountCalls, migrate: state.migrateCalls };
  }

  async _set(patch) {
    Object.assign(state, patch);
  }
}

export class ImagesRpc extends WorkerEntrypoint {
  async ingestAvatar(pictureUrl) {
    state.ingestCalls.push(pictureUrl);
    if (state.ingestResult === 'throw') throw new Error('stub-images: forced ingest failure');
    return state.ingestResult;
  }

  async _reset() {
    state.ingestCalls = [];
    state.ingestResult = null;
  }

  async _calls() {
    return { ingest: state.ingestCalls };
  }

  async _set(patch) {
    Object.assign(state, patch);
  }
}

export default {
  fetch: () => new Response('stub-users-images: RPC-only', { status: 404 }),
};
