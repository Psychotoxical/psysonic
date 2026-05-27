import { useEffect, useMemo } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import type { CoverArtId } from '../cover/types';
import { coverPrefetchRegister } from '../cover/prefetchRegistry';
import { albumCoverRef } from '../cover/ref';
import { useCoverArt } from '../cover/useCoverArt';

const PLAYLIST_HERO_BG_CSS_PX = 200;
const PLAYLIST_MAIN_COVER_CSS_PX = 200;

export interface PlaylistCovers {
  coverQuadIds: (CoverArtId | null)[];
  bgCoverId: CoverArtId | null;
  resolvedBgUrl: string;
}

function playlistCoverRef(coverId: string, songs: SubsonicSong[]) {
  const song = songs.find(s => s.coverArt === coverId || s.albumId === coverId);
  if (song?.albumId) return albumCoverRef(song.albumId, coverId);
  return albumCoverRef(coverId, coverId);
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
  const bgCoverRef = useMemo(
    () => (bgCoverId ? playlistCoverRef(bgCoverId, songs) : null),
    [bgCoverId, songs],
  );
  const { src: resolvedBgUrl } = useCoverArt(bgCoverRef, PLAYLIST_HERO_BG_CSS_PX, {
    surface: 'dense',
    ensurePriority: 'high',
  });

  useEffect(() => {
    const refs = coverQuadIds
      .filter((id): id is CoverArtId => !!id)
      .map(id => playlistCoverRef(id, songs));
    if (bgCoverId) refs.push(playlistCoverRef(bgCoverId, songs));
    return coverPrefetchRegister(refs, { surface: 'dense', priority: 'middle' });
  }, [coverQuadIds, bgCoverId, songs]);

  return { coverQuadIds, bgCoverId, resolvedBgUrl };
}

export { PLAYLIST_MAIN_COVER_CSS_PX };
