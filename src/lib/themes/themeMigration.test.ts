/**
 * Tests for the slim-bundle theme migration (C5).
 *
 * The migration rewrites the persisted theme selection in localStorage before
 * React mounts: any theme/themeDay/themeNight that is neither bundled
 * (FIXED_THEMES) nor installed is reset to a bundled fallback — Mocha for the
 * main + night slots, Latte for the day slot. It never installs anything and
 * must never throw on malformed/missing storage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrateThemeSelection,
  readThemeMigrationNotice,
  clearThemeMigrationNotice,
} from '@/lib/themes/themeMigration';
import { FIXED_THEMES } from '@/lib/themes/fixedThemes';

const THEME_KEY = 'psysonic_theme';
const INSTALLED_KEY = 'psysonic_installed_themes';

interface ThemeSlots {
  theme?: unknown;
  themeDay?: unknown;
  themeNight?: unknown;
  [k: string]: unknown;
}

function setPersistedTheme(state: ThemeSlots, version = 1): void {
  localStorage.setItem(THEME_KEY, JSON.stringify({ state, version }));
}

function readPersistedTheme(): { state: ThemeSlots; version: number } {
  return JSON.parse(localStorage.getItem(THEME_KEY) as string);
}

function setInstalled(ids: string[]): void {
  localStorage.setItem(
    INSTALLED_KEY,
    JSON.stringify({ state: { themes: ids.map((id) => ({ id })) }, version: 1 }),
  );
}

afterEach(() => {
  localStorage.clear();
});

describe('migrateThemeSelection', () => {
  it('does nothing when there is no persisted theme (fresh profile)', () => {
    migrateThemeSelection();
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('leaves bundled (fixed) themes untouched', () => {
    setPersistedTheme({ theme: 'kanagawa-wave', themeDay: 'latte', themeNight: 'mocha' });
    migrateThemeSelection();
    expect(readPersistedTheme().state).toMatchObject({
      theme: 'kanagawa-wave',
      themeDay: 'latte',
      themeNight: 'mocha',
    });
  });

  it('every fixed theme id resolves (none is treated as unresolved)', () => {
    const ids = FIXED_THEMES.map((t) => t.id);
    setPersistedTheme({ theme: ids[0], themeDay: ids[1], themeNight: ids[2] });
    migrateThemeSelection();
    expect(readPersistedTheme().state).toMatchObject({
      theme: ids[0],
      themeDay: ids[1],
      themeNight: ids[2],
    });
  });

  it('resets an unresolved main theme to Mocha (dark)', () => {
    setPersistedTheme({ theme: 'dracula', themeDay: 'latte', themeNight: 'mocha' });
    migrateThemeSelection();
    expect(readPersistedTheme().state.theme).toBe('mocha');
  });

  it('resets an unresolved day theme to Latte (light)', () => {
    setPersistedTheme({ theme: 'mocha', themeDay: 'nord-snowstorm', themeNight: 'mocha' });
    migrateThemeSelection();
    expect(readPersistedTheme().state.themeDay).toBe('latte');
  });

  it('resets an unresolved night theme to Mocha (dark)', () => {
    setPersistedTheme({ theme: 'mocha', themeDay: 'latte', themeNight: 'blade' });
    migrateThemeSelection();
    expect(readPersistedTheme().state.themeNight).toBe('mocha');
  });

  it('keeps a store theme that the user has installed', () => {
    setInstalled(['dracula']);
    setPersistedTheme({ theme: 'dracula', themeDay: 'latte', themeNight: 'mocha' });
    migrateThemeSelection();
    expect(readPersistedTheme().state.theme).toBe('dracula');
  });

  it('migrates only the unresolved slots and preserves the rest', () => {
    setInstalled(['gruvbox-dark-hard']);
    setPersistedTheme({
      theme: 'nord', // unresolved -> mocha
      themeDay: 'latte', // fixed -> unchanged
      themeNight: 'gruvbox-dark-hard', // installed -> unchanged
      timeDayStart: '07:00',
      enableThemeScheduler: true,
    });
    migrateThemeSelection();
    const { state, version } = readPersistedTheme();
    expect(state).toMatchObject({
      theme: 'mocha',
      themeDay: 'latte',
      themeNight: 'gruvbox-dark-hard',
      timeDayStart: '07:00',
      enableThemeScheduler: true,
    });
    expect(version).toBe(1);
  });

  it('does not rewrite storage when nothing changes', () => {
    setPersistedTheme({ theme: 'mocha', themeDay: 'latte', themeNight: 'mocha' });
    const before = localStorage.getItem(THEME_KEY);
    migrateThemeSelection();
    expect(localStorage.getItem(THEME_KEY)).toBe(before);
  });

  it('still falls back when the installed-themes store is malformed', () => {
    localStorage.setItem(INSTALLED_KEY, '{not valid json');
    setPersistedTheme({ theme: 'dracula', themeDay: 'latte', themeNight: 'mocha' });
    migrateThemeSelection();
    expect(readPersistedTheme().state.theme).toBe('mocha');
  });

  it('does not throw on malformed theme storage', () => {
    localStorage.setItem(THEME_KEY, '{not valid json');
    expect(() => migrateThemeSelection()).not.toThrow();
    expect(localStorage.getItem(THEME_KEY)).toBe('{not valid json');
  });

  it('ignores empty-string slot values', () => {
    setPersistedTheme({ theme: '', themeDay: 'latte', themeNight: 'mocha' });
    migrateThemeSelection();
    // empty string is not a real selection — left as-is, store applies its default
    expect(readPersistedTheme().state.theme).toBe('');
  });
});

describe('theme migration notice', () => {
  it('records the original id(s) that were reset', () => {
    setPersistedTheme({ theme: 'dracula', themeDay: 'latte', themeNight: 'nord' });
    migrateThemeSelection();
    expect(readThemeMigrationNotice().sort()).toEqual(['dracula', 'nord']);
  });

  it('deduplicates ids used in multiple slots', () => {
    setPersistedTheme({ theme: 'dracula', themeDay: 'latte', themeNight: 'dracula' });
    migrateThemeSelection();
    expect(readThemeMigrationNotice()).toEqual(['dracula']);
  });

  it('writes no notice when nothing was reset', () => {
    setPersistedTheme({ theme: 'mocha', themeDay: 'latte', themeNight: 'mocha' });
    migrateThemeSelection();
    expect(readThemeMigrationNotice()).toEqual([]);
  });

  it('clear removes the notice', () => {
    setPersistedTheme({ theme: 'dracula', themeDay: 'latte', themeNight: 'mocha' });
    migrateThemeSelection();
    expect(readThemeMigrationNotice()).toEqual(['dracula']);
    clearThemeMigrationNotice();
    expect(readThemeMigrationNotice()).toEqual([]);
  });

  it('returns [] on malformed notice storage', () => {
    localStorage.setItem('psysonic_theme_migration_notice', '{not json');
    expect(readThemeMigrationNotice()).toEqual([]);
  });
});
