import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import type { LinuxWaylandTextRenderProfile } from '../store/authStoreTypes';
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
  const [waylandTextUi, setWaylandTextUi] = useState(false);
  const useCustomTitlebar = useAuthStore(s => s.useCustomTitlebar);
  const linuxWebkitKineticScroll = useAuthStore(s => s.linuxWebkitKineticScroll);
  const linuxWaylandTextRenderProfile = useAuthStore(s => s.linuxWaylandTextRenderProfile);
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
    if (!IS_LINUX) return;
    invoke<boolean>('linux_wayland_text_render_settings_available')
      .then(av => {
        setWaylandTextUi(av);
        if (av) {
          document.documentElement.setAttribute('data-linux-session', 'wayland');
        } else {
          document.documentElement.removeAttribute('data-linux-session');
          document.documentElement.removeAttribute('data-wayland-text-profile');
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const platform = IS_LINUX ? 'linux' : IS_MACOS ? 'macos' : IS_WINDOWS ? 'windows' : 'unknown';
    document.documentElement.setAttribute('data-platform', platform);
  }, []);

  // Wayland text profile: CSS on <html> updates live; Rust persists for next launch / new mini webview
  // (WebKitGTK can hang when hardware-acceleration-policy is toggled repeatedly at runtime).
  useEffect(() => {
    if (!IS_LINUX || !waylandTextUi) {
      document.documentElement.removeAttribute('data-wayland-text-profile');
      return;
    }

    let cancelHydration: (() => void) | undefined;

    const apply = (profile: LinuxWaylandTextRenderProfile) => {
      document.documentElement.setAttribute('data-wayland-text-profile', profile);
      invoke('set_linux_wayland_text_render_profile', { profile }).catch(() => {});
    };

    apply(linuxWaylandTextRenderProfile);

    if (!useAuthStore.persist.hasHydrated()) {
      cancelHydration = useAuthStore.persist.onFinishHydration(() => {
        apply(useAuthStore.getState().linuxWaylandTextRenderProfile);
      });
    }

    return () => {
      cancelHydration?.();
    };
  }, [waylandTextUi, linuxWaylandTextRenderProfile]);

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

  // Persist rehydrates after first paint — default store has kinetic scroll ON until localStorage merges.
  // Re-apply OS WebKit prefs after hydrate (same pattern as useMiniWindowSetup) so OFF stays OFF.
  useEffect(() => {
    if (!IS_LINUX) return;
    const applySmoothFromStore = () => {
      invoke('set_linux_webkit_smooth_scrolling', {
        enabled: useAuthStore.getState().linuxWebkitKineticScroll,
      }).catch(() => {});
    };
    if (useAuthStore.persist.hasHydrated()) {
      applySmoothFromStore();
    }
    return useAuthStore.persist.onFinishHydration(() => {
      applySmoothFromStore();
    });
  }, []);

  useEffect(() => {
    invoke('set_logging_mode', { mode: loggingMode }).catch(() => {});
  }, [loggingMode]);

  return { isTilingWm };
}
