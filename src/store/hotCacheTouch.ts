import { useHotCacheStore } from './hotCacheStore';

/**
 * Mark a track as recently played for the hot-cache LRU. Called from every
 * `audio_play` entry point — cold start, gapless switch, queue rewrite,
 * radio next — so the hot cache promotes frequently-played tracks even when
 * playback bounced through different code paths. The empty-id guards keep
 * dev-time crashes (e.g. unauthenticated state, server still resolving)
 * from surfacing as cache writes against a meaningless key.
 */
export function touchHotCacheOnPlayback(trackId: string, serverId: string): void {
  if (!trackId || !serverId) return;
  useHotCacheStore.getState().touchPlayed(trackId, serverId);
}
