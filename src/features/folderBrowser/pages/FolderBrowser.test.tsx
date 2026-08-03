import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { useAuthStore } from '@/store/authStore';
import {
  resetServerReachabilitySnapshot,
  setServerReachability,
} from '@/lib/network/serverReachability';

const libraryScopeListArtistsMock = vi.fn();
const libraryScopeArtistDetailMock = vi.fn();
const libraryScopeAlbumDetailMock = vi.fn();
const playTrackMock = vi.fn();

vi.mock('@/lib/api/library/scopeReads', () => ({
  libraryScopeListArtists: (...args: unknown[]) => libraryScopeListArtistsMock(...args),
  libraryScopeArtistDetail: (...args: unknown[]) => libraryScopeArtistDetailMock(...args),
  libraryScopeAlbumDetail: (...args: unknown[]) => libraryScopeAlbumDetailMock(...args),
}));

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: (selector: (state: object) => unknown) => selector({
    currentTrack: null,
    isPlaying: false,
    playTrack: playTrackMock,
    openContextMenu: vi.fn(),
    contextMenu: { isOpen: false },
  }),
}));

vi.mock('@/features/folderBrowser/hooks/useFolderBrowserNowPlayingPath', () => ({
  useFolderBrowserNowPlayingPath: () => ({
    playingPathIds: [],
    setPlayingPathIds: vi.fn(),
    isSelectedPathForCurrentTrack: false,
  }),
}));

vi.mock('@/features/folderBrowser/hooks/useFolderBrowserKeyboardNav', () => ({
  useFolderBrowserKeyboardNav: () => () => undefined,
}));

import FolderBrowser from './FolderBrowser';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FolderBrowser', () => {
  beforeEach(() => {
    resetServerReachabilitySnapshot();
    libraryScopeListArtistsMock.mockReset();
    libraryScopeArtistDetailMock.mockReset();
    libraryScopeAlbumDetailMock.mockReset();
    playTrackMock.mockReset();
    useAuthStore.setState({
      servers: [
        { id: 'server-a', name: 'Alpha', url: 'https://alpha.example', username: 'u', password: 'p' },
        { id: 'server-b', name: 'Beta', url: 'https://beta.example', username: 'u', password: 'p' },
        { id: 'server-c', name: 'Gamma', url: 'https://gamma.example', username: 'u', password: 'p' },
      ],
      activeServerId: 'server-a',
      libraryBrowseServerIds: ['server-a', 'server-b'],
      musicFoldersByServer: {
        'server-a': [{ id: 'music', name: 'Library A' }],
        'server-b': [{ id: 'music', name: 'Library B' }],
        'server-c': [{ id: 'music', name: 'Library C' }],
      },
    });
    libraryScopeListArtistsMock.mockResolvedValue([
      { serverId: 'server-a', id: 'artist-a', name: 'Artist A' },
    ]);
    libraryScopeArtistDetailMock.mockResolvedValue({
      artist: { serverId: 'server-a', id: 'artist-a', name: 'Artist A' },
      albums: [{ serverId: 'server-a', id: 'album-a', name: 'Album A', artist: 'Artist A', artistId: 'artist-a', syncedAt: 1, rawJson: {} }],
      appearsOnAlbums: [],
      tracks: [],
    });
    libraryScopeAlbumDetailMock.mockResolvedValue({
      album: { serverId: 'server-a', id: 'album-a', name: 'Album A', syncedAt: 1, rawJson: {} },
      tracks: [{ serverId: 'server-a', id: 'track-a', title: 'Track A', album: 'Album A', durationSec: 60, syncedAt: 1, rawJson: {} }],
    });
  });

  it('shows folders from every selected server in the root column', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FolderBrowser />, { route: '/folders' });

    const alphaLibrary = await screen.findByRole('button', { name: 'Alpha - Library A' });
    expect(alphaLibrary).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beta - Library B' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gamma - Library C' })).not.toBeInTheDocument();

    await user.click(alphaLibrary);
    expect(libraryScopeListArtistsMock).toHaveBeenCalledWith('server-a', {
      scopes: [{ serverId: 'server-a', libraryId: 'music' }],
      sort: 'name',
      limit: 10_000,
    });

    await user.click(await screen.findByRole('button', { name: 'Artist A' }));
    expect(libraryScopeArtistDetailMock).toHaveBeenCalledWith('server-a', {
      scopes: [{ serverId: 'server-a', libraryId: 'music' }],
      artistId: 'artist-a',
      serverId: 'server-a',
      includeTracks: false,
    });

    await user.click(await screen.findByRole('button', { name: 'Album A' }));
    expect(libraryScopeAlbumDetailMock).toHaveBeenCalledWith('server-a', {
      scopes: [{ serverId: 'server-a', libraryId: 'music' }],
      albumId: 'album-a',
      serverId: 'server-a',
    });
    const track = await screen.findByRole('button', { name: 'Track A' });
    expect(track).toBeInTheDocument();
    await user.click(track);
    expect(playTrackMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'track-a', serverId: 'server-a', duration: 60 }),
      [expect.objectContaining({ id: 'track-a', serverId: 'server-a', duration: 60 })],
    );
  });

  it('hides folders from a confirmed unavailable selected server', async () => {
    setServerReachability('server-b', 'unavailable');

    renderWithProviders(<FolderBrowser />, { route: '/folders' });

    expect(await screen.findByRole('button', { name: 'Alpha - Library A' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Beta - Library B' })).not.toBeInTheDocument();
    expect(useAuthStore.getState().libraryBrowseServerIds).toEqual(['server-a', 'server-b']);
  });

  it('keeps equal server-local artist ids distinct in one column', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    libraryScopeListArtistsMock.mockResolvedValue([
      { serverId: 'server-a', id: 'shared-artist-id', name: 'Artist from Alpha' },
      { serverId: 'server-b', id: 'shared-artist-id', name: 'Artist from Beta' },
    ]);

    try {
      renderWithProviders(<FolderBrowser />, { route: '/folders' });
      await user.click(await screen.findByRole('button', { name: 'Alpha - Library A' }));

      expect(await screen.findByRole('button', { name: 'Artist from Alpha' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Artist from Beta' })).toBeInTheDocument();
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('Encountered two children with the same key');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('ignores a stale equal-id response after switching to another server', async () => {
    const user = userEvent.setup();
    const alpha = deferred<Array<{ serverId: string; id: string; name: string }>>();
    const beta = deferred<Array<{ serverId: string; id: string; name: string }>>();
    libraryScopeListArtistsMock.mockImplementation((serverId: string) => (
      serverId === 'server-a' ? alpha.promise : beta.promise
    ));

    renderWithProviders(<FolderBrowser />, { route: '/folders' });
    await user.click(await screen.findByRole('button', { name: 'Alpha - Library A' }));
    await user.click(screen.getByRole('button', { name: 'Beta - Library B' }));

    await act(async () => {
      alpha.resolve([{ serverId: 'server-a', id: 'artist-a', name: 'Stale Alpha Artist' }]);
      await alpha.promise;
    });
    expect(screen.queryByRole('button', { name: 'Stale Alpha Artist' })).not.toBeInTheDocument();

    await act(async () => {
      beta.resolve([{ serverId: 'server-b', id: 'artist-b', name: 'Current Beta Artist' }]);
      await beta.promise;
    });
    expect(await screen.findByRole('button', { name: 'Current Beta Artist' })).toBeInTheDocument();
  });
});
