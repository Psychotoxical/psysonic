/**
 * Tests for the cached Tauri window-kind detector.
 *
 * The cache is module-scoped, so each test must reset it via the
 * `_resetWindowKindCacheForTest()` escape hatch — otherwise the first call
 * locks the value for the rest of the file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(),
}));

import { getCurrentWindow } from '@tauri-apps/api/window';
import { _resetWindowKindCacheForTest, getWindowKind } from './windowKind';

beforeEach(() => {
  _resetWindowKindCacheForTest();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetWindowKindCacheForTest();
});

describe('getWindowKind', () => {
  it('returns "main" when the current window label is "main"', () => {
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'main' } as ReturnType<typeof getCurrentWindow>);
    expect(getWindowKind()).toBe('main');
  });

  it('returns "mini" when the current window label is "mini"', () => {
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'mini' } as ReturnType<typeof getCurrentWindow>);
    expect(getWindowKind()).toBe('mini');
  });

  it('falls back to "main" for any other label', () => {
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'something-else' } as ReturnType<typeof getCurrentWindow>);
    expect(getWindowKind()).toBe('main');
  });

  it('falls back to "main" when getCurrentWindow throws (non-Tauri runtime)', () => {
    vi.mocked(getCurrentWindow).mockImplementation(() => {
      throw new Error('not in tauri');
    });
    expect(getWindowKind()).toBe('main');
  });

  it('caches the first result and does not call getCurrentWindow again', () => {
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'mini' } as ReturnType<typeof getCurrentWindow>);
    expect(getWindowKind()).toBe('mini');
    expect(getWindowKind()).toBe('mini');
    expect(getWindowKind()).toBe('mini');
    expect(getCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the cache is reset', () => {
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'main' } as ReturnType<typeof getCurrentWindow>);
    expect(getWindowKind()).toBe('main');

    _resetWindowKindCacheForTest();
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'mini' } as ReturnType<typeof getCurrentWindow>);
    expect(getWindowKind()).toBe('mini');
    expect(getCurrentWindow).toHaveBeenCalledTimes(2);
  });
});
