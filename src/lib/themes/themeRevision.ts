import { useSyncExternalStore } from 'react';

/**
 * A counter that moves whenever the *contents* of an injected theme change.
 *
 * Canvas surfaces (the seekbar waveform, the visualizer, the EQ curve) can't
 * express their colours in CSS — they read `--accent` & co. with
 * `getComputedStyle` and cache the result, keyed on the theme id. That key is
 * sound for every bundled or community theme, whose id changes whenever its
 * colours do.
 *
 * The `desktop` theme breaks it: its id is constant while its CSS is rewritten
 * every time the user switches their desktop theme, so an id-keyed cache
 * returns the previous palette's colours forever. This is the missing signal —
 * bumped after `syncInjectedThemes` actually rewrites a `<style>`, so those
 * consumers re-read.
 *
 * Mirrored onto `<html data-theme-rev>` for non-React callers that already read
 * attributes off the root (see `waveformSeekHelpers`), and exposed as a React
 * hook for the rest. Because the bump happens in App's injection effect, a
 * subscriber's own effect re-runs in a *later* commit — i.e. after the new CSS
 * is in the document, which is what makes the re-read see fresh values.
 */

let revision = 0;
const listeners = new Set<() => void>();

/** Call after injected theme CSS changed. No-op for a same-CSS re-render. */
export function bumpThemeRevision(): void {
  revision += 1;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme-rev', String(revision));
  }
  for (const listener of listeners) listener();
}

export function getThemeRevision(): number {
  return revision;
}

export function subscribeThemeRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the caller whenever injected theme CSS changes. Use it as an
 *  effect dependency next to the theme id, not as a value to render. */
export function useThemeRevision(): number {
  return useSyncExternalStore(subscribeThemeRevision, getThemeRevision, getThemeRevision);
}

/** Test seam — resets the module counter between cases. */
export function _resetThemeRevisionForTest(): void {
  revision = 0;
  listeners.clear();
  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute('data-theme-rev');
  }
}
