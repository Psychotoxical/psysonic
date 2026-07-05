import { useEffect, useMemo, useState } from 'react';
import { isNewer } from '@/lib/util/appUpdaterHelpers';
import { fetchRegistry, getCachedRegistry, type Registry, type RegistryTheme } from '@/lib/themes/themeRegistry';
import { useInstalledThemesStore } from '@/store/installedThemesStore';

// Refresh the registry from source once per app launch (not just from the
// cache). This surfaces newly published themes and updates without the user
// having to hit the manual refresh in the Theme Store, and it feeds the
// sidebar update notice. Subsequent reads this session use the cache.
let sessionRefreshStarted = false;

/**
 * Registry entries for installed community themes that have a newer version
 * available. Returns the full registry theme (css path, version, metadata) so a
 * caller can update in place. Seeds from the last-cached registry synchronously,
 * then revalidates (forced on the first call this session). Recomputes when the
 * installed set changes, so the list shrinks as the user updates themes.
 */
export function useThemeUpdates(): RegistryTheme[] {
  const installed = useInstalledThemesStore(s => s.themes);
  const [registry, setRegistry] = useState<Registry | null>(() => getCachedRegistry());

  useEffect(() => {
    let alive = true;
    const opts = sessionRefreshStarted ? undefined : { force: true };
    sessionRefreshStarted = true;
    fetchRegistry(opts)
      .then(r => { if (alive) setRegistry(r.registry); })
      .catch(() => { /* offline: keep whatever the cache gave us */ });
    return () => { alive = false; };
  }, []);

  return useMemo(() => {
    if (!registry) return [];
    const installedVersionById = new Map(installed.map(t => [t.id, t.version]));
    return registry.themes.filter(rt => {
      const current = installedVersionById.get(rt.id);
      return current != null && isNewer(rt.version, current);
    });
  }, [registry, installed]);
}

/**
 * Stable signature of an update set, used to remember a dismissal: the sidebar
 * notice stays hidden until a new or bumped update changes this string.
 */
export function themeUpdateSignature(updates: Array<{ id: string; version: string }>): string {
  return updates.map(u => `${u.id}@${u.version}`).sort().join(',');
}
