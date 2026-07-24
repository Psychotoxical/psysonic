import { isTauri } from '@tauri-apps/api/core';
import { useInstalledThemesStore } from '@/store/installedThemesStore';
import { themeAssetBaseDir, sweepOrphanThemeDirs } from '@/lib/themes/themeAssetStorage';

/**
 * Startup reconciliation for on-disk theme assets. Runs once, in the main
 * window only, after mount:
 *
 *  1. **Self-heal** a stored `assetBase` that no longer matches the current app
 *     data directory — the profile was moved, copied to another machine, or a
 *     portable install changed paths. Re-storing the corrected base re-injects
 *     the theme with working `asset:` URLs. Without this, a moved profile would
 *     render every asset-using theme with broken images until re-install.
 *  2. **Sweep orphan directories** left by a crash mid-install or by an older
 *     client that removed a theme without cleaning up its files.
 *
 * Lives in the app layer (not `lib/`) because it reads the installed-themes
 * store to reconcile it. Best-effort: any failure is swallowed, since none of
 * this is load-bearing for the app to run.
 */
export async function reconcileThemeAssetsOnStartup(): Promise<void> {
  if (!isTauri()) return;
  const store = useInstalledThemesStore.getState();
  try {
    for (const t of store.themes) {
      if (!t.assetBase) continue;
      const expected = await themeAssetBaseDir(t.id);
      if (t.assetBase !== expected) {
        store.install({ ...t, assetBase: expected });
      }
    }
    await sweepOrphanThemeDirs(new Set(store.themes.map((t) => t.id)));
  } catch {
    // best-effort — a stale base or orphan directory is not fatal
  }
}
