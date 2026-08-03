import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';

const tryLoadArtistDetailMultiScopeMock = vi.fn();
const loadScopedArtistTopSongsMock = vi.fn();

vi.mock('@/lib/library/loadArtistDetailMultiScope', () => ({
  tryLoadArtistDetailMultiScope: (...args: unknown[]) => tryLoadArtistDetailMultiScopeMock(...args),
}));

vi.mock('@/lib/library/loadScopedArtistTopSongs', () => ({
  loadScopedArtistTopSongs: (...args: unknown[]) => loadScopedArtistTopSongsMock(...args),
}));

vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: () => true,
}));

vi.mock('@/lib/api/subsonicArtists');
vi.mock('@/lib/api/subsonicSearch');

vi.mock('@/features/offline', () => ({
  loadArtistFromLibraryIndex: vi.fn(),
  loadArtistFromLocalPlayback: vi.fn(),
  useOfflineBrowseContext: () => ({ active: false }),
}));

vi.mock('@/lib/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => ({ status: 'connected' }),
}));

import {
  getArtist, getArtistForServer, getArtistInfo, getArtistInfoForServer, getTopSongs, getTopSongsForServer,
} from '@/lib/api/subsonicArtists';
import { loadArtistFromLibraryIndex } from '@/features/offline';
import { search, searchForServer } from '@/lib/api/subsonicSearch';
import { useArtistDetailData } from './useArtistDetailData';

function routerWrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children);
}

/** Wrapper for routes that name their owning server, as every in-app artist link does. */
function serverScopedWrapper(entry: string) {
  return function ServerScopedWrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(MemoryRouter, { initialEntries: [entry] }, children);
  };
}

describe('useArtistDetailData — multi-library selection', () => {
  beforeEach(() => {
    tryLoadArtistDetailMultiScopeMock.mockReset();
    loadScopedArtistTopSongsMock.mockReset();
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getTopSongsForServer).mockResolvedValue([]);
    vi.mocked(getArtistInfo).mockResolvedValue({} as Awaited<ReturnType<typeof getArtistInfo>>);
    vi.mocked(getArtistInfoForServer).mockResolvedValue({} as Awaited<ReturnType<typeof getArtistInfoForServer>>);
    vi.mocked(search).mockResolvedValue({ songs: [], albums: [], artists: [] });
    vi.mocked(searchForServer).mockResolvedValue({ songs: [], albums: [], artists: [] });
    useAuthStore.setState({
      activeServerId: 'srv-1',
      servers: [
        { id: 'srv-1', name: 'S1', url: 'https://s1.test', username: 'u', password: 'p' },
        { id: 'srv-2', name: 'S2', url: 'https://s2.test', username: 'u', password: 'p' },
      ],
      favoritesOfflineEnabled: false,
      musicFoldersByServer: {
        'srv-1': [{ id: 'lib-a', name: 'A' }],
        'srv-2': [{ id: 'lib-b', name: 'B' }],
      },
      libraryBrowseServerIds: ['srv-1', 'srv-2'],
      libraryBrowseSelectionByServer: { 'srv-1': ['lib-a'], 'srv-2': ['lib-b'] },
      libraryBrowseScopeVersion: 0,
      audiomuseNavidromeByServer: {},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads via the authoritative cross-server browse scope', async () => {
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Merged' },
      albums: [{ id: 'alb-1', name: 'Album' }],
      topSongs: [{ id: 'trk-high', playCount: 10 }, { id: 'trk-low', playCount: 1 }],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadArtistDetailMultiScopeMock).toHaveBeenCalledWith([
      { serverId: 'srv-1', libraryId: 'lib-a' },
      { serverId: 'srv-2', libraryId: 'lib-b' },
    ], 'srv-1', 'art-1');
    expect(getArtistForServer).not.toHaveBeenCalled();
    expect(getArtist).not.toHaveBeenCalled();
    expect(result.current.artist).toMatchObject({ id: 'art-1', name: 'Merged' });
    expect(result.current.albums).toHaveLength(1);
    expect(result.current.topSongs.map(s => s.id)).toEqual(['trk-high', 'trk-low']);
  });

  it('loads artist info under a multi-server scope from the server the route names', async () => {
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      // The merged header won on another server than the route names; the explicit
      // route owner still decides, and the request must not be repeated for it.
      artist: { id: 'art-9', name: 'Merged', serverId: 'srv-1' },
      albums: [],
      topSongs: [],
    });
    vi.mocked(getArtistInfoForServer).mockResolvedValue(
      { biography: 'Formed in 2016.' } as Awaited<ReturnType<typeof getArtistInfoForServer>>,
    );

    const { result } = renderHook(() => useArtistDetailData('art-1'), {
      wrapper: serverScopedWrapper('/artist/art-1?server=srv-2'),
    });

    await waitFor(() => expect(result.current.info).toMatchObject({ biography: 'Formed in 2016.' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getArtistInfoForServer).toHaveBeenCalledWith('srv-2', 'art-1', { similarArtistCount: undefined });
    expect(getArtistInfoForServer).toHaveBeenCalledTimes(1);
    expect(getArtistInfo).not.toHaveBeenCalled();
  });

  it('asks no server for artist info while a multi-server route has no known owner', async () => {
    // No `?server=` and a header the loader could not attribute — the active server
    // would answer for whatever artist carries this id there.
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Merged' },
      albums: [],
      topSongs: [],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.artist).not.toBeNull());
    expect(getArtistInfoForServer).not.toHaveBeenCalled();
    expect(getArtistInfo).not.toHaveBeenCalled();
    expect(result.current.info).toBeNull();
  });

  it('loads artist info from the owner the scoped header reports when the route omits it', async () => {
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-2', name: 'Merged', serverId: 'srv-2' },
      albums: [],
      topSongs: [],
    });
    vi.mocked(getArtistInfoForServer).mockResolvedValue(
      { biography: 'Formed in 2016.' } as Awaited<ReturnType<typeof getArtistInfoForServer>>,
    );

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.info).toMatchObject({ biography: 'Formed in 2016.' }));
    // Server and id come from the same resolved row — the active server never answers.
    expect(getArtistInfoForServer).toHaveBeenCalledWith('srv-2', 'art-2', { similarArtistCount: undefined });
    expect(getArtistInfo).not.toHaveBeenCalled();
  });

  it('stops the artist-info spinner when a scope change leaves nobody to answer', async () => {
    // Selecting a second server while the page is open: the route never named an owner
    // and the header carries none, so the pending active-server request is dropped. The
    // similar-artists Last.fm fallback waits on this flag.
    useAuthStore.setState({
      libraryBrowseServerIds: ['srv-1'],
      libraryBrowseSelectionByServer: { 'srv-1': ['lib-a'] },
    });
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Merged' },
      albums: [],
      topSongs: [],
    });
    vi.mocked(getArtistInfoForServer).mockImplementation(
      () => new Promise(() => {}) as ReturnType<typeof getArtistInfoForServer>,
    );

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.artistInfoLoading).toBe(true));
    act(() => {
      useAuthStore.setState({
        libraryBrowseServerIds: ['srv-1', 'srv-2'],
        libraryBrowseScopeVersion: 1,
      });
    });

    await waitFor(() => expect(result.current.artistInfoLoading).toBe(false));
    expect(result.current.info).toBeNull();
  });

  it('drops the loaded owner when the scope moves to a different multi-server selection', async () => {
    // The previous test starts from a single-server fallback and never establishes an
    // owner, so it cannot catch a *retained* one. Here the first selection legitimately
    // resolves an owner, then that server leaves the scope and the refreshed load
    // attributes none — the route names no server either, so nobody may be asked.
    useAuthStore.setState({
      servers: [
        { id: 'srv-1', name: 'S1', url: 'https://s1.test', username: 'u', password: 'p' },
        { id: 'srv-2', name: 'S2', url: 'https://s2.test', username: 'u', password: 'p' },
        { id: 'srv-3', name: 'S3', url: 'https://s3.test', username: 'u', password: 'p' },
      ],
      musicFoldersByServer: {
        'srv-1': [{ id: 'lib-a', name: 'A' }],
        'srv-2': [{ id: 'lib-b', name: 'B' }],
        'srv-3': [{ id: 'lib-c', name: 'C' }],
      },
      libraryBrowseServerIds: ['srv-1', 'srv-2'],
      libraryBrowseSelectionByServer: { 'srv-1': ['lib-a'], 'srv-2': ['lib-b'] },
      libraryBrowseScopeVersion: 0,
    });
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-2', name: 'Merged', serverId: 'srv-2' },
      albums: [],
      topSongs: [],
    });
    vi.mocked(getArtistInfoForServer).mockResolvedValue(
      { biography: 'Owned by the second server.' } as Awaited<ReturnType<typeof getArtistInfoForServer>>,
    );

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.info).toMatchObject({
      biography: 'Owned by the second server.',
    }));
    expect(getArtistInfoForServer).toHaveBeenCalledWith('srv-2', 'art-2', { similarArtistCount: undefined });

    // srv-2 leaves the selection and the refreshed load resolves to nothing at all —
    // the branch that returns without ever entering the result handler, so only an
    // up-front reset can invalidate the owner it left behind.
    vi.mocked(getArtistInfoForServer).mockClear();
    vi.mocked(getArtistInfo).mockClear();
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue(null);
    act(() => {
      useAuthStore.setState({
        libraryBrowseServerIds: ['srv-1', 'srv-3'],
        libraryBrowseSelectionByServer: { 'srv-1': ['lib-a'], 'srv-3': ['lib-c'] },
        libraryBrowseScopeVersion: 1,
      });
    });

    await waitFor(() => expect(tryLoadArtistDetailMultiScopeMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A retained owner leaves the info effect's inputs untouched, so it simply does not
    // re-run and the damage stays latent. Any later re-trigger is what surfaces it — the
    // similar-artists toggle is one the store really drives. It has to name the *stale*
    // owner: that flag is read for the resolved target, so toggling any other server
    // would leave the unfixed dependencies unchanged and the test would pass on both
    // sides. With the owner correctly dropped there is no target, so nothing is asked.
    act(() => {
      useAuthStore.setState({ audiomuseNavidromeByServer: { 'srv-2': true } });
    });
    await act(async () => { await Promise.resolve(); });

    expect(getArtistInfoForServer).not.toHaveBeenCalled();
    expect(getArtistInfo).not.toHaveBeenCalled();
    expect(result.current.info).toBeNull();
  });

  it('asks the resolved owner even under a single-server scope on another server', async () => {
    // Browsing one server while a different one is active is an ordinary selection. The
    // scope has a single candidate, so the multi-server guard does not apply — but the
    // route-or-active fallback would still send the request to the *active* server with
    // the route id, and Subsonic ids collide freely across servers.
    useAuthStore.setState({
      libraryBrowseServerIds: ['srv-2'],
      libraryBrowseSelectionByServer: { 'srv-2': ['lib-b'] },
      libraryBrowseScopeVersion: 0,
    });
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-7', name: 'Merged', serverId: 'srv-2' },
      albums: [],
      topSongs: [],
    });
    vi.mocked(getArtistInfoForServer).mockResolvedValue(
      { biography: 'Owned by the second server.' } as Awaited<ReturnType<typeof getArtistInfoForServer>>,
    );

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.info).toMatchObject({
      biography: 'Owned by the second server.',
    }));
    expect(getArtistInfoForServer).toHaveBeenCalledWith('srv-2', 'art-7', { similarArtistCount: undefined });
    expect(getArtistInfo).not.toHaveBeenCalled();
  });

  it('reads the AudioMuse flag for the owning server, not the active one', async () => {
    // The flag both decides the requested similar-artist count and, in the page, whether
    // that list is rendered at all. Keyed on the active server it would ask the owner for
    // a default-sized set and then refuse to show it.
    useAuthStore.setState({ audiomuseNavidromeByServer: { 'srv-2': true } });
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-2', name: 'Merged', serverId: 'srv-2' },
      albums: [],
      topSongs: [],
    });
    vi.mocked(getArtistInfoForServer).mockResolvedValue(
      { biography: 'Formed in 2016.' } as Awaited<ReturnType<typeof getArtistInfoForServer>>,
    );

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.info).not.toBeNull());
    expect(getArtistInfoForServer).toHaveBeenCalledWith('srv-2', 'art-2', { similarArtistCount: 24 });
    expect(result.current.audiomuseNavidromeEnabled).toBe(true);
    expect(result.current.infoServerId).toBe('srv-2');
  });

  it('routes the scoped appears-on set to featuredAlbums without a network search', async () => {
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Merged' },
      albums: [{ id: 'own-1', name: 'Own' }],
      appearsOnAlbums: [{ id: 'feat-1', name: 'A Comp' }],
      topSongs: [],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.albums.map(a => a.id)).toEqual(['own-1']);
    // Appears-on comes from the scoped split, and the network featured search
    // (searchForServer) must stay suppressed under a browse scope.
    await waitFor(() => expect(result.current.featuredAlbums.map(a => a.id)).toEqual(['feat-1']));
    expect(searchForServer).not.toHaveBeenCalled();
  });

  it('renders local detail while one server Top Songs request remains pending', async () => {
    let resolveTopSongs!: (songs: Array<{ id: string; title: string }>) => void;
    loadScopedArtistTopSongsMock.mockImplementation(() => new Promise(resolve => {
      resolveTopSongs = resolve;
    }));
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Merged' },
      albums: [{ id: 'alb-1', name: 'Album' }],
      topSongs: [{ id: 'fallback', title: 'Fallback' }],
      topTracksServerId: 'srv-2',
      topTracksFingerprint: 'tracks-v1',
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.artist?.name).toBe('Merged');
    expect(result.current.topSongsLoading).toBe(true);
    expect(result.current.topSongs.map(song => song.id)).toEqual(['fallback']);
    expect(loadScopedArtistTopSongsMock).toHaveBeenCalledWith({
      artistName: 'Merged',
      sourceServerId: 'srv-2',
      scopes: [
        { serverId: 'srv-1', libraryId: 'lib-a' },
        { serverId: 'srv-2', libraryId: 'lib-b' },
      ],
      localFallback: [{ id: 'fallback', title: 'Fallback' }],
      tracksFingerprint: 'tracks-v1',
    });

    resolveTopSongs([{ id: 'global', title: 'Global' }]);
    await waitFor(() => expect(result.current.topSongsLoading).toBe(false));
    expect(result.current.topSongs.map(song => song.id)).toEqual(['global']);
  });

  it('keeps local Top Tracks when the optional ranking request fails', async () => {
    loadScopedArtistTopSongsMock.mockRejectedValue(new TypeError('invalid song metadata'));
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Merged' },
      albums: [{ id: 'alb-1', name: 'Album' }],
      topSongs: [{ id: 'fallback', title: 'Fallback' }],
      topTracksServerId: 'srv-2',
      topTracksFingerprint: 'tracks-v1',
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(loadScopedArtistTopSongsMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.topSongsLoading).toBe(false));
    expect(result.current.loading).toBe(false);
    expect(result.current.topSongs.map(song => song.id)).toEqual(['fallback']);
  });

  it('loads via the authoritative scope when one folder is selected', async () => {
    useAuthStore.setState({
      libraryBrowseServerIds: ['srv-1'],
      libraryBrowseSelectionByServer: { 'srv-1': ['lib-a'] },
    });
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Scoped' },
      albums: [{ id: 'alb-1', name: 'Sampler Album' }],
      topSongs: [],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadArtistDetailMultiScopeMock).toHaveBeenCalledWith([
      { serverId: 'srv-1', libraryId: 'lib-a' },
    ], 'srv-1', 'art-1');
    expect(getArtistForServer).not.toHaveBeenCalled();
    expect(result.current.albums).toHaveLength(1);
  });

  it('uses the direct resolver when no concrete browse scope is configured', async () => {
    useAuthStore.setState({ musicFoldersByServer: {}, libraryBrowseServerIds: [] });
    vi.mocked(getArtistForServer).mockResolvedValue({
      artist: { id: 'art-1', name: 'Network' },
      albums: [{ id: 'alb-1', name: 'Album', artist: 'Network', artistId: 'art-1', songCount: 1, duration: 100 }],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadArtistDetailMultiScopeMock).not.toHaveBeenCalled();
    expect(getArtistForServer).toHaveBeenCalled();
    expect(getArtist).not.toHaveBeenCalled();
    expect(result.current.artist).toMatchObject({ name: 'Network' });
  });

  it('falls back to the local library index when network getArtist fails', async () => {
    // Random Albums links an album-artist id that `getArtist` 404s on, but the
    // artist row exists in the local index the album came from → resolve there
    // instead of showing "Artist not found".
    useAuthStore.setState({ musicFoldersByServer: {}, libraryBrowseServerIds: [] });
    vi.mocked(getArtistForServer).mockRejectedValue(new Error('artist not found'));
    vi.mocked(loadArtistFromLibraryIndex).mockResolvedValue({
      artist: { id: 'art-x', name: 'Album Artist', albumCount: 1, serverId: 'srv-1' },
      albums: [{ id: 'alb-9', name: 'Comp', artist: 'Album Artist', artistId: 'art-x', songCount: 1, duration: 100 }],
      appearsOnAlbums: [{ id: 'alb-feat', name: 'A Comp', artist: 'Various Artists', artistId: 'va', songCount: 1, duration: 100 }],
    });

    const { result } = renderHook(() => useArtistDetailData('art-x'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getArtistForServer).toHaveBeenCalled();
    expect(loadArtistFromLibraryIndex).toHaveBeenCalledWith('srv-1', 'art-x');
    expect(result.current.artist).toMatchObject({ id: 'art-x', name: 'Album Artist' });
    // The fallback must not fold appears-on into the main discography — `albums` is
    // the own set only (finding 3). featuredAlbums is left to the network featured
    // search here (the server is reachable, getArtist just 404'd); the truly-offline
    // split is covered at the loader level in offlineLibraryIndexLoad.test.ts.
    expect(result.current.albums.map(a => a.id)).toEqual(['alb-9']);
  });

  it('shows nothing to resolve when both network and local index miss', async () => {
    useAuthStore.setState({ musicFoldersByServer: {}, libraryBrowseServerIds: [] });
    vi.mocked(getArtistForServer).mockRejectedValue(new Error('artist not found'));
    vi.mocked(loadArtistFromLibraryIndex).mockResolvedValue(null);

    const { result } = renderHook(() => useArtistDetailData('ghost'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(loadArtistFromLibraryIndex).toHaveBeenCalledWith('srv-1', 'ghost');
    expect(result.current.artist).toBeNull();
  });

  it('does not escape the authoritative scope when the scoped lookup misses', async () => {
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue(null);
    vi.mocked(getArtistForServer).mockResolvedValue({
      artist: { id: 'art-1', name: 'Fallback' },
      albums: [],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadArtistDetailMultiScopeMock).toHaveBeenCalled();
    expect(getArtistForServer).not.toHaveBeenCalled();
    expect(result.current.artist).toBeNull();
  });
});
