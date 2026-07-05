import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import * as offlineMediaResolve from '@/features/offline';
import { fetchArtistDetailTracks, runArtistDetailPlayTopSong } from '@/features/artist/utils/runArtistDetailPlay';

vi.mock('@/features/offline', () => ({
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

describe('runArtistDetailPlayTopSong', () => {
  const topSongs = [
    { id: 'top-1', title: 'Hit', artist: 'A', album: 'Greatest', albumId: 'al-x', duration: 200 },
    { id: 'top-2', title: 'Hit 2', artist: 'A', album: 'Greatest 2', albumId: 'al-y', duration: 180 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('plays top tracks when the artist has no albums on the page', async () => {
    const playTrack = vi.fn();
    const setPlayAllLoading = vi.fn();

    await runArtistDetailPlayTopSong({
      topSongs,
      albums: [],
      serverId: 'srv-1',
      startIndex: 1,
      setPlayAllLoading,
      playTrack,
    });

    expect(resolveAlbumMock).not.toHaveBeenCalled();
    expect(playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'top-2' }),
      [expect.objectContaining({ id: 'top-2' })],
    );
    expect(setPlayAllLoading).toHaveBeenCalledWith(true);
    expect(setPlayAllLoading).toHaveBeenLastCalledWith(false);
  });

  it('continues into album tracks after the top-song block', async () => {
    resolveAlbumMock.mockResolvedValueOnce({
      album: albums[1],
      songs: [{ id: 'top-1', title: 'Dup', artist: 'A', album: 'A', albumId: 'al-1', duration: 100, track: 1 }],
    });
    const playTrack = vi.fn();

    await runArtistDetailPlayTopSong({
      topSongs: [topSongs[0]],
      albums: [albums[1]],
      serverId: 'srv-1',
      startIndex: 0,
      setPlayAllLoading: vi.fn(),
      playTrack,
    });

    expect(playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'top-1' }),
      [expect.objectContaining({ id: 'top-1' })],
    );
  });
});
