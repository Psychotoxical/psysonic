import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  onFocusChanged: vi.fn(),
  setFocus: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onFocusChanged: mocks.onFocusChanged }),
}));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setFocus: mocks.setFocus }),
}));
vi.mock('@/lib/util/platform', () => ({ IS_LINUX: true }));

import { useWebviewFocusRecovery } from './useWebviewFocusRecovery';

describe('useWebviewFocusRecovery', () => {
  let focusHandler: ((event: { payload: boolean }) => void) | undefined;

  beforeEach(() => {
    focusHandler = undefined;
    mocks.onFocusChanged.mockReset();
    mocks.setFocus.mockReset().mockResolvedValue(undefined);
    mocks.unlisten.mockReset();
    mocks.onFocusChanged.mockImplementation(async (handler) => {
      focusHandler = handler;
      return mocks.unlisten;
    });
  });

  it('focuses the webview when the native window regains focus', async () => {
    renderHook(() => useWebviewFocusRecovery());
    await waitFor(() => expect(focusHandler).toBeDefined());

    act(() => focusHandler?.({ payload: false }));
    expect(mocks.setFocus).not.toHaveBeenCalled();

    act(() => focusHandler?.({ payload: true }));
    expect(mocks.setFocus).toHaveBeenCalledOnce();
  });

  it('removes the native focus listener on unmount', async () => {
    const { unmount } = renderHook(() => useWebviewFocusRecovery());
    await waitFor(() => expect(focusHandler).toBeDefined());

    unmount();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it('removes the listener when registration finishes after unmount', async () => {
    let resolveListener!: (unlisten: () => void) => void;
    mocks.onFocusChanged.mockImplementationOnce(() => new Promise<() => void>((resolve) => {
      resolveListener = resolve;
    }));

    const { unmount } = renderHook(() => useWebviewFocusRecovery());
    await waitFor(() => expect(mocks.onFocusChanged).toHaveBeenCalledOnce());
    unmount();

    resolveListener(mocks.unlisten);
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalledOnce());
  });
});
