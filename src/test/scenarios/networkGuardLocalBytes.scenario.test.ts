import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore, type LocalPlaybackTier } from '@/store/localPlaybackStore';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { makeServer } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';

// Scenario: network guard × local bytes (closes review residual #1). Uses the REAL
// hasLocalPlaybackUrl + subsonicNetworkGuard: a track that already resolves to
// local psysonic-local:// bytes must skip the reachability probe (plays offline),
// while a non-local track stays gated by reachability.

const isActiveServerReachable = vi.hoisted(() => vi.fn(() => true));
vi.mock('@/lib/network/activeServerReachability', () => ({ isActiveServerReachable }));

const server = makeServer({ id: 'srv-1', url: 'https://demo.example' });
const INDEX_KEY = serverIndexKeyForProfile(server);
const TRACK = 't1';

function seedLocal(tier: LocalPlaybackTier): void {
  useLocalPlaybackStore.getState().upsertEntry({
    serverIndexKey: INDEX_KEY,
    trackId: TRACK,
    localPath: `/disk/${TRACK}.opus`,
    layoutFingerprint: 'fp',
    sizeBytes: 1,
    suffix: 'opus',
    tier,
  });
}

beforeEach(() => {
  resetAllStores();
  useAuthStore.setState({ servers: [server], activeServerId: server.id });
  useLocalPlaybackStore.setState({ entries: {} });
  isActiveServerReachable.mockReturnValue(true);
});

describe('network guard × local bytes', () => {
  it.each<LocalPlaybackTier>(['library', 'favorite-auto', 'ephemeral'])(
    'local %s track → probe skipped (reachable server)',
    (tier) => {
      seedLocal(tier);
      isActiveServerReachable.mockReturnValue(true);
      expect(shouldAttemptSubsonicForServer(server.id, TRACK)).toBe(false);
    },
  );

  it('local track → probe skipped even when the server is unreachable', () => {
    seedLocal('library');
    isActiveServerReachable.mockReturnValue(false);
    expect(shouldAttemptSubsonicForServer(server.id, TRACK)).toBe(false);
  });

  it.each([
    { reachable: true, expected: true },
    { reachable: false, expected: false },
  ])('non-local track → follows reachability (reachable=$reachable)', ({ reachable, expected }) => {
    isActiveServerReachable.mockReturnValue(reachable);
    expect(shouldAttemptSubsonicForServer(server.id, TRACK)).toBe(expected);
  });
});
