import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = {
  id: 'server-a',
  name: 'Wall of Sound',
  url: 'https://music.example.com',
  username: 'alice',
  password: 'pw',
};

describe('localPlaybackStore first automatic hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('imports legacy offline entries before exposing the store', async () => {
    localStorage.setItem('psysonic-auth', JSON.stringify({
      version: 1,
      state: {
        servers: [server],
        activeServerId: server.id,
        libraryBrowseServerIds: [server.id],
      },
    }));
    localStorage.setItem('psysonic-offline', JSON.stringify({
      version: 0,
      state: {
        tracks: {
          [`${server.id}:track-1`]: {
            localPath: '/disk/track-1.flac',
            cachedAt: '2026-01-01T00:00:00.000Z',
            suffix: 'flac',
          },
        },
        albums: {},
      },
    }));

    const { useLocalPlaybackStore } = await import('./localPlaybackStore');

    const entries = Object.values(useLocalPlaybackStore.getState().entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      trackId: 'track-1',
      localPath: '/disk/track-1.flac',
      tier: 'library',
    });
    expect(localStorage.getItem('psysonic-local-playback-migrated-v1')).toBe('1');

    const persisted = JSON.parse(localStorage.getItem('psysonic-local-playback') ?? '{}') as {
      state?: { entries?: Record<string, unknown> };
    };
    expect(Object.values(persisted.state?.entries ?? {})).toHaveLength(1);
  });
});
