import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { PlaylistArtistCell } from '@/features/playlist/components/PlaylistArtistCell';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

function song(overrides: Partial<SubsonicSong>): SubsonicSong {
  return {
    id: 's1', title: 'Track', artist: 'A', album: 'Alb', albumId: 'al1', duration: 100,
    ...overrides,
  } as SubsonicSong;
}

describe('PlaylistArtistCell', () => {
  it('splits the OpenSubsonic artists array into individual links', () => {
    renderWithProviders(
      <PlaylistArtistCell song={song({
        artist: 'Apocalyptica', artistId: 'a1',
        artists: [{ id: 'a1', name: 'Apocalyptica' }, { id: 'a2', name: 'Joe Duplantier' }],
      })} />,
    );
    expect(screen.getByText('Apocalyptica')).toHaveClass('track-artist-link');
    expect(screen.getByText('Joe Duplantier')).toHaveClass('track-artist-link');
  });

  it('falls back to the legacy artist string when no structured array exists', () => {
    renderWithProviders(
      <PlaylistArtistCell song={song({ artist: 'Gathering Of Kings', artistId: 'a1' })} />,
    );
    expect(screen.getByText('Gathering Of Kings')).toHaveClass('track-artist-link');
  });

  it('renders a non-navigable name when the ref has no id', () => {
    renderWithProviders(
      <PlaylistArtistCell song={song({ artist: 'Various Artists', artistId: '' })} />,
    );
    const el = screen.getByText('Various Artists');
    expect(el).not.toHaveClass('track-artist-link');
  });
});
