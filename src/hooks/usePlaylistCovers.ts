import { useEffect, useMemo } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import type { CoverArtId } from '../cover/types';
import { coverPrefetchRegister } from '../cover/prefetchRegistry';
import { coverArtRef } from '../cover/ref';
import { useCoverArt } from '../cover/useCoverArt';

const PLAYLIST_HERO_BG_CSS_PX = 200;
const PLAYLIST_MAIN_COVER_CSS_PX = 200;

export interface PlaylistCovers {
  coverQuadIds: (CoverArtId | null)[];
  bgCoverId: CoverArtId | null;
  resolvedBgUrl: string;
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

  const coverQuadIds = useMemo(
    () =>
      Array.from({ length: 4 }, (_, i) => {
        const coverId = coverQuad[i % Math.max(1, coverQuad.length)];
        return coverId ?? null;
      }),
    [coverQuad],
  );

  const bgCoverId = customCoverId ?? coverQuad[0] ?? null;
  const { src: resolvedBgUrl } = useCoverArt(bgCoverId, PLAYLIST_HERO_BG_CSS_PX, {
    surface: 'dense',
    ensurePriority: 'high',
  });

  useEffect(() => {
    const refs = coverQuadIds
      .filter((id): id is CoverArtId => !!id)
      .map(id => coverArtRef(id));
    if (bgCoverId) refs.push(coverArtRef(bgCoverId));
    return coverPrefetchRegister(refs, { surface: 'dense', priority: 'middle' });
  }, [coverQuadIds, bgCoverId]);

  return { coverQuadIds, bgCoverId, resolvedBgUrl };
}

export { PLAYLIST_MAIN_COVER_CSS_PX };
