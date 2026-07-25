import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

const resolveArtistIds = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@/generated/bindings', () => ({
  commands: { libraryResolveArtistIds: resolveArtistIds },
}));
vi.mock('@/lib/api/coverCache', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api/coverCache')>()),
  librarySqlServerId: (id: string) => id,
}));
vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

import { __resetArtistIdResolveCacheForTests } from '@/lib/library/artistIdResolve';
import { PlaylistArtistCell } from '@/features/playlist/components/PlaylistArtistCell';

function song(overrides: Partial<SubsonicSong>): SubsonicSong {
  return {
    id: 's1', title: 'Track', artist: 'A', album: 'Alb', albumId: 'al1', duration: 100,
    ...overrides,
  } as SubsonicSong;
}

describe('PlaylistArtistCell', () => {
  beforeEach(() => {
    __resetArtistIdResolveCacheForTests();
    resolveArtistIds.mockReset();
    resolveArtistIds.mockResolvedValue({ status: 'ok', data: [] });
    navigate.mockReset();
  });

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

  // Playlist rows are one of the non-album track surfaces: they use the same split
  // helper, so a guest there has to become linkable the same way it does on the album
  // page — and be reachable without a mouse.
  it('links and keyboard-activates a guest split out of a joined credit', async () => {
    resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-guest'] });
    renderWithProviders(
      <PlaylistArtistCell song={song({
        artist: 'Primary feat. Guest', artistId: 'a1', serverId: 'srv-owner',
      })} />,
    );

    await waitFor(() => expect(resolveArtistIds).toHaveBeenCalledWith('srv-owner', ['Guest']));
    const guest = await screen.findByRole('link', { name: 'Guest' });
    expect(guest).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(guest, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/artist/ar-guest?server=srv-owner');

    navigate.mockClear();
    fireEvent.keyDown(guest, { key: ' ' });
    expect(navigate).toHaveBeenCalledWith('/artist/ar-guest?server=srv-owner');
  });
});
