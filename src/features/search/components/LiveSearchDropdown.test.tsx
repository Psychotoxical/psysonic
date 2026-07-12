import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import LiveSearchDropdown from '@/features/search/components/LiveSearchDropdown';
import type { useShareSearch } from '@/features/search/hooks/useShareSearch';
import type { SearchResults } from '@/lib/api/subsonicTypes';

vi.mock('@/store/liveSearchScopeStore', () => ({
  useLiveSearchScopeStore: (selector: (s: { query: string; setQuery: () => void }) => unknown) =>
    selector({ query: 'beatles', setQuery: vi.fn() }),
}));

vi.mock('react-router-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock('@/features/album', () => ({
  useNavigateToAlbum: () => vi.fn(),
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
});
