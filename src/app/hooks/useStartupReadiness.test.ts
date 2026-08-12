import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStartupReadiness } from './useStartupReadiness';

const bindMock = vi.hoisted(() => vi.fn());
const startInitialSyncsMock = vi.hoisted(() => vi.fn());
const hydrateMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/library/librarySession', () => ({
  bindAllIndexedServers: bindMock,
  startInitialSyncsForBoundServers: startInitialSyncsMock,
}));
vi.mock('@/features/playback/store/queueRestore', () => ({
  hydrateQueueFromIndex: hydrateMock,
}));
vi.mock('@/features/playback/store/startupPlayQueueReconcile', () => ({
  reconcileStartupPlayQueues: reconcileMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('useStartupReadiness', () => {
  beforeEach(() => {
    bindMock.mockReset().mockResolvedValue({});
    startInitialSyncsMock.mockReset().mockResolvedValue(undefined);
    hydrateMock.mockReset().mockResolvedValue(undefined);
    reconcileMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not release startup work until bootstrap and canonical reconciliation finish', async () => {
    const bootstrap = deferred<Record<string, string>>();
    bindMock.mockReturnValue(bootstrap.promise);
    const { result } = renderHook(() => useStartupReadiness({
      migrationReady: true,
      activeServerId: 'srv-a',
      serverIdsKey: 'srv-a',
      masterEnabled: true,
      migrationRevision: 0,
    }));

    expect(result.current).toBe(false);
    await waitFor(() => expect(bindMock).toHaveBeenCalledOnce());
    expect(hydrateMock).not.toHaveBeenCalled();

    bootstrap.resolve({ 'a.test': 'bound' });
    await waitFor(() => expect(result.current).toBe(true));
    expect(hydrateMock).toHaveBeenCalledOnce();
    expect(reconcileMock).toHaveBeenCalledOnce();
    expect(startInitialSyncsMock).toHaveBeenCalledWith({ 'a.test': 'bound' });
  });

  it('resets immediately when migration blocks again and ignores the stale bootstrap completion', async () => {
    const bootstrap = deferred<Record<string, string>>();
    bindMock.mockReturnValueOnce(bootstrap.promise).mockResolvedValue({});
    const { result, rerender } = renderHook(
      ({ migrationReady, migrationRevision }) => useStartupReadiness({
        migrationReady,
        activeServerId: 'srv-a',
        serverIdsKey: 'srv-a',
        masterEnabled: true,
        migrationRevision,
      }),
      { initialProps: { migrationReady: true, migrationRevision: 0 } },
    );
    await waitFor(() => expect(bindMock).toHaveBeenCalledOnce());

    rerender({ migrationReady: false, migrationRevision: 1 });
    expect(result.current).toBe(false);
    bootstrap.resolve({ 'a.test': 'bound' });
    await Promise.resolve();
    expect(hydrateMock).not.toHaveBeenCalled();

    rerender({ migrationReady: true, migrationRevision: 1 });
    await waitFor(() => expect(result.current).toBe(true));
    expect(bindMock).toHaveBeenCalledTimes(2);
  });

  it('becomes ready while initial sync remains pending', async () => {
    const initialSync = deferred<void>();
    bindMock.mockResolvedValue({ 'a.test': 'bound' });
    startInitialSyncsMock.mockReturnValue(initialSync.promise);

    const { result } = renderHook(() => useStartupReadiness({
      migrationReady: true,
      activeServerId: 'srv-a',
      serverIdsKey: 'srv-a',
      masterEnabled: true,
      migrationRevision: 0,
    }));

    await waitFor(() => expect(result.current).toBe(true));
    expect(startInitialSyncsMock).toHaveBeenCalledOnce();
  });

  it('starts a fresh queue reconciliation when the server scope changes', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    reconcileMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ serverIdsKey }) => useStartupReadiness({
        migrationReady: true,
        activeServerId: 'srv-a',
        serverIdsKey,
        masterEnabled: true,
        migrationRevision: 0,
      }),
      { initialProps: { serverIdsKey: 'srv-a' } },
    );

    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(1));
    const firstOptions = reconcileMock.mock.calls[0]?.[0] as { shouldAbort(): boolean };
    rerender({ serverIdsKey: 'srv-a,srv-b' });

    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2));
    expect(firstOptions.shouldAbort()).toBe(true);
    second.resolve();
    await waitFor(() => expect(result.current).toBe(true));

    first.resolve();
    await Promise.resolve();
    expect(reconcileMock).toHaveBeenCalledTimes(2);
  });

  it('retries one transient startup failure with bounded backoff', async () => {
    vi.useFakeTimers();
    bindMock.mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({});
    const { result } = renderHook(() => useStartupReadiness({
      migrationReady: true,
      activeServerId: 'srv-a',
      serverIdsKey: 'srv-a',
      masterEnabled: true,
      migrationRevision: 0,
    }));

    await vi.waitFor(() => expect(bindMock).toHaveBeenCalledOnce());
    expect(result.current).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(result.current).toBe(true));
    expect(bindMock).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying with capped backoff until startup succeeds', async () => {
    vi.useFakeTimers();
    bindMock
      .mockRejectedValueOnce(new Error('temporary-1'))
      .mockRejectedValueOnce(new Error('temporary-2'))
      .mockRejectedValueOnce(new Error('temporary-3'))
      .mockRejectedValueOnce(new Error('temporary-4'))
      .mockResolvedValue({});
    const { result } = renderHook(() => useStartupReadiness({
      migrationReady: true,
      activeServerId: 'srv-a',
      serverIdsKey: 'srv-a',
      masterEnabled: true,
      migrationRevision: 0,
    }));

    await vi.waitFor(() => expect(bindMock).toHaveBeenCalledTimes(1));
    for (const delay of [250, 500, 1000, 2000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    await vi.waitFor(() => expect(result.current).toBe(true));
    expect(bindMock).toHaveBeenCalledTimes(5);
  });

  it('cancels the pending retry when unmounted', async () => {
    vi.useFakeTimers();
    bindMock.mockRejectedValue(new Error('offline'));
    const { unmount } = renderHook(() => useStartupReadiness({
      migrationReady: true,
      activeServerId: 'srv-a',
      serverIdsKey: 'srv-a',
      masterEnabled: true,
      migrationRevision: 0,
    }));

    await vi.waitFor(() => expect(bindMock).toHaveBeenCalledOnce());
    unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(bindMock).toHaveBeenCalledOnce();
  });
});
