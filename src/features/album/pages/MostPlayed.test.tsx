import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAuthStore, resetPlayerStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { CoverArtRef, CoverServerScope } from '@/cover/types';

const mocks = vi.hoisted(() => ({
  fetchMostPlayedAlbums: vi.fn(),
  useAlbumCoverRef: vi.fn(),
  useArtistCoverRef: vi.fn(),
  coverArtImage: vi.fn(),
  wakeMissingMetadata: vi.fn(),
  playAlbum: vi.fn(),
  playAlbumShuffled: vi.fn(),
  resolveAlbum: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('@/lib/api/subsonicStatistics', () => ({
  fetchMostPlayedAlbums: mocks.fetchMostPlayedAlbums,
}));

vi.mock('@/cover/useLibraryCoverRef', () => ({
  useAlbumCoverRef: mocks.useAlbumCoverRef,
  useArtistCoverRef: mocks.useArtistCoverRef,
}));

vi.mock('@/cover/CoverArtImage', () => ({
  CoverArtImage: (props: { coverRef?: CoverArtRef | null; className?: string }) => {
    mocks.coverArtImage(props);
    return <div className={props.className} data-testid="most-played-cover" />;
  },
}));

vi.mock('@/cover/wakeCoverBackfillForMissingMetadata', () => ({
  wakeCoverBackfillForMissingMetadata: mocks.wakeMissingMetadata,
}));

vi.mock('@/features/playback/utils/playback/playAlbum', () => ({
  playAlbum: mocks.playAlbum,
  playAlbumShuffled: mocks.playAlbumShuffled,
}));

vi.mock('@/features/offline', () => ({
  resolveAlbum: mocks.resolveAlbum,
}));

import MostPlayed from './MostPlayed';

const activeServer = {
  id: 'srv-active',
  name: 'Active',
  url: 'https://active.test',
  username: 'active-user',
  password: 'active-password',
};

const ownerServer = {
  id: 'srv-owner',
  name: 'Owner',
  url: 'https://owner.test',
  username: 'owner-user',
  password: 'owner-password',
};

function mostPlayedResult(serverId = ownerServer.id) {
  return {
    albums: [{
      serverId,
      libraryId: 'library-owner',
      id: 'album-owned',
      name: 'Owned Album',
      artist: 'Owned Artist',
      artistId: 'artist-owned',
      coverArtId: null,
      playCount: 42,
      year: 2026,
    }],
    artists: [{
      serverId,
      id: 'artist-owned',
      name: 'Owned Artist',
      coverArtId: null,
      playCount: 42,
    }],
    hasMore: false,
  };
}

function coverRef(kind: 'album' | 'artist', id: string, serverScope: CoverServerScope): CoverArtRef {
  return {
    cacheKind: kind,
    cacheEntityId: id,
    fetchCoverArtId: `resolved-${id}`,
    serverScope,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

async function renderMostPlayed() {
  renderWithProviders(
    <>
      <MostPlayed />
      <LocationProbe />
    </>,
  );
  await screen.findByText('Owned Album');
}

describe('MostPlayed owner-scoped artwork and actions', () => {
  beforeEach(() => {
    resetAuthStore();
    resetPlayerStore();
    Object.values(mocks).forEach(mock => mock.mockReset());

    useAuthStore.setState({
      activeServerId: activeServer.id,
      servers: [activeServer, ownerServer],
      libraryBrowseServerIds: [activeServer.id, ownerServer.id],
      libraryBrowseSelectionByServer: {},
    });
    usePlayerStore.setState({
      enqueue: mocks.enqueue,
      openContextMenu: vi.fn(),
    });

    mocks.fetchMostPlayedAlbums.mockResolvedValue(mostPlayedResult());
    mocks.useAlbumCoverRef.mockImplementation((id, _fallback, scope) => coverRef('album', id, scope));
    mocks.useArtistCoverRef.mockImplementation((id, _fallback, scope) => coverRef('artist', id, scope));
    mocks.resolveAlbum.mockResolvedValue({ songs: [] });
  });

  it('uses owner-scoped library resolution and the standard disk-cache image path without raw cover ids', async () => {
    await renderMostPlayed();

    const expectedScope = {
      kind: 'server',
      serverId: ownerServer.id,
      url: ownerServer.url,
      username: ownerServer.username,
      password: ownerServer.password,
    };
    expect(mocks.useAlbumCoverRef).toHaveBeenCalledWith(
      'album-owned',
      undefined,
      expectedScope,
      { libraryResolve: true },
    );
    expect(mocks.useArtistCoverRef).toHaveBeenCalledWith(
      'artist-owned',
      null,
      expectedScope,
      { libraryResolve: true },
    );
    expect(mocks.coverArtImage).toHaveBeenCalledWith(expect.objectContaining({
      coverRef: expect.objectContaining({
        cacheEntityId: 'album-owned',
        fetchCoverArtId: 'resolved-album-owned',
        serverScope: expectedScope,
      }),
    }));
    await waitFor(() => {
      expect(mocks.wakeMissingMetadata).toHaveBeenCalledWith(ownerServer.id);
    });
    expect(mocks.useAlbumCoverRef).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'active' }),
      expect.anything(),
    );
  });

  it('keeps album and artist detail navigation on the row owner', async () => {
    const user = userEvent.setup();
    await renderMostPlayed();

    await user.click(screen.getByText('Owned Album'));
    expect(screen.getByTestId('location')).toHaveTextContent('/album/album-owned?server=srv-owner');

    await user.click(screen.getByRole('button', { name: /Owned Artist/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/artist/artist-owned?server=srv-owner');
  });

  it('plays and enqueues from the owner server instead of the active server', async () => {
    const user = userEvent.setup();
    await renderMostPlayed();

    await user.click(screen.getByRole('button', { name: 'Play Album (hold to shuffle)' }));
    expect(mocks.playAlbum).toHaveBeenCalledWith('album-owned', { serverId: ownerServer.id });

    await user.click(screen.getByRole('button', { name: 'Enqueue Album' }));
    await waitFor(() => {
      expect(mocks.resolveAlbum).toHaveBeenCalledWith(ownerServer.id, 'album-owned');
    });
    expect(mocks.resolveAlbum).not.toHaveBeenCalledWith(activeServer.id, 'album-owned');
    expect(mocks.enqueue).toHaveBeenCalledWith([]);
  });

  it('keeps an unmapped owner local-only rather than falling back artwork to the active server', async () => {
    const orphanOwner = 'orphan-index-key';
    mocks.fetchMostPlayedAlbums.mockResolvedValue(mostPlayedResult(orphanOwner));

    await renderMostPlayed();

    expect(mocks.useAlbumCoverRef).toHaveBeenCalledWith(
      'album-owned',
      undefined,
      {
        kind: 'server',
        serverId: orphanOwner,
        url: '',
        username: '',
        password: '',
      },
      { libraryResolve: true },
    );
    await waitFor(() => {
      expect(mocks.wakeMissingMetadata).toHaveBeenCalledWith(orphanOwner);
    });
  });
});
