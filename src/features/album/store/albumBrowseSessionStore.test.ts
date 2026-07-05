import { describe, expect, it, beforeEach } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import {
  DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
  DEFAULT_ALBUM_BROWSE_SORT,
  albumBrowseSortForServer,
  albumBrowseSurfaceForPath,
  clearGenreDetailReturnStash,
  isAlbumDetailPath,
  isAlbumsBrowsePath,
  isNewReleasesBrowsePath,
  isGenreDetailPath,
  genreDetailGenreFromPath,
  peekAlbumBrowseScrollRestore,
  peekGenreDetailReturnStash,
  peekGenreDetailScrollRestore,
  stashGenreDetailReturnFilters,
  useAlbumBrowseSessionStore,
} from '@/features/album/store/albumBrowseSessionStore';

describe('albumBrowseSessionStore', () => {
  beforeEach(() => {
    useAlbumBrowseSessionStore.setState({ sortByServer: {}, returnStashByKey: {} });
  });

  it('keeps sort per server for the session', () => {
    const { setSort } = useAlbumBrowseSessionStore.getState();
    setSort('srv-a', 'alphabeticalByArtist');
    setSort('srv-b', 'alphabeticalByName');

    const { sortByServer } = useAlbumBrowseSessionStore.getState();
    expect(albumBrowseSortForServer(sortByServer, 'srv-a')).toBe('alphabeticalByArtist');
    expect(albumBrowseSortForServer(sortByServer, 'srv-b')).toBe('alphabeticalByName');
  });

  it('stashes and peeks return filters with scroll snapshot per surface', () => {
    const { stashReturnFilters, peekReturnStash } = useAlbumBrowseSessionStore.getState();
    stashReturnFilters('srv-a', 'albums', {
      ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
      selectedGenres: ['Rock'],
      yearFrom: '1990',
      yearTo: '2000',
      starredOnly: true,
      scrollTop: 840,
      displayCount: 120,
    });

    expect(peekReturnStash('srv-a', 'albums')).toEqual({
      selectedGenres: ['Rock'],
      yearFrom: '1990',
      yearTo: '2000',
      compFilter: 'all',
      starredOnly: true,
      losslessOnly: false,
      scrollTop: 840,
      displayCount: 120,
    });
    expect(peekReturnStash('srv-a', 'new-releases')).toBeNull();
  });

  it('peeks scroll restore target for a surface', () => {
    const { stashReturnFilters } = useAlbumBrowseSessionStore.getState();
    stashReturnFilters('srv-a', 'new-releases', {
      ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
      scrollTop: 420,
      displayCount: 180,
    });
    expect(peekAlbumBrowseScrollRestore('srv-a', 'new-releases')).toEqual({
      scrollTop: 420,
      displayCount: 180,
    });
    expect(peekAlbumBrowseScrollRestore('srv-b', 'new-releases')).toBeNull();
  });

  it('stashes cached album rows for grid surfaces', () => {
    const albums = [{ id: 'a1', name: 'A', artist: 'X', artistId: 'x' }] as SubsonicAlbum[];
    const { stashReturnFilters, peekReturnStash } = useAlbumBrowseSessionStore.getState();
    stashReturnFilters('srv-a', 'random-albums', {
      ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
      selectedGenres: ['Jazz'],
      albums,
      hasMore: false,
      scrollTop: 100,
      displayCount: 1,
    });
    expect(peekReturnStash('srv-a', 'random-albums')?.albums).toEqual(albums);
  });

  it('clears return stash for a surface only', () => {
    const { stashReturnFilters, clearReturnStash, peekReturnStash } = useAlbumBrowseSessionStore.getState();
    stashReturnFilters('srv-a', 'albums', {
      ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
      selectedGenres: ['Jazz'],
    });
    stashReturnFilters('srv-a', 'new-releases', {
      ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
      selectedGenres: ['Rock'],
    });
    clearReturnStash('srv-a', 'albums');
    expect(peekReturnStash('srv-a', 'albums')).toBeNull();
    expect(peekReturnStash('srv-a', 'new-releases')?.selectedGenres).toEqual(['Rock']);
  });

  it('defaults sort when server has no entry', () => {
    const { sortByServer } = useAlbumBrowseSessionStore.getState();
    expect(albumBrowseSortForServer(sortByServer, 'unknown')).toBe(DEFAULT_ALBUM_BROWSE_SORT);
  });

  it('stashes genre detail leave snapshot separately from album grid surfaces', () => {
    stashGenreDetailReturnFilters('srv-a', 'Rock', {
      ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
      selectedGenres: ['Rock'],
      scrollTop: 640,
      displayCount: 90,
    });
    expect(peekGenreDetailReturnStash('srv-a', 'Rock')?.scrollTop).toBe(640);
    expect(peekGenreDetailScrollRestore('srv-a', 'Rock')).toEqual({
      scrollTop: 640,
      displayCount: 90,
    });
    clearGenreDetailReturnStash('srv-a', 'Rock');
    expect(peekGenreDetailReturnStash('srv-a', 'Rock')).toBeNull();
  });
});

describe('isAlbumDetailPath', () => {
  it('matches album detail routes only', () => {
    expect(isAlbumDetailPath('/album/abc')).toBe(true);
    expect(isAlbumDetailPath('/album/abc/')).toBe(true);
    expect(isAlbumDetailPath('/albums')).toBe(false);
    expect(isAlbumDetailPath('/artist/abc')).toBe(false);
    expect(isAlbumDetailPath('/album/abc/tracks')).toBe(false);
  });
});

describe('isGenreDetailPath', () => {
  it('matches single genre detail routes only', () => {
    expect(isGenreDetailPath('/genres/Rock')).toBe(true);
    expect(isGenreDetailPath('/genres/Rock%20%26%20Roll')).toBe(true);
    expect(isGenreDetailPath('/genres')).toBe(false);
    expect(isGenreDetailPath('/genres/Rock/albums')).toBe(false);
    expect(genreDetailGenreFromPath('/genres/Rock%20%26%20Roll')).toBe('Rock & Roll');
  });
});

describe('albumBrowseSurfaceForPath', () => {
  it('maps album grid browse routes', () => {
    expect(albumBrowseSurfaceForPath('/albums')).toBe('albums');
    expect(isAlbumsBrowsePath('/albums')).toBe(true);
    expect(isAlbumsBrowsePath('/albums/')).toBe(true);
    expect(isAlbumsBrowsePath('/new-releases')).toBe(false);
    expect(isNewReleasesBrowsePath('/new-releases')).toBe(true);
    expect(isNewReleasesBrowsePath('/new-releases/')).toBe(true);
    expect(albumBrowseSurfaceForPath('/new-releases')).toBe('new-releases');
    expect(albumBrowseSurfaceForPath('/random/albums')).toBe('random-albums');
    expect(albumBrowseSurfaceForPath('/artists')).toBeNull();
  });
});
