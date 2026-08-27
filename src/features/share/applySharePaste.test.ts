import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';

const mocks = vi.hoisted(() => ({
  authState: {
    current: {
      servers: [] as Array<{
        id: string;
        name: string;
        url: string;
        username: string;
        password: string;
      }>,
      isLoggedIn: true,
      activeServerId: 'active',
      setActiveServer: vi.fn(),
    },
  },
  clearQueue: vi.fn(),
  getSongForServer: vi.fn(),
  navigateToAlbumDetail: vi.fn(),
  playTrack: vi.fn(),
  resolveAlbum: vi.fn(),
  resolveArtist: vi.fn(),
  showToast: vi.fn(),
  songToTrack: vi.fn(),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => mocks.authState.current,
  },
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getSongForServer: mocks.getSongForServer,
}));

vi.mock('@/features/offline', () => ({
  resolveAlbum: mocks.resolveAlbum,
  resolveArtist: mocks.resolveArtist,
}));

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: {
    getState: () => ({
      clearQueue: mocks.clearQueue,
      playTrack: mocks.playTrack,
    }),
  },
}));

vi.mock('@/lib/media/songToTrack', () => ({
  songToTrack: mocks.songToTrack,
}));

vi.mock('@/lib/navigation/albumDetailNavigation', () => ({
  navigateToAlbumDetail: mocks.navigateToAlbumDetail,
}));

vi.mock('@/lib/dom/toast', () => ({
  showToast: mocks.showToast,
}));

import {
  applySharePastePayload,
  applySharePasteQueue,
} from '@/features/share/applySharePaste';

const t = ((key: string) => key) as TFunction;
const activeServer = {
  id: 'active',
  name: 'Active',
  url: 'https://active.example.com',
  username: 'active-user',
  password: 'active-pass',
};
const sharedServer = {
  id: 'shared',
  name: 'Shared',
  url: 'https://shared.example.com',
  username: 'shared-user',
  password: 'shared-pass',
};
const sharedSong = {
  id: 'song-1',
  title: 'Shared Song',
  artist: 'Shared Artist',
  album: 'Shared Album',
  albumId: 'album-1',
  duration: 180,
  serverId: 'shared',
};

describe('share paste resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.authState.current = {
      servers: [activeServer, sharedServer],
      isLoggedIn: true,
      activeServerId: 'active',
      setActiveServer: vi.fn(),
    };
    mocks.getSongForServer.mockResolvedValue(sharedSong);
    mocks.resolveAlbum.mockResolvedValue({
      album: { id: 'album-1', name: 'Shared Album', serverId: 'shared' },
      songs: [sharedSong],
    });
    mocks.resolveArtist.mockResolvedValue({
      artist: { id: 'artist-1', name: 'Shared Artist', serverId: 'shared' },
      albums: [],
    });
    mocks.songToTrack.mockImplementation(song => ({
      id: song.id,
      title: song.title,
      serverId: song.serverId,
    }));
  });

  it('fetches and maps a track through its explicit share server before activation', async () => {
    const order: string[] = [];
    mocks.getSongForServer.mockImplementation(async () => {
      order.push('fetch');
      return sharedSong;
    });
    mocks.authState.current.setActiveServer.mockImplementation(() => order.push('activate'));
    mocks.playTrack.mockImplementation(() => order.push('play'));

    await applySharePastePayload(
      { srv: sharedServer.url, k: 'track', id: sharedSong.id },
      vi.fn(),
      t,
    );

    expect(mocks.getSongForServer).toHaveBeenCalledWith('shared', 'song-1');
    expect(mocks.songToTrack).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'shared' }));
    expect(mocks.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'song-1', serverId: 'shared' }),
      [expect.objectContaining({ id: 'song-1', serverId: 'shared' })],
    );
    expect(order).toEqual(['fetch', 'activate', 'play']);
  });

  it('keeps queue tracks owner-qualified and activates only after resolution succeeds', async () => {
    const ok = await applySharePasteQueue(
      { srv: sharedServer.url, k: 'queue', ids: ['song-1'] },
      t,
    );

    expect(ok).toBe(true);
    expect(mocks.getSongForServer).toHaveBeenCalledWith('shared', 'song-1');
    expect(mocks.authState.current.setActiveServer).toHaveBeenCalledWith('shared');
    expect(mocks.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'shared' }),
      [expect.objectContaining({ serverId: 'shared' })],
    );
  });

  it('preserves the owning server in album navigation', async () => {
    const navigate = vi.fn();
    const location = { pathname: '/search', search: '', hash: '', state: null };

    await applySharePastePayload(
      { srv: sharedServer.url, k: 'album', id: 'album-1' },
      navigate,
      t,
      location,
    );

    expect(mocks.resolveAlbum).toHaveBeenCalledWith('shared', 'album-1');
    expect(mocks.navigateToAlbumDetail).toHaveBeenCalledWith(
      navigate,
      location,
      'album-1',
      { serverId: 'shared' },
    );
  });

  it('does not switch servers when the shared entity cannot be resolved', async () => {
    mocks.getSongForServer.mockResolvedValue(null);

    await applySharePastePayload(
      { srv: sharedServer.url, k: 'track', id: 'missing' },
      vi.fn(),
      t,
    );

    expect(mocks.authState.current.setActiveServer).not.toHaveBeenCalled();
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('canonicalizes an old clipboard ID for a ready Navidrome owner', async () => {
    const legacyId = '550e8400-e29b-41d4-a716-446655440000';
    localStorage.setItem('psysonic-auth', JSON.stringify({
      state: { servers: [activeServer, sharedServer] },
    }));
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      servers: {
        'shared.example.com': { canonicalVersion: 1, phase: 'ready', checkedVersion: '0.64.0' },
      },
    }));

    await applySharePastePayload(
      { srv: sharedServer.url, k: 'track', id: legacyId },
      vi.fn(),
      t,
    );

    expect(mocks.getSongForServer).toHaveBeenCalledWith('shared', canonicalNavidromeId(legacyId));
  });
});
