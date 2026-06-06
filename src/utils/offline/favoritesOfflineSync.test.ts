import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import {
  mergeStarredSongsUnion,
  onFavoritesOfflineStarChange,
} from './favoritesOfflineSync';

const getStarredForServerMock = vi.fn(async () => ({
  artists: [],
  albums: [],
  songs: [{ id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al-1', duration: 1 }],
}));

vi.mock('../../api/subsonicStarRating', () => ({
  getStarredForServer: (...args: unknown[]) => getStarredForServerMock(...args),
}));

vi.mock('../../api/subsonicLibrary', () => ({
  getAlbumForServer: vi.fn(async () => ({ songs: [] })),
}));

vi.mock('../../api/subsonicArtists', () => ({
  getArtistForServer: vi.fn(async () => ({ albums: [] })),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({})),
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
    getStarredForServerMock.mockClear();
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

  it('schedules sync for the explicit server, not only the active one', async () => {
    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-b');
    await vi.advanceTimersByTimeAsync(700);
    expect(getStarredForServerMock).toHaveBeenCalledWith('srv-b');
    expect(getStarredForServerMock).not.toHaveBeenCalledWith('srv-a');
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
