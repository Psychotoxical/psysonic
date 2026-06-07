import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import * as offlineMediaResolve from '../offline/offlineMediaResolve';
import { fetchArtistDetailTracks } from './runArtistDetailPlay';

vi.mock('../offline/offlineMediaResolve', () => ({
  resolveAlbum: vi.fn(),
  resolveMediaServerId: vi.fn((id?: string | null) => id ?? 'srv-1'),
}));

const resolveAlbumMock = vi.mocked(offlineMediaResolve.resolveAlbum);

const albums: SubsonicAlbum[] = [
  { id: 'al-2', name: 'B', artist: 'A', artistId: 'ar-1', songCount: 1, duration: 100, year: 2001 },
  { id: 'al-1', name: 'A', artist: 'A', artistId: 'ar-1', songCount: 1, duration: 100, year: 2000 },
];

describe('fetchArtistDetailTracks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads albums via resolveAlbum when serverId is set', async () => {
    resolveAlbumMock
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
    expect(resolveAlbumMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty when no server scope', async () => {
    vi.mocked(offlineMediaResolve.resolveMediaServerId).mockReturnValueOnce(null);

    const tracks = await fetchArtistDetailTracks(albums, null);
    expect(tracks).toEqual([]);
    expect(resolveAlbumMock).not.toHaveBeenCalled();
  });
});
