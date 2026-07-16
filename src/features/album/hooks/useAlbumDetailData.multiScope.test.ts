import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';

const tryLoadAlbumDetailMultiScopeMock = vi.fn();
const resolveAlbumMock = vi.fn();
const librarySelectionForServerMock = vi.fn();
let browseScope = {
  pairs: [{ serverId: 'srv-1', libraryId: 'lib-a' }, { serverId: 'srv-2', libraryId: null }],
  fingerprint: 'multi',
  anchorServerId: 'srv-1',
  configuredServerIds: ['srv-1', 'srv-2'],
  multiServer: true,
};

vi.mock('@/features/album/hooks/loadAlbumDetailMultiScope', () => ({
  tryLoadAlbumDetailMultiScope: (...args: unknown[]) => tryLoadAlbumDetailMultiScopeMock(...args),
}));

vi.mock('@/lib/library/loadArtistDetailMultiScope', () => ({
  tryLoadArtistDetailMultiScope: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/store/useBrowseLibraryScope', () => ({
  useBrowseLibraryScope: () => browseScope,
}));

vi.mock('@/lib/api/subsonicClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/subsonicClient')>();
  return {
    ...actual,
    librarySelectionForServer: (...args: unknown[]) => librarySelectionForServerMock(...args),
  };
});

vi.mock('@/features/offline', () => ({
  resolveAlbum: (...args: unknown[]) => resolveAlbumMock(...args),
  resolveArtist: vi.fn().mockResolvedValue(null),
  loadAlbumFromLibraryIndex: vi.fn(),
  loadArtistFromLibraryIndex: vi.fn(),
  loadArtistFromLocalPlayback: vi.fn(),
  useOfflineBrowseContext: () => ({ active: false }),
}));

vi.mock('@/lib/library/libraryReady', () => ({
  libraryIsReady: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForActiveServer: () => true,
  shouldAttemptSubsonicForServer: () => true,
}));

import { useAlbumDetailData } from './useAlbumDetailData';

function routerWrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children);
}

describe('useAlbumDetailData — multi-library selection', () => {
  beforeEach(() => {
    tryLoadAlbumDetailMultiScopeMock.mockReset();
    resolveAlbumMock.mockReset();
    librarySelectionForServerMock.mockReset();
    browseScope = {
      pairs: [{ serverId: 'srv-1', libraryId: 'lib-a' }, { serverId: 'srv-2', libraryId: null }],
      fingerprint: 'multi',
      anchorServerId: 'srv-1',
      configuredServerIds: ['srv-1', 'srv-2'],
      multiServer: true,
    };
    useAuthStore.setState({
      activeServerId: 'srv-1',
      servers: [{ id: 'srv-1', name: 'S', url: 'https://s.test', username: 'u', password: 'p' }],
      favoritesOfflineEnabled: false,
      musicLibrarySelectionByServer: { 'srv-1': ['lib-a', 'lib-b'] },
      musicLibraryFilterVersion: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads via tryLoadAlbumDetailMultiScope when more than one library is selected', async () => {
    tryLoadAlbumDetailMultiScopeMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Merged', artistId: 'art-1', songs: [] },
      songs: [{ id: 'trk-1', title: 'One' }],
    });
    librarySelectionForServerMock.mockReturnValue(['lib-a', 'lib-b']);

    const { result } = renderHook(() => useAlbumDetailData('alb-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadAlbumDetailMultiScopeMock).toHaveBeenCalledWith('srv-1', 'alb-1', browseScope.pairs);
    expect(resolveAlbumMock).not.toHaveBeenCalled();
    expect(result.current.album?.album).toMatchObject({ id: 'alb-1', name: 'Merged' });
    expect(result.current.album?.songs).toHaveLength(1);
  });

  it('loads via tryLoadAlbumDetailMultiScope when one library is selected', async () => {
    tryLoadAlbumDetailMultiScopeMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Scoped', artistId: 'art-1', songs: [] },
      songs: [{ id: 'trk-1', title: 'One' }],
    });
    librarySelectionForServerMock.mockReturnValue(['sampler']);

    const { result } = renderHook(() => useAlbumDetailData('alb-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadAlbumDetailMultiScopeMock).toHaveBeenCalledWith('srv-1', 'alb-1', browseScope.pairs);
    expect(resolveAlbumMock).not.toHaveBeenCalled();
    expect(result.current.album?.album).toMatchObject({ name: 'Scoped' });
  });

  it('does not call tryLoadAlbumDetailMultiScope when all libraries are selected', async () => {
    browseScope = {
      pairs: [],
      fingerprint: 'single',
      anchorServerId: 'srv-1',
      configuredServerIds: ['srv-1'],
      multiServer: false,
    };
    librarySelectionForServerMock.mockReturnValue([]);
    resolveAlbumMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Single' },
      songs: [],
    });

    const { result } = renderHook(() => useAlbumDetailData('alb-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadAlbumDetailMultiScopeMock).not.toHaveBeenCalled();
    expect(resolveAlbumMock).toHaveBeenCalled();
    expect(result.current.album?.album).toMatchObject({ id: 'alb-1', name: 'Single' });
  });

  it('does not fall through to network when multi-server scope load returns null', async () => {
    librarySelectionForServerMock.mockReturnValue(['lib-a', 'lib-b']);
    tryLoadAlbumDetailMultiScopeMock.mockResolvedValue(null);
    resolveAlbumMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Fallback' },
      songs: [],
    });

    const { result } = renderHook(() => useAlbumDetailData('alb-1'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(tryLoadAlbumDetailMultiScopeMock).toHaveBeenCalled();
    expect(resolveAlbumMock).not.toHaveBeenCalled();
    expect(result.current.album).toBeNull();
  });
});
