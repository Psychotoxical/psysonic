import { useEffect } from 'react';
import { coverCacheEnsure, coverCachePeekBatch } from '../api/coverCache';
import { coverArtRef, resolvePlaybackCoverScope } from '../cover/ref';
import { getDiskSrc, rememberDiskSrc } from '../cover/diskSrcCache';
import { coverIndexKeyFromRef, coverStorageKey } from '../cover/storageKeys';
import { resolveCoverDisplayTier } from '../cover/tiers';
import { coverArtIdFromRadio } from '../cover/ids';
import type { CoverServerScope } from '../cover/types';
import { prewarmNowPlayingFetchers } from './useNowPlayingFetchers';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { usePlaybackServerId } from './usePlaybackServerId';

const NOW_PLAYING_COVER_CSS_PX = 800;

async function prewarmCoverForScope(
  coverArtId: string,
  scope: CoverServerScope,
): Promise<void> {
  if (!coverArtId) return;
  const tier = resolveCoverDisplayTier(NOW_PLAYING_COVER_CSS_PX, { surface: 'sparse' });
  const ref = coverArtRef(coverArtId, scope);
  const storageKey = coverStorageKey(ref.serverScope, ref.coverArtId, tier);
  if (getDiskSrc(storageKey)) return;

  const hits = await coverCachePeekBatch([
    {
      serverIndexKey: coverIndexKeyFromRef(ref),
      coverArtId: ref.coverArtId,
      tier,
    },
  ]);
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
  const lastfmUsername = useAuthStore(s => s.lastfmUsername);

  useEffect(() => {
    if (!currentTrack || !playbackServerId) return;

    void prewarmNowPlayingFetchers({
      songId: currentTrack.id,
      artistId: currentTrack.artistId,
      albumId: currentTrack.albumId,
      artistName: currentTrack.artist,
      enableBandsintown,
      audiomuseNavidromeEnabled,
      lastfmUsername,
      currentTrack,
      subsonicServerId: playbackServerId,
      fetchEnabled: true,
    });

    if (currentTrack.coverArt) {
      void prewarmCoverForScope(currentTrack.coverArt, resolvePlaybackCoverScope());
    }
  }, [
    currentTrack?.id,
    currentTrack?.artistId,
    currentTrack?.albumId,
    currentTrack?.coverArt,
    currentTrack?.artist,
    playbackServerId,
    enableBandsintown,
    audiomuseNavidromeEnabled,
    lastfmUsername,
  ]);

  useEffect(() => {
    if (!currentRadio?.coverArt || !activeServerId) return;
    const radioCoverArtId = coverArtIdFromRadio(currentRadio.id);
    void prewarmCoverForScope(radioCoverArtId, { kind: 'active' });
  }, [currentRadio?.id, currentRadio?.coverArt, activeServerId]);
}
