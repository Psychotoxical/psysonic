import { useEffect, useMemo, useState } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { CoverArtId, CoverArtRef } from '@/cover/types';
import { coverPrefetchRegister } from '@/cover/prefetchRegistry';
import { resolveAlbumCoverRefFromLibrary } from '@/cover/resolveEntryLibrary';
import { useCoverArt } from '@/cover/useCoverArt';

const PLAYLIST_HERO_BG_CSS_PX = 200;
const PLAYLIST_MAIN_COVER_CSS_PX = 200;

export interface PlaylistCovers {
  coverQuadIds: (CoverArtId | null)[];
  bgCoverId: CoverArtId | null;
  resolvedBgUrl: string;
}

async function playlistCoverRefFromLibrary(
  coverId: string,
  songs: SubsonicSong[],
): Promise<CoverArtRef> {
  const song = songs.find(s => s.coverArt === coverId || s.albumId === coverId);
  if (song?.albumId) {
    return resolveAlbumCoverRefFromLibrary(song.albumId, coverId);
  }
  return resolveAlbumCoverRefFromLibrary(coverId, coverId);
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
  const [bgCoverRef, setBgCoverRef] = useState<CoverArtRef | null>(null);

  useEffect(() => {
    if (!bgCoverId) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBgCoverRef(null);
      return;
    }
    let cancelled = false;
    void playlistCoverRefFromLibrary(bgCoverId, songs).then(ref => {
      if (!cancelled) setBgCoverRef(ref);
    });
    return () => {
      cancelled = true;
    };
  }, [bgCoverId, songs]);

  const { src: resolvedBgUrl } = useCoverArt(bgCoverRef, PLAYLIST_HERO_BG_CSS_PX, {
    surface: 'dense',
    ensurePriority: 'high',
  });

  useEffect(() => {
    const ids = [
      ...coverQuadIds.filter((id): id is CoverArtId => !!id),
      ...(bgCoverId ? [bgCoverId] : []),
    ];
    if (ids.length === 0) return;
    let cancelled = false;
    let unreg: (() => void) | undefined;
    void (async () => {
      const refs = await Promise.all(ids.map(id => playlistCoverRefFromLibrary(id, songs)));
      if (!cancelled) {
        unreg = coverPrefetchRegister(refs, { surface: 'dense', priority: 'middle' });
      }
    })();
    return () => {
      cancelled = true;
      unreg?.();
    };
  }, [coverQuadIds, bgCoverId, songs]);

  return { coverQuadIds, bgCoverId, resolvedBgUrl };
}

export { PLAYLIST_MAIN_COVER_CSS_PX };
