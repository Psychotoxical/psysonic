/** Sidebar / mobile-more navigation gates while offline browse is active. */

export function isOfflineSidebarLibraryNavAllowed(
  navId: string,
  favoritesOfflineBrowse: boolean,
  localLibraryBrowse = false,
  playlistsOfflineBrowse = false,
): boolean {
  if (navId === 'favorites') return favoritesOfflineBrowse;
  if (navId === 'artists' || navId === 'allAlbums' || navId === 'tracks') return localLibraryBrowse;
  if (navId === 'playlists') return playlistsOfflineBrowse;
  if (navId === 'offline') return true;
  return false;
}

/** System nav entries that stay available without a Subsonic connection. */
export function isOfflineSidebarSystemNavAllowed(
  navId: string,
  playerStatsBrowse: boolean,
): boolean {
  if (navId === 'help') return true;
  if (navId === 'statistics') return playerStatsBrowse;
  return false;
}

/** Sidebar / mobile-more gate while offline browse is active. */
export function isOfflineSidebarNavAllowed(
  navId: string,
  favoritesOfflineBrowse: boolean,
  localLibraryBrowse: boolean,
  playerStatsBrowse: boolean,
  playlistsOfflineBrowse = false,
): boolean {
  if (isOfflineSidebarSystemNavAllowed(navId, playerStatsBrowse)) return true;
  return isOfflineSidebarLibraryNavAllowed(
    navId,
    favoritesOfflineBrowse,
    localLibraryBrowse,
    playlistsOfflineBrowse,
  );
}
