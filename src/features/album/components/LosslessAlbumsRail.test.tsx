import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetLibraryLocalReadSingleFlightsForTests } from '@/lib/library/localReadSingleFlight';

const { localMock, networkMock, authState, revisionState } = vi.hoisted(() => ({
  localMock: vi.fn(),
  networkMock: vi.fn(),
  authState: { activeServerId: 'active' as string | null },
  revisionState: { value: 0 },
}));

vi.mock('@/lib/library/browseTextSearch', () => ({ runLocalLosslessAlbums: localMock }));
vi.mock('@/lib/api/navidromeBrowse', () => ({ ndListLosslessAlbumsPageForServer: networkMock }));
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));
vi.mock('@/store/libraryIndexStore', () => ({
  useLibraryIndexStore: (selector: (state: { masterEnabled: boolean }) => unknown) => selector({ masterEnabled: true }),
}));
vi.mock('@/store/offlineLocalLibrarySyncRevision', () => ({
  useLibraryScopeSyncRevision: () => revisionState.value,
}));
vi.mock('@/features/album/components/AlbumRow', () => ({
  default: ({ albums }: { albums: Array<{ id: string; serverId?: string }> }) => (
    <div data-testid="albums">{albums.map(album => `${album.serverId}:${album.id}`).join('|')}</div>
  ),
}));

import LosslessAlbumsRail from '@/features/album/components/LosslessAlbumsRail';
import { resetLosslessRailCacheForTests } from '@/features/album/components/losslessAlbumsRailCache';

const album = (serverId: string, id: string) => ({
  serverId,
  id,
  name: id,
  artist: 'Artist',
  artistId: 'artist',
  songCount: 1,
  duration: 1,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('LosslessAlbumsRail multi-server scope', () => {
  beforeEach(() => {
    localMock.mockReset();
    networkMock.mockReset();
    resetLibraryLocalReadSingleFlightsForTests();
    resetLosslessRailCacheForTests();
    revisionState.value = 0;
  });

  it('uses equal quotas, local-first fallback, failure isolation, and stable round-robin order', async () => {
    localMock.mockImplementation(async (serverId: string, limit: number) => {
      if (serverId === 'srv-a') {
        return { albums: Array.from({ length: limit }, (_, index) => album(serverId, `a${index + 1}`)), hasMore: false };
      }
      return null;
    });
    networkMock.mockImplementation(async (serverId: string, req: { targetNewAlbums: number }) => {
      if (serverId === 'srv-c') throw new Error('offline');
      return {
        entries: Array.from({ length: req.targetNewAlbums }, (_, index) => ({
          album: album(serverId, `b${index + 1}`), bitDepth: 24, sampleRate: 96000,
        })),
        done: false,
        nextSongOffset: 100,
      };
    });

    const onDiagnosticResult = vi.fn();
    renderWithProviders(
      <LosslessAlbumsRail
        serverIds={['srv-a', 'srv-b', 'srv-c']}
        scopeVersion={4}
        onDiagnosticResult={onDiagnosticResult}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('albums')).toHaveTextContent(
      'srv-a:a1|srv-b:b1|srv-a:a2|srv-b:b2|srv-a:a3|srv-b:b3|srv-a:a4|srv-b:b4|srv-a:a5|srv-b:b5|srv-a:a6|srv-b:b6|srv-a:a7|srv-b:b7',
    ));
    expect(localMock).toHaveBeenNthCalledWith(1, 'srv-a', 7, 0);
    expect(localMock).toHaveBeenNthCalledWith(2, 'srv-b', 7, 0);
    expect(localMock).toHaveBeenNthCalledWith(3, 'srv-c', 6, 0);
    expect(networkMock).not.toHaveBeenCalledWith('srv-a', expect.anything());
    expect(networkMock).toHaveBeenCalledWith('srv-b', {
      targetNewAlbums: 7,
      songsPerPage: 100,
      maxPagesPerCall: 1,
    });
    expect(networkMock).toHaveBeenCalledWith('srv-c', {
      targetNewAlbums: 6,
      songsPerPage: 100,
      maxPagesPerCall: 1,
    });
    expect(onDiagnosticResult).toHaveBeenNthCalledWith(1, { status: 'loading' });
    expect(onDiagnosticResult).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'ready',
      itemCount: 14,
      detail: expect.stringContaining('srv-a:local:'),
      durationMs: expect.any(Number),
    }));
  });

  it('preserves active-server behavior when the scope props are omitted', async () => {
    localMock.mockResolvedValue({ albums: [album('active', 'local')], hasMore: false });

    renderWithProviders(<LosslessAlbumsRail />);

    await waitFor(() => expect(screen.getByTestId('albums')).toHaveTextContent('active:local'));
    expect(localMock).toHaveBeenCalledWith('active', 20, 0);
    expect(networkMock).not.toHaveBeenCalled();
  });

  it('keeps selected-library Home scopes local instead of leaking through the unscoped network fallback', async () => {
    localMock.mockResolvedValue(null);
    const onDiagnosticResult = vi.fn();
    const scopes = [{ serverId: 'srv-a', libraryId: 'library-a' }];

    renderWithProviders(
      <LosslessAlbumsRail
        serverIds={['srv-a']}
        scopeVersion={5}
        scopes={scopes}
        onDiagnosticResult={onDiagnosticResult}
      />,
    );

    await waitFor(() => expect(onDiagnosticResult).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'empty',
      itemCount: 0,
      detail: expect.stringContaining('selected scope'),
    })));
    expect(localMock).toHaveBeenCalledWith('srv-a', 20, 0, scopes);
    expect(networkMock).not.toHaveBeenCalled();
  });

  it('reuses a fresh scope result after remount without another database read', async () => {
    localMock.mockResolvedValue({ albums: [album('srv-a', 'cached')], hasMore: false });
    const first = renderWithProviders(<LosslessAlbumsRail serverIds={['srv-a']} scopeVersion={3} />);
    await waitFor(() => expect(screen.getByTestId('albums')).toHaveTextContent('srv-a:cached'));
    expect(localMock).toHaveBeenCalledTimes(1);
    first.unmount();
    localMock.mockClear();

    const onDiagnosticResult = vi.fn();
    renderWithProviders(
      <LosslessAlbumsRail
        serverIds={['srv-a']}
        scopeVersion={3}
        onDiagnosticResult={onDiagnosticResult}
      />,
    );

    expect(screen.getByTestId('albums')).toHaveTextContent('srv-a:cached');
    await waitFor(() => expect(onDiagnosticResult).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ready',
      durationMs: 0,
      detail: 'cache',
    })));
    expect(localMock).not.toHaveBeenCalled();
  });

  it('reports timeout when every server misses the aggregate deadline', async () => {
    vi.useFakeTimers();
    localMock.mockResolvedValue(null);
    networkMock.mockReturnValue(new Promise(() => undefined));
    const onDiagnosticResult = vi.fn();

    renderWithProviders(
      <LosslessAlbumsRail serverIds={['srv-a']} onDiagnosticResult={onDiagnosticResult} />,
    );
    expect(onDiagnosticResult).toHaveBeenCalledWith({ status: 'loading' });

    await vi.advanceTimersByTimeAsync(4000);

    expect(onDiagnosticResult).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'timeout',
      itemCount: 0,
      detail: 'srv-a:network:4000ms/0',
      durationMs: expect.any(Number),
    }));
    expect(networkMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('falls back to network before the total deadline when the local flight never settles', async () => {
    vi.useFakeTimers();
    localMock.mockReturnValue(new Promise(() => undefined));
    networkMock.mockResolvedValue({
      entries: [{ album: album('srv-a', 'network'), bitDepth: 24, sampleRate: 96000 }],
      done: false,
      nextSongOffset: 100,
    });
    const onDiagnosticResult = vi.fn();
    renderWithProviders(
      <LosslessAlbumsRail serverIds={['srv-a']} onDiagnosticResult={onDiagnosticResult} />,
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(networkMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('albums')).toHaveTextContent('srv-a:network');
    expect(localMock).toHaveBeenCalledTimes(1);
    expect(networkMock).toHaveBeenCalledTimes(1);
    expect(onDiagnosticResult).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'ready',
      itemCount: 1,
    }));
    vi.useRealTimers();
  });

  it('starts a fresh local flight after sync revision and ignores the stale result', async () => {
    const oldLocal = deferred<{ albums: ReturnType<typeof album>[]; hasMore: boolean }>();
    const freshLocal = deferred<{ albums: ReturnType<typeof album>[]; hasMore: boolean }>();
    localMock
      .mockReturnValueOnce(oldLocal.promise)
      .mockReturnValueOnce(freshLocal.promise);
    const view = renderWithProviders(<LosslessAlbumsRail serverIds={['srv-a']} />);
    await waitFor(() => expect(localMock).toHaveBeenCalledTimes(1));

    revisionState.value = 1;
    view.rerender(
      <LosslessAlbumsRail serverIds={['srv-a']} />,
    );
    await waitFor(() => expect(localMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      freshLocal.resolve({ albums: [album('srv-a', 'fresh')], hasMore: false });
    });
    expect(screen.getByTestId('albums')).toHaveTextContent('srv-a:fresh');

    await act(async () => {
      oldLocal.resolve({ albums: [album('srv-a', 'stale')], hasMore: false });
    });
    expect(screen.getByTestId('albums')).toHaveTextContent('srv-a:fresh');
    expect(networkMock).not.toHaveBeenCalled();
  });
});
