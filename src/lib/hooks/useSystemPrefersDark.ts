import { useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Tracks whether the OS prefers a dark color scheme, for the "follow system"
 * theme scheduler mode.
 *
 * The native Tauri window theme API is the primary source: on Linux the Web
 * `prefers-color-scheme` media query is unreliable through WebKitGTK (Tauri
 * does not reliably forward the system preference — it tends to report `light`
 * regardless), whereas `theme()` / `onThemeChanged` read the OS theme natively
 * (via the XDG portal on Linux). `matchMedia` is only a fallback for the
 * frontend-only dev shell where the Tauri IPC is absent.
 *
 * `theme()` resolves the OS theme correctly at startup; `onThemeChanged` gives
 * an instant live update where the platform forwards it (macOS / Windows). On
 * some Linux setups (tao does not forward the portal change live) the event
 * never fires, so a light/dark flip is only reflected after an app restart —
 * the UI surfaces that note in the system scheduler mode.
 */

let isDark = false;
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setDark(next: boolean): void {
  if (next === isDark) return;
  isDark = next;
  emit();
}

/** Begin watching once the first subscriber mounts (idempotent). */
function start(): void {
  if (started) return;
  started = true;

  void (async () => {
    try {
      const win = getCurrentWindow();
      setDark((await win.theme()) === 'dark');
      // Instant updates where the platform forwards them (macOS / Windows).
      await win.onThemeChanged(({ payload }) => setDark(payload === 'dark'));
    } catch {
      // No Tauri IPC (frontend-only dev) — best-effort Web fallback.
      try {
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        setDark(mql.matches);
        mql.addEventListener('change', (e) => setDark(e.matches));
      } catch {
        /* default: light */
      }
    }
  })();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => listeners.delete(cb);
}

function getSnapshot(): boolean {
  return isDark;
}

function getServerSnapshot(): boolean {
  return false;
}

/** `true` when the OS theme is dark. Updates live on OS theme changes. */
export function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
