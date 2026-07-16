import { beforeEach, describe, expect, it } from 'vitest';
import { useInstalledThemesStore, type InstalledTheme } from './installedThemesStore';

const theme = (id: string, over: Partial<InstalledTheme> = {}): InstalledTheme => ({
  id,
  name: id,
  author: 'tester',
  version: '1.0.0',
  description: '',
  mode: 'dark',
  css: `[data-theme='${id}'] { --accent: #000; }`,
  installedAt: 1,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  useInstalledThemesStore.setState({ themes: [] });
});

describe('installedThemesStore', () => {
  it('replaces an existing theme in place, keeping its grid position', () => {
    const s = useInstalledThemesStore.getState();
    s.install(theme('a'));
    s.install(theme('b'));
    s.install(theme('c'));
    useInstalledThemesStore.getState().install(theme('b', { version: '1.0.1' }));
    expect(useInstalledThemesStore.getState().themes.map(t => t.id)).toEqual(['a', 'b', 'c']);
    expect(useInstalledThemesStore.getState().getInstalled('b')?.version).toBe('1.0.1');
  });

  it('appends a new theme at the end', () => {
    const s = useInstalledThemesStore.getState();
    s.install(theme('a'));
    s.install(theme('b'));
    expect(useInstalledThemesStore.getState().themes.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('keeps dev themes out of persisted storage', () => {
    const s = useInstalledThemesStore.getState();
    s.install(theme('real'));
    s.install(theme('wip', { dev: true }));
    const raw = localStorage.getItem('psysonic_installed_themes');
    const stored = JSON.parse(raw ?? '{}') as { state?: { themes?: InstalledTheme[] } };
    expect(stored.state?.themes?.map(t => t.id)).toEqual(['real']);
    // In-memory state still has both.
    expect(useInstalledThemesStore.getState().themes.map(t => t.id)).toEqual(['real', 'wip']);
  });

  it('keeps in-memory dev themes across a rehydrate', async () => {
    const s = useInstalledThemesStore.getState();
    s.install(theme('real'));
    s.install(theme('wip', { dev: true }));
    // Simulate another window persisting a change (cross-window storage sync
    // rehydrates this window from the new snapshot).
    localStorage.setItem(
      'psysonic_installed_themes',
      JSON.stringify({ state: { themes: [theme('real', { version: '2.0.0' })] }, version: 1 }),
    );
    await useInstalledThemesStore.persist.rehydrate();
    expect(useInstalledThemesStore.getState().themes.map(t => t.id)).toEqual(['real', 'wip']);
    expect(useInstalledThemesStore.getState().getInstalled('real')?.version).toBe('2.0.0');
  });

  it('drops a dev theme on rehydrate when storage has a real install of the same id', async () => {
    useInstalledThemesStore.getState().install(theme('x', { dev: true }));
    localStorage.setItem(
      'psysonic_installed_themes',
      JSON.stringify({ state: { themes: [theme('x', { version: '3.0.0' })] }, version: 1 }),
    );
    await useInstalledThemesStore.persist.rehydrate();
    const only = useInstalledThemesStore.getState().themes;
    expect(only).toHaveLength(1);
    expect(only[0].version).toBe('3.0.0');
    expect(only[0].dev).toBeUndefined();
  });
});
