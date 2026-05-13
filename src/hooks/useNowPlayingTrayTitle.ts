import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Track } from '../store/playerStoreTypes';

/**
 * Keep `document.title`, the OS window title, and the tray tooltip in sync
 * with the currently playing track. Tray tooltip uses an en-dash separator
 * (` – `) and tags playback state for the tray badge.
 */
export function useNowPlayingTrayTitle(currentTrack: Track | null, isPlaying: boolean): void {
  useEffect(() => {
    const fn = async () => {
      try {
        const appWindow = getCurrentWindow();
        if (currentTrack) {
          const state = isPlaying ? '▶' : '⏸';
          const title = `${state} ${currentTrack.artist} - ${currentTrack.title} | Psysonic`;
          document.title = title;
          await appWindow.setTitle(title);
          await invoke('set_tray_tooltip', {
            tooltip: `${currentTrack.artist} – ${currentTrack.title}`,
            playbackState: isPlaying ? 'play' : 'pause',
          }).catch(() => {});
        } else {
          document.title = 'Psysonic';
          await appWindow.setTitle('Psysonic');
          await invoke('set_tray_tooltip', {
            tooltip: '',
            playbackState: 'stop',
          }).catch(() => {});
        }
      } catch {
        // Ignore Tauri IPC failures — title sync is best-effort.
      }
    };
    fn();
  }, [currentTrack, isPlaying]);
}
