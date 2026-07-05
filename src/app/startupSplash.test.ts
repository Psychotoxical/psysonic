import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STARTUP_SPLASH_ID,
  configureStartupSplash,
  dismissStartupSplash,
} from './startupSplash';

vi.mock('./windowKind', () => ({
  getWindowKind: vi.fn(() => 'main'),
}));

vi.mock('@/lib/themes/startupThemeAppearance', () => ({
  applyStartupSplashThemeFromStorage: vi.fn(() => 'mocha'),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: vi.fn(() => ({ show: vi.fn(() => Promise.resolve()) })),
}));

import { getWindowKind } from './windowKind';
import { applyStartupSplashThemeFromStorage } from '@/lib/themes/startupThemeAppearance';

describe('startupSplash', () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="${STARTUP_SPLASH_ID}"></div><div id="root"></div>`;
    vi.mocked(getWindowKind).mockReturnValue('main');
    vi.mocked(applyStartupSplashThemeFromStorage).mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('removes splash on mini player webview', () => {
    vi.mocked(getWindowKind).mockReturnValue('mini');
    configureStartupSplash();
    expect(document.getElementById(STARTUP_SPLASH_ID)).toBeNull();
  });

  it('re-applies theme from storage on main window', () => {
    configureStartupSplash();
    expect(applyStartupSplashThemeFromStorage).toHaveBeenCalled();
  });

  it('fades out and removes splash', () => {
    vi.useFakeTimers();
    dismissStartupSplash();
    expect(document.getElementById(STARTUP_SPLASH_ID)?.classList.contains('app-startup-splash--hide')).toBe(true);
    vi.runAllTimers();
    expect(document.getElementById(STARTUP_SPLASH_ID)).toBeNull();
    vi.useRealTimers();
  });
});
