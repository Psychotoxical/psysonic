import { resolvePlaybackUrl, type PlaybackSourceKind } from '../utils/playback/resolvePlaybackUrl';
import { sameQueueTrackId } from '../utils/playback/queueIdentity';
import { useOfflineStore } from './offlineStore';

/**
 * Helpers that classify the URL `audio_play` was last invoked with, so the
 * runtime can rebind playback onto a freshly-promoted hot-cache entry the
 * next time the same track plays.
 *
 * `lastOpenedWithHttpTrackId` remembers the most recent track id we asked
 * the engine to fetch over HTTP (anything that isn't the `psysonic-local://`
 * scheme). When the hot-cache later promotes that track to a local URL we
 * compare against this id to decide whether a transparent rebind is worth
 * triggering.
 */
let lastOpenedWithHttpTrackId: string | null = null;

export function recordEnginePlayUrl(trackId: string, url: string): void {
  lastOpenedWithHttpTrackId = url.startsWith('psysonic-local://') ? null : trackId;
}

/** Matches `playTrack` / PlayerBar: stream vs hot-cache vs offline file from resolved `audio_play` URL. */
export function playbackSourceHintForResolvedUrl(trackId: string, serverId: string, url: string): PlaybackSourceKind {
  if (!url.startsWith('psysonic-local://')) return 'stream';
  return useOfflineStore.getState().getLocalUrl(trackId, serverId) ? 'offline' : 'hot';
}

export function shouldRebindPlaybackToHotCache(trackId: string, serverId: string): boolean {
  if (!serverId) return false;
  if (!lastOpenedWithHttpTrackId || !sameQueueTrackId(lastOpenedWithHttpTrackId, trackId)) {
    return false;
  }
  return resolvePlaybackUrl(trackId, serverId).startsWith('psysonic-local://');
}

/** Test-only: clear the module-scoped track id so each test starts clean. */
export function _resetPlaybackUrlRoutingForTest(): void {
  lastOpenedWithHttpTrackId = null;
}
