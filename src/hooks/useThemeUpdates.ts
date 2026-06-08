import { useEffect, useMemo, useState } from 'react';
import { isNewer } from '../utils/componentHelpers/appUpdaterHelpers';
import { fetchRegistry, getCachedRegistry, type Registry } from '../utils/themes/themeRegistry';
import { useInstalledThemesStore } from '../store/installedThemesStore';

export interface ThemeUpdate {
  id: string;
  /** The newer version advertised by the registry. */
  version: string;
}

// Refresh the registry from source once per app launch (not just from the
// cache). This surfaces newly published themes and updates without the user
// having to hit the manual refresh in the Theme Store, and it feeds the
// sidebar update notice. Subsequent reads this session use the cache.
let sessionRefreshStarted = false;

/**
 * Installed community themes that have a newer version in the registry.
 * Seeds from the last-cached registry synchronously, then revalidates (forced
 * on the first call this session). Recomputes when the installed set changes,
 * so the list shrinks as the user updates themes.
 */
export function useThemeUpdates(): ThemeUpdate[] {
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
    const latestById = new Map(registry.themes.map(t => [t.id, t.version]));
    const out: ThemeUpdate[] = [];
    for (const inst of installed) {
      const latest = latestById.get(inst.id);
      if (latest && isNewer(latest, inst.version)) out.push({ id: inst.id, version: latest });
    }
    return out;
  }, [registry, installed]);
}

/**
 * Stable signature of an update set, used to remember a dismissal: the sidebar
 * notice stays hidden until a new or bumped update changes this string.
 */
export function themeUpdateSignature(updates: ThemeUpdate[]): string {
  return updates.map(u => `${u.id}@${u.version}`).sort().join(',');
}
