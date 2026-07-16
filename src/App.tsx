import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useLyricsStore } from './store/lyricsStore';
import { useThemeStore } from './store/themeStore';
import { useInstalledThemesStore } from './store/installedThemesStore';
import { gateInjectedThemes, syncInjectedThemes } from '@/lib/themes/themeInjection';
import { useThemeScheduler } from '@/app/hooks/useThemeScheduler';
import { useFontStore } from './store/fontStore';
import { getWindowKind } from './app/windowKind';
import { showToast } from '@/lib/dom/toast';
import MiniPlayerApp from './app/MiniPlayerApp';
import MainApp from './app/MainApp';

export default function App() {
  const theme = useThemeStore(s => s.theme);
  const themeDay = useThemeStore(s => s.themeDay);
  const themeNight = useThemeStore(s => s.themeNight);
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
    // Only the active slots participate in style matching (inactive styles
    // get media="not all" — see gateInjectedThemes). Runs in the same effects
    // flush as the data-theme attribute below, so a switch paints with both
    // applied.
    gateInjectedThemes([theme, themeDay, themeNight, effectiveTheme]);
  }, [installedThemes, theme, themeDay, themeNight, effectiveTheme]);

  // Dev only: `--theme-watch <theme.css | dir>` (debug builds) pushes local
  // theme CSS (+ sibling manifest.json metadata) in on every save. Each
  // payload is installed under the id in its `[data-theme='<id>']` selector —
  // the syncInjectedThemes effect above re-injects, so authoring is live
  // without re-importing a zip. `theme-watch:css` also applies (single file,
  // or a save in a watched directory); `theme-watch:css-seed` only installs
  // (directory startup sweep), so authors can switch between a themes-repo
  // checkout's themes in the UI. Both windows subscribe: dev-seeded themes
  // are session-only (excluded from persistence), so the mini player cannot
  // get them through the cross-window storage sync. Never wired in
  // production.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const unlisteners: (() => void)[] = [];
    void import('@tauri-apps/api/event').then(({ listen, emit }) => {
      type WatchPayload = {
        css: string;
        name?: string | null;
        author?: string | null;
        version?: string | null;
        description?: string | null;
        mode?: string | null;
      };
      const install = (payload: WatchPayload, apply: boolean) => {
        const css = payload?.css;
        const id = css?.match(/\[data-theme=['"]([^'"]+)['"]\]/)?.[1];
        if (!id) return;
        // Manifest metadata wins, then a store-installed copy's, then dev
        // placeholders — watched themes keep their real identity, and only
        // the CSS is the live payload. Fresh seeds are marked dev
        // (session-only, never persisted); a store-installed theme being
        // watched keeps its persisted entry.
        const prev = useInstalledThemesStore.getState().getInstalled(id);
        useInstalledThemesStore.getState().install({
          id,
          name: payload.name ?? prev?.name ?? id,
          author: payload.author ?? prev?.author ?? 'dev',
          version: payload.version ?? prev?.version ?? '0.0.0',
          description: payload.description ?? prev?.description ?? '',
          mode: payload.mode === 'light' || payload.mode === 'dark'
            ? payload.mode
            : prev?.mode ?? 'dark',
          tags: prev?.tags,
          css,
          installedAt: prev?.installedAt ?? Date.now(),
          dev: prev ? prev.dev ?? false : true,
        });
        if (apply) {
          useThemeStore.getState().setTheme(id);
          // Confirm the save reached the app — theme authors watch the app
          // window, not the terminal. Main window only: the mini player
          // subscribes too and would double the toast. Dev-only path, so the
          // string stays untranslated (same as the rest of theme-watch).
          if (getWindowKind() !== 'mini') {
            showToast(`Theme synced: ${payload.name ?? prev?.name ?? id}`, 2500, 'success');
          }
        }
      };
      const subs = [
        listen<WatchPayload>('theme-watch:css', ({ payload }) => install(payload, true)),
        listen<WatchPayload>('theme-watch:css-seed', ({ payload }) => install(payload, false)),
      ];
      // Guard the mocked-in-tests case where listen() isn't a promise.
      for (const sub of subs) {
        if (sub && typeof sub.then === 'function') void sub.then(u => { unlisteners.push(u); });
      }
      // Announce the attached listeners (again after every dev-server reload)
      // so the watcher (re-)sends current contents — no lost first emit.
      void emit('theme-watch:ready').catch(() => {});
    }).catch(() => {});
    return () => { unlisteners.forEach(u => u()); };
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
