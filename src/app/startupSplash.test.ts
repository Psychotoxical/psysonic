import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STARTUP_SPLASH_ID,
  STARTUP_ROOT_PENDING_CLASS,
  configureStartupSplash,
  dismissStartupSplash,
  scheduleStartupSplashDismiss,
} from './startupSplash';

vi.mock('./windowKind', () => ({
  getWindowKind: vi.fn(() => 'main'),
}));

vi.mock('@/lib/themes/startupThemeAppearance', () => ({
  applyStartupSplashThemeFromStorage: vi.fn(() => 'mocha'),
}));

import { getWindowKind } from './windowKind';
import { applyStartupSplashThemeFromStorage } from '@/lib/themes/startupThemeAppearance';

describe('startupSplash', () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="${STARTUP_SPLASH_ID}"></div><div id="root" class="${STARTUP_ROOT_PENDING_CLASS}"></div>`;
    vi.mocked(getWindowKind).mockReturnValue('main');
    vi.mocked(applyStartupSplashThemeFromStorage).mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('removes splash on mini player webview', () => {
    vi.mocked(getWindowKind).mockReturnValue('mini');
    configureStartupSplash();
    expect(document.getElementById(STARTUP_SPLASH_ID)).toBeNull();
    expect(document.getElementById('root')).not.toHaveClass(STARTUP_ROOT_PENDING_CLASS);
  });

  it('re-applies theme from storage on main window', () => {
    configureStartupSplash();
    expect(applyStartupSplashThemeFromStorage).toHaveBeenCalled();
  });

  it('reveals the React tree if the inline splash is already absent', () => {
    document.getElementById(STARTUP_SPLASH_ID)?.remove();
    configureStartupSplash();
    expect(document.getElementById('root')).not.toHaveClass(STARTUP_ROOT_PENDING_CLASS);
  });

  it('atomically replaces the splash with the prepared React tree', () => {
    dismissStartupSplash();
    expect(document.getElementById(STARTUP_SPLASH_ID)).toBeNull();
    expect(document.getElementById('root')).not.toHaveClass(STARTUP_ROOT_PENDING_CLASS);
  });

  it('keeps the React tree hidden until the ready handoff frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));

    scheduleStartupSplashDismiss();
    expect(document.getElementById(STARTUP_SPLASH_ID)).not.toBeNull();
    expect(document.getElementById('root')).toHaveClass(STARTUP_ROOT_PENDING_CLASS);

    frames.shift()?.(0);
    expect(document.getElementById(STARTUP_SPLASH_ID)).not.toBeNull();
    expect(document.getElementById('root')).toHaveClass(STARTUP_ROOT_PENDING_CLASS);

    frames.shift()?.(0);
    expect(document.getElementById(STARTUP_SPLASH_ID)).toBeNull();
    expect(document.getElementById('root')).not.toHaveClass(STARTUP_ROOT_PENDING_CLASS);
  });
});
