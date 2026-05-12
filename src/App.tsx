import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { useThemeStore } from './store/themeStore';
import { useThemeScheduler } from './hooks/useThemeScheduler';
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

  // Document-attribute hooks are shared between both window kinds — each
  // webview has its own `document`, and theme / font / track-preview tokens
  // are read by CSS in both trees.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font', font);
  }, [font]);

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
