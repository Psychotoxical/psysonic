import { useInstalledThemesStore } from '@/store/installedThemesStore';
import { useThemeStore } from '@/store/themeStore';
import { removeThemeAssets } from '@/lib/themes/themeAssetStorage';

/**
 * Uninstall a community theme and repair any theme selection that pointed at it.
 *
 * A removed theme has no `[data-theme]` block, so every slot referencing its id
 * must fall back to a bundled core — not just the manual `theme`, but the
 * scheduler's `themeDay` / `themeNight` too. Without this, uninstalling a theme
 * that is set as the day/night theme leaves the scheduler pointing at a missing
 * id; when the clock crosses into that slot the app renders unstyled until the
 * next launch (where the bootstrap migration would repair it).
 *
 * Fallback per slot: the active theme keeps its light/dark mode (Latte / Mocha);
 * the day slot is light (Latte), the night slot is dark (Mocha).
 */
export function uninstallTheme(id: string): void {
  const installed = useInstalledThemesStore.getState();
  const wasLight = installed.getInstalled(id)?.mode === 'light';
  installed.uninstall(id);
  // Drop any on-disk assets. Best-effort and off the critical path — the startup
  // orphan sweep removes it anyway if this fails.
  void removeThemeAssets(id);

  const t = useThemeStore.getState();
  if (t.theme === id) t.setTheme(wasLight ? 'latte' : 'mocha');
  if (t.themeDay === id) t.setThemeDay('latte');
  if (t.themeNight === id) t.setThemeNight('mocha');
}
