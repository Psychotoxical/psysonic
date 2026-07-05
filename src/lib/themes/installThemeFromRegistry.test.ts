import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/themes/themeRegistry', () => ({ fetchThemeCss: vi.fn() }));
vi.mock('@/lib/themes/themeInjection', () => ({ validateThemeCss: vi.fn() }));

import { fetchThemeCss, type RegistryTheme } from '@/lib/themes/themeRegistry';
import { validateThemeCss } from '@/lib/themes/themeInjection';
import { useInstalledThemesStore } from '@/store/installedThemesStore';
import { installThemeFromRegistry } from '@/lib/themes/installThemeFromRegistry';

const fetchCss = vi.mocked(fetchThemeCss);
const validate = vi.mocked(validateThemeCss);

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
});
