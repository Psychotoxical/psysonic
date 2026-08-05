import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTauriEvent, listenMock } from '@/test/mocks/tauri';

const mocks = vi.hoisted(() => ({
  minimizeToTray: true,
  hide: vi.fn(async () => undefined),
  pauseRendering: vi.fn(async () => undefined),
  windowLifecycleReady: vi.fn(async () => undefined),
  exitApp: vi.fn(async () => undefined),
  finalize: vi.fn(async () => undefined),
  reportStopped: vi.fn(async () => undefined),
  flushQueue: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ hide: mocks.hide }),
}));

vi.mock('@/app/windowKind', () => ({
  getWindowKind: () => 'main',
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ minimizeToTray: mocks.minimizeToTray }) },
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
  pauseRendering: mocks.pauseRendering,
  windowLifecycleReady: mocks.windowLifecycleReady,
}));

import { setupWindowLifecycleBridge } from './windowLifecycleBridge';

describe('windowLifecycleBridge', () => {
  beforeEach(() => {
    mocks.minimizeToTray = true;
    Object.values(mocks).forEach(value => {
      if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
    });
  });

  it('registers close first, acknowledges readiness, and handles both close policies', async () => {
    await setupWindowLifecycleBridge();

    expect(listenMock.mock.calls.map(call => call[0])).toEqual([
      'window:close-requested',
      'app:force-quit',
    ]);
    expect(mocks.windowLifecycleReady).toHaveBeenCalledTimes(1);

    emitTauriEvent('window:close-requested', undefined);
    await vi.waitFor(() => expect(mocks.hide).toHaveBeenCalledTimes(1));
    expect(mocks.pauseRendering).toHaveBeenCalledBefore(mocks.hide);

    mocks.minimizeToTray = false;
    emitTauriEvent('window:close-requested', undefined);
    await vi.waitFor(() => expect(mocks.exitApp).toHaveBeenCalledTimes(1));
    expect(mocks.finalize).toHaveBeenCalledWith('close');
    expect(mocks.reportStopped).toHaveBeenCalledTimes(1);
    expect(mocks.flushQueue).toHaveBeenCalledTimes(1);
  });
});
