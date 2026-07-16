import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';

/** True when pathname is the Playlists browse route (`/playlists`). */
export function isPlaylistsBrowsePath(pathname: string): boolean {
  return pathname === '/playlists';
}

/** Scoped Playlists text search — playlist name only. */
export function filterPlaylistsByNameQuery(
  playlists: SubsonicPlaylist[],
  query: string,
): SubsonicPlaylist[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return playlists;
  return playlists.filter(p => (p.name ?? '').toLowerCase().includes(needle));
}
