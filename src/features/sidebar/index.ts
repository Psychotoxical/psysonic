/**
 * Sidebar feature — the primary nav sidebar (library/system nav, playlists
 * section, library picker, active jobs) plus its nav config store, reorder
 * helpers, and the in-sidebar performance-probe overlay (Ctrl+Shift+P).
 */
export { default } from './components/Sidebar';
export { useSidebarStore, CONSERVED_SIDEBAR_NAV_IDS } from './store/sidebarStore';
export type { SidebarItemConfig } from './store/sidebarStore';
export { applySidebarReorderById, resolveStartRoute } from './utils/sidebarNavReorder';
