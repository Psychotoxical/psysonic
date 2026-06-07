import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import * as subsonicLibrary from '../../api/subsonicLibrary';
import * as offlineBrowseMode from '../offline/offlineBrowseMode';
import * as offlineLocalBrowse from '../offline/offlineLocalBrowse';
import { fetchArtistDetailTracks } from './runArtistDetailPlay';

vi.mock('../../api/subsonicLibrary', () => ({
  getAlbum: vi.fn(),
}));

vi.mock('../offline/offlineBrowseMode', () => ({
  isOfflineBrowseActive: vi.fn(),
}));

vi.mock('../offline/offlineLocalBrowse', () => ({
  loadAlbumFromLocalPlayback: vi.fn(),
}));

const getAlbumMock = vi.mocked(subsonicLibrary.getAlbum);
const isOfflineBrowseActiveMock = vi.mocked(offlineBrowseMode.isOfflineBrowseActive);
const loadAlbumFromLocalPlaybackMock = vi.mocked(offlineLocalBrowse.loadAlbumFromLocalPlayback);

const albums: SubsonicAlbum[] = [
  { id: 'al-2', name: 'B', artist: 'A', artistId: 'ar-1', songCount: 1, duration: 100, year: 2001 },
  { id: 'al-1', name: 'A', artist: 'A', artistId: 'ar-1', songCount: 1, duration: 100, year: 2000 },
];

describe('fetchArtistDetailTracks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isOfflineBrowseActiveMock.mockReturnValue(false);
  });

  it('loads albums from the network when online', async () => {
    getAlbumMock
      .mockResolvedValueOnce({
        album: albums[1],
        songs: [{ id: 't1', title: 'One', artist: 'A', album: 'A', albumId: 'al-1', duration: 100, track: 2 }],
      })
      .mockResolvedValueOnce({
        album: albums[0],
        songs: [{ id: 't2', title: 'Two', artist: 'A', album: 'B', albumId: 'al-2', duration: 100, track: 1 }],
      });

    const tracks = await fetchArtistDetailTracks(albums, 'srv-1');
    expect(tracks.map(t => t.id)).toEqual(['t1', 't2']);
    expect(loadAlbumFromLocalPlaybackMock).not.toHaveBeenCalled();
  });

  it('loads albums from local bytes when offline browse is active', async () => {
    isOfflineBrowseActiveMock.mockReturnValue(true);
    loadAlbumFromLocalPlaybackMock
      .mockResolvedValueOnce({
        album: albums[1],
        songs: [{ id: 't1', title: 'One', artist: 'A', album: 'A', albumId: 'al-1', duration: 100, track: 2 }],
      })
      .mockResolvedValueOnce({
        album: albums[0],
        songs: [{ id: 't2', title: 'Two', artist: 'A', album: 'B', albumId: 'al-2', duration: 100, track: 1 }],
      });

    const tracks = await fetchArtistDetailTracks(albums, 'srv-1');
    expect(tracks.map(t => t.id)).toEqual(['t1', 't2']);
    expect(getAlbumMock).not.toHaveBeenCalled();
  });
});
