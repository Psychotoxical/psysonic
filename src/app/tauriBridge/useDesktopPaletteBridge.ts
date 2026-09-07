import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { commands } from '@/generated/bindings';
import type { DesktopPalette } from '@/generated/bindings';
import { useInstalledThemesStore, type InstalledTheme } from '@/store/installedThemesStore';
import { useThemeStore } from '@/store/themeStore';
import {
  DESKTOP_THEME_ID,
  desktopPaletteCss,
  desktopPaletteMode,
} from '@/lib/themes/desktopPalette';

/**
 * The installed-theme entry for a palette. Installed like any other theme (not
 * as a session-only dev copy) so it is in localStorage before the first paint
 * on the next launch — a user who selected it doesn't get a flash of Mocha
 * while the palette is re-read.
 */
export function desktopPaletteTheme(palette: DesktopPalette): InstalledTheme {
  return {
    id: DESKTOP_THEME_ID,
    // Prefixed so the card in the theme grid reads as desktop-provided rather
    // than as one more community theme with an unfamiliar name.
    name: palette.name ? `Desktop — ${palette.name}` : 'Desktop',
    author: 'desktop',
    version: '1.0.0',
    description: palette.source,
    mode: desktopPaletteMode(palette),
    css: desktopPaletteCss(palette),
    installedAt: Date.now(),
  };
}

/**
 * Rust → UI: keep the `desktop` theme in step with the palette the user's
 * desktop publishes.
 *
 * Reads once at startup and then on every `desktop-palette:changed`, so
 * switching the desktop theme re-themes a running app. The generated theme is
 * installed like any other, which is what makes it show up in the theme grid
 * and survive a restart. While `followDesktopTheme` is on it is also selected,
 * so the app tracks the desktop without the user picking anything; turning that
 * off (the Settings toggle, or picking another theme) leaves the card in the
 * grid as an ordinary theme.
 *
 * A machine that publishes no palette (every non-Linux install, and most Linux
 * ones) resolves to `null` and this does nothing. Main window only: the entry
 * is persisted, so the mini player picks it up through the cross-window
 * storage sync rather than installing it a second time.
 */
export function useDesktopPaletteBridge(): void {
  useEffect(() => {
    let cancelled = false;

    const apply = (palette: DesktopPalette | null) => {
      if (cancelled || !palette) return;
      const store = useInstalledThemesStore.getState();
      const next = desktopPaletteTheme(palette);
      const prev = store.getInstalled(DESKTOP_THEME_ID);
      // Nothing meaningful changed (a rewrite with identical colours, or the
      // startup read after a restart) — skip the write so the store doesn't
      // churn and the theme keeps its original install timestamp. The selection
      // below still runs: an unchanged palette is the normal restart case, and
      // that is exactly when the theme has to be put back in place.
      if (!prev || prev.css !== next.css || prev.name !== next.name) {
        store.install({ ...next, installedAt: prev?.installedAt ?? next.installedAt });
      }
      // Follow mode: the desktop owns the selection, so re-theming happens
      // without the user having to pick the card. Off after they choose any
      // other theme by hand, and inert while the day/night scheduler is on —
      // that already overrides the selection, so fighting it would only make
      // the toggle look broken.
      const theme = useThemeStore.getState();
      if (theme.followDesktopTheme && !theme.enableThemeScheduler && theme.theme !== DESKTOP_THEME_ID) {
        theme.setTheme(DESKTOP_THEME_ID);
      }
    };

    void commands
      .readDesktopPalette()
      .then(res => apply(res.status === 'ok' ? res.data : null))
      .catch(() => {});

    const sub = listen<DesktopPalette>('desktop-palette:changed', ({ payload }) => apply(payload));
    let unlisten: (() => void) | undefined;
    void sub
      .then(fn => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
