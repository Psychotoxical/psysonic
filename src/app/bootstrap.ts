import { invoke } from '@tauri-apps/api/core';
import { installQueueUndoHotkey } from '../store/playerStore';
import { getWindowKind } from './windowKind';

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

/** Orchestrates everything that must run before React mounts. */
export function runPreReactBootstrap(): void {
  // Pre-warm the window-kind cache so subsequent reads are sync + safe.
  getWindowKind();
  pushUserAgentToBackend();
  pushLoggingModeToBackend();
  installQueueUndoHotkey();
}
