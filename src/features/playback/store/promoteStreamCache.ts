import { buildStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import type { Track } from '@/lib/media/trackTypes';
import { invoke } from '@tauri-apps/api/core';
import { useHotCacheStore } from '@/features/playback/store/hotCacheStore';
import { getMediaDir } from '@/lib/media/mediaDir';
import { librarySqlServerId } from '@/lib/api/coverCache';
import { hasLocalPersistentPlaybackBytes } from '@/store/localPlaybackResolve';

/**
 * Promote a track whose stream cache is full to the on-disk ephemeral tier.
 * Best-effort: prefetch remains fallback.
 */
export async function promoteCompletedStreamToHotCache(
  track: Track,
  serverIndexKey: string,
  _customDir: string | null,
): Promise<void> {
  if (hasLocalPersistentPlaybackBytes(track.id, serverIndexKey)) return;
  try {
    const libraryServerId = librarySqlServerId(serverIndexKey);
    const res = await invoke<{ path: string; size: number; layoutFingerprint: string } | null>(
      'promote_stream_cache_to_local',
      {
        trackId: track.id,
        serverIndexKey,
        libraryServerId,
        url: buildStreamUrlForServer(serverIndexKey, track.id),
        suffix: track.suffix || 'mp3',
        mediaDir: getMediaDir(),
      },
    );
    if (!res?.path) return;
    useHotCacheStore.getState().setEntry(
      track.id,
      serverIndexKey,
      res.path,
      res.size || 0,
      'stream-promote',
      res.layoutFingerprint,
      track.suffix || 'mp3',
    );
  } catch {
    // best-effort promotion; normal hot-cache prefetch remains fallback
  }
}
