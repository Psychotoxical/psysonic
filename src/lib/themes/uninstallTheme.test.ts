/**
 * Tests for uninstallTheme — removing a community theme must repair every
 * selection slot that referenced it (active + scheduler day/night).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { uninstallTheme } from '@/lib/themes/uninstallTheme';
import { useInstalledThemesStore, type InstalledTheme } from '@/store/installedThemesStore';
import { useThemeStore } from '@/store/themeStore';

function mk(id: string, mode: 'dark' | 'light' = 'dark'): InstalledTheme {
  return { id, name: id, author: 'a', version: '1.0.0', description: '', mode, css: `[data-theme='${id}']{--accent:#fff;}`, installedAt: 0 };
}

beforeEach(() => {
  useInstalledThemesStore.setState({ themes: [] });
  useThemeStore.setState({ theme: 'mocha', themeDay: 'latte', themeNight: 'mocha' });
});

describe('uninstallTheme', () => {
  it('removes the theme from the installed store', () => {
    useInstalledThemesStore.getState().install(mk('dracula'));
    uninstallTheme('dracula');
    expect(useInstalledThemesStore.getState().isInstalled('dracula')).toBe(false);
  });

  it('resets an active dark theme to mocha', () => {
    useInstalledThemesStore.getState().install(mk('dracula', 'dark'));
    useThemeStore.setState({ theme: 'dracula' });
    uninstallTheme('dracula');
    expect(useThemeStore.getState().theme).toBe('mocha');
  });

  it('resets an active light theme to latte', () => {
    useInstalledThemesStore.getState().install(mk('nord-snowstorm', 'light'));
    useThemeStore.setState({ theme: 'nord-snowstorm' });
    uninstallTheme('nord-snowstorm');
    expect(useThemeStore.getState().theme).toBe('latte');
  });

  it('resets the scheduler day slot to latte', () => {
    useInstalledThemesStore.getState().install(mk('dracula'));
    useThemeStore.setState({ themeDay: 'dracula' });
    uninstallTheme('dracula');
    expect(useThemeStore.getState().themeDay).toBe('latte');
  });

  it('resets the scheduler night slot to mocha', () => {
    useInstalledThemesStore.getState().install(mk('dracula'));
    useThemeStore.setState({ themeNight: 'dracula' });
    uninstallTheme('dracula');
    expect(useThemeStore.getState().themeNight).toBe('mocha');
  });

  it('repairs every slot at once', () => {
    useInstalledThemesStore.getState().install(mk('dracula', 'dark'));
    useThemeStore.setState({ theme: 'dracula', themeDay: 'dracula', themeNight: 'dracula' });
    uninstallTheme('dracula');
    const s = useThemeStore.getState();
    expect([s.theme, s.themeDay, s.themeNight]).toEqual(['mocha', 'latte', 'mocha']);
  });

  it('leaves unrelated slots untouched', () => {
    useInstalledThemesStore.getState().install(mk('dracula'));
    useThemeStore.setState({ theme: 'kanagawa-wave', themeDay: 'latte', themeNight: 'mocha' });
    uninstallTheme('dracula');
    const s = useThemeStore.getState();
    expect([s.theme, s.themeDay, s.themeNight]).toEqual(['kanagawa-wave', 'latte', 'mocha']);
  });
});
