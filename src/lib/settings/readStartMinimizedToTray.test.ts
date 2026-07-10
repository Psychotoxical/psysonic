import { beforeEach, describe, expect, it } from 'vitest';
import {
  STARTUP_TRAY_HANDLED_KEY,
  isStartupTrayHandledThisSession,
  markStartupTrayHandledThisSession,
  readStartMinimizedToTray,
  shouldDeferMainWindowReveal,
  shouldDeferMainWindowRevealThisSession,
} from './readStartMinimizedToTray';

describe('readStartMinimizedToTray', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete window.__psyStartMinimizedToTray;
  });

  it('returns false when unset', () => {
    expect(readStartMinimizedToTray()).toBe(false);
  });

  it('reads persisted value from psysonic-auth', () => {
    localStorage.setItem(
      'psysonic-auth',
      JSON.stringify({ state: { startMinimizedToTray: true } }),
    );
    expect(readStartMinimizedToTray()).toBe(true);
  });

  it('returns false when tray icon is disabled', () => {
    localStorage.setItem(
      'psysonic-auth',
      JSON.stringify({ state: { startMinimizedToTray: true, showTrayIcon: false } }),
    );
    expect(readStartMinimizedToTray()).toBe(false);
  });
});

describe('startup tray session gate', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete window.__psyStartMinimizedToTray;
  });

  it('defers reveal only on the first load when the setting is on', () => {
    localStorage.setItem(
      'psysonic-auth',
      JSON.stringify({ state: { startMinimizedToTray: true } }),
    );
    expect(shouldDeferMainWindowRevealThisSession()).toBe(true);
    markStartupTrayHandledThisSession();
    expect(shouldDeferMainWindowRevealThisSession()).toBe(false);
    expect(isStartupTrayHandledThisSession()).toBe(true);
    expect(sessionStorage.getItem(STARTUP_TRAY_HANDLED_KEY)).toBe('1');
  });

  it('prefers the preflight flag when present', () => {
    window.__psyStartMinimizedToTray = true;
    expect(shouldDeferMainWindowReveal()).toBe(true);
    window.__psyStartMinimizedToTray = false;
    expect(shouldDeferMainWindowReveal()).toBe(false);
  });
});
