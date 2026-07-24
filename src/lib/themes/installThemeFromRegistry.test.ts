import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/themes/themeRegistry', () => ({
  fetchThemeCss: vi.fn(),
  themeRequiresNewerApp: vi.fn(),
}));
vi.mock('@/lib/themes/themeInjection', () => ({ validateThemeCss: vi.fn() }));
vi.mock('@/lib/themes/themeAssetInstall', () => ({ installRegistryAssets: vi.fn() }));
vi.mock('@/lib/themes/themeAssetStorage', () => ({ removeThemeAssets: vi.fn().mockResolvedValue(undefined) }));

import { fetchThemeCss, themeRequiresNewerApp, type RegistryTheme } from '@/lib/themes/themeRegistry';
import { validateThemeCss } from '@/lib/themes/themeInjection';
import { installRegistryAssets } from '@/lib/themes/themeAssetInstall';
import { removeThemeAssets } from '@/lib/themes/themeAssetStorage';
import { useInstalledThemesStore } from '@/store/installedThemesStore';
import { installThemeFromRegistry } from '@/lib/themes/installThemeFromRegistry';

const fetchCss = vi.mocked(fetchThemeCss);
const validate = vi.mocked(validateThemeCss);
const requiresNewerApp = vi.mocked(themeRequiresNewerApp);
const installAssets = vi.mocked(installRegistryAssets);
const removeAssets = vi.mocked(removeThemeAssets);

const TH = {
  id: 'theme-a',
  name: 'Theme A',
  author: 'someone',
  version: '1.1.0',
  description: 'desc',
  mode: 'dark',
  tags: ['x'],
  css: 'themes/theme-a/theme.css',
} as unknown as RegistryTheme;

beforeEach(() => {
  useInstalledThemesStore.setState({ themes: [] });
  fetchCss.mockReset();
  validate.mockReset();
  requiresNewerApp.mockReset();
  requiresNewerApp.mockReturnValue(false);
  installAssets.mockReset();
  removeAssets.mockReset();
  removeAssets.mockResolvedValue(undefined);
});

describe('installThemeFromRegistry', () => {
  it('installs the validated CSS and returns ok', async () => {
    fetchCss.mockResolvedValue('/* css */');
    validate.mockReturnValue('/* css */');

    await expect(installThemeFromRegistry(TH)).resolves.toBe('ok');

    const installed = useInstalledThemesStore.getState().getInstalled('theme-a');
    expect(installed?.version).toBe('1.1.0');
    expect(installed?.css).toBe('/* css */');
  });

  it('does not persist CSS that fails the safety floor', async () => {
    fetchCss.mockResolvedValue('bad');
    validate.mockReturnValue(null);

    await expect(installThemeFromRegistry(TH)).resolves.toBe('invalid');
    expect(useInstalledThemesStore.getState().isInstalled('theme-a')).toBe(false);
  });

  it('returns error when the fetch fails', async () => {
    fetchCss.mockRejectedValue(new Error('network'));

    await expect(installThemeFromRegistry(TH)).resolves.toBe('error');
    expect(useInstalledThemesStore.getState().isInstalled('theme-a')).toBe(false);
  });

  it('refuses a theme that needs a newer app, before any fetch', async () => {
    requiresNewerApp.mockReturnValue(true);

    await expect(installThemeFromRegistry(TH)).resolves.toBe('app-too-old');
    expect(fetchCss).not.toHaveBeenCalled();
    expect(useInstalledThemesStore.getState().isInstalled('theme-a')).toBe(false);
  });

  it('writes assets and persists the asset base for a theme that ships them', async () => {
    fetchCss.mockResolvedValue('/* css */');
    validate.mockReturnValue('/* css */');
    installAssets.mockResolvedValue({ ok: true, assetBase: '/data/themes/theme-a', rels: ['assets/logo.svg'] });
    const withAssets = { ...TH, assets: [{ path: 'themes/theme-a/assets/logo.svg', bytes: 10 }] } as RegistryTheme;

    await expect(installThemeFromRegistry(withAssets)).resolves.toBe('ok');
    const installed = useInstalledThemesStore.getState().getInstalled('theme-a');
    expect(installed?.assetBase).toBe('/data/themes/theme-a');
    expect(installed?.assets).toEqual(['assets/logo.svg']);
  });

  it('aborts and cleans up when an asset fails the contract', async () => {
    fetchCss.mockResolvedValue('/* css */');
    validate.mockReturnValue('/* css */');
    installAssets.mockResolvedValue({ ok: false, reason: 'invalid' });
    const withAssets = { ...TH, assets: [{ path: 'themes/theme-a/assets/evil.exe', bytes: 10 }] } as RegistryTheme;

    await expect(installThemeFromRegistry(withAssets)).resolves.toBe('invalid');
    expect(removeAssets).toHaveBeenCalledWith('theme-a');
    expect(useInstalledThemesStore.getState().isInstalled('theme-a')).toBe(false);
  });

  it('clears a prior asset directory when an update drops its assets', async () => {
    fetchCss.mockResolvedValue('/* css */');
    validate.mockReturnValue('/* css */');

    await expect(installThemeFromRegistry(TH)).resolves.toBe('ok');
    expect(removeAssets).toHaveBeenCalledWith('theme-a');
    expect(installAssets).not.toHaveBeenCalled();
    const installed = useInstalledThemesStore.getState().getInstalled('theme-a');
    expect(installed?.assetBase).toBeUndefined();
  });
});
