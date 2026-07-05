import { libraryGetCatalogYearBounds } from '@/lib/api/library';
import { ALBUM_YEAR_MAX, ALBUM_YEAR_MIN, type AlbumCatalogYearRange } from './albumYearFilter';
import { libraryIsReady } from './libraryReady';

const FALLBACK: AlbumCatalogYearRange = { min: ALBUM_YEAR_MIN, max: ALBUM_YEAR_MAX };

/** Indexed track years for Albums filter spinners (falls back when index is off). */
export async function fetchAlbumCatalogYearBounds(
  serverId: string,
  indexEnabled: boolean,
): Promise<AlbumCatalogYearRange> {
  if (!serverId || !indexEnabled || !(await libraryIsReady(serverId))) {
    return FALLBACK;
  }
  try {
    const b = await libraryGetCatalogYearBounds({ serverId });
    if (b.minYear != null && b.maxYear != null && b.minYear <= b.maxYear) {
      return { min: b.minYear, max: b.maxYear };
    }
  } catch {
    /* ignore */
  }
  return FALLBACK;
}
