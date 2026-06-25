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
    songs: [] as SubsonicSong[],
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

const albumInfo = (over: Record<string, unknown> = {}) => ({
  id: 'al1', name: 'Album', artist: 'Artist', artistId: 'a1', ...over,
});

describe('AlbumHeader genres', () => {
  it('shows the primary genre inline and the rest in a cursor menu', async () => {
    navigate.mockClear();
    const user = userEvent.setup();
    renderWithProviders(
      <AlbumHeader
        {...baseProps()}
        info={albumInfo({ genres: [{ name: 'Power Metal' }, { name: 'Rock' }] })}
      />,
    );

    // Primary genre is a link; the extra genre stays hidden until the menu opens.
    expect(screen.getByRole('button', { name: 'More albums in Power Metal' })).toBeInTheDocument();
    expect(screen.queryByText('Rock')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show all genres' }));

    // The menu lists only the remaining genres — the primary is not repeated.
    expect(screen.getAllByText('Power Metal')).toHaveLength(1);
    const rock = screen.getByText('Rock');
    await user.click(rock);
    expect(navigate).toHaveBeenCalledWith('/genres/Rock', { state: { returnTo: '/album/al1' } });
  });

  it('unions track-level genres after the album genres', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AlbumHeader
        {...baseProps()}
        songs={[{ id: 't1', duration: 100, genres: [{ name: 'Heavy Metal' }] } as unknown as SubsonicSong]}
        info={albumInfo({ genres: [{ name: 'Power Metal' }] })}
      />,
    );

    // Album has one genre, the track adds another → +1 chip, extra genre in the menu.
    await user.click(screen.getByRole('button', { name: 'Show all genres' }));
    expect(screen.getByText('Heavy Metal')).toBeInTheDocument();
  });

  it('shows no +N control for a single genre', () => {
    renderWithProviders(
      <AlbumHeader {...baseProps()} info={albumInfo({ genres: [{ name: 'Power Metal' }] })} />,
    );
    expect(screen.getByRole('button', { name: 'More albums in Power Metal' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all genres' })).not.toBeInTheDocument();
  });

  it('falls back to splitting the legacy genre string', () => {
    renderWithProviders(
      <AlbumHeader {...baseProps()} info={albumInfo({ genre: 'Rock; Metal' })} />,
    );
    expect(screen.getByRole('button', { name: 'More albums in Rock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show all genres' })).toBeInTheDocument();
  });
});
