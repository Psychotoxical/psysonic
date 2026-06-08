import { installQueueUndoHotkey } from '../store/queueUndoHotkey';
import { configureStartupSplash } from './startupSplash';
import { invoke } from '@tauri-apps/api/core';
import { getWindowKind } from './windowKind';
import { migrateThemeSelection } from '../utils/themes/themeMigration';
import { getScheduledTheme, useThemeStore } from '../store/themeStore';
import { syncInjectedThemes } from '../utils/themes/themeInjection';
import { useInstalledThemesStore, type InstalledTheme } from '../store/installedThemesStore';

/** Sync backend HTTP User-Agent from the main webview once at startup. */
export function pushUserAgentToBackend(): void {
  try {
    if (getWindowKind() !== 'main') return;
    const ua = window.navigator.userAgent?.trim();
    if (ua) {
      void invoke('set_subsonic_wire_user_agent', { userAgent: ua, windowLabel: 'main' });
    }
  } catch {
    // Ignore in non-Tauri runtimes.
  }
}

/**
 * Push the persisted logging mode to Rust before React mounts. Zustand rehydrate
 * runs after first paint; AppShell's useEffect can miss the user's persisted
 * `loggingMode` until then — but waveform/audio may already run. Matches the
 * `psysonic-auth` localStorage key.
 */
export function pushLoggingModeToBackend(): void {
  try {
    const raw = localStorage.getItem('psysonic-auth');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: { loggingMode?: string } };
    const mode = parsed.state?.loggingMode;
    if (mode === 'off' || mode === 'normal' || mode === 'debug') {
      void invoke('set_logging_mode', { mode });
    }
  } catch {
    // Ignore parse / non-Tauri.
  }
}

function readInstalledThemes(): InstalledTheme[] {
  try {
    const raw = localStorage.getItem('psysonic_installed_themes');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { themes?: InstalledTheme[] } };
    return Array.isArray(parsed.state?.themes) ? (parsed.state!.themes as InstalledTheme[]) : [];
  } catch {
    return [];
  }
}

/**
 * Apply the active theme synchronously, before React mounts, so the first paint
 * is already correct. Zustand rehydrate + the `data-theme` effect run after the
 * first paint, so without this a non-Mocha active theme (every light theme and
 * every installed community theme) flashes the `:root` Mocha default for a
 * frame. We set `data-theme` to the effective (scheduler-resolved) theme and
 * inject installed community themes' CSS up front. Runs after the migration so
 * the persisted ids are already resolved.
 */
export function applyThemeAtStartup(): void {
  try {
    const raw = localStorage.getItem('psysonic_theme');
    if (!raw) return; // fresh profile — the :root default is correct
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const s = parsed.state;
    if (!s) return;
    syncInjectedThemes(readInstalledThemes());
    const effective = getScheduledTheme({
      enableThemeScheduler: !!s.enableThemeScheduler,
      theme: String(s.theme ?? 'mocha'),
      themeDay: String(s.themeDay ?? 'latte'),
      themeNight: String(s.themeNight ?? 'mocha'),
      timeDayStart: String(s.timeDayStart ?? '07:00'),
      timeNightStart: String(s.timeNightStart ?? '19:00'),
    });
    if (effective) document.documentElement.setAttribute('data-theme', effective);
  } catch {
    // Non-fatal — App's effects apply the theme after mount.
  }
}

/**
 * Keep theme state in sync across webviews (main ↔ mini player). Zustand
 * persist does not sync across windows on its own; the `storage` event fires in
 * *other* windows when localStorage changes, so rehydrate the relevant store
 * there. Installing/applying/uninstalling in one window then live-updates the
 * other (App's effects re-run and re-apply `data-theme` / injected styles).
 */
export function installCrossWindowThemeSync(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (e) => {
    if (e.key === 'psysonic_theme') void useThemeStore.persist?.rehydrate?.();
    else if (e.key === 'psysonic_installed_themes') void useInstalledThemesStore.persist?.rehydrate?.();
  });
}

/** Mark the document in Vite dev so CSS can show dev-only chrome. */
export function markDevBuildDocument(): void {
  if (import.meta.env.DEV) {
    document.documentElement.dataset.devBuild = 'true';
  }
}

/** Orchestrates everything that must run before React mounts. */
export function runPreReactBootstrap(): void {
  // Pre-warm the window-kind cache so subsequent reads are sync + safe.
  getWindowKind();
  // Reset any persisted theme that is no longer bundled and not installed, so
  // the store hydrates onto a paintable theme (no unstyled-:root flash).
  migrateThemeSelection();
  // Paint the correct theme on the very first frame (no Mocha flash).
  applyThemeAtStartup();
  configureStartupSplash();
  installCrossWindowThemeSync();
  markDevBuildDocument();
  pushUserAgentToBackend();
  pushLoggingModeToBackend();
  installQueueUndoHotkey();
}
