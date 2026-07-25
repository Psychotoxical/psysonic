import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
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
