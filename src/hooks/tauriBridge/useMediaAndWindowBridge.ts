import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { NavigateFunction } from 'react-router-dom';
import { flushPlayQueuePosition } from '../../store/queueSync';
import { getPlaybackProgressSnapshot } from '../../store/playbackProgress';
import { usePlayerStore } from '../../store/playerStore';
import { useAuthStore } from '../../store/authStore';
import { useOrbitStore } from '../../store/orbitStore';
import { endOrbitSession, leaveOrbitSession } from '../../utils/orbit';
import {
  canRunShortcutActionInMiniWindow,
  executeRuntimeAction,
  isGlobalShortcutActionId,
  isShortcutAction,
} from '../../config/shortcutActions';

/** Media keys, tray actions, global / cross-window shortcut events, relative &
 * absolute seek + volume, and the window-close / force-quit exit flow. */
export function useMediaAndWindowBridge(navigate: NavigateFunction) {
  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];

    const setup = async () => {
      const handlers: Array<[string, () => void]> = [
        // Hardware media controls should not interrupt active preview playback.
        ['media:play-pause', () => executeRuntimeAction('play-pause', { navigate, previewPolicy: 'ignore' })],
        ['media:play',       () => executeRuntimeAction('play', { navigate, previewPolicy: 'ignore' })],
        ['media:pause',      () => executeRuntimeAction('pause', { navigate, previewPolicy: 'ignore' })],
        ['media:next',       () => executeRuntimeAction('next', { navigate, previewPolicy: 'ignore' })],
        ['media:prev',       () => executeRuntimeAction('prev', { navigate, previewPolicy: 'ignore' })],
        ['media:stop',       () => executeRuntimeAction('stop', { navigate, previewPolicy: 'ignore' })],
        ['media:volume-up',  () => executeRuntimeAction('volume-up', { navigate, previewPolicy: 'ignore' })],
        ['media:volume-down', () => executeRuntimeAction('volume-down', { navigate, previewPolicy: 'ignore' })],
        // Tray clicks are explicit UI intent: stop preview first, then act.
        ['tray:play-pause',  () => executeRuntimeAction('play-pause', { navigate, previewPolicy: 'stop' })],
        ['tray:next',        () => executeRuntimeAction('next', { navigate, previewPolicy: 'stop' })],
        ['tray:previous',    () => executeRuntimeAction('prev', { navigate, previewPolicy: 'stop' })],
      ];
      for (const [event, handler] of handlers) {
        const u = await listen(event, handler);
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      {
        const u = await listen<string>('shortcut:global-action', e => {
          const action = e.payload;
          if (!isGlobalShortcutActionId(action)) return;
          executeRuntimeAction(action, { navigate, previewPolicy: 'ignore' });
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      {
        const u = await listen<{ action: string; source?: string }>('shortcut:run-action', e => {
          const action = e.payload?.action;
          const source = e.payload?.source;
          if (!action || !isShortcutAction(action)) return;
          if (source === 'mini-window' && !canRunShortcutActionInMiniWindow(action)) return;
          const previewPolicy = source === 'cli' ? 'ignore' : 'stop';
          executeRuntimeAction(action, { navigate, previewPolicy });
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }


      // Seek events carry a numeric payload (seconds) — seek() expects 0-1 progress
      {
        const u = await listen<number>('media:seek-relative', e => {
          const s = usePlayerStore.getState();
          const p = getPlaybackProgressSnapshot();
          const dur = s.currentTrack?.duration;
          if (!dur) return;
          s.seek(Math.max(0, p.currentTime + e.payload) / dur);
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }
      {
        const u = await listen<number>('media:seek-absolute', e => {
          const s = usePlayerStore.getState();
          const dur = s.currentTrack?.duration;
          if (!dur) return;
          s.seek(e.payload / dur);
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }
      {
        const u = await listen<number>('media:set-volume', e => {
          const p = e.payload;
          if (typeof p !== 'number' || Number.isNaN(p)) return;
          usePlayerStore.getState().setVolume(Math.min(1, Math.max(0, p / 100)));
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      // Shared exit path: flush play-queue position so other devices can
      // resume from where we left off, tear down any active Orbit session,
      // then ask Rust to exit. Each step is capped at 1500 ms so a slow
      // server can't keep the app hanging on quit; the playback heartbeat
      // is the safety net for anything that didn't make it out in time.
      const performExit = async () => {
        await Promise.race([
          flushPlayQueuePosition(),
          new Promise(r => setTimeout(r, 1500)),
        ]);
        const role = useOrbitStore.getState().role;
        if (role === 'host' || role === 'guest') {
          const teardown = role === 'host' ? endOrbitSession() : leaveOrbitSession();
          await Promise.race([
            teardown.catch(() => {}),
            new Promise(r => setTimeout(r, 1500)),
          ]);
        }
        await invoke('exit_app');
      };

      // window:close-requested is emitted by Rust (prevent_close + emit) on
      // the X-button. JS decides: minimize to tray or exit.
      const u = await listen('window:close-requested', async () => {
        if (useAuthStore.getState().minimizeToTray) {
          await invoke('pause_rendering').catch(() => {});
          await getCurrentWindow().hide();
        } else {
          await performExit();
        }
      });
      if (cancelled) { u(); return; }
      unlisten.push(u);

      // app:force-quit bypasses the minimize-to-tray decision — used by the
      // tray "Exit" menu item and the macOS red close button.
      const fq = await listen('app:force-quit', async () => {
        await performExit();
      });
      if (cancelled) { fq(); return; }
      unlisten.push(fq);
    };

    setup();
    return () => { cancelled = true; unlisten.forEach(u => u()); };
  }, [navigate]);
}
