import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const ndLoginMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/generated/bindings', () => ({
  commands: { ndDeletePlaylist: vi.fn() },
}));
vi.mock('@/lib/api/navidromeAdmin', () => ({ ndLogin: ndLoginMock }));
vi.mock('@/lib/server/serverEndpoint', () => ({ getCachedConnectBaseUrl: () => null }));
vi.mock('@/lib/server/serverBaseUrl', () => ({ serverProfileBaseUrl: ({ url }: { url: string }) => url }));
vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => ({
      activeServerId: 'a',
      servers: [
        { id: 'a', url: 'https://a.test', username: 'user-a', password: 'pass-a' },
        { id: 'b', url: 'https://b.test', username: 'user-b', password: 'pass-b' },
      ],
      getActiveServer: () => ({
        id: 'a', url: 'https://a.test', username: 'user-a', password: 'pass-a',
      }),
    }),
  },
}));

import {
  ndCreateSmartPlaylist,
  ndGetSmartPlaylist,
  ndGetPlaylistTracks,
  ndListPlaylists,
  ndPreviewSmartPlaylist,
  ndUpdatePlaylistMeta,
  ndUpdateSmartPlaylist,
} from '@/lib/api/navidromeSmart';

describe('Navidrome smart playlist owner routing', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue({ id: 'smart', name: 'Smart', songCount: 0 });
    ndLoginMock.mockReset().mockResolvedValue({ token: 'token-b' });
  });

  it('uses the requested server instead of the mutable active server', async () => {
    await ndCreateSmartPlaylist('Smart', { all: [] }, true, 'b');
    await ndUpdateSmartPlaylist('smart', 'Smart', { all: [] }, true, 'b');

    expect(ndLoginMock).toHaveBeenCalledWith('https://b.test', 'user-b', 'pass-b');
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'nd_create_playlist', expect.objectContaining({
      serverUrl: 'https://b.test', token: 'token-b',
    }));
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'nd_update_playlist', expect.objectContaining({
      serverUrl: 'https://b.test', token: 'token-b', id: 'smart',
    }));
  });

  it('omits the smart query when listing native playlist metadata', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'regular', name: 'Regular', songCount: 1, rules: null },
      { id: 'smart', name: 'Native smart', songCount: 2, rules: { any: [] } },
    ]);

    await expect(ndListPlaylists('b')).resolves.toEqual([
      expect.objectContaining({ id: 'regular', rules: undefined }),
      expect.objectContaining({ id: 'smart', rules: { any: [] } }),
    ]);
    expect(invokeMock).toHaveBeenCalledWith('nd_list_playlists', {
      serverUrl: 'https://b.test',
      token: 'token-b',
    });
    expect(invokeMock.mock.calls[0]?.[1]).not.toHaveProperty('smart');
  });

  it('parses native playlist comments and ownerName metadata', async () => {
    invokeMock.mockResolvedValueOnce({
      id: 'smart',
      name: 'Commented mix',
      songCount: 0,
      comment: 'Existing comment',
      ownerName: 'jalen',
      rules: { all: [] },
    });

    await expect(ndGetSmartPlaylist('smart', 'b')).resolves.toEqual(expect.objectContaining({
      comment: 'Existing comment',
      owner: 'jalen',
    }));
  });

  it('sends a metadata-only native update without rules or sync', async () => {
    await ndUpdatePlaylistMeta('smart', { name: 'Renamed', comment: 'Hi', public: false }, 'b');
    expect(invokeMock).toHaveBeenCalledWith('nd_update_playlist', {
      serverUrl: 'https://b.test',
      token: 'token-b',
      id: 'smart',
      body: { name: 'Renamed', comment: 'Hi', public: false },
    });
    const body = invokeMock.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('rules');
    expect(body).not.toHaveProperty('sync');
  });

  it('omits sync on REST create unless explicitly requested', async () => {
    await ndCreateSmartPlaylist('Smart', { all: [{ contains: { title: 'a' } }] }, { serverId: 'b' });

    expect(invokeMock).toHaveBeenCalledWith('nd_create_playlist', expect.objectContaining({
      body: { name: 'Smart', rules: { all: [{ contains: { title: 'a' } }] } },
    }));
    expect(invokeMock.mock.calls[0]?.[1].body).not.toHaveProperty('sync');
  });

  it('previews existing playlists via tracks and unsaved rules via a temporary playlist', async () => {
    invokeMock.mockResolvedValueOnce([{ id: 't1', title: 'One' }]);
    await expect(ndGetPlaylistTracks('pl-1', 'b', { start: 0, end: 50 })).resolves.toEqual([
      { id: 't1', title: 'One' },
    ]);
    expect(invokeMock).toHaveBeenCalledWith('nd_get_playlist_tracks', expect.objectContaining({
      id: 'pl-1',
      start: 0,
      end: 50,
    }));

    invokeMock.mockResolvedValueOnce([{ id: 't2', title: 'Two' }]);
    await expect(ndPreviewSmartPlaylist({
      owner: 'user-b',
      rules: { all: [{ contains: { title: 'a' } }] },
    }, 'b')).resolves.toEqual([{ id: 't2', title: 'Two' }]);
    expect(invokeMock).toHaveBeenCalledWith('nd_preview_playlist', expect.objectContaining({
      body: expect.objectContaining({
        owner: 'user-b',
        rules: { all: [{ contains: { title: 'a' } }] },
        public: false,
      }),
    }));
  });
});
