import { ALL_NAV_ITEMS } from '../../config/navItems';
import type { SidebarItemConfig } from '../../store/sidebarStore';

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
    if (!ALL_NAV_ITEMS[cfg.id] || ALL_NAV_ITEMS[cfg.id].section !== 'library') return false;
    if (randomNavMode === 'hub' && (cfg.id === 'randomMix' || cfg.id === 'randomAlbums' || cfg.id === 'luckyMix')) return false;
    if (randomNavMode === 'separate' && cfg.id === 'randomPicker') return false;
    return true;
  });
}

export function getSystemItemsForReorder(items: SidebarItemConfig[]): SidebarItemConfig[] {
  return items.filter(cfg => ALL_NAV_ITEMS[cfg.id]?.section === 'system');
}

/** Same entries as in Settings toggles — safe to hide via drag-out. */
export function isSidebarNavItemUserHideable(id: string): boolean {
  return Boolean(ALL_NAV_ITEMS[id]);
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
