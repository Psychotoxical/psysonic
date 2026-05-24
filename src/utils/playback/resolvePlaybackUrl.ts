import { buildStreamUrlForServer } from '../../api/subsonicStreamUrl';
import { useOfflineStore } from '../../store/offlineStore';
import { useHotCacheStore } from '../../store/hotCacheStore';
import { getPlaybackCacheServerKey, getPlaybackServerId } from './playbackServer';

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

/**
 * @param enginePreloadedTrackId — song id for which `audio_preload` finished into the engine RAM slot
 *   (parsed from `audio:preload-ready` payload URL).
 */
export function getPlaybackSourceKind(
  trackId: string,
  serverId: string,
  enginePreloadedTrackId: string | null = null,
): PlaybackSourceKind {
  const legacySid = getPlaybackServerId();
  const offline =
    useOfflineStore.getState().getLocalUrl(trackId, serverId)
    || (legacySid && legacySid !== serverId ? useOfflineStore.getState().getLocalUrl(trackId, legacySid) : null);
  if (offline) return 'offline';
  const hot =
    useHotCacheStore.getState().getLocalUrl(trackId, serverId)
    || (legacySid && legacySid !== serverId ? useHotCacheStore.getState().getLocalUrl(trackId, legacySid) : null);
  if (hot) return 'hot';
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

/** Offline library → hot playback cache → HTTP stream. */
export function resolvePlaybackUrl(trackId: string, serverId?: string): string {
  const sid = serverId && serverId.length > 0 ? serverId : getPlaybackCacheServerKey();
  const legacySid = getPlaybackServerId();
  const offline =
    useOfflineStore.getState().getLocalUrl(trackId, sid)
    || (legacySid && legacySid !== sid ? useOfflineStore.getState().getLocalUrl(trackId, legacySid) : null);
  if (offline) return offline;
  const hot =
    useHotCacheStore.getState().getLocalUrl(trackId, sid)
    || (legacySid && legacySid !== sid ? useHotCacheStore.getState().getLocalUrl(trackId, legacySid) : null);
  if (hot) return hot;
  return buildStreamUrlForServer(sid, trackId);
}
