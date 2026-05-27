import type { SubsonicAlbum } from '../../api/subsonicTypes';

export type AlbumCompFilter = 'all' | 'only' | 'hide';

/** Max albums to scan client-side for compilation filter before showing empty. */
export const ALBUM_COMP_FILTER_MAX_SCAN_ALBUMS = 500;

/** OpenSubsonic / Navidrome: `compilation`, `isCompilation`, or `releaseTypes`. */
export function albumIsCompilation(a: SubsonicAlbum): boolean {
  if (a.isCompilation === true) return true;
  const loose = a as SubsonicAlbum & { compilation?: boolean };
  if (loose.compilation === true) return true;
  return a.releaseTypes?.some(t => /^compilation$/i.test(t.trim())) ?? false;
}

/** Stop paginating when the catalog tail is reached or the scan budget is spent. */
export function albumBrowseCompScanComplete(
  loadedAlbums: SubsonicAlbum[],
  compFilter: AlbumCompFilter,
  hasMore: boolean,
): boolean {
  if (compFilter === 'all') return true;
  if (!hasMore) return true;
  if (loadedAlbums.length >= ALBUM_COMP_FILTER_MAX_SCAN_ALBUMS) return true;
  return false;
}
