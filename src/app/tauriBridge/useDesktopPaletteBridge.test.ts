import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { onInvoke, emitTauriEvent } from '@/test/mocks/tauri';
import { resetAllStores } from '@/test/helpers/storeReset';
import { useInstalledThemesStore } from '@/store/installedThemesStore';
import { useThemeStore } from '@/store/themeStore';
import { desktopPaletteTheme, useDesktopPaletteBridge } from './useDesktopPaletteBridge';
import type { DesktopPalette } from '@/generated/bindings';

const named: DesktopPalette = {
  source: '/home/user/.local/state/named/current/theme/colors.toml',
  name: 'Example Theme',
  mode: 'dark',
  colors: { background: '#101014', foreground: '#e6e6ec', accent: '#4c6ef5' },
};

const unnamed: DesktopPalette = {
  source: '/tmp/palette.toml',
  name: null,
  mode: null,
  colors: { background: '#18181c', foreground: '#e8e8ef', accent: '#7aa2f7' },
};

describe('desktopPaletteTheme', () => {
  it("carries the desktop theme's name and where it came from", () => {
    const theme = desktopPaletteTheme(named);

    expect(theme.id).toBe('desktop');
    expect(theme.name).toBe('Desktop — Example Theme');
    expect(theme.mode).toBe('dark');
    expect(theme.description).toBe(named.source);
    // Not a dev copy — it persists, so a selected desktop theme survives a restart.
    expect(theme.dev).toBeUndefined();
    expect(theme.css).toContain("[data-theme='desktop']");
  });

  it('falls back to a generic name when the desktop publishes none', () => {
    expect(desktopPaletteTheme(unnamed).name).toBe('Desktop');
    expect(desktopPaletteTheme(unnamed).mode).toBe('dark');
  });

  it('reports a light palette as light so the theme store schedules it correctly', () => {
    const light = { ...unnamed, colors: { ...unnamed.colors, background: '#fafafa' } };

    expect(desktopPaletteTheme(light).mode).toBe('light');
  });
});

describe('useDesktopPaletteBridge — following the desktop', () => {
  beforeEach(() => {
    resetAllStores();
    useInstalledThemesStore.setState({ themes: [] });
    // `resetAllStores` does not cover the theme store, so set the fields these
    // tests steer explicitly — otherwise one test's toggle leaks into the next.
    useThemeStore.setState({ theme: 'mocha', followDesktopTheme: true, enableThemeScheduler: false });
    onInvoke('read_desktop_palette', () => named);
  });

  const mount = () => renderHook(() => useDesktopPaletteBridge());

  it('installs the theme and selects it while following', async () => {
    mount();
    await waitFor(() => {
      expect(useInstalledThemesStore.getState().getInstalled('desktop')).toBeDefined();
    });

    // The selection is the whole point: without it the theme sits in the grid
    // and the app keeps rendering whatever was selected before.
    expect(useThemeStore.getState().theme).toBe('desktop');
  });

  it('leaves the selection alone when following is off', async () => {
    useThemeStore.setState({ followDesktopTheme: false, theme: 'mocha' });
    mount();
    await waitFor(() => {
      expect(useInstalledThemesStore.getState().getInstalled('desktop')).toBeDefined();
    });

    // Still installed — it stays available as an ordinary card in the grid.
    expect(useThemeStore.getState().theme).toBe('mocha');
  });

  it('yields to the day/night scheduler rather than fighting it', async () => {
    useThemeStore.setState({ enableThemeScheduler: true, theme: 'mocha' });
    mount();
    await waitFor(() => {
      expect(useInstalledThemesStore.getState().getInstalled('desktop')).toBeDefined();
    });

    expect(useThemeStore.getState().theme).toBe('mocha');
  });

  it('re-themes on a live palette change without a restart', async () => {
    mount();
    await waitFor(() => {
      expect(useInstalledThemesStore.getState().getInstalled('desktop')).toBeDefined();
    });

    emitTauriEvent('desktop-palette:changed', {
      ...named,
      name: 'Other Theme',
      colors: { ...named.colors, background: '#202028', accent: '#ff0000' },
    });

    await waitFor(() => {
      expect(useInstalledThemesStore.getState().getInstalled('desktop')?.name)
        .toBe('Desktop — Other Theme');
    });
    expect(useInstalledThemesStore.getState().getInstalled('desktop')?.css)
      .toContain('--ctp-mauve: #ff0000;');
  });

  it('re-selects the desktop theme on a restart with an unchanged palette', async () => {
    // The startup read short-circuits the reinstall when nothing changed; the
    // selection still has to be put back, which is the restart case.
    useInstalledThemesStore.setState({ themes: [desktopPaletteTheme(named)] });
    useThemeStore.setState({ theme: 'mocha' });
    mount();

    await waitFor(() => {
      expect(useThemeStore.getState().theme).toBe('desktop');
    });
  });
});
