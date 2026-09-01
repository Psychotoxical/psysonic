import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const platform = vi.hoisted(() => ({ IS_LINUX: false, IS_MACOS: false, IS_WINDOWS: false }));
vi.mock('@/lib/util/platform', () => platform);

const plugin = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: plugin.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: plugin.relaunch }));
vi.mock('@/generated/bindings', () => ({
  commands: {
    checkArchLinux: vi.fn(async () => false),
    downloadUpdate: vi.fn(),
    openFolder: vi.fn(),
  },
}));

import { useAppUpdater } from '@/features/updater/hooks/useAppUpdater';

type UpdateEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

const FULL_DOWNLOAD: UpdateEvent[] = [
  { event: 'Started', data: { contentLength: 100 } },
  { event: 'Progress', data: { chunkLength: 100 } },
  { event: 'Finished' },
];

function updateThatEmits(events: UpdateEvent[]) {
  return {
    downloadAndInstall: vi.fn(async (onEvent: (e: UpdateEvent) => void) => {
      for (const e of events) onEvent(e);
    }),
  };
}

describe('useAppUpdater in-app install', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The hook probes GitHub 4s after mount; keep that off the network.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    plugin.check.mockReset();
    plugin.relaunch.mockClear();
    platform.IS_LINUX = false;
    platform.IS_MACOS = false;
    platform.IS_WINDOWS = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Windows: installs through the plugin and leaves the relaunch to the installer', async () => {
    platform.IS_WINDOWS = true;
    plugin.check.mockResolvedValue(updateThatEmits(FULL_DOWNLOAD));
    const { result } = renderHook(() => useAppUpdater());
    expect(result.current.updaterPlatform).toBe('windows');
    expect(result.current.useTauriUpdater).toBe(true);

    await act(async () => {
      await result.current.handleDownload();
    });

    expect(plugin.check).toHaveBeenCalledTimes(1);
    expect(result.current.dlState).toBe('done');
    expect(result.current.dlProgress).toEqual({ bytes: 100, total: 100 });
    // The installer relaunches Psysonic; the app must not count down or
    // relaunch on its own (the plugin exits the process).
    expect(result.current.countdown).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.countdown).toBeNull();
    expect(plugin.relaunch).not.toHaveBeenCalled();
  });

  it('macOS: counts down and relaunches the replaced app itself', async () => {
    platform.IS_MACOS = true;
    plugin.check.mockResolvedValue(updateThatEmits(FULL_DOWNLOAD));
    const { result } = renderHook(() => useAppUpdater());
    expect(result.current.updaterPlatform).toBe('macos');

    await act(async () => {
      await result.current.handleDownload();
    });

    expect(result.current.dlState).toBe('done');
    expect(result.current.countdown).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(plugin.relaunch).toHaveBeenCalledTimes(1);
  });

  it('Windows: reports an error when the manifest has nothing for this platform', async () => {
    platform.IS_WINDOWS = true;
    plugin.check.mockResolvedValue(null);
    const { result } = renderHook(() => useAppUpdater());

    await act(async () => {
      await result.current.handleDownload();
    });

    expect(result.current.dlState).toBe('error');
    expect(plugin.relaunch).not.toHaveBeenCalled();
  });

  it('Linux keeps the manual download path', () => {
    platform.IS_LINUX = true;
    const { result } = renderHook(() => useAppUpdater());
    expect(result.current.updaterPlatform).toBeNull();
    expect(result.current.useTauriUpdater).toBe(false);
  });
});
