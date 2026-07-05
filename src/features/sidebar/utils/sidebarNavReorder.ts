import { ALL_NAV_ITEMS } from '@/config/navItems';
import { CONSERVED_SIDEBAR_NAV_IDS, type SidebarItemConfig } from '@/features/sidebar/store/sidebarStore';
import { applyListReorderById, type ListReorderDropTarget } from '@/lib/util/listReorder';

export type SidebarNavSection = 'library' | 'system';

export type SidebarNavDropTarget = {
  /** Stable id of the row the cursor is over — never a positional index. */
  id: string;
  before: boolean;
  section: SidebarNavSection;
};

/** True when `id` is a real, non-conserved nav item that lives in `section`. */
function itemBelongsToSection(id: string, section: SidebarNavSection): boolean {
  if (CONSERVED_SIDEBAR_NAV_IDS.has(id)) return false;
  return ALL_NAV_ITEMS[id]?.section === section;
}

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
 * Reorders one sidebar section by **stable item id**, not by positional index.
 *
 * The dragged row and the drop target are identified by id, and the move is
 * applied directly to the canonical full `items` array. This deliberately has
 * no shared index space with whatever filter decides which rows are *shown*:
 * a render filter (visibility, luckyMix availability, randomNavMode gating, any
 * future gate) can never desync the reorder, because indices are resolved here
 * from ids against the same array that is mutated. Hidden/gated items keep their
 * absolute slot and are never anchors.
 *
 * Returns a new `items` array, or `null` when nothing should change — unknown
 * id, cross-section drop, dropping onto self, or a no-op edge (defensive guard
 * against any payload the canonical list does not contain).
 */
export function applySidebarReorderById(
  allItems: SidebarItemConfig[],
  section: SidebarNavSection,
  draggedId: string,
  target: ListReorderDropTarget | null,
): SidebarItemConfig[] | null {
  if (!target || target.section !== section) return null;

  // Guard: both ids must be real, non-conserved items that belong to `section`.
  if (!itemBelongsToSection(draggedId, section)) return null;
  if (!itemBelongsToSection(target.id, section)) return null;

  // The move itself is the shared id-based reorder over the canonical array.
  return applyListReorderById(allItems, draggedId, target);
}
