const AUTH_STORAGE_KEY = 'psysonic-auth';

/** Keep in sync with `public/startup-splash-preflight.js` and `public/startup-splash-reveal.js`. */
export const STARTUP_TRAY_HANDLED_KEY = 'psy-startup-tray-handled';

/** Read persisted "start minimized to tray" before Zustand rehydrates. */
export function readStartMinimizedToTray(): boolean {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as {
      state?: { startMinimizedToTray?: boolean; showTrayIcon?: boolean };
    };
    const state = parsed.state;
    if (!state?.startMinimizedToTray) return false;
    // Tray icon must be available to restore the window after a hidden start.
    return state.showTrayIcon !== false;
  } catch {
    return false;
  }
}

/** Whether startup-to-tray already ran (or was skipped) this app process session. */
export function isStartupTrayHandledThisSession(): boolean {
  try {
    return sessionStorage.getItem(STARTUP_TRAY_HANDLED_KEY) === '1';
  } catch {
    return false;
  }
}

/** True only on the first document load of a process when the setting is on. */
export function shouldDeferMainWindowRevealThisSession(): boolean {
  return readStartMinimizedToTray() && !isStartupTrayHandledThisSession();
}

/** Prefer the preflight flag when set; otherwise compute from storage + session. */
export function shouldDeferMainWindowReveal(): boolean {
  if (typeof window.__psyStartMinimizedToTray === 'boolean') {
    return window.__psyStartMinimizedToTray;
  }
  return shouldDeferMainWindowRevealThisSession();
}

export function markStartupTrayHandledThisSession(): void {
  try {
    sessionStorage.setItem(STARTUP_TRAY_HANDLED_KEY, '1');
  } catch {
    // Non-fatal — worst case we re-apply pause once on reload.
  }
}
