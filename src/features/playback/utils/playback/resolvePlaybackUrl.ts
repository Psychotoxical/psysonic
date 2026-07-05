import { buildStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import { findLocalPlaybackUrl } from '@/store/localPlaybackResolve';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { getPlaybackCacheServerKey, getPlaybackServerId } from '@/features/playback/utils/playback/playbackServer';

/** Same resolution order as {@link resolvePlaybackUrl} — for UI hints only. */
export type PlaybackSourceKind = 'offline' | 'hot' | 'stream';

/**
 * Subsonic `buildStreamUrl()` rotates `t`/`s` on every call; Rust matches by `id` (see `playback_identity`).
 */
export function streamUrlTrackId(url: string): string | null {
  if (!url.includes('stream.view')) return null;
  try {
    const fromUrl = new URL(url).searchParams.get('id');
    if (fromUrl) return fromUrl;
  } catch {
    // Fallback for non-standard/relative URLs: parse query manually.
  }
  const q = url.split('?')[1];
  if (!q) return null;
  for (const part of q.split('&')) {
    const [k, v = ''] = part.split('=');
    if (k === 'id') {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

function resolvePlaybackProfileId(serverIdOrKey: string): string {
  return resolveServerIdForIndexKey(serverIdOrKey) || serverIdOrKey || getPlaybackServerId();
}

/**
 * @param enginePreloadedTrackId — song id for which `audio_preload` finished into the engine RAM slot
 *   (parsed from `audio:preload-ready` payload URL).
 */
export function getPlaybackSourceKind(
  trackId: string,
  serverId: string,
  enginePreloadedTrackId: string | null = null,
): PlaybackSourceKind {
  const profileId = resolvePlaybackProfileId(serverId);
  if (findLocalPlaybackUrl(trackId, profileId, 'library')) return 'offline';
  if (findLocalPlaybackUrl(trackId, profileId, 'favorite-auto')) return 'offline';
  if (findLocalPlaybackUrl(trackId, profileId, 'ephemeral')) return 'hot';
  const resolved = resolvePlaybackUrl(trackId, serverId);
  if (
    !resolved.startsWith('psysonic-local://')
    && enginePreloadedTrackId
    && trackId === enginePreloadedTrackId
  ) {
    return 'hot';
  }
  return 'stream';
}

/** Pinned library → favorites auto → ephemeral cache → HTTP stream. */
export function resolvePlaybackUrl(trackId: string, serverId?: string): string {
  const cacheKey = serverId && serverId.length > 0 ? serverId : getPlaybackCacheServerKey();
  const profileId = resolvePlaybackProfileId(cacheKey);
  const pinned = findLocalPlaybackUrl(trackId, profileId, 'library');
  if (pinned) return pinned;
  const favorites = findLocalPlaybackUrl(trackId, profileId, 'favorite-auto');
  if (favorites) return favorites;
  const hot = findLocalPlaybackUrl(trackId, profileId, 'ephemeral');
  if (hot) return hot;
  return buildStreamUrlForServer(profileId, trackId);
}
