// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useSongBrowseList } from '@/features/search/hooks/useSongBrowseList';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { runLocalSongScopeBrowse } from '@/lib/library/advancedSearchLocal';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { clearSongBrowsePageCache } from '@/features/search/hooks/songBrowsePageCache';

const { browseScopeState, readyLibraryServerKeysMock, revisionState } = vi.hoisted(() => ({
  browseScopeState: {
    anchorServerId: 'srv-1' as string | null,
    serverIds: ['srv-1'] as string[],
    pairs: [] as Array<{ serverId: string; libraryId: string }>,
    multiServer: false,
    fingerprint: 'srv-1',
  },
  readyLibraryServerKeysMock: vi.fn(),
  revisionState: { value: 0 },
}));

vi.mock('@/lib/api/subsonicSearch', () => ({
  searchSongsPaged: vi.fn(async () => []),
}));

vi.mock('@/lib/api/navidromeBrowse', () => ({
  ndListSongs: vi.fn(async () => []),
}));

vi.mock('@/lib/library/advancedSearchLocal', () => ({
  runLocalSongBrowse: vi.fn(async () => []),
  runLocalSongScopeBrowse: vi.fn(async () => null),
}));

// Only the reload-token hook was stubbed pre-move (its own module); mock that
// submodule directly so the barrel re-exports the stub while the real
// `useOfflineBrowseContext` (a different submodule) stays live.
vi.mock('@/features/offline/hooks/useOfflineBrowseReloadToken', () => ({
  useOfflineBrowseReloadToken: () => undefined,
}));

vi.mock('@/features/offline/hooks/useOfflineBrowseContext', () => ({
  useOfflineBrowseContext: () => ({ active: false }),
}));

vi.mock('@/lib/library/browseTextSearch', () => ({
  BROWSE_TEXT_DEBOUNCE_NETWORK_MS: 10,
  BROWSE_TEXT_DEBOUNCE_RACE_MS: 10,
  browseRaceCountsSongs: vi.fn(),
  loadMoreLocalBrowseSongs: vi.fn(async () => []),
  raceBrowseWithLocalFallback: vi.fn(async () => null),
  runLocalBrowseSongPage: vi.fn(async () => []),
  runNetworkBrowseSongPage: vi.fn(async () => [{ id: 'fresh' } as SubsonicSong]),
}));

vi.mock('@/lib/library/libraryReady', () => ({
  readyLibraryServerKeys: readyLibraryServerKeysMock,
}));

vi.mock('@/lib/library/libraryBrowseScope', () => ({
  getLibraryBrowseScope: () => browseScopeState,
  setLibraryBrowseScopeSource: vi.fn(),
}));

vi.mock('@/store/offlineLocalLibrarySyncRevision', () => ({
  useLibraryScopeSyncRevision: () => revisionState.value,
  useOfflineLocalLibrarySyncRevision: () => 0,
}));

const stashedSong = { id: 'stashed', title: 'Stashed', artist: 'A', duration: 180 } as SubsonicSong;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function seedMultiServerScope() {
  browseScopeState.anchorServerId = 'a';
  browseScopeState.serverIds = ['a', 'b'];
  browseScopeState.pairs = [
    { serverId: 'a', libraryId: 'lib-a' },
    { serverId: 'b', libraryId: 'lib-b' },
  ];
  browseScopeState.multiServer = true;
  browseScopeState.fingerprint = 'a,b';
  useAuthStore.setState({
    activeServerId: 'a',
    servers: [
      { id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
      { id: 'b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
    ],
    libraryBrowseServerIds: ['a', 'b'],
    musicFoldersByServer: {
      a: [{ id: 'lib-a', name: 'A' }],
      b: [{ id: 'lib-b', name: 'B' }],
    },
    libraryBrowseSelectionByServer: {},
  });
}

describe('useSongBrowseList restore hold', () => {
  beforeEach(() => {
    clearSongBrowsePageCache();
    resetAuthStore();
    useAuthStore.setState({ activeServerId: 'srv-1' });
    useLibraryIndexStore.setState({ masterEnabled: true });
    vi.mocked(runLocalSongScopeBrowse).mockReset().mockResolvedValue(null);
    readyLibraryServerKeysMock.mockReset().mockResolvedValue(['srv-1']);
    revisionState.value = 0;
    browseScopeState.serverIds = ['srv-1'];
    browseScopeState.anchorServerId = 'srv-1';
    browseScopeState.pairs = [];
    browseScopeState.multiServer = false;
    browseScopeState.fingerprint = 'srv-1';
  });

  it('keeps stashed songs after fetchSongPage identity changes until query edits', async () => {
    const { result, rerender } = renderHook(
      ({ searchQuery }) => useSongBrowseList({
        enabled: true,
        searchQuery,
        initialRestore: {
          browseScopeFingerprint: 'srv-1',
          librarySyncRevision: 0,
          query: 'jazz',
          songs: [stashedSong],
          offset: 1,
          hasMore: false,
          browseCursor: null,
          localSearchMode: true,
          browseUnsupported: false,
          hasSearched: true,
        },
      }),
      { initialProps: { searchQuery: 'jazz' } },
    );

    expect(result.current.songs).toEqual([stashedSong]);

    rerender({ searchQuery: 'jazz' });
    await waitFor(() => {
      expect(result.current.songs).toEqual([stashedSong]);
    }, { timeout: 500 });

    rerender({ searchQuery: 'jazzx' });
    await waitFor(() => {
      expect(result.current.songs[0]?.id).toBe('fresh');
    }, { timeout: 500 });
  });

  it('discards a restored cursor and songs when the browse scope changed', async () => {
    const { result } = renderHook(() => useSongBrowseList({
      enabled: true,
      searchQuery: '',
      initialRestore: {
        browseScopeFingerprint: 'old-scope',
        librarySyncRevision: 0,
        query: '',
        songs: [stashedSong],
        offset: 50,
        hasMore: true,
        browseCursor: 'old-cursor',
        localSearchMode: true,
        browseUnsupported: false,
        hasSearched: true,
      },
    }));

    await waitFor(() => expect(runLocalSongScopeBrowse).toHaveBeenCalled());
    expect(result.current.songs).not.toContainEqual(stashedSong);
    expect(result.current.browseCursor).toBeNull();
  });

  it('discards a valid restore when its scope or sync revision changes after mount', async () => {
    vi.mocked(runLocalSongScopeBrowse).mockResolvedValue({
      songs: [{ id: 'fresh', title: 'Fresh' } as SubsonicSong],
      hasMore: false,
      nextCursor: null,
    });
    const view = renderHook(() => useSongBrowseList({
      enabled: true,
      searchQuery: '',
      initialRestore: {
        browseScopeFingerprint: 'srv-1',
        librarySyncRevision: 0,
        query: '',
        songs: [stashedSong],
        offset: 50,
        hasMore: true,
        browseCursor: 'old-cursor',
        localSearchMode: true,
        browseUnsupported: false,
        hasSearched: true,
      },
    }));
    expect(view.result.current.songs).toEqual([stashedSong]);

    browseScopeState.fingerprint = 'srv-1:new-library';
    revisionState.value = 1;
    view.rerender();

    await waitFor(() => expect(view.result.current.songs.map(song => song.id)).toEqual(['fresh']));
    expect(view.result.current.resultBrowseScopeFingerprint).toBe('srv-1:new-library');
    expect(view.result.current.resultLibrarySyncRevision).toBe(1);
    expect(runLocalSongScopeBrowse).toHaveBeenCalledWith(
      'srv-1',
      50,
      null,
      expect.objectContaining({ fingerprint: 'srv-1:new-library' }),
    );
  });
});

describe('useSongBrowseList scoped browse', () => {
  beforeEach(() => {
    clearSongBrowsePageCache();
    resetAuthStore();
    useAuthStore.setState({ activeServerId: 'srv-1' });
    useLibraryIndexStore.setState({ masterEnabled: true });
    vi.mocked(runLocalSongScopeBrowse).mockReset();
    readyLibraryServerKeysMock.mockReset().mockResolvedValue(['srv-1']);
    revisionState.value = 0;
    browseScopeState.serverIds = ['srv-1'];
    browseScopeState.anchorServerId = 'srv-1';
    browseScopeState.pairs = [];
    browseScopeState.multiServer = false;
    browseScopeState.fingerprint = 'srv-1';
  });

  it('does not fall back to the active server when the effective scope is empty', async () => {
    browseScopeState.anchorServerId = null;
    browseScopeState.serverIds = [];
    browseScopeState.pairs = [];
    browseScopeState.fingerprint = '';

    const { result } = renderHook(() => useSongBrowseList({ enabled: true, searchQuery: '' }));

    await waitFor(() => expect(result.current.hasSearched).toBe(true));
    expect(result.current.songs).toEqual([]);
    expect(result.current.browseUnsupported).toBe(true);
    expect(runLocalSongScopeBrowse).not.toHaveBeenCalled();
  });

  it('continues the ordinary Tracks catalogue with its opaque scoped cursor', async () => {
    vi.mocked(runLocalSongScopeBrowse)
      .mockResolvedValueOnce({
        songs: [{ id: 'one', title: 'One', artist: 'A', duration: 60 } as SubsonicSong],
        hasMore: true,
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        songs: [{ id: 'two', title: 'Two', artist: 'A', duration: 60 } as SubsonicSong],
        hasMore: false,
        nextCursor: null,
      });
    const { result } = renderHook(() => useSongBrowseList({ enabled: true, searchQuery: '' }));

    await waitFor(() => expect(result.current.songs.map(song => song.id)).toEqual(['one']));
    void result.current.loadMore();
    await waitFor(() => expect(result.current.songs.map(song => song.id)).toEqual(['one', 'two']));
    expect(runLocalSongScopeBrowse).toHaveBeenNthCalledWith(
      1,
      'srv-1',
      50,
      null,
      expect.objectContaining({ anchorServerId: 'srv-1' }),
    );
    expect(runLocalSongScopeBrowse).toHaveBeenNthCalledWith(
      2,
      'srv-1',
      50,
      'cursor-1',
      expect.objectContaining({ anchorServerId: 'srv-1' }),
    );
    expect(result.current.hasMore).toBe(false);
  });

  it('reuses a resolved local first page on a warm remount', async () => {
    seedMultiServerScope();
    readyLibraryServerKeysMock.mockResolvedValue(['a.test', 'b.test']);
    vi.mocked(runLocalSongScopeBrowse).mockResolvedValue({
      songs: [{ id: 'cached', title: 'Cached' } as SubsonicSong],
      hasMore: true,
      nextCursor: 'cursor-1',
    });

    const first = renderHook(() => useSongBrowseList({ enabled: true, searchQuery: '' }));
    await waitFor(() => expect(first.result.current.songs.map(song => song.id)).toEqual(['cached']));
    first.unmount();

    const second = renderHook(() => useSongBrowseList({ enabled: true, searchQuery: '' }));
    await waitFor(() => expect(second.result.current.songs.map(song => song.id)).toEqual(['cached']));

    expect(runLocalSongScopeBrowse).toHaveBeenCalledTimes(1);
    expect(second.result.current.browseCursor).toBe('cursor-1');
  });

  it('retries when multi-server readiness changes during the first page request', async () => {
    seedMultiServerScope();
    readyLibraryServerKeysMock.mockResolvedValue(['a.test', 'b.test']);
    vi.mocked(runLocalSongScopeBrowse)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        songs: [{ id: 'ready', title: 'Ready' } as SubsonicSong],
        hasMore: false,
        nextCursor: null,
      });

    const { result } = renderHook(() => useSongBrowseList({ enabled: true, searchQuery: '' }));

    await waitFor(() => expect(result.current.songs.map(song => song.id)).toEqual(['ready']));
    expect(runLocalSongScopeBrowse).toHaveBeenCalledTimes(2);
  });

  it('retries a transient readiness change when the sentinel loads the next page', async () => {
    seedMultiServerScope();
    readyLibraryServerKeysMock.mockResolvedValue(['a.test', 'b.test']);
    vi.mocked(runLocalSongScopeBrowse)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        songs: [{ id: 'next', title: 'Next' } as SubsonicSong],
        hasMore: false,
        nextCursor: null,
      });
    const { result } = renderHook(() => useSongBrowseList({
      enabled: true,
      searchQuery: '',
      initialRestore: {
        browseScopeFingerprint: 'a,b',
        librarySyncRevision: 0,
        query: '',
        songs: [stashedSong],
        offset: 1,
        hasMore: true,
        browseCursor: null,
        localSearchMode: true,
        browseUnsupported: false,
        hasSearched: true,
      },
    }));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.songs.map(song => song.id)).toEqual(['stashed', 'next']);
    expect(runLocalSongScopeBrowse).toHaveBeenCalledTimes(2);
  });

  it('preserves multi-server results until every selected index is ready', async () => {
    seedMultiServerScope();
    readyLibraryServerKeysMock.mockResolvedValue(['a.test', 'b.test']);
    vi.mocked(runLocalSongScopeBrowse)
      .mockResolvedValueOnce({
        songs: [{ id: 'current', title: 'Current' } as SubsonicSong],
        hasMore: false,
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        songs: [{ id: 'fresh', title: 'Fresh' } as SubsonicSong],
        hasMore: false,
        nextCursor: null,
      });
    const view = renderHook(() => useSongBrowseList({ enabled: true, searchQuery: '' }));
    await waitFor(() => expect(view.result.current.songs.map(song => song.id)).toEqual(['current']));

    readyLibraryServerKeysMock.mockResolvedValue(null);
    revisionState.value = 1;
    view.rerender();
    await waitFor(() => expect(readyLibraryServerKeysMock).toHaveBeenLastCalledWith(['a', 'b']));
    expect(view.result.current.songs.map(song => song.id)).toEqual(['current']);
    expect(runLocalSongScopeBrowse).toHaveBeenCalledTimes(1);

    readyLibraryServerKeysMock.mockResolvedValue(['a.test', 'b.test']);
    revisionState.value = 2;
    view.rerender();
    await waitFor(() => expect(view.result.current.songs.map(song => song.id)).toEqual(['fresh']));
    expect(runLocalSongScopeBrowse).toHaveBeenCalledTimes(2);
  });

  it('rekeys browse inflight work on sync revision and ignores the stale settlement', async () => {
    seedMultiServerScope();
    readyLibraryServerKeysMock.mockResolvedValue(['a.test', 'b.test']);
    const oldPage = deferred<{ songs: SubsonicSong[]; hasMore: boolean; nextCursor: string | null }>();
    const freshPage = deferred<{ songs: SubsonicSong[]; hasMore: boolean; nextCursor: string | null }>();
    vi.mocked(runLocalSongScopeBrowse)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(freshPage.promise);
    const view = renderHook(() => useSongBrowseList({ enabled: true, searchQuery: '' }));
    await waitFor(() => expect(runLocalSongScopeBrowse).toHaveBeenCalledTimes(1));

    revisionState.value = 1;
    view.rerender();
    await waitFor(() => expect(runLocalSongScopeBrowse).toHaveBeenCalledTimes(2));
    await act(async () => {
      freshPage.resolve({
        songs: [{ id: 'fresh', title: 'Fresh' } as SubsonicSong],
        hasMore: false,
        nextCursor: null,
      });
    });
    expect(view.result.current.songs.map(song => song.id)).toEqual(['fresh']);

    await act(async () => {
      oldPage.resolve({
        songs: [{ id: 'stale', title: 'Stale' } as SubsonicSong],
        hasMore: false,
        nextCursor: null,
      });
    });
    expect(view.result.current.songs.map(song => song.id)).toEqual(['fresh']);
  });
});
