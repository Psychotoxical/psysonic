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

vi.mock('../api/subsonic', () => ({
  getAlbum: mocks.getAlbum,
  getAlbumWithCredentials: mocks.getAlbumWithCredentials,
  getArtist: mocks.getArtist,
  getArtistWithCredentials: mocks.getArtistWithCredentials,
  getSong: mocks.getSong,
  getSongWithCredentials: mocks.getSongWithCredentials,
}));

vi.mock('../store/authStore', () => ({
  useAuthStore: {
    getState: () => mocks.authState.current,
  },
}));

vi.mock('../store/playerStore', () => ({
  songToTrack: mocks.songToTrack,
  usePlayerStore: {
    getState: () => ({ enqueue: mocks.enqueue }),
  },
}));

vi.mock('./orbitBulkGuard', () => ({
  orbitBulkGuard: mocks.orbitBulkGuard,
}));

vi.mock('./toast', () => ({
  showToast: mocks.showToast,
}));

import {
  enqueueShareSearchPayload,
  resolveShareSearchAlbum,
  resolveShareSearchArtist,
  resolveShareSearchPayload,
} from './enqueueShareSearchPayload';

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
    );
    expect(mocks.getArtistWithCredentials).toHaveBeenCalledWith(
      sharedServer.url,
      sharedServer.username,
      sharedServer.password,
      'artist-1',
    );
    expect(mocks.getAlbum).not.toHaveBeenCalled();
    expect(mocks.getArtist).not.toHaveBeenCalled();
    expect(mocks.authState.current.setActiveServer).not.toHaveBeenCalled();
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
});
