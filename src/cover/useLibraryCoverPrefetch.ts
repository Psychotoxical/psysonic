import { useEffect } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { coverPrefetchRegister } from './prefetchRegistry';
import {
  resolveAlbumCoverRefsFromLibrary,
  resolveArtistCoverRefsFromLibrary,
  resolveTrackCoverRefsFromLibrary,
} from './resolveEntryLibrary';
import { COVER_SCOPE_ACTIVE, type CoverPrefetchPriority, type CoverServerScope, type CoverSurfaceKind } from './types';

export type LibraryCoverPrefetchBucket = {
  albums?: ReadonlyArray<{ id: string; coverArt?: string | null }>;
  artists?: ReadonlyArray<{ id: string; coverArt?: string | null }>;
  songs?: ReadonlyArray<Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'>>;
  limit?: number;
  priority: CoverPrefetchPriority;
  surface?: CoverSurfaceKind;
  serverScope?: CoverServerScope;
};

/** Register cover prefetch after resolving refs from the local library index. */
export function useLibraryCoverPrefetch(
  buckets: LibraryCoverPrefetchBucket[],
  deps: readonly unknown[],
): void {
  useEffect(() => {
    let cancelled = false;
    const unregisters: Array<() => void> = [];

    void (async () => {
      for (const bucket of buckets) {
        const scope = bucket.serverScope ?? COVER_SCOPE_ACTIVE;
        const refs = [
          ...(bucket.albums?.length
            ? await resolveAlbumCoverRefsFromLibrary(bucket.albums, scope)
            : []),
          ...(bucket.artists?.length
            ? await resolveArtistCoverRefsFromLibrary(bucket.artists, scope)
            : []),
          ...(bucket.songs?.length
            ? await resolveTrackCoverRefsFromLibrary(bucket.songs, scope)
            : []),
        ];
        const capped = bucket.limit != null ? refs.slice(0, bucket.limit) : refs;
        if (cancelled || capped.length === 0) continue;
        unregisters.push(
          coverPrefetchRegister(capped, {
            surface: bucket.surface ?? 'dense',
            priority: bucket.priority,
          }),
        );
      }
    })();

    return () => {
      cancelled = true;
      for (const unreg of unregisters) unreg();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller supplies `deps` for bucket inputs
  }, deps);
}
