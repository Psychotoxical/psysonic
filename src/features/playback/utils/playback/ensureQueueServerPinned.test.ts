/**
 * Regression cluster for the queue auto-add server-pin contract.
 *
 * The infinite-queue top-up and radio top-up paths in `nextAction.ts` used to
 * read `state.queueServerId ?? ''` directly inside their `set(state => ...)`
 * callbacks. When the queue was populated via paths that don't replace it (e.g.
 * single-track enqueue from a SongRow + button), `queueServerId` stayed null,
 * `seedQueueResolver` skipped its store-write under the `if (serverId)` guard,
 * and the auto-added refs landed with an empty server key — every new row
 * rendered as the resolver placeholder ('…' / 0:00) in the queue panel.
 *
 * PR #892 fixed the manual-enqueue surface via `ensureQueueServerPinned` inside
 * `queueMutationActions.ts`. This file pins the contract for the auto-add
 * paths that share the same helper (see `nextAction.ts`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetAuthStore, resetPlayerStore } from '@/test/helpers/storeReset';
import { ensureQueueServerPinned } from '@/features/playback/utils/playback/playbackServer';

const SERVER_A = {
  id: 'uuid-a',
  name: 'A',
  url: 'http://a.test',
  username: 'u',
  password: 'p',
};
const SERVER_B = {
  id: 'uuid-b',
  name: 'B',
  url: 'http://b.test',
  username: 'u',
  password: 'p',
};
const KEY_A = 'a.test';
const KEY_B = 'b.test';

beforeEach(() => {
  resetAuthStore();
  resetPlayerStore();
  useAuthStore.setState({
    servers: [SERVER_A, SERVER_B],
    activeServerId: SERVER_A.id,
    isLoggedIn: true,
  });
});

describe('ensureQueueServerPinned', () => {
  it('binds the active server when queueServerId is null and returns the canonical key', () => {
    expect(usePlayerStore.getState().queueServerId).toBeNull();

    const serverId = ensureQueueServerPinned();

    expect(serverId).toBe(KEY_A);
    expect(usePlayerStore.getState().queueServerId).toBe(KEY_A);
  });

  it('is idempotent when queueServerId is already bound — no overwrite, no extra writes', () => {
    usePlayerStore.setState({ queueServerId: KEY_B });
    // Pin via the helper while the active server is A but the queue is bound to B
    // (e.g. cross-server enqueue blocked elsewhere; we should not silently rebind here).
    const serverId = ensureQueueServerPinned();

    expect(serverId).toBe(KEY_B);
    expect(usePlayerStore.getState().queueServerId).toBe(KEY_B);
  });

  it('returns an empty string and leaves queueServerId null when no active server is available', () => {
    useAuthStore.setState({ activeServerId: null });
    expect(usePlayerStore.getState().queueServerId).toBeNull();

    const serverId = ensureQueueServerPinned();

    // Matches the pre-existing no-active-server fallback in
    // `bindQueueServerForPlayback`: an empty key signals "do not seed the
    // resolver" without crashing the caller (unit tests, pre-login state).
    expect(serverId).toBe('');
    expect(usePlayerStore.getState().queueServerId).toBeNull();
  });

  it('returns the canonical key after a fresh pin even when the active server id is the raw UUID', () => {
    // `bindQueueServerForPlayback` converts uuid → canonical index key.
    // This documents that the returned value is the same value `toQueueItemRefs`
    // should be called with, not the auth-store uuid.
    useAuthStore.setState({ activeServerId: SERVER_B.id });
    usePlayerStore.setState({ queueServerId: null });

    const serverId = ensureQueueServerPinned();

    expect(serverId).toBe(KEY_B);
    expect(serverId).not.toBe(SERVER_B.id);
  });
});
