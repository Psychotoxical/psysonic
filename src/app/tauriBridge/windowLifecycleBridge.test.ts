import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emitTauriEvent,
  listenMock,
  tauriMockListenerCount,
} from '@/test/mocks/tauri';

const defaultListenImplementation = listenMock.getMockImplementation();

const mocks = vi.hoisted(() => ({
  minimizeToTray: true,
  authSubscribers: new Set<(state: { minimizeToTray: boolean }, previous: { minimizeToTray: boolean }) => void>(),
  windowLifecycleBegin: vi.fn(async (_args: { generation: number; attempt: number }) => undefined),
  windowLifecycleFallback: vi.fn(async (_args: { generation: number; attempt: number; minimizeToTray: boolean }) => undefined),
  windowLifecycleGeneration: vi.fn(async () => 7),
  windowLifecycleHide: vi.fn(async (_args: { generation: number; transition: number }) => true),
  windowLifecycleReady: vi.fn(async (_args: { generation: number; attempt: number; minimizeToTray: boolean }) => undefined),
  windowLifecycleUpdateFallbackPolicy: vi.fn(async (_args: { generation: number; minimizeToTray: boolean }) => undefined),
  exitApp: vi.fn(async () => undefined),
  finalize: vi.fn(async () => undefined),
  reportStopped: vi.fn(async () => undefined),
  flushQueue: vi.fn(async () => undefined),
}));

vi.mock('@/app/windowKind', () => ({
  getWindowKind: () => 'main',
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => ({ minimizeToTray: mocks.minimizeToTray }),
    subscribe: (subscriber: (state: { minimizeToTray: boolean }, previous: { minimizeToTray: boolean }) => void) => {
      mocks.authSubscribers.add(subscriber);
      return () => mocks.authSubscribers.delete(subscriber);
    },
  },
}));

vi.mock('@/features/orbit', () => ({
  useOrbitStore: { getState: () => ({ role: 'none' }) },
  endOrbitSession: vi.fn(async () => undefined),
  leaveOrbitSession: vi.fn(async () => undefined),
}));

vi.mock('@/features/playback/store/playListenSession', () => ({
  playListenSessionFinalize: mocks.finalize,
}));

vi.mock('@/features/playback/store/playbackReportSession', () => ({
  playbackReportStopped: mocks.reportStopped,
}));

vi.mock('@/features/playback/store/queueSync', () => ({
  flushPlayQueuePosition: mocks.flushQueue,
}));

vi.mock('@/lib/api/platformShell', () => ({
  exitApp: mocks.exitApp,
  windowLifecycleBegin: mocks.windowLifecycleBegin,
  windowLifecycleFallback: mocks.windowLifecycleFallback,
  windowLifecycleGeneration: mocks.windowLifecycleGeneration,
  windowLifecycleHide: mocks.windowLifecycleHide,
  windowLifecycleReady: mocks.windowLifecycleReady,
  windowLifecycleUpdateFallbackPolicy: mocks.windowLifecycleUpdateFallbackPolicy,
}));

import {
  _resetWindowLifecycleBridgeForTest,
  setupWindowLifecycleBridge,
} from './windowLifecycleBridge';

describe('windowLifecycleBridge', () => {
  beforeEach(() => {
    _resetWindowLifecycleBridgeForTest();
    listenMock.mockReset().mockImplementation(defaultListenImplementation!);
    mocks.authSubscribers.clear();
    mocks.minimizeToTray = true;
    mocks.windowLifecycleBegin.mockReset().mockResolvedValue(undefined);
    mocks.windowLifecycleFallback.mockReset().mockResolvedValue(undefined);
    mocks.windowLifecycleGeneration.mockReset().mockResolvedValue(7);
    mocks.windowLifecycleHide.mockReset().mockResolvedValue(true);
    mocks.windowLifecycleReady.mockReset().mockResolvedValue(undefined);
    mocks.windowLifecycleUpdateFallbackPolicy.mockReset().mockResolvedValue(undefined);
    mocks.exitApp.mockReset().mockResolvedValue(undefined);
    mocks.finalize.mockReset().mockResolvedValue(undefined);
    mocks.reportStopped.mockReset().mockResolvedValue(undefined);
    mocks.flushQueue.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    _resetWindowLifecycleBridgeForTest();
    delete window.__psyLifecycleGeneration;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers close first, acknowledges readiness, and handles both close policies', async () => {
    await setupWindowLifecycleBridge();

    expect(listenMock.mock.calls.map(call => call[0])).toEqual([
      'window:close-requested',
      'app:force-quit',
    ]);
    expect(mocks.windowLifecycleReady).toHaveBeenCalledTimes(1);
    expect(mocks.windowLifecycleReady).toHaveBeenCalledWith({
      generation: 7,
      attempt: expect.any(Number),
      minimizeToTray: true,
    });

    emitTauriEvent('window:close-requested', 11);
    await vi.waitFor(() => expect(mocks.windowLifecycleHide).toHaveBeenCalledWith({
      generation: 7,
      transition: 11,
    }));

    mocks.minimizeToTray = false;
    emitTauriEvent('window:close-requested', 12);
    await vi.waitFor(() => expect(mocks.exitApp).toHaveBeenCalledTimes(1));
    expect(mocks.finalize).toHaveBeenCalledWith('close');
    expect(mocks.reportStopped).toHaveBeenCalledTimes(1);
    expect(mocks.flushQueue).toHaveBeenCalledTimes(1);
  });

  it('cleans up a partial registration and retries before acknowledging readiness', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defaultListen = listenMock.getMockImplementation();
    expect(defaultListen).toBeTypeOf('function');
    listenMock
      .mockImplementationOnce(defaultListen!)
      .mockRejectedValueOnce(new Error('force listener unavailable'));

    const setup = setupWindowLifecycleBridge();
    await vi.advanceTimersByTimeAsync(0);

    expect(tauriMockListenerCount('window:close-requested')).toBe(0);
    expect(mocks.windowLifecycleReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await setup;

    expect(tauriMockListenerCount('window:close-requested')).toBe(1);
    expect(tauriMockListenerCount('app:force-quit')).toBe(1);
    expect(mocks.windowLifecycleReady).toHaveBeenCalledTimes(1);
  });

  it('enables the native fallback after bounded listener retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    listenMock.mockRejectedValue(new Error('listener unavailable'));

    const setup = setupWindowLifecycleBridge();
    await vi.runAllTimersAsync();
    await setup;

    expect(listenMock).toHaveBeenCalledTimes(4);
    expect(mocks.windowLifecycleReady).not.toHaveBeenCalled();
    expect(mocks.windowLifecycleFallback).toHaveBeenCalledWith({
      generation: 7,
      attempt: expect.any(Number),
      minimizeToTray: true,
    });
    const listenerAttempts = mocks.windowLifecycleBegin.mock.calls.map(call => call[0].attempt);
    const fallbackAttempt = mocks.windowLifecycleFallback.mock.calls[0]?.[0].attempt;
    expect(fallbackAttempt).toBeGreaterThan(Math.max(...listenerAttempts));

    const previous = { minimizeToTray: true };
    mocks.minimizeToTray = false;
    for (const subscriber of mocks.authSubscribers) {
      subscriber({ minimizeToTray: false }, previous);
    }
    await vi.waitFor(() => {
      expect(mocks.windowLifecycleUpdateFallbackPolicy).toHaveBeenCalledWith({
        generation: 7,
        minimizeToTray: false,
      });
    });
  });

  it('applies a policy change queued during fallback preparation before activation', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    listenMock.mockRejectedValue(new Error('listener unavailable'));
    const policyResolvers: Array<() => void> = [];
    mocks.windowLifecycleUpdateFallbackPolicy.mockImplementation(() => (
      new Promise<undefined>(resolve => policyResolvers.push(() => resolve(undefined)))
    ));

    const setup = setupWindowLifecycleBridge();
    await vi.advanceTimersByTimeAsync(700);
    expect(mocks.windowLifecycleUpdateFallbackPolicy).toHaveBeenCalledWith({
      generation: 7,
      minimizeToTray: true,
    });
    expect(mocks.windowLifecycleFallback).not.toHaveBeenCalled();

    const previous = { minimizeToTray: true };
    mocks.minimizeToTray = false;
    for (const subscriber of mocks.authSubscribers) {
      subscriber({ minimizeToTray: false }, previous);
    }
    policyResolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.windowLifecycleUpdateFallbackPolicy).toHaveBeenLastCalledWith({
      generation: 7,
      minimizeToTray: false,
    });
    expect(mocks.windowLifecycleFallback).not.toHaveBeenCalled();

    policyResolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    await setup;

    const policyCallOrder = mocks.windowLifecycleUpdateFallbackPolicy.mock.invocationCallOrder;
    expect(policyCallOrder[policyCallOrder.length - 1])
      .toBeLessThan(mocks.windowLifecycleFallback.mock.invocationCallOrder[0]!);
    expect(mocks.windowLifecycleFallback).toHaveBeenCalledWith({
      generation: 7,
      attempt: expect.any(Number),
      minimizeToTray: false,
    });
  });

  it('activates native fallback with the current policy when policy sync times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    listenMock.mockRejectedValue(new Error('listener unavailable'));
    mocks.windowLifecycleUpdateFallbackPolicy.mockImplementation(() => new Promise(() => {}));

    const setup = setupWindowLifecycleBridge();
    await vi.runAllTimersAsync();
    await setup;

    expect(mocks.windowLifecycleFallback).toHaveBeenCalledWith({
      generation: 7,
      attempt: expect.any(Number),
      minimizeToTray: true,
    });
  });

  it('reports a rejected close-to-tray hide and allows a newer transition', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.windowLifecycleHide.mockRejectedValueOnce(new Error('hide failed'));
    await setupWindowLifecycleBridge();

    emitTauriEvent('window:close-requested', 21);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    emitTauriEvent('window:close-requested', 22);

    await vi.waitFor(() => expect(mocks.windowLifecycleHide).toHaveBeenCalledTimes(2));
    expect(mocks.windowLifecycleHide).toHaveBeenLastCalledWith({
      generation: 7,
      transition: 22,
    });
  });

  it('continues best-effort cleanup and retries a rejected exit', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.minimizeToTray = false;
    mocks.finalize.mockRejectedValueOnce(new Error('finalize failed'));
    mocks.exitApp.mockRejectedValueOnce(new Error('exit failed'));
    await setupWindowLifecycleBridge();

    emitTauriEvent('app:force-quit', undefined);
    await vi.waitFor(() => expect(mocks.exitApp).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalled();

    emitTauriEvent('window:close-requested', 31);
    await vi.waitFor(() => expect(mocks.exitApp).toHaveBeenCalledTimes(2));
  });

  it('allows another exit attempt when the native exit invoke never settles', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.minimizeToTray = false;
    mocks.exitApp.mockImplementation(() => new Promise(() => {}));
    await setupWindowLifecycleBridge();

    emitTauriEvent('app:force-quit', undefined);
    await vi.advanceTimersByTimeAsync(1600);
    emitTauriEvent('window:close-requested', 32);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.exitApp).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate a timed-out hide for the same transition', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.windowLifecycleHide.mockImplementation(() => new Promise(() => {}));
    await setupWindowLifecycleBridge();

    emitTauriEvent('window:close-requested', 41);
    await vi.advanceTimersByTimeAsync(1600);
    emitTauriEvent('window:close-requested', 41);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.windowLifecycleHide).toHaveBeenCalledTimes(1);
  });

  it('starts a newer fenced hide while an older transition remains unresolved', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.windowLifecycleHide.mockImplementation(() => new Promise(() => {}));
    await setupWindowLifecycleBridge();

    emitTauriEvent('window:close-requested', 51);
    await vi.advanceTimersByTimeAsync(1600);
    emitTauriEvent('window:close-requested', 52);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.windowLifecycleHide).toHaveBeenCalledTimes(2);
    expect(mocks.windowLifecycleHide).toHaveBeenLastCalledWith({
      generation: 7,
      transition: 52,
    });
  });

  it('keeps listeners active while a timed-out readiness acknowledgement may apply late', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveReadiness!: () => void;
    mocks.windowLifecycleReady.mockImplementationOnce(() => (
      new Promise<undefined>(resolve => {
        resolveReadiness = () => resolve(undefined);
      })
    ));

    const setup = setupWindowLifecycleBridge();
    await vi.advanceTimersByTimeAsync(1000);
    const listenersDuringRetryGap = tauriMockListenerCount('window:close-requested');
    resolveReadiness();
    await vi.advanceTimersByTimeAsync(100);
    await setup;

    expect(listenersDuringRetryGap).toBe(1);
    expect(tauriMockListenerCount('window:close-requested')).toBe(1);
  });
});
