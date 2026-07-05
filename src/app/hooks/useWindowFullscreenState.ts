import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Track the live Tauri window-fullscreen state. `onResized` fires for every
 * fullscreen enter/exit transition on every platform, so we re-query
 * `isFullscreen()` instead of inferring from the size (avoids platform
 * quirks). Also covers the initial state for apps launched already
 * fullscreen / maximized.
 */
export function useWindowFullscreenState(): boolean {
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    win.isFullscreen().then(setIsWindowFullscreen).catch(() => {});
    let unlisten: (() => void) | undefined;
    win.onResized(() => {
      win.isFullscreen().then(setIsWindowFullscreen).catch(() => {});
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);
  return isWindowFullscreen;
}
