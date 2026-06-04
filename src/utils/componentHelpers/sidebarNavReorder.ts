import { ALL_NAV_ITEMS } from '../../config/navItems';
import { CONSERVED_SIDEBAR_NAV_IDS, type SidebarItemConfig } from '../../store/sidebarStore';

export type SidebarNavSection = 'library' | 'system';

export type SidebarNavDropTarget = {
  idx: number;
  before: boolean;
  section: SidebarNavSection;
};

export function getLibraryItemsForReorder(
  items: SidebarItemConfig[],
  randomNavMode: 'hub' | 'separate',
): SidebarItemConfig[] {
  return items.filter(cfg => {
    if (CONSERVED_SIDEBAR_NAV_IDS.has(cfg.id)) return false;
    if (!ALL_NAV_ITEMS[cfg.id] || ALL_NAV_ITEMS[cfg.id].section !== 'library') return false;
    if (randomNavMode === 'hub' && (cfg.id === 'randomMix' || cfg.id === 'randomAlbums' || cfg.id === 'luckyMix')) return false;
    if (randomNavMode === 'separate' && cfg.id === 'randomPicker') return false;
    return true;
  });
}

export function getSystemItemsForReorder(items: SidebarItemConfig[]): SidebarItemConfig[] {
  return items.filter(cfg => ALL_NAV_ITEMS[cfg.id]?.section === 'system');
}

/**
 * Resolve the route the app should open on "/" when the Mainstage entry is
 * hidden from the sidebar. Mirrors the sidebar's own visible-library ordering
 * (same filter + randomNavMode + luckyMix gating) and returns the first visible
 * library item's route, skipping Mainstage itself ('/'). Returns null when no
 * other library item is visible, so the caller can fall back to rendering the
 * (empty) Mainstage rather than redirecting nowhere.
 */
export function resolveStartRoute(
  items: SidebarItemConfig[],
  randomNavMode: 'hub' | 'separate',
  luckyMixAvailable: boolean,
): string | null {
  const libraryConfigs = getLibraryItemsForReorder(items, randomNavMode).filter(cfg => {
    if (!cfg.visible) return false;
    if (cfg.id === 'luckyMix' && !luckyMixAvailable) return false;
    return true;
  });
  for (const cfg of libraryConfigs) {
    const to = ALL_NAV_ITEMS[cfg.id]?.to;
    if (to && to !== '/') return to;
  }
  return null;
}

/** Same entries as in Settings toggles — safe to hide via drag-out. */
export function isSidebarNavItemUserHideable(id: string): boolean {
  return Boolean(ALL_NAV_ITEMS[id]) && !CONSERVED_SIDEBAR_NAV_IDS.has(id);
}

/**
 * Reorders one sidebar section (library or system) like the Settings customizer.
 * Returns a new `items` array, or null if nothing changes.
 */
export function applySidebarDropReorder(
  allItems: SidebarItemConfig[],
  section: SidebarNavSection,
  fromIdx: number,
  target: SidebarNavDropTarget | null,
  randomNavMode: 'hub' | 'separate',
): SidebarItemConfig[] | null {
  if (!target || target.section !== section) return null;

  const sectionItems =
    section === 'library'
      ? [...getLibraryItemsForReorder(allItems, randomNavMode)]
      : [...getSystemItemsForReorder(allItems)];

  const insertBefore = target.before ? target.idx : target.idx + 1;
  if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return null;

  const [moved] = sectionItems.splice(fromIdx, 1);
  sectionItems.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);

  const visibleIds = new Set(sectionItems.map(c => c.id));
  const next = [...allItems];
  const positions = next
    .map((cfg, i) => ({ cfg, i }))
    .filter(({ cfg }) => visibleIds.has(cfg.id))
    .map(({ i }) => i);
  positions.forEach((pos, i) => {
    next[pos] = sectionItems[i];
  });
  return next;
}
