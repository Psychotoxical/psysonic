import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import userEvent from '@testing-library/user-event';
import LiveSearchDropdown from '@/features/search/components/LiveSearchDropdown';
import type { useShareSearch } from '@/features/search/hooks/useShareSearch';
import type { SearchResults } from '@/lib/api/subsonicTypes';

const { navigateToAlbumMock } = vi.hoisted(() => ({
  navigateToAlbumMock: vi.fn(),
}));

vi.mock('@/store/liveSearchScopeStore', () => ({
  useLiveSearchScopeStore: (selector: (s: { query: string; setQuery: () => void }) => unknown) =>
    selector({ query: 'beatles', setQuery: vi.fn() }),
}));

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock('@/features/album', () => ({
  useNavigateToAlbum: () => navigateToAlbumMock,
  albumArtistDisplayName: (album: { artist?: string }) => album.artist ?? '',
}));

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      enqueue: vi.fn(),
      openContextMenu: vi.fn(),
      contextMenu: { isOpen: false, item: null, type: null },
    }),
}));

vi.mock('@/features/search/components/liveSearchResultThumbs', () => ({
  LiveSearchArtistThumb: () => null,
  LiveSearchAlbumThumb: () => null,
  LiveSearchSongThumb: () => null,
}));

const shareStub = {
  shareMatch: null,
  shareServerLabel: '',
  shareCoverServer: null,
  shareQueueBusy: false,
  enqueueShareMatch: vi.fn(),
  openShareAlbum: vi.fn(),
  openShareArtist: vi.fn(),
  openShareComposer: vi.fn(),
  shareTrackSong: null,
  shareTrackResolving: false,
  shareTrackUnavailable: false,
  shareAlbum: null,
  shareAlbumResolving: false,
  shareAlbumUnavailable: false,
  shareArtist: null,
  shareArtistResolving: false,
  shareArtistUnavailable: false,
  shareComposer: null,
  shareComposerResolving: false,
  shareComposerUnavailable: false,
  canQueueShareMatch: false,
  canPlayNavidromePublic: false,
  canOpenShareAlbum: false,
  canOpenShareArtist: false,
  canOpenShareComposer: false,
  hasShareKeyboardTarget: false,
  playNavidromePublic: vi.fn(),
  navidromeShareInfo: null,
  navidromeShareResolving: false,
  navidromeShareError: null,
} as ReturnType<typeof useShareSearch>;

const results: SearchResults = {
  artists: [{ id: 'a1', name: 'Artist' }],
  albums: [],
  songs: [],
};

describe('LiveSearchDropdown index incomplete banner', () => {
  it('shows the banner while the index is incomplete', () => {
    renderWithProviders(
      <LiveSearchDropdown
        dropdownRef={{ current: null }}
        results={results}
        searchSource="local"
        activeIndex={-1}
        loading={false}
        indexIncomplete
        share={shareStub}
        setOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Index still building — results may be incomplete',
    );
  });

  it('hides the banner when the index is ready', () => {
    renderWithProviders(
      <LiveSearchDropdown
        dropdownRef={{ current: null }}
        results={results}
        searchSource="local"
        activeIndex={-1}
        loading={false}
        indexIncomplete={false}
        share={shareStub}
        setOpen={vi.fn()}
      />,
    );

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('preserves the album owner when opening a local result', async () => {
    navigateToAlbumMock.mockReset();
    const user = userEvent.setup();
    renderWithProviders(
      <LiveSearchDropdown
        dropdownRef={{ current: null }}
        results={{
          artists: [],
          albums: [{
            serverId: 'srv-b',
            id: 'album-1',
            name: 'Owned Album',
            artist: 'Artist',
            artistId: 'artist-1',
            songCount: 1,
            duration: 60,
            coverArt: 'cover-1',
          }],
          songs: [],
        }}
        searchSource="local"
        activeIndex={-1}
        loading={false}
        indexIncomplete={false}
        share={shareStub}
        setOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('option', { name: /Owned Album/i }));

    expect(navigateToAlbumMock).toHaveBeenCalledWith('album-1', { serverId: 'srv-b' });
  });
});
