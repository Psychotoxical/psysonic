import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';

const mocks = vi.hoisted(() => ({
  getSong: vi.fn(),
  playTrack: vi.fn(),
  songToTrack: vi.fn((song: unknown) => song),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({ getSong: mocks.getSong }));
vi.mock('@/store/mediaResolver', () => ({ resolveAlbumForActiveServer: vi.fn() }));
vi.mock('@/lib/media/songToTrack', () => ({ songToTrack: mocks.songToTrack }));
vi.mock('@/features/playback/utils/playback/playAlbum', () => ({ playAlbum: vi.fn() }));
vi.mock('@/features/playback/utils/playback/playArtistShuffled', () => ({ playArtistShuffled: vi.fn() }));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: { getState: () => ({ playTrack: mocks.playTrack }) },
}));
vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ activeServerId: '123e4567-e89b-42d3-a456-426614174000' }) },
}));

import { playByOpaqueId } from '@/features/playback/utils/playback/playByOpaqueId';

describe('playByOpaqueId canonical ingress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('canonicalizes an old CLI ID before probing entity APIs', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174000';
    const legacyId = '550e8400-e29b-41d4-a716-446655440000';
    localStorage.setItem('psysonic-auth', JSON.stringify({
      state: { activeServerId: profileId, servers: [{ id: profileId, url: 'https://music.test' }] },
    }));
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      servers: {
        'music.test': { canonicalVersion: 1, phase: 'ready', checkedVersion: '0.64.0' },
      },
    }));
    mocks.getSong.mockResolvedValue({ id: canonicalNavidromeId(legacyId) });

    await playByOpaqueId(legacyId);

    expect(mocks.getSong).toHaveBeenCalledWith(canonicalNavidromeId(legacyId));
    expect(mocks.playTrack).toHaveBeenCalledOnce();
  });
});
