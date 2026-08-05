import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const authState = {
    useCustomTitlebar: true,
    linuxWebkitKineticScroll: true,
    linuxWaylandTextRenderProfile: 'default',
    loggingMode: 'normal',
  };
  return {
    authState,
    setWindowDecorations: vi.fn(async () => true),
    windowLifecycleGeneration: vi.fn(async () => 3),
  };
});

vi.mock('@/lib/util/platform', () => ({
  IS_LINUX: true,
  IS_MACOS: false,
  IS_WINDOWS: false,
}));

vi.mock('@/store/authStore', () => {
  const useAuthStore = Object.assign(
    (selector: (state: typeof mocks.authState) => unknown) => selector(mocks.authState),
    {
      getState: () => mocks.authState,
      persist: {
        hasHydrated: () => true,
        onFinishHydration: () => () => {},
      },
    },
  );
  return { useAuthStore };
});

vi.mock('@/lib/api/platformShell', () => ({
  isTilingWmCmd: vi.fn(async () => false),
  linuxWaylandTextRenderSettingsAvailable: vi.fn(async () => false),
  noCompositingMode: vi.fn(async () => false),
  setLinuxWaylandTextRenderProfile: vi.fn(async () => undefined),
  setLinuxWebkitSmoothScrolling: vi.fn(async () => undefined),
  setLoggingMode: vi.fn(async () => undefined),
  setWindowDecorations: mocks.setWindowDecorations,
  windowLifecycleGeneration: mocks.windowLifecycleGeneration,
}));

import { usePlatformShellSetup } from './usePlatformShellSetup';

describe('usePlatformShellSetup', () => {
  beforeEach(() => {
    window.__psyIsTilingWm = false;
    mocks.authState.useCustomTitlebar = true;
    mocks.setWindowDecorations.mockReset().mockResolvedValue(true);
    mocks.windowLifecycleGeneration.mockReset().mockResolvedValue(3);
    delete window.__psyLifecycleGeneration;
  });

  it('mounts the custom titlebar before native decorations are disabled', async () => {
    let finishDecorationChange: (() => void) | undefined;
    mocks.setWindowDecorations.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      finishDecorationChange = () => resolve(true);
    }));

    const { result } = renderHook(() => usePlatformShellSetup());

    await waitFor(() => expect(result.current.linuxCustomTitlebarActive).toBe(true));
    expect(mocks.setWindowDecorations).toHaveBeenCalledWith({
      enabled: false,
      generation: 3,
      transition: expect.any(Number),
    });

    finishDecorationChange?.();
    await waitFor(() => expect(result.current.linuxCustomTitlebarActive).toBe(true));
  });

  it('serializes rapid titlebar changes and keeps custom controls until native controls return', async () => {
    const decorationResolvers: Array<() => void> = [];
    mocks.setWindowDecorations.mockImplementation(() => new Promise<boolean>(resolve => {
      decorationResolvers.push(() => resolve(true));
    }));

    const { result, rerender } = renderHook(() => usePlatformShellSetup());
    await waitFor(() => expect(result.current.linuxCustomTitlebarActive).toBe(true));
    expect(mocks.setWindowDecorations).toHaveBeenNthCalledWith(1, {
      enabled: false,
      generation: 3,
      transition: expect.any(Number),
    });

    mocks.authState.useCustomTitlebar = false;
    rerender();
    decorationResolvers[0]?.();
    await waitFor(() => expect(mocks.setWindowDecorations).toHaveBeenNthCalledWith(2, {
      enabled: true,
      generation: 3,
      transition: expect.any(Number),
    }));
    expect(result.current.linuxCustomTitlebarActive).toBe(true);

    decorationResolvers[1]?.();
    await waitFor(() => expect(result.current.linuxCustomTitlebarActive).toBe(false));
  });

  it('keeps custom controls mounted when disabling native decorations fails', async () => {
    mocks.setWindowDecorations.mockRejectedValueOnce(new Error('decorations unavailable'));

    const { result } = renderHook(() => usePlatformShellSetup());

    await waitFor(() => expect(mocks.setWindowDecorations).toHaveBeenCalledWith({
      enabled: false,
      generation: 3,
      transition: expect.any(Number),
    }));
    expect(result.current.linuxCustomTitlebarActive).toBe(true);
  });

  it('keeps custom controls when a stale native transition is rejected', async () => {
    mocks.setWindowDecorations
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { result, rerender } = renderHook(() => usePlatformShellSetup());
    await waitFor(() => expect(result.current.linuxCustomTitlebarActive).toBe(true));

    mocks.authState.useCustomTitlebar = false;
    rerender();
    await waitFor(() => expect(mocks.setWindowDecorations).toHaveBeenCalledTimes(2));

    expect(result.current.linuxCustomTitlebarActive).toBe(true);
  });

  it('restores native decorations when the custom-titlebar owner unmounts', async () => {
    const { result, unmount } = renderHook(() => usePlatformShellSetup());
    await waitFor(() => expect(result.current.linuxCustomTitlebarActive).toBe(true));
    await waitFor(() => expect(mocks.setWindowDecorations).toHaveBeenCalledWith({
      enabled: false,
      generation: 3,
      transition: expect.any(Number),
    }));

    unmount();

    await waitFor(() => expect(mocks.setWindowDecorations).toHaveBeenLastCalledWith({
      enabled: true,
      generation: 3,
      transition: expect.any(Number),
    }));
  });
});
