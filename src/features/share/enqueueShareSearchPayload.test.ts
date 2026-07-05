import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const mocks = vi.hoisted(() => ({
  authState: {
    current: {
      servers: [] as Array<{ id: string; name: string; url: string; username: string; password: string }>,
      isLoggedIn: true,
      activeServerId: 'active',
      setActiveServer: vi.fn(),
    },
  },
  enqueue: vi.fn(),
  getAlbum: vi.fn(),
  getAlbumWithCredentials: vi.fn(),
  getArtist: vi.fn(),
  getArtistWithCredentials: vi.fn(),
  getSong: vi.fn(),
  getSongWithCredentials: vi.fn(),
  orbitBulkGuard: vi.fn(),
  showToast: vi.fn(),
  songToTrack: vi.fn(),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbum: mocks.getAlbum,
  getSong: mocks.getSong,
}));

vi.mock('@/lib/api/subsonicArtists', () => ({
  getArtist: mocks.getArtist,
}));

vi.mock('@/lib/api/subsonicEntityWithCredentials', () => ({
  getAlbumWithCredentials: mocks.getAlbumWithCredentials,
  getArtistWithCredentials: mocks.getArtistWithCredentials,
  getSongWithCredentials: mocks.getSongWithCredentials,
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => mocks.authState.current,
  },
}));

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: {
    getState: () => ({ enqueue: mocks.enqueue }),
  },
}));

vi.mock('@/lib/media/songToTrack', () => ({
  songToTrack: mocks.songToTrack,
}));

vi.mock('@/features/orbit', () => ({
  orbitBulkGuard: mocks.orbitBulkGuard,
}));

vi.mock('@/lib/dom/toast', () => ({
  showToast: mocks.showToast,
}));

import {
  activateShareSearchServer,
  enqueueShareSearchPayload,
  resolveShareSearchAlbum,
  resolveShareSearchArtist,
  resolveShareSearchPayload,
} from '@/features/share/enqueueShareSearchPayload';

const sharedServer = {
  id: 'shared',
  name: 'Shared',
  url: 'https://shared.example.com',
  username: 'shared-user',
  password: 'shared-pass',
};

const activeServer = {
  id: 'active',
  name: 'Active',
  url: 'https://active.example.com',
  username: 'active-user',
  password: 'active-pass',
};

const sharedSong = {
  id: 'song-1',
  title: 'Shared Song',
  artist: 'Shared Artist',
  album: 'Shared Album',
  albumId: 'album-1',
  duration: 180,
  minutesAgo: 0,
  playerId: 0,
  playerName: '',
};

describe('share search payload resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authState.current = {
      servers: [activeServer, sharedServer],
      isLoggedIn: true,
      activeServerId: 'active',
      setActiveServer: vi.fn(),
    };
    mocks.getSongWithCredentials.mockResolvedValue(sharedSong);
    mocks.getAlbumWithCredentials.mockResolvedValue({
      album: { id: 'album-1', name: 'Shared Album', artist: 'Shared Artist' },
      songs: [],
    });
    mocks.getArtistWithCredentials.mockResolvedValue({
      artist: { id: 'artist-1', name: 'Shared Artist' },
      albums: [],
    });
    mocks.getSong.mockResolvedValue(sharedSong);
    mocks.songToTrack.mockImplementation(song => ({ id: song.id, title: song.title }));
    mocks.orbitBulkGuard.mockResolvedValue(true);
  });

  it('resolves a shared track preview with explicit credentials without switching active server', async () => {
    const result = await resolveShareSearchPayload({
      srv: 'https://shared.example.com',
      k: 'track',
      id: 'song-1',
    });

    expect(result).toEqual({ type: 'ok', songs: [sharedSong], total: 1, skipped: 0 });
    expect(mocks.getSongWithCredentials).toHaveBeenCalledWith(
      sharedServer.url,
      sharedServer.username,
      sharedServer.password,
      'song-1',
      sharedServer,
    );
    expect(mocks.getSong).not.toHaveBeenCalled();
    expect(mocks.authState.current.setActiveServer).not.toHaveBeenCalled();
  });

  it('resolves album and artist previews without switching active server', async () => {
    await resolveShareSearchAlbum({ srv: 'https://shared.example.com', k: 'album', id: 'album-1' });
    await resolveShareSearchArtist({ srv: 'https://shared.example.com', k: 'artist', id: 'artist-1' });

    expect(mocks.getAlbumWithCredentials).toHaveBeenCalledWith(
      sharedServer.url,
      sharedServer.username,
      sharedServer.password,
      'album-1',
      sharedServer,
    );
    expect(mocks.getArtistWithCredentials).toHaveBeenCalledWith(
      sharedServer.url,
      sharedServer.username,
      sharedServer.password,
      'artist-1',
      sharedServer,
    );
    expect(mocks.getAlbum).not.toHaveBeenCalled();
    expect(mocks.getArtist).not.toHaveBeenCalled();
    expect(mocks.authState.current.setActiveServer).not.toHaveBeenCalled();
  });

  it('resolves composer previews via artist credentials without switching active server', async () => {
    const result = await resolveShareSearchArtist({
      srv: 'https://shared.example.com',
      k: 'composer',
      id: 'composer-1',
    });

    expect(result.type).toBe('ok');
    expect(mocks.getArtistWithCredentials).toHaveBeenCalledWith(
      sharedServer.url,
      sharedServer.username,
      sharedServer.password,
      'composer-1',
      sharedServer,
    );
    expect(mocks.authState.current.setActiveServer).not.toHaveBeenCalled();
  });

  it('returns not-logged-in without calling the API', async () => {
    mocks.authState.current.isLoggedIn = false;

    const result = await resolveShareSearchPayload({
      srv: 'https://shared.example.com',
      k: 'track',
      id: 'song-1',
    });

    expect(result).toEqual({ type: 'not-logged-in' });
    expect(mocks.getSongWithCredentials).not.toHaveBeenCalled();
  });

  it('activates the share server for confirmed enqueue actions', async () => {
    const t = ((key: string) => key) as TFunction;
    const ok = await enqueueShareSearchPayload({
      srv: 'https://shared.example.com',
      k: 'track',
      id: 'song-1',
    }, t);

    expect(ok).toBe(true);
    expect(mocks.authState.current.setActiveServer).toHaveBeenCalledWith('shared');
    expect(mocks.getSong).toHaveBeenCalledWith('song-1');
    expect(mocks.getSongWithCredentials).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith([{ id: 'song-1', title: 'Shared Song' }], true);
  });

  it('aborts enqueue when orbitBulkGuard rejects the bulk add', async () => {
    mocks.orbitBulkGuard.mockResolvedValue(false);
    const t = ((key: string) => key) as TFunction;

    const ok = await enqueueShareSearchPayload({
      srv: 'https://shared.example.com',
      k: 'track',
      id: 'song-1',
    }, t);

    expect(ok).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('reports partial queue enqueue with a partial toast', async () => {
    mocks.getSong.mockImplementation((id: string) =>
      id === 'song-1' ? Promise.resolve(sharedSong) : Promise.resolve(null),
    );
    const t = ((key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key) as TFunction;

    const ok = await enqueueShareSearchPayload({
      srv: 'https://shared.example.com',
      k: 'queue',
      ids: ['song-1', 'missing'],
    }, t);

    expect(ok).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledWith([{ id: 'song-1', title: 'Shared Song' }], true);
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining('search.shareQueuedPartial'),
      5000,
      'info',
    );
  });

  it('activateShareSearchServer switches server when lookup succeeds', () => {
    const t = ((key: string) => key) as TFunction;
    expect(activateShareSearchServer('https://shared.example.com', t)).toBe(true);
    expect(mocks.authState.current.setActiveServer).toHaveBeenCalledWith('shared');
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('activateShareSearchServer toasts when no matching server exists', () => {
    const t = ((key: string) => key) as TFunction;
    expect(activateShareSearchServer('https://unknown.example.com', t)).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith(
      'sharePaste.noMatchingServer',
      6000,
      'error',
    );
  });
});
