import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
  DEFAULT_ALBUM_BROWSE_SORT,
  albumBrowseSortForServer,
  isAlbumDetailPath,
  useAlbumBrowseSessionStore,
} from './albumBrowseSessionStore';

describe('albumBrowseSessionStore', () => {
  beforeEach(() => {
    useAlbumBrowseSessionStore.setState({ sortByServer: {}, returnStashByServer: {} });
  });

  it('keeps sort per server for the session', () => {
    const { setSort } = useAlbumBrowseSessionStore.getState();
    setSort('srv-a', 'alphabeticalByArtist');
    setSort('srv-b', 'alphabeticalByName');

    const { sortByServer } = useAlbumBrowseSessionStore.getState();
    expect(albumBrowseSortForServer(sortByServer, 'srv-a')).toBe('alphabeticalByArtist');
    expect(albumBrowseSortForServer(sortByServer, 'srv-b')).toBe('alphabeticalByName');
  });

  it('stashes and peeks return filters', () => {
    const { stashReturnFilters, peekReturnStash } = useAlbumBrowseSessionStore.getState();
    stashReturnFilters('srv-a', {
      ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
      selectedGenres: ['Rock'],
      yearFrom: '1990',
      yearTo: '2000',
      starredOnly: true,
    });

    expect(peekReturnStash('srv-a')).toEqual({
      selectedGenres: ['Rock'],
      yearFrom: '1990',
      yearTo: '2000',
      compFilter: 'all',
      starredOnly: true,
      losslessOnly: false,
    });
    expect(peekReturnStash('srv-a')).not.toBeNull();
  });

  it('clears return stash', () => {
    const { stashReturnFilters, clearReturnStash, peekReturnStash } = useAlbumBrowseSessionStore.getState();
    stashReturnFilters('srv-a', {
      ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
      selectedGenres: ['Jazz'],
    });
    clearReturnStash('srv-a');
    expect(peekReturnStash('srv-a')).toBeNull();
  });

  it('defaults sort when server has no entry', () => {
    const { sortByServer } = useAlbumBrowseSessionStore.getState();
    expect(albumBrowseSortForServer(sortByServer, 'unknown')).toBe(DEFAULT_ALBUM_BROWSE_SORT);
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
