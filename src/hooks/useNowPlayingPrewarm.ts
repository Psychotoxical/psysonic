import { useEffect } from 'react';
import { coverCacheEnsure, coverCachePeekBatch } from '../api/coverCache';
import { albumCoverRef } from '../cover/ref';
import { resolvePlaybackCoverScope } from '../cover/ref';
import { resolveTrackCoverRefFromLibrary } from '../cover/resolveEntryLibrary';
import { getDiskSrc, rememberDiskSrc } from '../cover/diskSrcCache';
import { coverStorageKeyFromRef } from '../cover/storageKeys';
import { resolveCoverDisplayTier } from '../cover/tiers';
import { coverArtIdFromRadio } from '../cover/ids';
import type { CoverArtRef } from '../cover/types';
import { prewarmNowPlayingFetchers } from './useNowPlayingFetchers';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { usePlaybackServerId } from './usePlaybackServerId';
import { primaryTrackArtistRef } from '../utils/playback/trackArtistRefs';

const NOW_PLAYING_COVER_CSS_PX = 800;

async function prewarmCoverRef(ref: CoverArtRef): Promise<void> {
  if (!ref.fetchCoverArtId) return;
  const tier = resolveCoverDisplayTier(NOW_PLAYING_COVER_CSS_PX, { surface: 'sparse' });
  const storageKey = coverStorageKeyFromRef(ref, tier);
  if (getDiskSrc(storageKey)) return;

  const hits = await coverCachePeekBatch([ref], tier);
  const hitPath = hits[storageKey];
  if (hitPath) {
    rememberDiskSrc(storageKey, hitPath);
    return;
  }

  const ensured = await coverCacheEnsure(ref, tier, 'high');
  if (ensured.hit && ensured.path) {
    rememberDiskSrc(storageKey, ensured.path);
  }
}

/**
 * Warm the Now Playing data + key artwork as soon as the playing track changes,
 * so opening `/now-playing` shows track-correct content instantly.
 */
export function useNowPlayingPrewarm(): void {
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const currentRadio = usePlayerStore(s => s.currentRadio);
  const playbackServerId = usePlaybackServerId();
  const enableBandsintown = useAuthStore(s => s.enableBandsintown);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const audiomuseNavidromeEnabled = useAuthStore(
    s => (playbackServerId ? Boolean(s.audiomuseNavidromeByServer[playbackServerId]) : false),
  );
  const enrichmentKey = useAuthStore(s => s.enrichmentPrimaryId ?? '');

  useEffect(() => {
    if (!currentTrack || !playbackServerId) return;

    const primary = primaryTrackArtistRef(currentTrack);
    void prewarmNowPlayingFetchers({
      songId: currentTrack.id,
      artistId: primary.id,
      albumId: currentTrack.albumId,
      artistName: primary.name ?? currentTrack.artist,
      enableBandsintown,
      audiomuseNavidromeEnabled,
      enrichmentKey,
      currentTrack,
      subsonicServerId: playbackServerId,
      // No `fetchEnabled` / no trackId: prewarmNowPlayingFetchers owns the single
      // reachability gate, and metadata must warm even when the track's audio
      // plays from local cache.
    });

    if (currentTrack.albumId && currentTrack.id) {
      void resolveTrackCoverRefFromLibrary(
        {
          id: currentTrack.id,
          albumId: currentTrack.albumId,
          coverArt: currentTrack.coverArt,
          discNumber: (currentTrack as { discNumber?: number }).discNumber,
        },
        resolvePlaybackCoverScope(),
      ).then(ref => {
        if (ref) void prewarmCoverRef(ref);
      });
    }
    // Keyed on currentTrack?.id; depending on the `currentTrack` object would
    // re-prewarm on every render when its identity changes but its id does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentTrack?.id,
    currentTrack?.artistId,
    currentTrack?.artists,
    currentTrack?.albumId,
    currentTrack?.coverArt,
    currentTrack?.artist,
    playbackServerId,
    enableBandsintown,
    audiomuseNavidromeEnabled,
    enrichmentKey,
  ]);

  useEffect(() => {
    if (!currentRadio?.coverArt || !activeServerId) return;
    const radioCoverArtId = coverArtIdFromRadio(currentRadio.id);
    void prewarmCoverRef(albumCoverRef(radioCoverArtId, radioCoverArtId, { kind: 'active' }));
  }, [currentRadio?.id, currentRadio?.coverArt, activeServerId]);
}
