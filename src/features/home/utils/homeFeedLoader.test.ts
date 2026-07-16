import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getArtists } from '@/lib/api/subsonicArtists';
import { getAlbumList, getRandomSongs } from '@/lib/api/subsonicLibrary';
import {
  libraryAdvancedSearch,
  libraryScopeListArtists,
  libraryScopeMostPlayedAlbums,
} from '@/lib/api/library';
import { runLocalRandomAlbums } from '@/lib/library/browseTextSearch';
import { runLocalRandomSongs } from '@/lib/library/randomScopeReads';
import { appendHomeAlbumPage, loadHomeAlbumPage, loadHomeFeed, type HomeFeedScope } from './homeFeedLoader';

vi.mock('@/lib/api/subsonicArtists');
vi.mock('@/lib/api/subsonicLibrary');
vi.mock('@/lib/api/library');
vi.mock('@/lib/library/browseTextSearch');
vi.mock('@/lib/library/randomScopeReads');
vi.mock('@/features/playback/utils/mixRatingFilter', () => ({
  getMixMinRatingsConfigFromAuth: () => ({ enabled: false, minSong: 0, minAlbum: 0, minArtist: 0 }),
  filterAlbumsByMixRatings: async (albums: unknown[]) => albums,
}));

const multiScope: HomeFeedScope = {
  activeServerId: 'offline-active',
  browseServerId: 'online-selected',
  pairs: [{ serverId: 'online-selected', libraryId: 'music' }],
  fingerprint: '[["online-selected","music"]]',
  multiServer: true,
  filterVersion: 3,
};

const albumDto = (serverId: string, id: string, name: string) => ({
  serverId,
  id,
  name,
  artist: `${name} Artist`,
  artistId: `${id}-artist`,
  songCount: 1,
  durationSec: 60,
  syncedAt: 1,
  rawJson: {},
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(libraryAdvancedSearch).mockResolvedValue({
    artists: [], albums: [], tracks: [], totals: { artists: 0, albums: 0, tracks: 0 }, appliedFilters: [], source: 'local',
  });
  vi.mocked(libraryScopeListArtists).mockResolvedValue([]);
  vi.mocked(libraryScopeMostPlayedAlbums).mockResolvedValue([]);
  vi.mocked(runLocalRandomAlbums).mockResolvedValue([]);
  vi.mocked(runLocalRandomSongs).mockResolvedValue([]);
});

describe('homeFeedLoader multi-server contract', () => {
  it('uses the reachable browse anchor and local merged readers without active-server network fallback', async () => {
    vi.mocked(libraryAdvancedSearch)
      .mockResolvedValueOnce({
        artists: [], albums: [albumDto('online-selected', 'starred', 'Starred')], tracks: [],
        totals: { artists: 0, albums: 1, tracks: 0 }, appliedFilters: ['starred'], source: 'local',
      })
      .mockResolvedValueOnce({
        artists: [], albums: [albumDto('online-selected', 'newest', 'Newest')], tracks: [],
        totals: { artists: 0, albums: 1, tracks: 0 }, appliedFilters: [], source: 'local',
      });
    vi.mocked(runLocalRandomAlbums).mockResolvedValue([
      { id: 'random', name: 'Random', artist: 'Artist', artistId: 'artist', songCount: 1, duration: 60, serverId: 'online-selected' },
    ]);
    vi.mocked(libraryScopeMostPlayedAlbums).mockResolvedValue([{
      album: albumDto('online-selected', 'frequent', 'Frequent'), playCount: 8,
    }]);
    vi.mocked(libraryScopeListArtists).mockResolvedValue([{
      serverId: 'online-selected', id: 'artist', name: 'Artist', syncedAt: 1, rawJson: {},
    }]);
    vi.mocked(runLocalRandomSongs).mockResolvedValue([{
      id: 'song', title: 'Song', artist: 'Artist', album: 'Album', albumId: 'album', duration: 60, serverId: 'online-selected',
    }]);

    const feed = await loadHomeFeed(multiScope, { discoverArtists: true, discoverSongs: true });

    expect(feed.scopeFingerprint).toBe(multiScope.fingerprint);
    expect(feed.starred[0]?.serverId).toBe('online-selected');
    expect(feed.recent[0]?.serverId).toBe('online-selected');
    expect(feed.mostPlayed[0]).toMatchObject({ serverId: 'online-selected', playCount: 8 });
    expect(feed.randomArtists[0]?.serverId).toBe('online-selected');
    expect(feed.discoverSongs[0]?.serverId).toBe('online-selected');
    expect(feed.recentlyPlayed).toEqual([]);
    expect(getAlbumList).not.toHaveBeenCalled();
    expect(getArtists).not.toHaveBeenCalled();
    expect(getRandomSongs).not.toHaveBeenCalled();
    expect(libraryAdvancedSearch).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'online-selected',
      libraryScopes: multiScope.pairs,
    }));
  });

  it('never falls back to active-server random network data when the merged index is unavailable', async () => {
    vi.mocked(runLocalRandomAlbums).mockResolvedValue(null);

    expect(await loadHomeAlbumPage(multiScope, 'random', 12)).toEqual([]);
    expect(getAlbumList).not.toHaveBeenCalled();
  });

  it('keeps same raw ids from different servers as distinct composite entities', async () => {
    vi.mocked(libraryScopeMostPlayedAlbums).mockResolvedValue([
      { album: albumDto('server-a', 'same', 'Album A'), playCount: 9 },
      { album: albumDto('server-b', 'same', 'Album B'), playCount: 7 },
    ]);

    const page = await loadHomeAlbumPage(multiScope, 'frequent', 0);

    expect(page).toHaveLength(2);
    expect(page.map(album => `${album.serverId}:${album.id}`)).toEqual(['server-a:same', 'server-b:same']);
  });

  it('preserves single-server network behavior and stamps provenance', async () => {
    const singleScope = { ...multiScope, activeServerId: 'single', browseServerId: 'single', pairs: [], fingerprint: 'single', multiServer: false };
    vi.mocked(getAlbumList).mockResolvedValue([
      { id: 'same-id', name: 'Album', artist: 'Artist', artistId: 'artist', songCount: 1, duration: 60 },
    ]);

    const page = await loadHomeAlbumPage(singleScope, 'newest', 0);

    expect(getAlbumList).toHaveBeenCalledWith('newest', 12, 0);
    expect(page).toEqual([expect.objectContaining({ id: 'same-id', serverId: 'single' })]);
    expect(libraryAdvancedSearch).not.toHaveBeenCalled();
  });

  it('drops stale load-more results after the scope fingerprint changes', () => {
    const current = [{
      id: 'one', name: 'One', artist: 'Artist', artistId: 'artist', songCount: 1, duration: 60, serverId: 'server-a',
    }];
    const staleBatch = [{
      id: 'two', name: 'Two', artist: 'Artist', artistId: 'artist', songCount: 1, duration: 60, serverId: 'server-b',
    }];

    expect(appendHomeAlbumPage(current, staleBatch, 'scope-a', 'scope-b')).toBe(current);
    expect(appendHomeAlbumPage(current, staleBatch, 'scope-a', 'scope-a')).toHaveLength(2);
  });
});
