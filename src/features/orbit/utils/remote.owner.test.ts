import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeInitialOrbitState } from '@/features/orbit/api/orbit';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';

const mocks = vi.hoisted(() => ({
  getPlaylist: vi.fn(),
  getPlaylistForServer: vi.fn(),
  getPlaylists: vi.fn(),
  getPlaylistsForServer: vi.fn(),
  updatePlaylistMeta: vi.fn(),
}));

vi.mock('@/lib/api/subsonicPlaylists', () => mocks);

import {
  findSessionPlaylistId,
  readOrbitState,
  writeOrbitHeartbeat,
  writeOrbitState,
} from '@/features/orbit/utils/remote';

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  localStorage.clear();
});

describe('Orbit remote owner routing', () => {
  it('uses explicit-server playlist reads and writes throughout', async () => {
    const state = makeInitialOrbitState({ sid: 'aaaa1111', host: 'host', name: 'Session' });
    mocks.getPlaylistsForServer.mockResolvedValue([{ id: 'session-pl', name: '__psyorbit_aaaa1111__' }]);
    mocks.getPlaylistForServer.mockResolvedValue({
      playlist: { id: 'session-pl', name: '__psyorbit_aaaa1111__', comment: JSON.stringify(state) },
      songs: [],
    });

    await expect(findSessionPlaylistId('aaaa1111', 'srv-owner')).resolves.toBe('session-pl');
    await expect(readOrbitState('session-pl', 'srv-owner')).resolves.toEqual(state);
    await writeOrbitState('session-pl', state, 'srv-owner');
    await writeOrbitHeartbeat('outbox-pl', '__psyorbit_aaaa1111_from_host__', 'srv-owner');

    expect(mocks.getPlaylistsForServer).toHaveBeenCalledWith('srv-owner', true);
    expect(mocks.getPlaylistForServer).toHaveBeenCalledWith('srv-owner', 'session-pl');
    expect(mocks.updatePlaylistMeta).toHaveBeenNthCalledWith(
      1,
      'session-pl',
      '__psyorbit_aaaa1111__',
      expect.any(String),
      true,
      'srv-owner',
    );
    expect(mocks.updatePlaylistMeta).toHaveBeenNthCalledWith(
      2,
      'outbox-pl',
      '__psyorbit_aaaa1111_from_host__',
      expect.any(String),
      true,
      'srv-owner',
    );
    expect(mocks.getPlaylist).not.toHaveBeenCalled();
    expect(mocks.getPlaylists).not.toHaveBeenCalled();
  });

  it('normalizes track IDs from an old remote session for a ready owner', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174000';
    const legacyId = '550e8400-e29b-41d4-a716-446655440000';
    const state = makeInitialOrbitState({ sid: 'aaaa1111', host: 'host', name: 'Session' });
    state.currentTrack = { trackId: legacyId, addedBy: 'host', addedAt: 1 };
    state.queue = [{ trackId: legacyId, addedBy: 'guest', addedAt: 2 }];
    state.playQueue = [{ trackId: legacyId, addedBy: 'host' }];
    localStorage.setItem('psysonic-auth', JSON.stringify({
      state: { servers: [{ id: profileId, url: 'https://music.test' }] },
    }));
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      servers: {
        'music.test': { canonicalVersion: 1, phase: 'ready', checkedVersion: '0.64.0' },
      },
    }));
    mocks.getPlaylistForServer.mockResolvedValue({
      playlist: { comment: JSON.stringify(state) },
      songs: [],
    });

    const result = await readOrbitState('session-pl', profileId);
    const canonical = canonicalNavidromeId(legacyId);
    expect(result?.currentTrack?.trackId).toBe(canonical);
    expect(result?.queue[0]?.trackId).toBe(canonical);
    expect(result?.playQueue?.[0]?.trackId).toBe(canonical);
  });
});
