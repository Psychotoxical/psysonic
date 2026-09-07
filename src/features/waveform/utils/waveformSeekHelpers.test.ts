import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getColors, invalidateColorCache } from './waveformSeekHelpers';
import { _resetThemeRevisionForTest, bumpThemeRevision } from '@/lib/themes/themeRevision';

/**
 * `getColors` caches by theme identity because resolving custom properties on
 * every animation frame is expensive. These cover what that key has to include:
 * the `desktop` theme rewrites its CSS under a constant id, so an id-only key
 * pinned the seekbar waveform to the previous desktop theme's accent.
 */

/** Stand-in for the resolved custom properties on `<html>`. */
let computed: Record<string, string> = {};

beforeEach(() => {
  _resetThemeRevisionForTest();
  invalidateColorCache();
  document.documentElement.setAttribute('data-theme', 'desktop');
  computed = { '--accent': '#4c6ef5' };
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () => ({ getPropertyValue: (name: string) => computed[name] ?? '' }) as CSSStyleDeclaration,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('getColors', () => {
  it('falls back to the accent when the theme names no waveform colour', () => {
    expect(getColors().played).toBe('#4c6ef5');
  });

  it('caches while nothing about the theme has moved', () => {
    getColors();
    computed['--accent'] = '#f38d70';

    // Deliberate: without a signal there is nothing to tell it to re-read, and
    // re-resolving on every frame is what the cache exists to avoid.
    expect(getColors().played).toBe('#4c6ef5');
  });

  it('re-reads when the theme CSS is rewritten under the same id', () => {
    getColors();
    computed['--accent'] = '#f38d70';

    // What a desktop-palette switch does: same `data-theme`, new colours.
    bumpThemeRevision();

    expect(getColors().played).toBe('#f38d70');
  });

  it('still re-reads on an ordinary theme switch', () => {
    getColors();
    computed['--accent'] = '#a6e3a1';
    document.documentElement.setAttribute('data-theme', 'latte');

    expect(getColors().played).toBe('#a6e3a1');
  });
});
