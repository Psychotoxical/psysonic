import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { SyncStateDto } from '@/lib/api/library/dto';

const libraryGetStatusMock = vi.fn();

vi.mock('@/lib/api/library', () => ({
  libraryGetStatus: (...args: unknown[]) => libraryGetStatusMock(...args),
  subscribeLibrarySyncIdle: vi.fn(async () => () => {}),
  subscribeLibrarySyncProgress: vi.fn(async () => () => {}),
}));

vi.mock('@/lib/library/liveSearchLocal', () => ({
  LIVE_SEARCH_DEBOUNCE_NETWORK_MS: 500,
  LIVE_SEARCH_DEBOUNCE_RACE_MS: 500,
  EMPTY_SEARCH_RESULTS: { artists: [], albums: [], songs: [] },
  liveSearchQueryRejected: () => false,
  mergeLiveSearchResults: (primary: unknown) => primary,
  runLocalLiveSearch: vi.fn(async () => null),
  runNetworkLiveSearch: vi.fn(async () => null),
}));

vi.mock('@/lib/library/searchRace', () => ({
  raceLiveSearch: vi.fn(async () => null),
}));

vi.mock('@/lib/library/liveSearchDebug', () => ({
  emitLiveSearchDebug: vi.fn(),
  searchHitCounts: () => 0,
  searchResultSamples: () => [],
}));

vi.mock('@/lib/library/libraryDevLog', () => ({
  logLibrarySearch: vi.fn(),
}));

vi.mock('@/lib/dom/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/features/search/components/liveSearchScope', () => ({
  isLiveSearchDropdownBlocked: () => false,
}));

import { useLiveSearchQuery } from './useLiveSearchQuery';

function buildingStatus(): SyncStateDto {
  return {
    serverId: 'srv-1',
    syncPhase: 'initial_sync',
    localTrackCount: 10,
    serverTrackCount: 1000,
  } as SyncStateDto;
}

function readyStatus(): SyncStateDto {
  return {
    serverId: 'srv-1',
    syncPhase: 'ready',
    localTrackCount: 1000,
    serverTrackCount: 1000,
  } as SyncStateDto;
}

function hookParams() {
  return {
    query: '',
    scope: null,
    shareMatch: null,
    liveSearchGenRef: { current: 0 },
    setResults: vi.fn(),
    setOpen: vi.fn(),
    setLoading: vi.fn(),
    setSearchSource: vi.fn(),
    setActiveIndex: vi.fn(),
  };
}

describe('useLiveSearchQuery indexIncomplete', () => {
  beforeEach(() => {
    libraryGetStatusMock.mockReset();
    useAuthStore.setState({
      activeServerId: 'srv-1',
      servers: [{ id: 'srv-1', name: 'S', url: 'https://s.test', username: 'u', password: 'p' }],
      musicLibraryFilterVersion: 0,
    });
    useLibraryIndexStore.setState({ masterEnabled: true });
  });

  it('is true while the active server index is still building', async () => {
    libraryGetStatusMock.mockResolvedValue(buildingStatus());

    const { result } = renderHook(() => useLiveSearchQuery(hookParams()));

    await waitFor(() => expect(result.current.indexIncomplete).toBe(true));
    expect(libraryGetStatusMock).toHaveBeenCalledWith('srv-1');
  });

  it('is false when the active server index is ready', async () => {
    libraryGetStatusMock.mockResolvedValue(readyStatus());

    const { result } = renderHook(() => useLiveSearchQuery(hookParams()));

    await waitFor(() => expect(result.current.indexIncomplete).toBe(false));
  });
});
