import { buildStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import { findLocalPlaybackUrl, ephemeralServeableAtQuality } from '@/store/localPlaybackResolve';
import { effectiveStreamCapKbps, effectiveStreamFormat } from '@/features/playback/utils/playback/streamQualityResolve';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { getPlaybackCacheServerKey, getPlaybackServerId } from '@/features/playback/utils/playback/playbackServer';
import type { Track } from '@/lib/media/trackTypes';
import { queueTrackIdentityMatches } from '@/features/playback/utils/playback/queueIdentity';

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
 * @param enginePreloadedTrackId — server-qualified queue identity for which `audio_preload`
 *   finished into the engine RAM slot; legacy callers may pass a raw song id.
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
    && queueTrackIdentityMatches(enginePreloadedTrackId, trackId, serverId)
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
  // Per-address, Navidrome-gated cap for the endpoint the connect layer chose.
  // Applies ONLY to the live HTTP stream — locally cached / offline / pinned
  // tracks and the prefetch/analysis fetch paths always use the original.
  const cap = effectiveStreamCapKbps(profileId);
  const fmt = effectiveStreamFormat(profileId);
  const hot = findLocalPlaybackUrl(trackId, profileId, 'ephemeral');
  // Only reuse a hot-cache blob when its captured quality matches the current
  // request — a blob promoted from a capped stream must not be served at a
  // different quality (e.g. a 128 kbps blob for an Original request).
  if (hot && ephemeralServeableAtQuality(trackId, profileId, cap)) return hot;
  return buildStreamUrlForServer(profileId, trackId, cap, fmt);
}

/** Like {@link resolvePlaybackUrl} but honours {@link Track.directStreamUrl}. */
export function resolvePlaybackUrlForTrack(
  track: Pick<Track, 'id' | 'directStreamUrl'>,
  serverId?: string,
): string {
  if (track.directStreamUrl) return track.directStreamUrl;
  return resolvePlaybackUrl(track.id, serverId);
}
