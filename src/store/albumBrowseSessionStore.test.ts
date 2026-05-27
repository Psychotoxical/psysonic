import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_ALBUM_BROWSE_SORT,
  albumBrowseGenresForServer,
  albumBrowseSortForServer,
  useAlbumBrowseSessionStore,
} from './albumBrowseSessionStore';

describe('albumBrowseSessionStore', () => {
  beforeEach(() => {
    useAlbumBrowseSessionStore.setState({ byServer: {} });
  });

  it('keeps sort and genre filter for a server across updates', () => {
    const { setSort, setSelectedGenres } = useAlbumBrowseSessionStore.getState();
    setSort('srv-a', 'alphabeticalByArtist');
    setSelectedGenres('srv-a', ['Rock', 'Jazz']);

    const { byServer } = useAlbumBrowseSessionStore.getState();
    expect(albumBrowseSortForServer(byServer, 'srv-a')).toBe('alphabeticalByArtist');
    expect(albumBrowseGenresForServer(byServer, 'srv-a')).toEqual(['Rock', 'Jazz']);
  });

  it('scopes browse state per server', () => {
    const { setSort, setSelectedGenres } = useAlbumBrowseSessionStore.getState();
    setSort('srv-a', 'alphabeticalByArtist');
    setSelectedGenres('srv-a', ['Rock']);
    setSort('srv-b', 'alphabeticalByName');
    setSelectedGenres('srv-b', ['Classical']);

    const { byServer } = useAlbumBrowseSessionStore.getState();
    expect(albumBrowseSortForServer(byServer, 'srv-a')).toBe('alphabeticalByArtist');
    expect(albumBrowseGenresForServer(byServer, 'srv-a')).toEqual(['Rock']);
    expect(albumBrowseSortForServer(byServer, 'srv-b')).toBe('alphabeticalByName');
    expect(albumBrowseGenresForServer(byServer, 'srv-b')).toEqual(['Classical']);
  });

  it('updates sort without clearing genres', () => {
    const { setSort, setSelectedGenres } = useAlbumBrowseSessionStore.getState();
    setSelectedGenres('srv-a', ['Ambient']);
    setSort('srv-a', 'alphabeticalByArtist');

    const { byServer } = useAlbumBrowseSessionStore.getState();
    expect(albumBrowseSortForServer(byServer, 'srv-a')).toBe('alphabeticalByArtist');
    expect(albumBrowseGenresForServer(byServer, 'srv-a')).toEqual(['Ambient']);
  });

  it('defaults when server has no entry', () => {
    const { byServer } = useAlbumBrowseSessionStore.getState();
    expect(albumBrowseSortForServer(byServer, 'unknown')).toBe(DEFAULT_ALBUM_BROWSE_SORT);
    expect(albumBrowseGenresForServer(byServer, 'unknown')).toEqual([]);
  });
});
