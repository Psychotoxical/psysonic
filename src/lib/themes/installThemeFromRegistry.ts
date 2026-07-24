import { fetchThemeCss, themeRequiresNewerApp, type RegistryTheme } from '@/lib/themes/themeRegistry';
import { validateThemeCss } from '@/lib/themes/themeInjection';
import { installRegistryAssets } from '@/lib/themes/themeAssetInstall';
import { removeThemeAssets } from '@/lib/themes/themeAssetStorage';
import { useInstalledThemesStore } from '@/store/installedThemesStore';

export type InstallResult = 'ok' | 'invalid' | 'error' | 'app-too-old';

/**
 * Fetch a registry theme's CSS, validate it against the in-app safety floor,
 * write any local assets to disk, and persist it (install or in-place update —
 * the store replaces by id). Shared by the Theme Store list and the "your
 * themes" update chip so both go through the same fetch → validate → install
 * path.
 *
 * Never throws: returns `'app-too-old'` when the theme needs a newer app,
 * `'invalid'` when the CSS or an asset fails the floor and `'error'` on a
 * network/fetch failure, so callers can surface it without a try/catch.
 */
export async function installThemeFromRegistry(th: RegistryTheme): Promise<InstallResult> {
  // Refuse before any fetch: a theme built for a newer app may rely on a
  // capability this build lacks, so installing it would render broken. This is
  // the single choke point every install/update path goes through, so the guard
  // holds even where a caller forgets to check.
  if (themeRequiresNewerApp(th)) return 'app-too-old';
  try {
    const css = await fetchThemeCss(th.css);
    // Don't persist CSS that won't inject — it would show as installed/active
    // but render nothing. Validate before storing.
    if (validateThemeCss(css, th.id) == null) return 'invalid';

    // Local assets: write them before persisting, so the theme is never stored
    // pointing at files that aren't on disk. A failure removes the partial
    // directory and aborts the install.
    let assetBase: string | undefined;
    let assets: string[] | undefined;
    if (th.assets && th.assets.length > 0) {
      const res = await installRegistryAssets(th.id, th.assets);
      if (!res.ok) {
        await removeThemeAssets(th.id);
        return res.reason;
      }
      assetBase = res.assetBase;
      assets = res.rels;
    } else {
      // An update that dropped its assets must not keep the old files around.
      await removeThemeAssets(th.id);
    }

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
      ...(assetBase ? { assetBase, assets } : {}),
    });
    return 'ok';
  } catch {
    return 'error';
  }
}
