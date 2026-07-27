/**
 * Tests for pickSpotlightTheme — the slot exists to surface themes that sit past
 * the store's first page, so "prefers the back of the catalogue" is the property
 * under test, not merely "returns something".
 */
import { describe, expect, it } from 'vitest';

import { pickSpotlightTheme } from '@/lib/themes/pickSpotlightTheme';
import type { RegistryTheme } from '@/lib/themes/themeRegistry';

/** Builds a catalogue where index 0 is the most recently changed theme. */
function catalogue(count: number, overrides: Partial<RegistryTheme>[] = []): RegistryTheme[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `theme-${i}`,
    name: `Theme ${String(i).padStart(2, '0')}`,
    author: 'someone',
    version: '1.0.0',
    description: 'A theme.',
    mode: 'dark' as const,
    css: `themes/theme-${i}/theme.css`,
    thumbnail: `themes/theme-${i}/thumbnail.webp`,
    // Descending dates: theme-0 newest, so the front page is theme-0..theme-N.
    updatedAt: new Date(Date.UTC(2026, 0, 100 - i)).toISOString(),
    ...overrides[i],
  }));
}

const base = {
  installedIds: new Set<string>(),
  activeThemeId: null,
  frontPageSize: 12,
};

describe('pickSpotlightTheme', () => {
  it('returns null for an empty catalogue', () => {
    expect(pickSpotlightTheme({ ...base, themes: [], random: 0 })).toBeNull();
  });

  it('never picks from the first page while older themes exist', () => {
    const themes = catalogue(30);
    const frontPage = new Set(themes.slice(0, 12).map(th => th.id));
    // Sweep the whole random range: every draw must land past the fold.
    for (let r = 0; r < 1; r += 0.01) {
      const pick = pickSpotlightTheme({ ...base, themes, random: r });
      expect(pick).not.toBeNull();
      expect(frontPage.has(pick!.id)).toBe(false);
    }
  });

  it('prefers a theme the user has not installed', () => {
    const themes = catalogue(15);
    // Everything past the fold except the last one is already installed.
    const installedIds = new Set(themes.slice(12, 14).map(th => th.id));
    const pick = pickSpotlightTheme({ ...base, themes, installedIds, random: 0.5 });
    expect(pick!.id).toBe('theme-14');
  });

  it('falls back to installed themes when every older one is installed', () => {
    const themes = catalogue(15);
    const installedIds = new Set(themes.map(th => th.id));
    const pick = pickSpotlightTheme({ ...base, themes, installedIds, random: 0 });
    expect(pick).not.toBeNull();
    expect(installedIds.has(pick!.id)).toBe(true);
  });

  it('falls back to the front page on a catalogue smaller than one page', () => {
    const themes = catalogue(3);
    const pick = pickSpotlightTheme({ ...base, themes, random: 0 });
    expect(pick!.id).toBe('theme-0');
  });

  it('never picks the active theme', () => {
    const themes = catalogue(2);
    const pick = pickSpotlightTheme({ ...base, themes, activeThemeId: 'theme-0', random: 0 });
    expect(pick!.id).toBe('theme-1');
  });

  it('skips themes that need a newer app', () => {
    const themes = catalogue(2, [{ minAppVersion: '99.0.0' }]);
    const pick = pickSpotlightTheme({ ...base, themes, random: 0 });
    expect(pick!.id).toBe('theme-1');
  });

  it('returns null when nothing in the catalogue is usable', () => {
    const themes = catalogue(1, [{ minAppVersion: '99.0.0' }]);
    expect(pickSpotlightTheme({ ...base, themes, random: 0 })).toBeNull();
  });

  it('avoids repeating the current pick when shuffling', () => {
    const themes = catalogue(14);
    // Two themes past the fold; excluding one must yield the other for any draw.
    for (const r of [0, 0.4, 0.99]) {
      const pick = pickSpotlightTheme({ ...base, themes, excludeId: 'theme-12', random: r });
      expect(pick!.id).toBe('theme-13');
    }
  });

  it('still returns the excluded theme when it is the only candidate', () => {
    const themes = catalogue(1);
    const pick = pickSpotlightTheme({ ...base, themes, excludeId: 'theme-0', random: 0 });
    expect(pick!.id).toBe('theme-0');
  });

  it('clamps a random value of 1 to the last candidate', () => {
    const themes = catalogue(14);
    const pick = pickSpotlightTheme({ ...base, themes, random: 1 });
    expect(pick!.id).toBe('theme-13');
  });
});
