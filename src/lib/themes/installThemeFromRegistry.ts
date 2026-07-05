import { fetchThemeCss, type RegistryTheme } from '@/lib/themes/themeRegistry';
import { validateThemeCss } from '@/lib/themes/themeInjection';
import { useInstalledThemesStore } from '@/store/installedThemesStore';

export type InstallResult = 'ok' | 'invalid' | 'error';

/**
 * Fetch a registry theme's CSS, validate it against the in-app safety floor,
 * and persist it (install or in-place update — the store replaces by id).
 * Shared by the Theme Store list and the "your themes" update chip so both go
 * through the same fetch → validate → install path.
 *
 * Never throws: returns `'invalid'` when the CSS fails the floor and `'error'`
 * on a network/fetch failure, so callers can surface it without a try/catch.
 */
export async function installThemeFromRegistry(th: RegistryTheme): Promise<InstallResult> {
  try {
    const css = await fetchThemeCss(th.css);
    // Don't persist CSS that won't inject — it would show as installed/active
    // but render nothing. Validate before storing.
    if (validateThemeCss(css, th.id) == null) return 'invalid';
    useInstalledThemesStore.getState().install({
      id: th.id,
      name: th.name,
      author: th.author,
      version: th.version,
      description: th.description,
      mode: th.mode,
      tags: th.tags,
      css,
      installedAt: Date.now(),
    });
    return 'ok';
  } catch {
    return 'error';
  }
}
