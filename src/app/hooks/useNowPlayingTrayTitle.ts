import { useEffect } from 'react';
import { setTrayTooltip } from '@/lib/api/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Track } from '@/lib/media/trackTypes';

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
          // `⏵` (U+23F5) instead of `▶` (U+25B6): the Geometric-Shapes triangle
          // renders well below the baseline in most OS title-bar fonts (Segoe UI,
          // GNOME Cantarell, etc.), while the Miscellaneous-Technical pair
          // `⏵`/`⏸` shares metrics and stays centred next to the text.
          const state = isPlaying ? '⏵' : '⏸';
          const title = `${state} ${currentTrack.artist} - ${currentTrack.title} | Psysonic`;
          document.title = title;
          await appWindow.setTitle(title);
          await setTrayTooltip({
            tooltip: `${currentTrack.artist} – ${currentTrack.title}`,
            playbackState: isPlaying ? 'play' : 'pause',
          }).catch(() => {});
        } else {
          document.title = 'Psysonic';
          await appWindow.setTitle('Psysonic');
          await setTrayTooltip({
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
