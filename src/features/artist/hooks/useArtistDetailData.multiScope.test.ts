import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';

const tryLoadArtistDetailMultiScopeMock = vi.fn();
const librarySelectionForServerMock = vi.fn();

vi.mock('@/features/artist/hooks/loadArtistDetailMultiScope', () => ({
  tryLoadArtistDetailMultiScope: (...args: unknown[]) => tryLoadArtistDetailMultiScopeMock(...args),
}));

vi.mock('@/lib/api/subsonicClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/subsonicClient')>();
  return {
    ...actual,
    librarySelectionForServer: (...args: unknown[]) => librarySelectionForServerMock(...args),
  };
});

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

import { getArtist, getArtistForServer, getArtistInfo, getTopSongs } from '@/lib/api/subsonicArtists';
import { loadArtistFromLibraryIndex } from '@/features/offline';
import { search } from '@/lib/api/subsonicSearch';
import { useArtistDetailData } from './useArtistDetailData';

function routerWrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children);
}

describe('useArtistDetailData — multi-library selection', () => {
  beforeEach(() => {
    tryLoadArtistDetailMultiScopeMock.mockReset();
    librarySelectionForServerMock.mockReset();
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getArtistInfo).mockResolvedValue({} as Awaited<ReturnType<typeof getArtistInfo>>);
    vi.mocked(search).mockResolvedValue({ songs: [], albums: [], artists: [] });
    useAuthStore.setState({
      activeServerId: 'srv-1',
      servers: [{ id: 'srv-1', name: 'S', url: 'https://s.test', username: 'u', password: 'p' }],
      favoritesOfflineEnabled: false,
      musicLibrarySelectionByServer: { 'srv-1': ['lib-a', 'lib-b'] },
      musicLibraryFilterVersion: 0,
      audiomuseNavidromeByServer: {},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads via tryLoadArtistDetailMultiScope when more than one library is selected', async () => {
    librarySelectionForServerMock.mockReturnValue(['lib-a', 'lib-b']);
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Merged' },
      albums: [{ id: 'alb-1', name: 'Album' }],
      topSongs: [{ id: 'trk-high', playCount: 10 }, { id: 'trk-low', playCount: 1 }],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadArtistDetailMultiScopeMock).toHaveBeenCalledWith('srv-1', 'art-1');
    expect(getArtistForServer).not.toHaveBeenCalled();
    expect(getArtist).not.toHaveBeenCalled();
    expect(result.current.artist).toMatchObject({ id: 'art-1', name: 'Merged' });
    expect(result.current.albums).toHaveLength(1);
    expect(result.current.topSongs.map(s => s.id)).toEqual(['trk-high', 'trk-low']);
  });

  it('loads via tryLoadArtistDetailMultiScope when one library is selected', async () => {
    librarySelectionForServerMock.mockReturnValue(['sampler']);
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Scoped' },
      albums: [{ id: 'alb-1', name: 'Sampler Album' }],
      topSongs: [],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadArtistDetailMultiScopeMock).toHaveBeenCalledWith('srv-1', 'art-1');
    expect(getArtistForServer).not.toHaveBeenCalled();
    expect(result.current.albums).toHaveLength(1);
  });

  it('does not call tryLoadArtistDetailMultiScope when all libraries are selected', async () => {
    librarySelectionForServerMock.mockReturnValue([]);
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
    librarySelectionForServerMock.mockReturnValue([]);
    vi.mocked(getArtistForServer).mockRejectedValue(new Error('artist not found'));
    vi.mocked(loadArtistFromLibraryIndex).mockResolvedValue({
      artist: { id: 'art-x', name: 'Album Artist', albumCount: 1, serverId: 'srv-1' },
      albums: [{ id: 'alb-9', name: 'Comp', artist: 'Album Artist', artistId: 'art-x', songCount: 1, duration: 100 }],
    });

    const { result } = renderHook(() => useArtistDetailData('art-x'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getArtistForServer).toHaveBeenCalled();
    expect(loadArtistFromLibraryIndex).toHaveBeenCalledWith('srv-1', 'art-x');
    expect(result.current.artist).toMatchObject({ id: 'art-x', name: 'Album Artist' });
    expect(result.current.albums).toHaveLength(1);
  });

  it('shows nothing to resolve when both network and local index miss', async () => {
    librarySelectionForServerMock.mockReturnValue([]);
    vi.mocked(getArtistForServer).mockRejectedValue(new Error('artist not found'));
    vi.mocked(loadArtistFromLibraryIndex).mockResolvedValue(null);

    const { result } = renderHook(() => useArtistDetailData('ghost'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(loadArtistFromLibraryIndex).toHaveBeenCalledWith('srv-1', 'ghost');
    expect(result.current.artist).toBeNull();
  });

  it('falls through to getArtist when multi-scope load returns null', async () => {
    librarySelectionForServerMock.mockReturnValue(['lib-a', 'lib-b']);
    tryLoadArtistDetailMultiScopeMock.mockResolvedValue(null);
    vi.mocked(getArtistForServer).mockResolvedValue({
      artist: { id: 'art-1', name: 'Fallback' },
      albums: [],
    });

    const { result } = renderHook(() => useArtistDetailData('art-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadArtistDetailMultiScopeMock).toHaveBeenCalled();
    expect(getArtistForServer).toHaveBeenCalled();
    expect(result.current.artist).toMatchObject({ name: 'Fallback' });
  });
});
