import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { latestIntersectionObserver } from '@/test/mocks/browser';

const hoisted = vi.hoisted(() => ({
  fetchGenreAlbumPage: vi.fn(),
}));

vi.mock('@/lib/library/genreAlbumBrowse', () => ({
  fetchGenreAlbumPage: hoisted.fetchGenreAlbumPage,
  GENRE_ALBUM_CATALOG_CHUNK: 200,
  GENRE_ALBUM_FIRST_PAGE: 60,
}));

import { useGenreAlbumBrowse } from './useGenreAlbumBrowse';

const browseScope = {
  anchorServerId: 'srv-1',
  serverIds: ['srv-1', 'srv-2'],
  pairs: [
    { serverId: 'srv-1', libraryId: null },
    { serverId: 'srv-2', libraryId: null },
  ],
  fingerprint: 'scope',
  multiServer: true,
};

function albums(offset: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `album-${offset + index}`,
    name: `Album ${offset + index}`,
    artist: 'Artist',
    artistId: 'artist-1',
    songCount: 1,
    duration: 60,
  }));
}

describe('useGenreAlbumBrowse', () => {
  beforeEach(() => {
    hoisted.fetchGenreAlbumPage.mockReset();
  });

  it('continues draining pages while the sentinel stays intersecting', async () => {
    hoisted.fetchGenreAlbumPage
      .mockResolvedValueOnce({ albums: albums(0, 60), hasMore: true })
      .mockResolvedValueOnce({ albums: albums(60, 200), hasMore: false });
    const scrollRoot = document.createElement('div');
    const { result } = renderHook(() => useGenreAlbumBrowse(
      'srv-1',
      'Rock',
      true,
      'alphabeticalByName',
      0,
      browseScope,
      () => scrollRoot,
      scrollRoot,
    ));

    await waitFor(() => expect(result.current.displayAlbums).toHaveLength(60));

    act(() => {
      result.current.bindLoadMoreSentinel(document.createElement('div'));
      latestIntersectionObserver()?.emit(true);
    });

    await waitFor(() => expect(hoisted.fetchGenreAlbumPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.displayAlbums.length).toBeGreaterThan(60));
    expect(hoisted.fetchGenreAlbumPage).toHaveBeenLastCalledWith(
      'srv-1',
      'Rock',
      true,
      60,
      200,
      'alphabeticalByName',
      browseScope,
    );
  });
});
