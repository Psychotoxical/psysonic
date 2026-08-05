import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  isTilingWmCmd,
  linuxWaylandTextRenderSettingsAvailable,
  noCompositingMode,
  setLinuxWaylandTextRenderProfile,
  setLinuxWebkitSmoothScrolling,
  setLoggingMode,
  setWindowDecorations,
  windowLifecycleGeneration,
} from '@/lib/api/platformShell';
import { useAuthStore } from '@/store/authStore';
import type { LinuxWaylandTextRenderProfile } from '@/store/authStoreTypes';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from '@/lib/util/platform';

const DECORATION_TRANSITION_TIMEOUT_MS = 1500;
const DECORATION_TRANSITION_BASE = Date.now() * 1000;
let decorationTransitionSequence = 0;

function withDecorationTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('window decoration transition timed out')), DECORATION_TRANSITION_TIMEOUT_MS);
    work.then(
      value => {
        window.clearTimeout(timer);
        resolve(value);
      },
      error => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * One-shot platform + window-shell configuration. Reads tiling-WM state,
 * applies platform-specific document attributes/classes, and pushes
 * preference changes (custom titlebar, kinetic scroll, log level) into
 * Rust as the user toggles them. Titlebar transitions keep the outgoing controls
 * mounted until the replacement is available.
 */
export function usePlatformShellSetup(): {
  isTilingWm: boolean;
  linuxCustomTitlebarActive: boolean;
} {
  const [isTilingWm, setIsTilingWm] = useState<boolean | null>(() => window.__psyIsTilingWm ?? null);
  const [linuxCustomTitlebarActive, setLinuxCustomTitlebarActive] = useState(false);
  const titlebarTransition = useRef<Promise<void>>(Promise.resolve());
  const titlebarTransitionId = useRef(0);
  const customTitlebarCommitted = useRef(false);
  const customTitlebarCommitResolver = useRef<(() => void) | null>(null);
  const isTilingWmRef = useRef(isTilingWm);
  const [waylandTextUi, setWaylandTextUi] = useState(false);
  const useCustomTitlebar = useAuthStore(s => s.useCustomTitlebar);
  const linuxWebkitKineticScroll = useAuthStore(s => s.linuxWebkitKineticScroll);
  const linuxWaylandTextRenderProfile = useAuthStore(s => s.linuxWaylandTextRenderProfile);
  const loggingMode = useAuthStore(s => s.loggingMode);

  useEffect(() => {
    isTilingWmRef.current = isTilingWm;
  }, [isTilingWm]);

  useLayoutEffect(() => {
    customTitlebarCommitted.current = linuxCustomTitlebarActive;
    if (linuxCustomTitlebarActive) {
      customTitlebarCommitResolver.current?.();
      customTitlebarCommitResolver.current = null;
    }
  }, [linuxCustomTitlebarActive]);

  useEffect(() => {
    if (!IS_LINUX) return;
    isTilingWmCmd().then(value => {
      window.__psyIsTilingWm = value;
      setIsTilingWm(value);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!IS_LINUX) return;
    noCompositingMode().then(noComp => {
      if (noComp) document.documentElement.classList.add('no-compositing');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!IS_LINUX) return;
    linuxWaylandTextRenderSettingsAvailable()
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
      setLinuxWaylandTextRenderProfile({ profile }).catch(() => {});
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

  // Serialize decoration changes so a stale async completion cannot leave both
  // native and custom controls disabled after rapid preference changes.
  useEffect(() => {
    if (!IS_LINUX) return;
    if (isTilingWm === null) return;
    const enabled = isTilingWm ? false : !useCustomTitlebar;
    const customTitlebarActive = !isTilingWm && useCustomTitlebar;
    const transitionId = ++titlebarTransitionId.current;
    const nativeTransition = DECORATION_TRANSITION_BASE + (++decorationTransitionSequence);
    let cancelled = false;
    let releaseCommitWait: (() => void) | null = null;

    titlebarTransition.current = titlebarTransition.current.catch(() => {}).then(async () => {
      if (cancelled || transitionId !== titlebarTransitionId.current) return;
      const generation = window.__psyLifecycleGeneration
        ?? await withDecorationTimeout(windowLifecycleGeneration());
      window.__psyLifecycleGeneration = generation;

      if (customTitlebarActive) {
        if (!customTitlebarCommitted.current) {
          await new Promise<void>(resolve => {
            releaseCommitWait = resolve;
            customTitlebarCommitResolver.current = resolve;
            setLinuxCustomTitlebarActive(true);
          });
        }
        if (cancelled || transitionId !== titlebarTransitionId.current) return;
        try {
          await withDecorationTimeout(setWindowDecorations({
            enabled: false,
            generation,
            transition: nativeTransition,
          }));
        } catch {
          // Keep custom controls mounted if the native mutation applied but its
          // response failed, or if native decorations could not be changed.
        }
        return;
      }

      try {
        const accepted = await withDecorationTimeout(setWindowDecorations({
          enabled,
          generation,
          transition: nativeTransition,
        }));
        if (accepted && !cancelled && transitionId === titlebarTransitionId.current) {
          setLinuxCustomTitlebarActive(false);
        }
      } catch {
        // Keep the currently mounted controls when the native transition fails.
      }
    });

    return () => {
      cancelled = true;
      releaseCommitWait?.();
      if (customTitlebarCommitResolver.current === releaseCommitWait) {
        customTitlebarCommitResolver.current = null;
      }
      if (titlebarTransitionId.current === transitionId) titlebarTransitionId.current += 1;
    };
  }, [useCustomTitlebar, isTilingWm]);

  useEffect(() => () => {
    if (!IS_LINUX || isTilingWmRef.current !== false || !customTitlebarCommitted.current) return;
    const transitionId = ++titlebarTransitionId.current;
    const nativeTransition = DECORATION_TRANSITION_BASE + (++decorationTransitionSequence);
    titlebarTransition.current = titlebarTransition.current.catch(() => {}).then(async () => {
      if (transitionId !== titlebarTransitionId.current) return;
      const generation = window.__psyLifecycleGeneration
        ?? await withDecorationTimeout(windowLifecycleGeneration());
      window.__psyLifecycleGeneration = generation;
      await withDecorationTimeout(setWindowDecorations({
        enabled: true,
        generation,
        transition: nativeTransition,
      })).catch(() => {});
    });
  }, []);

  useEffect(() => {
    if (!IS_LINUX) return;
    setLinuxWebkitSmoothScrolling({ enabled: linuxWebkitKineticScroll }).catch(() => {});
  }, [linuxWebkitKineticScroll]);

  // Persist rehydrates after first paint — default store has kinetic scroll ON until localStorage merges.
  // Re-apply OS WebKit prefs after hydrate (same pattern as useMiniWindowSetup) so OFF stays OFF.
  useEffect(() => {
    if (!IS_LINUX) return;
    const applySmoothFromStore = () => {
      setLinuxWebkitSmoothScrolling({
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
    setLoggingMode({ mode: loggingMode }).catch(() => {});
  }, [loggingMode]);

  return {
    isTilingWm: isTilingWm ?? false,
    linuxCustomTitlebarActive,
  };
}
