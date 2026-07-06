import { useThemeStore } from '@/store/themeStore';
import { useArtistFanart } from '@/cover/useArtistFanart';
import { backdropFromConfig } from '@/cover/artistBackdrop';
import { useArtistCoverRef } from '@/cover/useLibraryCoverRef';
import { usePlaybackCoverArt } from '@/cover/usePlaybackCoverArt';
import { useCachedUrl } from '@/ui/CachedImage';
import type { Track } from '@/lib/media/trackTypes';

/**
 * Resolves the fullscreen-player artist backdrop URL through the shared cover
 * pipeline, in the user's configured source order (fanart.tv → Navidrome artist
 * image), honouring the per-surface enable toggle. Returns '' when the backdrop
 * is disabled or nothing resolves.
 *
 * Single source of truth for all three fullscreen player styles — no player
 * re-derives the backdrop; they all call this.
 */
export function useFsArtistBackdrop(currentTrack: Track | null): string {
  const cfg = useThemeStore(s => s.backdrops.fullscreenPlayer);
  const fanart = useArtistFanart(currentTrack?.artistId, {
    artistName: currentTrack?.artist,
    albumTitle: currentTrack?.album,
  });
  const artistCoverRef =
    useArtistCoverRef(currentTrack?.artistId, undefined, undefined, { libraryResolve: false }) ?? undefined;
  const artistImage = usePlaybackCoverArt(artistCoverRef, 2000, { fullRes: true });
  const artistImgUrl = useCachedUrl(artistImage.src, artistImage.cacheKey, true);

  return cfg.enabled
    ? backdropFromConfig(cfg.sources, { fanart, navidrome: artistImgUrl }).url
    : '';
}
