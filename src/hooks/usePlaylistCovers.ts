import { useMemo } from 'react';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import type { SubsonicSong } from '../api/subsonicTypes';
import { useCachedUrl } from '../components/CachedImage';

export interface PlaylistCovers {
  coverQuadUrls: ({ src: string; cacheKey: string } | null)[];
  customCoverFetchUrl: string | null;
  customCoverCacheKey: string | null;
  resolvedBgUrl: string | null;
}

export function usePlaylistCovers(songs: SubsonicSong[], customCoverId: string | null): PlaylistCovers {
  const coverQuad = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const s of songs) {
      if (s.coverArt && !seen.has(s.coverArt)) {
        seen.add(s.coverArt);
        result.push(s.coverArt);
        if (result.length === 4) break;
      }
    }
    return result;
  }, [songs]);

  // Stable fetch URLs + cache keys for the 2×2 grid and blurred background.
  // buildCoverArtUrl generates a new crypto salt on every call, so these MUST
  // be memoized — otherwise every render produces new URLs, useCachedUrl
  // re-triggers, state updates, another render → infinite flicker loop.
  const coverQuadUrls = useMemo(() =>
    Array.from({ length: 4 }, (_, i) => {
      const coverId = coverQuad[i % Math.max(1, coverQuad.length)];
      if (!coverId) return null;
      return { src: buildCoverArtUrl(coverId, 200), cacheKey: coverArtCacheKey(coverId, 200) };
    }),
  [coverQuad]);

  const effectiveBgId = customCoverId ?? coverQuad[0] ?? '';
  const bgFetchUrl = useMemo(() => buildCoverArtUrl(effectiveBgId, 300), [effectiveBgId]);
  const bgCacheKey = useMemo(() => coverArtCacheKey(effectiveBgId, 300), [effectiveBgId]);
  const resolvedBgUrl = useCachedUrl(bgFetchUrl, bgCacheKey);

  const customCoverFetchUrl = useMemo(
    () => customCoverId ? buildCoverArtUrl(customCoverId, 300) : null,
    [customCoverId],
  );
  const customCoverCacheKey = useMemo(
    () => customCoverId ? coverArtCacheKey(customCoverId, 300) : null,
    [customCoverId],
  );

  return { coverQuadUrls, customCoverFetchUrl, customCoverCacheKey, resolvedBgUrl };
}
