import { usePlaybackCoverArt } from '@/cover/usePlaybackCoverArt';
import { useAlbumCoverRef } from '@/cover/useLibraryCoverRef';
import { usePlayerStore } from '@/features/playback';

/**
 * Cover art for the playing track, used only to derive the visualizer palette.
 *
 * Album-keyed like the fullscreen player's ref so the palette stays stable
 * across tracks within one album instead of re-extracting (and briefly
 * shifting hue) on every advance. A small display size is requested because
 * nothing renders this image — it is decoded once for its dominant colour.
 */
export function useVisualizerCoverArt(): { artUrl: string; artKey: string } {
  const albumId = usePlayerStore(s => s.currentTrack?.albumId);
  const directCover = usePlayerStore(s => s.currentTrack?.directCoverArtUrl);
  const coverRef = useAlbumCoverRef(albumId, undefined, undefined, { libraryResolve: false }) ?? undefined;
  const cover = usePlaybackCoverArt(coverRef, 160);
  return { artUrl: directCover ?? cover.src, artKey: cover.cacheKey };
}
