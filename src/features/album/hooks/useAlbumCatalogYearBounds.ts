import { useEffect, useState } from 'react';
import {
  ALBUM_YEAR_MAX,
  ALBUM_YEAR_MIN,
  type AlbumCatalogYearRange,
} from '@/lib/library/albumYearFilter';
import { fetchAlbumCatalogYearBounds } from '@/lib/library/albumCatalogYearBounds';

const DEFAULT: AlbumCatalogYearRange = { min: ALBUM_YEAR_MIN, max: ALBUM_YEAR_MAX };

export function useAlbumCatalogYearBounds(
  serverId: string,
  indexEnabled: boolean,
  libraryFilterVersion: number,
): AlbumCatalogYearRange {
  const [bounds, setBounds] = useState(DEFAULT);

  useEffect(() => {
    let cancelled = false;
    void fetchAlbumCatalogYearBounds(serverId, indexEnabled).then(next => {
      if (!cancelled) setBounds(next);
    });
    return () => {
      cancelled = true;
    };
  }, [serverId, indexEnabled, libraryFilterVersion]);

  return bounds;
}
