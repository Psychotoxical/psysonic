import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import TracksPageChrome from '@/features/search/components/TracksPageChrome';

const mocks = vi.hoisted(() => ({
  ndListSongs: vi.fn(),
  ndInvalidateSongsCache: vi.fn(),
  shuffleArray: vi.fn(),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getRandomSongs: vi.fn(async () => []),
}));

vi.mock('@/lib/api/navidromeBrowse', () => ({
  ndListSongs: mocks.ndListSongs,
  ndInvalidateSongsCache: mocks.ndInvalidateSongsCache,
}));

vi.mock('@/lib/util/shuffleArray', () => ({
  shuffleArray: mocks.shuffleArray,
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (state: { activeServerId: string }) => unknown) =>
    selector({ activeServerId: 'server-1' }),
}));

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: (selector: (state: { enqueue: () => void }) => unknown) =>
    selector({ enqueue: vi.fn() }),
}));

vi.mock('@/lib/perf/perfFlags', () => ({
  usePerfProbeFlags: () => ({
    disableMainstageStickyHeader: false,
    disableMainstageHero: false,
    disableMainstageRails: false,
  }),
}));

vi.mock('@/features/album', () => ({ useNavigateToAlbum: () => vi.fn() }));
vi.mock('@/features/artist', () => ({ useNavigateToArtist: () => vi.fn() }));
vi.mock('@/cover/AlbumCoverArtImage', () => ({ AlbumCoverArtImage: () => null }));
vi.mock('@/ui/ResolvedArtistRefInline', () => ({ ResolvedArtistRefInline: () => null }));

vi.mock('@/features/home', async () => {
  const React = await import('react');
  return {
    SongRail: ({
      title,
      songs,
      onReroll,
      loading,
    }: {
      title: string;
      songs: SubsonicSong[];
      onReroll?: () => void | Promise<void>;
      loading?: boolean;
    }) => React.createElement(
      'section',
      null,
      React.createElement('h2', null, title),
      onReroll && React.createElement(
        'button',
        { 'aria-label': `Reroll ${title}`, disabled: loading, onClick: onReroll },
        'Reroll',
      ),
      React.createElement(
        'ul',
        { 'aria-label': `${title} songs` },
        songs.map(song => React.createElement('li', { key: song.id }, song.id)),
      ),
    ),
  };
});

function ratedSong(index: number): SubsonicSong {
  return {
    id: `song-${index}`,
    title: `Song ${index}`,
    artist: 'Artist',
    album: 'Album',
    albumId: 'album-1',
    duration: 180,
    userRating: index <= 40 ? 5 : 4,
  };
}

function visibleSongIds(list: HTMLElement): string[] {
  return Array.from(list.querySelectorAll('li'), item => item.textContent ?? '');
}

describe('TracksPageChrome Highly Rated rail', () => {
  beforeEach(() => {
    mocks.ndListSongs.mockReset();
    mocks.ndInvalidateSongsCache.mockReset();
    mocks.shuffleArray.mockReset();
  });

  it('rerolls the cached candidates while keeping higher ratings first', async () => {
    const songs = Array.from({ length: 60 }, (_, index) => ratedSong(index + 1));
    mocks.ndListSongs.mockResolvedValue(songs);
    mocks.shuffleArray
      .mockImplementationOnce((items: SubsonicSong[]) => [...items])
      .mockImplementationOnce((items: SubsonicSong[]) => [...items].reverse());

    const user = userEvent.setup();
    renderWithProviders(<TracksPageChrome />);

    const list = await screen.findByRole('list', { name: 'Highly Rated songs' });
    await waitFor(() => expect(visibleSongIds(list)).toEqual(
      Array.from({ length: 30 }, (_, index) => `song-${index + 1}`),
    ));

    await user.click(screen.getByRole('button', { name: 'Reroll Highly Rated' }));

    await waitFor(() => expect(visibleSongIds(list)).toEqual(
      Array.from({ length: 30 }, (_, index) => `song-${40 - index}`),
    ));
    expect(mocks.ndInvalidateSongsCache).not.toHaveBeenCalled();
    expect(mocks.ndListSongs).toHaveBeenLastCalledWith(0, 60, 'rating', 'DESC', 60_000);
  });
});
