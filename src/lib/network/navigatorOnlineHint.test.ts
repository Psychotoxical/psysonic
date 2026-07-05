import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const isTauri = vi.fn(() => false);

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => isTauri(),
}));

import { isNavigatorOfflineHint } from './navigatorOnlineHint';

describe('isNavigatorOfflineHint', () => {
  beforeEach(() => {
    isTauri.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false in Tauri even when navigator.onLine is false', () => {
    isTauri.mockReturnValue(true);
    vi.stubGlobal('navigator', { onLine: false });
    expect(isNavigatorOfflineHint()).toBe(false);
  });

  it('returns true in non-Tauri when navigator.onLine is false (offline hint applies)', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(isNavigatorOfflineHint()).toBe(true);
  });

  it('returns false when navigator.onLine is true', () => {
    vi.stubGlobal('navigator', { onLine: true });
    expect(isNavigatorOfflineHint()).toBe(false);
  });
});
