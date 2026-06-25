import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/helpers/renderWithProviders';
import AlbumHeader from './AlbumHeader';
import type { SubsonicSong } from '../api/subsonicTypes';

const navigate = vi.fn();

vi.mock('react-router-dom', async importActual => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

// Genre-unrelated dependencies — stub so the test stays focused on the meta row.
vi.mock('../cover/useLibraryCoverRef', () => ({ useAlbumCoverRef: () => undefined }));
vi.mock('../cover/lightbox', () => ({ useCoverLightboxSrc: () => ({ open: vi.fn(), lightbox: null }) }));
vi.mock('../hooks/useAlbumDetailBack', () => ({ useAlbumDetailBack: () => vi.fn() }));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../store/themeStore', () => ({ useThemeStore: () => false }));
vi.mock('./StarRating', () => ({ default: () => null }));
vi.mock('./OpenArtistRefInline', () => ({ OpenArtistRefInline: () => null }));
vi.mock('../cover/CoverArtImage', () => ({ CoverArtImage: () => null }));

function baseProps() {
  return {
    headerArtistRefs: [],
    songs: [{ id: 't1', duration: 100, suffix: 'mp3' } as SubsonicSong],
    resolvedCoverUrl: null,
    isStarred: false,
    downloadProgress: null,
    offlineStatus: 'none' as const,
    offlineProgress: null,
    bio: null,
    bioOpen: false,
    onToggleStar: vi.fn(),
    onDownload: vi.fn(),
    onCacheOffline: vi.fn(),
    onRemoveOffline: vi.fn(),
    onPlayAll: vi.fn(),
    onEnqueueAll: vi.fn(),
    onBio: vi.fn(),
    onCloseBio: vi.fn(),
    entityRatingValue: 0,
    onEntityRatingChange: vi.fn(),
    entityRatingSupport: 'unknown' as const,
  };
}

describe('AlbumHeader genres', () => {
  it('renders each OpenSubsonic genre as a clickable link and navigates with return state', async () => {
    navigate.mockClear();
    const user = userEvent.setup();
    renderWithProviders(
      <AlbumHeader
        {...baseProps()}
        info={{
          id: 'al1', name: 'Album', artist: 'Artist', artistId: 'a1',
          genres: [{ name: 'Power Metal' }, { name: 'Heavy Metal' }],
        }}
      />,
    );

    expect(screen.getByText('Power Metal')).toHaveClass('album-detail-artist-link');
    expect(screen.getByText('Heavy Metal')).toHaveClass('album-detail-artist-link');

    await user.click(screen.getByText('Heavy Metal'));
    expect(navigate).toHaveBeenCalledWith('/genres/Heavy%20Metal', {
      state: { returnTo: '/album/al1' },
    });
  });

  it('falls back to splitting the legacy genre string when no genres[] array is present', () => {
    renderWithProviders(
      <AlbumHeader
        {...baseProps()}
        info={{ id: 'al2', name: 'Album', artist: 'Artist', artistId: 'a1', genre: 'Rock; Metal' }}
      />,
    );

    expect(screen.getByText('Rock')).toHaveClass('album-detail-artist-link');
    expect(screen.getByText('Metal')).toHaveClass('album-detail-artist-link');
  });
});
