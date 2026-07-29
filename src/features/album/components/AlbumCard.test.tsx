import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

const startDrag = vi.hoisted(() => vi.fn());
const resolveArtistIds = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/dnd/DragDropContext', () => ({
  useDragDrop: () => ({ startDrag, payload: null, isDragging: false }),
}));
vi.mock('@/cover/useLibraryCoverRef', () => ({
  useAlbumCoverRef: () => null,
}));
vi.mock('@/generated/bindings', () => ({
  commands: { libraryResolveArtistIds: resolveArtistIds },
}));
vi.mock('@/lib/api/coverCache', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api/coverCache')>()),
  librarySqlServerId: (id: string) => id,
}));
vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));

import { __resetArtistIdResolveCacheForTests } from '@/lib/library/artistIdResolve';
import AlbumCard from './AlbumCard';

describe('AlbumCard', () => {
  beforeEach(() => {
    __resetArtistIdResolveCacheForTests();
    resolveArtistIds.mockReset();
    navigate.mockReset();
  });

  // The card credit is split ("A feat. B"), and only the primary name arrives with an
  // id — the guest is linkable only once its id is looked up. Cards and rails are the
  // surfaces where that split is most visible, so the resolution has to reach them.
  it('links a guest split out of a joined credit once its id resolves', async () => {
    resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-guest'] });
    const album: SubsonicAlbum = {
      id: 'album-1',
      name: 'Split Credit',
      artist: 'Primary feat. Guest',
      artistId: 'artist-primary',
      songCount: 1,
      duration: 100,
      serverId: 'srv-owner',
    };
    renderWithProviders(<AlbumCard album={album} disableArtwork />);

    await waitFor(() => expect(resolveArtistIds).toHaveBeenCalledWith('srv-owner', ['Guest']));
    const guest = await screen.findByRole('link', { name: 'Guest' });
    fireEvent.click(guest);
    expect(navigate).toHaveBeenCalledWith('/artist/ar-guest?server=srv-owner');
  });

  it('keeps a guest with no artist row as plain text', async () => {
    resolveArtistIds.mockResolvedValue({ status: 'ok', data: [null] });
    const album: SubsonicAlbum = {
      id: 'album-2',
      name: 'Unknown Guest',
      artist: 'Primary feat. Nobody',
      artistId: 'artist-primary',
      songCount: 1,
      duration: 100,
      serverId: 'srv-owner',
    };
    renderWithProviders(<AlbumCard album={album} disableArtwork />);

    await waitFor(() => expect(resolveArtistIds).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Nobody' })).toBeNull();
    expect(screen.getByText('Nobody')).toBeTruthy();
  });
  it('includes the album owner in its drag payload', () => {
    startDrag.mockClear();
    const album: SubsonicAlbum = {
      id: 'album-1',
      name: 'Owned Album',
      artist: 'Artist',
      artistId: 'artist-1',
      songCount: 1,
      duration: 100,
      serverId: 'srv-owner',
    };
    renderWithProviders(<AlbumCard album={album} disableArtwork />);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Owned Album von Artist' }), {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.mouseMove(document, { clientX: 20, clientY: 10 });

    expect(startDrag).toHaveBeenCalledOnce();
    expect(JSON.parse(startDrag.mock.calls[0]![0].data)).toEqual({
      type: 'album',
      id: 'album-1',
      name: 'Owned Album',
      serverId: 'srv-owner',
    });
  });
});
