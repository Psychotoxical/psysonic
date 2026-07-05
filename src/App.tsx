import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useLyricsStore } from './store/lyricsStore';
import { useThemeStore } from './store/themeStore';
import { useInstalledThemesStore } from './store/installedThemesStore';
import { syncInjectedThemes } from '@/lib/themes/themeInjection';
import { useThemeScheduler } from '@/app/hooks/useThemeScheduler';
import { useFontStore } from './store/fontStore';
import { getWindowKind } from './app/windowKind';
import MiniPlayerApp from './app/MiniPlayerApp';
import MainApp from './app/MainApp';

export default function App() {
  // Re-subscribe so themeStore changes trigger a re-render (the value itself
  // is consumed via useThemeScheduler / data-theme attribute below).
  useThemeStore(s => s.theme);
  const effectiveTheme = useThemeScheduler();
  const font = useFontStore(s => s.font);
  const buttonSize = useThemeStore(s => s.buttonSize);
  const installedThemes = useInstalledThemesStore(s => s.themes);

  // Document-attribute hooks are shared between both window kinds — each
  // webview has its own `document`, and theme / font / track-preview tokens
  // are read by CSS in both trees.

  // Installed community themes have no build-time CSS — inject their
  // `[data-theme='<id>']` blocks into <head> from the persisted (localStorage)
  // store. Runs before the data-theme effect below so the matching style exists
  // when the attribute is applied. The store hydrates synchronously, so an
  // active community theme is painted without a network round-trip.
  useEffect(() => {
    syncInjectedThemes(installedThemes);
  }, [installedThemes]);

  // Dev only: `--theme-watch <theme.css>` (debug builds) pushes a local theme's
  // CSS in on every save. Install it under the id in its `[data-theme='<id>']`
  // selector and apply it — the syncInjectedThemes effect above re-injects, so
  // authoring is live without re-importing a zip. Never wired in production.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => {
      const sub = listen<string>('theme-watch:css', ({ payload }) => {
        const id = payload.match(/\[data-theme=['"]([^'"]+)['"]\]/)?.[1];
        if (!id) return;
        useInstalledThemesStore.getState().install({
          id, name: id, author: 'dev', version: '0.0.0', description: '', mode: 'dark', css: payload, installedAt: Date.now(),
        });
        useThemeStore.getState().setTheme(id);
      });
      // Guard the mocked-in-tests case where listen() isn't a promise.
      if (sub && typeof sub.then === 'function') sub.then(u => { unlisten = u; });
    }).catch(() => {});
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }, [effectiveTheme]);

  // Expose app state on the theme root so themes can react to it with a
  // same-element compound selector, e.g. `[data-theme='x'][data-playing='true']`.
  // The set of allowed state attributes is the contract's `stateSelectors`.
  // (Sidebar-collapsed is set in AppShell, where that state lives.)
  const isPlaying = usePlayerStore(s => s.isPlaying);
  useEffect(() => {
    document.documentElement.setAttribute('data-playing', isPlaying ? 'true' : 'false');
  }, [isPlaying]);

  const isFullscreenOpen = usePlayerStore(s => s.isFullscreenOpen);
  useEffect(() => {
    document.documentElement.setAttribute('data-fullscreen', isFullscreenOpen ? 'true' : 'false');
  }, [isFullscreenOpen]);

  const lyricsOpen = useLyricsStore(s => s.activeTab === 'lyrics');
  useEffect(() => {
    document.documentElement.setAttribute('data-lyrics-open', lyricsOpen ? 'true' : 'false');
  }, [lyricsOpen]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font', font);
  }, [font]);

  useEffect(() => {
    document.documentElement.setAttribute('data-button-size', buttonSize);
  }, [buttonSize]);

  // Strip rounded corners off grid cards when the user opts in — single CSS
  // hook (`html[data-square-corners]`) overriding whatever radius the theme set.
  const squareCorners = useThemeStore(s => s.squareCorners);
  useEffect(() => {
    const root = document.documentElement;
    if (squareCorners) root.setAttribute('data-square-corners', '');
    else root.removeAttribute('data-square-corners');
  }, [squareCorners]);

  // Hide all inline track-preview buttons when the user opts out — single
  // CSS hook (`html[data-track-previews="off"]`) instead of conditional
  // rendering in every tracklist. Per-location toggles use additional
  // attributes `data-track-previews-{location}` consumed by scoped selectors.
  const trackPreviewsEnabled = useAuthStore(s => s.trackPreviewsEnabled);
  const trackPreviewLocations = useAuthStore(s => s.trackPreviewLocations);
  const trackPreviewDurationSec = useAuthStore(s => s.trackPreviewDurationSec);
  useEffect(() => {
    document.documentElement.setAttribute(
      'data-track-previews',
      trackPreviewsEnabled ? 'on' : 'off',
    );
  }, [trackPreviewsEnabled]);
  useEffect(() => {
    const root = document.documentElement;
    (Object.keys(trackPreviewLocations) as Array<keyof typeof trackPreviewLocations>).forEach(loc => {
      root.setAttribute(`data-track-previews-${loc.toLowerCase()}`, trackPreviewLocations[loc] ? 'on' : 'off');
    });
  }, [trackPreviewLocations]);
  // Drive the SVG progress-ring keyframe duration from the same setting that
  // governs the engine's auto-stop timer so both finish in lockstep.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--preview-duration',
      `${trackPreviewDurationSec}s`,
    );
  }, [trackPreviewDurationSec]);

  return getWindowKind() === 'mini' ? <MiniPlayerApp /> : <MainApp />;
}
