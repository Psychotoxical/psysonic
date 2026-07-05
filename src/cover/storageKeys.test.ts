import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coverIndexKeyFromScope, coverStorageKey } from './storageKeys';

const mockState = {
  activeServerId: 'profile-uuid-1',
  servers: [
    {
      id: 'profile-uuid-1',
      url: 'http://music.local:4533',
      username: 'u',
      password: 'p',
      name: 'Home',
    },
    {
      id: 'profile-uuid-2',
      url: 'https://nav.example.com/navidrome',
      username: 'u2',
      password: 'p2',
      name: 'Remote',
    },
  ],
  getActiveServer: () => mockState.servers.find(s => s.id === mockState.activeServerId),
};

vi.mock('../store/authStore', () => ({
  useAuthStore: { getState: () => mockState },
}));

vi.mock('@/features/playback/utils/playback/playbackServer', () => ({
  getPlaybackServerId: () => null,
}));

describe('coverStorageKey', () => {
  beforeEach(() => {
    mockState.activeServerId = 'profile-uuid-1';
  });

  it('uses host index key for active scope (not profile uuid)', () => {
    expect(
      coverStorageKey({ kind: 'active' }, { cacheKind: 'album', cacheEntityId: 'al-42' }, 128),
    ).toBe('music.local:4533:cover:album:al-42:128');
  });

  it('uses host index key from explicit server url', () => {
    expect(
      coverStorageKey(
        {
          kind: 'server',
          serverId: 'profile-uuid-2',
          url: 'https://nav.example.com/navidrome',
          username: 'u',
          password: 'p',
        },
        { cacheKind: 'artist', cacheEntityId: 'ar-1' },
        512,
      ),
    ).toBe('nav.example.com/navidrome:cover:artist:ar-1:512');
  });

  it('coverIndexKeyFromScope matches library-style keys', () => {
    expect(coverIndexKeyFromScope({ kind: 'active' })).toBe('music.local:4533');
  });
});
