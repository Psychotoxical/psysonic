import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import { FAVORITES_OFFLINE_JOB_ID } from '@/features/offline/utils/favoritesOfflineConstants';
import {
  mergeStarredSongsUnion,
  onFavoritesOfflineStarChange,
} from '@/features/offline/utils/favoritesOfflineSync';

const getStarredForServerMock = vi.fn(async (_serverId: string) => ({
  artists: [],
  albums: [],
  songs: [{ id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al-1', duration: 1 }],
}));

const isActiveServerReachableMock = vi.fn(() => true);

vi.mock('@/lib/network/activeServerReachability', () => ({
  isActiveServerReachable: () => isActiveServerReachableMock(),
}));

vi.mock('@/lib/api/subsonicStarRating', () => ({
  getStarredForServer: (serverId: string) => getStarredForServerMock(serverId),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbumForServer: vi.fn(async () => ({ songs: [] })),
}));

vi.mock('@/lib/api/subsonicArtists', () => ({
  getArtistForServer: vi.fn(async () => ({ albums: [] })),
}));

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => ({}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

function song(id: string): SubsonicSong {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumId: 'al-1',
    duration: 180,
  };
}

describe('onFavoritesOfflineStarChange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isActiveServerReachableMock.mockReturnValue(true);
    getStarredForServerMock.mockClear();
    invokeMock.mockClear();
    useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
    useAuthStore.setState({
      favoritesOfflineEnabled: true,
      activeServerId: 'srv-a',
      servers: [
        { id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'srv-b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule sync while the active server is unreachable', async () => {
    isActiveServerReachableMock.mockReturnValue(false);
    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-b');
    await vi.advanceTimersByTimeAsync(700);
    expect(getStarredForServerMock).not.toHaveBeenCalled();
  });

  it('schedules sync for the explicit server, not only the active one', async () => {
    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-b');
    await vi.advanceTimersByTimeAsync(700);
    expect(getStarredForServerMock).toHaveBeenCalledWith('srv-b');
    expect(getStarredForServerMock).not.toHaveBeenCalledWith('srv-a');
  });

  it('aborts in-flight favorites Rust downloads when a star change reschedules sync', async () => {
    useOfflineJobStore.setState({
      jobs: [{
        trackId: 't1',
        albumId: FAVORITES_OFFLINE_JOB_ID,
        albumName: 'Favorites',
        trackTitle: 'T',
        trackIndex: 0,
        totalTracks: 1,
        status: 'downloading',
        downloadId: 'favorites-111',
      }],
      pinQueue: [],
      bulkProgress: {},
    });
    onFavoritesOfflineStarChange('t2', 'song', false, 'srv-a');
    expect(invokeMock).toHaveBeenCalledWith(
      'cancel_offline_downloads',
      { downloadIds: ['favorites-111'] },
    );
    expect(useOfflineJobStore.getState().jobs).toEqual([]);
  });
});

describe('mergeStarredSongsUnion', () => {
  it('dedupes the same track from direct song, album, and artist stars', () => {
    const shared = song('t-shared');
    const union = mergeStarredSongsUnion(
      [shared, song('t-solo')],
      [[shared, song('t-album-only')]],
      [[shared, song('t-artist-only')]],
    );
    expect(union.map(s => s.id).sort()).toEqual([
      't-album-only',
      't-artist-only',
      't-shared',
      't-solo',
    ]);
  });

  it('returns empty when nothing is starred', () => {
    expect(mergeStarredSongsUnion([], [], [])).toEqual([]);
  });
});
