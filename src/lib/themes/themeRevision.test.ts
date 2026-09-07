import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetThemeRevisionForTest,
  bumpThemeRevision,
  getThemeRevision,
  subscribeThemeRevision,
} from './themeRevision';
import { syncInjectedThemes } from './themeInjection';
import type { InstalledTheme } from '@/store/installedThemesStore';

function theme(css: string, id = 'desktop'): InstalledTheme {
  return {
    id,
    name: 'Desktop',
    author: 'desktop',
    version: '1.0.0',
    description: '',
    mode: 'dark',
    css,
    installedAt: 0,
  };
}

const A = "[data-theme='desktop'] { --accent: #4c6ef5; }";
const B = "[data-theme='desktop'] { --accent: #f38d70; }";

beforeEach(() => {
  _resetThemeRevisionForTest();
  document.head.querySelectorAll('style[data-installed-theme]').forEach(el => el.remove());
});

describe('themeRevision', () => {
  it('advances and mirrors onto the root element', () => {
    expect(getThemeRevision()).toBe(0);

    bumpThemeRevision();

    expect(getThemeRevision()).toBe(1);
    // Canvas code that already reads root attributes picks it up without a hook.
    expect(document.documentElement.getAttribute('data-theme-rev')).toBe('1');
  });

  it('notifies subscribers until they unsubscribe', () => {
    const seen = vi.fn();
    const stop = subscribeThemeRevision(seen);

    bumpThemeRevision();
    expect(seen).toHaveBeenCalledTimes(1);

    stop();
    bumpThemeRevision();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('syncInjectedThemes change reporting', () => {
  it('reports the first injection', () => {
    expect(syncInjectedThemes([theme(A)])).toBe(true);
  });

  it('reports nothing for an identical re-sync', () => {
    syncInjectedThemes([theme(A)]);

    // The store rewrites on every palette read; only real CSS changes count.
    expect(syncInjectedThemes([theme(A)])).toBe(false);
  });

  it('reports a rewrite that keeps the same theme id', () => {
    syncInjectedThemes([theme(A)]);

    // This is the desktop-palette case the theme id alone cannot detect.
    expect(syncInjectedThemes([theme(B)])).toBe(true);
  });

  it('reports a removal', () => {
    syncInjectedThemes([theme(A)]);

    expect(syncInjectedThemes([])).toBe(true);
  });
});

describe('the attribute canvases observe', () => {
  /** The filter `WaveformSeek` installs to know when to repaint. */
  const FILTER = ['data-theme', 'data-theme-rev'];

  it('notifies the seekbar observer when the palette is rewritten', async () => {
    const fired = vi.fn();
    const observer = new MutationObserver(fired);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: FILTER });

    // A desktop palette switch: `data-theme` never moves, only the revision.
    bumpThemeRevision();
    // MutationObserver delivers on a microtask, batching records into one call.
    await Promise.resolve();
    observer.disconnect();

    expect(fired).toHaveBeenCalled();
    const records = fired.mock.calls[0][0] as MutationRecord[];
    expect(records.map(r => r.attributeName)).toContain('data-theme-rev');
  });

  it('writes a distinct value per bump, so no change goes unrecorded', async () => {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver(rs => records.push(...rs));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: FILTER });

    bumpThemeRevision();
    bumpThemeRevision();
    await Promise.resolve();
    observer.disconnect();

    // Re-writing an identical value still records a mutation, but a distinct
    // one keeps the attribute honest about how many rewrites happened.
    expect(records).toHaveLength(2);
    expect(document.documentElement.getAttribute('data-theme-rev')).toBe('2');
  });
});
