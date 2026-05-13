import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from '../utils/platform';

/**
 * One-shot platform + window-shell configuration. Reads tiling-WM state,
 * applies platform-specific document attributes/classes, and pushes
 * preference changes (custom titlebar, kinetic scroll, log level) into
 * Rust as the user toggles them. Returns the live `isTilingWm` flag so
 * AppShell can decide whether to mount the custom titlebar.
 */
export function usePlatformShellSetup(): { isTilingWm: boolean } {
  const [isTilingWm, setIsTilingWm] = useState(false);
  const useCustomTitlebar = useAuthStore(s => s.useCustomTitlebar);
  const linuxWebkitKineticScroll = useAuthStore(s => s.linuxWebkitKineticScroll);
  const loggingMode = useAuthStore(s => s.loggingMode);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke<boolean>('is_tiling_wm_cmd').then(setIsTilingWm).catch(() => {});
  }, []);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke<boolean>('no_compositing_mode').then(noComp => {
      if (noComp) document.documentElement.classList.add('no-compositing');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const platform = IS_LINUX ? 'linux' : IS_MACOS ? 'macos' : IS_WINDOWS ? 'windows' : 'unknown';
    document.documentElement.setAttribute('data-platform', platform);
  }, []);

  // Sync custom titlebar preference with native decorations on Linux.
  // On tiling WMs decorations are always off (no native title bar to replace).
  useEffect(() => {
    if (!IS_LINUX) return;
    const enabled = isTilingWm ? false : !useCustomTitlebar;
    invoke('set_window_decorations', { enabled }).catch(() => {});
  }, [useCustomTitlebar, isTilingWm]);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke('set_linux_webkit_smooth_scrolling', { enabled: linuxWebkitKineticScroll }).catch(() => {});
  }, [linuxWebkitKineticScroll]);

  useEffect(() => {
    invoke('set_logging_mode', { mode: loggingMode }).catch(() => {});
  }, [loggingMode]);

  return { isTilingWm };
}
