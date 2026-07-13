import { useEffect, useMemo } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { COVER_ARTIST_TOP_TRACK_CSS_PX } from '@/cover/layoutSizes';
import { useLibraryCoverPrefetch } from '@/cover/useLibraryCoverPrefetch';
import {
  uniqueAlbumIdsFromSongs,
  warmUniqueAlbumCoversFromLibrary,
} from '@/cover/warmDiskPeek';

const DEFAULT_LIMIT = 48;

type SongAlbumSource = Pick<SubsonicSong, 'albumId'>;

/**
 * Standard cover pipeline warm for track-list surfaces: dedupe visible songs to
 * album ids, register library prefetch, peek disk tiers, and high-priority ensure
 * misses — same building blocks as album grids, without per-track mf-* fetch ids.
 */
export function useWarmTrackListAlbumCovers(
  songs: ReadonlyArray<SongAlbumSource>,
  displayCssPx: number = COVER_ARTIST_TOP_TRACK_CSS_PX,
  opts?: { enabled?: boolean; limit?: number },
): void {
  const enabled = opts?.enabled ?? true;
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const albumIds = useMemo(
    () => uniqueAlbumIdsFromSongs(songs, limit),
    [songs, limit],
  );
  const warmKey = useMemo(() => albumIds.join('\u0001'), [albumIds]);
  const prefetchAlbums = useMemo(
    () => albumIds.map(id => ({ id })),
    [albumIds],
  );

  useLibraryCoverPrefetch(
    prefetchAlbums.length > 0
      ? [{ albums: prefetchAlbums, limit, priority: 'high' }]
      : [],
    [warmKey, enabled],
  );

  useEffect(() => {
    if (!enabled || displayCssPx <= 0 || albumIds.length === 0) return;
    let cancelled = false;
    void warmUniqueAlbumCoversFromLibrary(albumIds, displayCssPx, 'dense').then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
    // albumIds content is keyed by `warmKey`; listing the array retriggers warm on
    // benign parent re-renders that rebuild the songs slice reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, warmKey, displayCssPx]);
}
