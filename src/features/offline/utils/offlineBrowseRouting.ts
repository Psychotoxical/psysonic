import { isOfflineSidebarNavAllowed } from '@/features/offline/utils/offlineNavPolicy';

/** Any offline browse surface the disconnect fork may use. */
export function hasOfflineBrowseCapability(
  localLibraryBrowse: boolean,
  favoritesOfflineBrowse: boolean,
  hasManualOfflineContent: boolean,
): boolean {
  return localLibraryBrowse || favoritesOfflineBrowse || hasManualOfflineContent;
}

/** Map a route to a sidebar nav id for offline-allow checks (detail pages included). */
function offlineNavIdForPathname(pathname: string): string | null {
  if (pathname === '/albums') return 'allAlbums';
  if (pathname === '/artists' || pathname.startsWith('/artist/')) return 'artists';
  if (pathname === '/playlists' || pathname.startsWith('/playlists/')) return 'playlists';
  if (pathname === '/tracks') return 'tracks';
  if (pathname === '/favorites') return 'favorites';
  if (pathname === '/offline') return 'offline';
  if (pathname === '/help') return 'help';
  if (pathname === '/statistics' || pathname === '/player-stats') return 'statistics';
  if (pathname.startsWith('/album/')) return 'allAlbums';
  return null;
}

const OFFLINE_ALWAYS_STAY_PATHS = new Set([
  '/now-playing',
  '/settings',
]);

export function isPathOfflineBrowsable(
  pathname: string,
  favoritesOfflineBrowse: boolean,
  localLibraryBrowse: boolean,
  playerStatsBrowse: boolean,
  playlistsOfflineBrowse: boolean,
): boolean {
  if (OFFLINE_ALWAYS_STAY_PATHS.has(pathname)) return true;
  const navId = offlineNavIdForPathname(pathname);
  if (!navId) return false;
  return isOfflineSidebarNavAllowed(
    navId,
    favoritesOfflineBrowse,
    localLibraryBrowse,
    playerStatsBrowse,
    playlistsOfflineBrowse,
  );
}

type OfflineDisconnectNavAction =
  | { kind: 'stay' }
  | { kind: 'stay-reload' }
  | { kind: 'redirect'; to: '/albums' };

/** Decide what to do when the active server just became unreachable. */
export function resolveOfflineDisconnectNavAction(
  pathname: string,
  favoritesOfflineBrowse: boolean,
  localLibraryBrowse: boolean,
  playerStatsBrowse: boolean,
  playlistsOfflineBrowse: boolean,
  hasManualOfflineContent: boolean,
): OfflineDisconnectNavAction {
  if (!hasOfflineBrowseCapability(localLibraryBrowse, favoritesOfflineBrowse, hasManualOfflineContent)) {
    return { kind: 'stay' };
  }
  if (isPathOfflineBrowsable(
    pathname,
    favoritesOfflineBrowse,
    localLibraryBrowse,
    playerStatsBrowse,
    playlistsOfflineBrowse,
  )) {
    return { kind: 'stay-reload' };
  }
  return { kind: 'redirect', to: '/albums' };
}
