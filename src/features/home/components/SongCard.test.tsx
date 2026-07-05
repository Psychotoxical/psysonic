import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import SongCard from '@/features/home/components/SongCard';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

const navigateToArtist = vi.fn();

// Only navigate-to-artist is stubbed; mock that submodule directly so the
// barrel re-exports the stub while coerceOpenArtistRefs (used by
// trackArtistRefs, a different submodule) stays real.
vi.mock('@/features/artist/hooks/useNavigateToArtist', () => ({
  useNavigateToArtist: () => navigateToArtist,
}));

vi.mock('@/cover/useLibraryCoverRef', () => ({
  useTrackCoverRef: () => undefined,
}));

function song(overrides: Partial<SubsonicSong>): SubsonicSong {
  return {
    id: 's1', title: 'Track', artist: 'A', album: 'Alb', albumId: 'al1', duration: 100,
    ...overrides,
  } as SubsonicSong;
}

describe('SongCard', () => {
  it('splits OpenSubsonic artists into individual links', async () => {
    navigateToArtist.mockClear();
    const user = userEvent.setup();
    renderWithProviders(
      <SongCard
        disableArtwork
        song={song({
          artist: 'Apocalyptica', artistId: 'a1',
          artists: [{ id: 'a1', name: 'Apocalyptica' }, { id: 'a2', name: 'Joe Duplantier' }],
        })}
      />,
    );
    expect(screen.getByText('Apocalyptica')).toHaveClass('track-artist-link');
    expect(screen.getByText('Joe Duplantier')).toHaveClass('track-artist-link');
    await user.click(screen.getByText('Joe Duplantier'));
    expect(navigateToArtist).toHaveBeenCalledWith('a2');
  });
});
