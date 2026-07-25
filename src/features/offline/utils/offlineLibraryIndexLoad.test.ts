import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  libraryAdvancedSearchMock,
  libraryGetTracksByAlbumMock,
  libraryScopeArtistDetailMock,
  libraryScopeForServerMock,
  libraryScopePairsForServerMock,
} = vi.hoisted(() => ({
  libraryAdvancedSearchMock: vi.fn(),
  libraryGetTracksByAlbumMock: vi.fn(),
  libraryScopeArtistDetailMock: vi.fn(),
  libraryScopeForServerMock: vi.fn(),
  libraryScopePairsForServerMock: vi.fn(),
}));

vi.mock('@/lib/api/library', () => ({
  libraryAdvancedSearch: libraryAdvancedSearchMock,
  libraryGetTracksByAlbum: libraryGetTracksByAlbumMock,
  libraryScopeArtistDetail: libraryScopeArtistDetailMock,
}));

vi.mock('@/lib/api/subsonicClient', () => ({
  libraryScopeForServer: libraryScopeForServerMock,
  libraryScopePairsForServer: libraryScopePairsForServerMock,
}));

import {
  loadAlbumFromLibraryIndex,
  loadArtistFromLibraryIndex,
  loadArtistTracksFromLibraryIndex,
} from './offlineLibraryIndexLoad';

describe('loadArtistFromLibraryIndex', () => {
  beforeEach(() => {
    libraryAdvancedSearchMock.mockReset();
    libraryGetTracksByAlbumMock.mockReset();
    libraryScopeArtistDetailMock.mockReset();
    libraryScopeForServerMock.mockReset();
    libraryScopePairsForServerMock.mockReset();
  });

  it('uses one scoped artist-detail request for concurrent loads', async () => {
    const scopes = [{ serverId: 'srv-1', libraryId: 'lib-1' }];
    libraryScopePairsForServerMock.mockReturnValue(scopes);
    libraryScopeArtistDetailMock.mockResolvedValue({
      artist: { id: 'artist-1', name: 'Artist', albumCount: 1, serverId: 'srv-1' },
      albums: [{ id: 'album-1', name: 'Album', artist: 'Artist', artistId: 'artist-1', serverId: 'srv-1' }],
      appearsOnAlbums: [],
      tracks: [],
    });

    const [first, second] = await Promise.all([
      loadArtistFromLibraryIndex('srv-1', 'artist-1'),
      loadArtistFromLibraryIndex('srv-1', 'artist-1'),
    ]);

    expect(libraryScopeArtistDetailMock).toHaveBeenCalledOnce();
    expect(libraryScopeArtistDetailMock).toHaveBeenCalledWith('srv-1', {
      scopes,
      artistId: 'artist-1',
      serverId: 'srv-1',
      includeTracks: false,
    });
    expect(libraryAdvancedSearchMock).not.toHaveBeenCalled();
    expect(first).toEqual(second);
    expect(first?.albums).toHaveLength(1);
  });

  it('keeps own releases and appears-on separate rather than unioning them', async () => {
    const scopes = [{ serverId: 'srv-1', libraryId: 'lib-1' }];
    libraryScopePairsForServerMock.mockReturnValue(scopes);
    libraryScopeArtistDetailMock.mockResolvedValue({
      artist: { id: 'artist-1', name: 'Artist', albumCount: 1, serverId: 'srv-1' },
      albums: [{ id: 'own-1', name: 'Own', artist: 'Artist', artistId: 'artist-1', serverId: 'srv-1' }],
      appearsOnAlbums: [{ id: 'feat-1', name: 'A Comp', artist: 'Various Artists', artistId: 'va', serverId: 'srv-1' }],
      tracks: [],
    });

    const load = await loadArtistFromLibraryIndex('srv-1', 'artist-1');

    // The split must survive the loader so the artist page can render it offline —
    // own in `albums`, appears-on in `appearsOnAlbums`, not merged (finding 3).
    expect(load?.albums.map(a => a.id)).toEqual(['own-1']);
    expect(load?.appearsOnAlbums.map(a => a.id)).toEqual(['feat-1']);
  });

  it('deduplicates album lookup and skips its unused total', async () => {
    libraryGetTracksByAlbumMock.mockResolvedValue([
      { id: 'track-1', title: 'Track', album: 'Album', artistId: 'artist-1', serverId: 'srv-1' },
    ]);
    libraryAdvancedSearchMock.mockResolvedValue({
      albums: [{ id: 'album-1', name: 'Album', artistId: 'artist-1', serverId: 'srv-1' }],
    });

    const [first, second] = await Promise.all([
      loadAlbumFromLibraryIndex('srv-1', 'album-1'),
      loadAlbumFromLibraryIndex('srv-1', 'album-1'),
    ]);

    expect(libraryGetTracksByAlbumMock).toHaveBeenCalledOnce();
    expect(libraryAdvancedSearchMock).toHaveBeenCalledWith({
      serverId: 'srv-1',
      entityTypes: ['album'],
      restrictAlbumIds: ['album-1'],
      limit: 1,
      skipTotals: true,
    });
    expect(first).toEqual(second);
  });

  it('skips totals on the legacy all-library fallback', async () => {
    libraryScopePairsForServerMock.mockReturnValue([]);
    libraryScopeForServerMock.mockReturnValue(null);
    libraryAdvancedSearchMock.mockResolvedValue({ artists: [], albums: [] });

    await expect(loadArtistFromLibraryIndex('srv-1', 'artist-1')).resolves.toBeNull();

    expect(libraryAdvancedSearchMock).toHaveBeenCalledWith({
      serverId: 'srv-1',
      entityTypes: ['album', 'artist'],
      limit: 10_000,
      skipTotals: true,
    });
  });

  it('loads scoped artist tracks once instead of querying each album', async () => {
    const scopes = [{ serverId: 'srv-1', libraryId: 'lib-1' }];
    libraryScopePairsForServerMock.mockReturnValue(scopes);
    libraryScopeArtistDetailMock.mockResolvedValue({
      artist: { id: 'artist-1', name: 'Artist', albumCount: 1, serverId: 'srv-1' },
      albums: [],
      appearsOnAlbums: [],
      tracks: [{ id: 'track-1', title: 'Track', serverId: 'srv-1', syncedAt: 0, rawJson: {} }],
    });

    const [first, second] = await Promise.all([
      loadArtistTracksFromLibraryIndex('srv-1', 'artist-1'),
      loadArtistTracksFromLibraryIndex('srv-1', 'artist-1'),
    ]);

    expect(libraryScopeArtistDetailMock).toHaveBeenCalledOnce();
    expect(libraryScopeArtistDetailMock).toHaveBeenCalledWith('srv-1', {
      scopes,
      artistId: 'artist-1',
      serverId: 'srv-1',
      includeTracks: true,
    });
    expect(first).toEqual(second);
    expect(first?.map(track => track.id)).toEqual(['track-1']);
  });
});
