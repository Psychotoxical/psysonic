import { buildStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import type { Track } from '@/lib/media/trackTypes';
import { invoke } from '@tauri-apps/api/core';
import { useHotCacheStore } from '@/features/playback/store/hotCacheStore';
import { getMediaDir } from '@/lib/media/mediaDir';
import { librarySqlServerId } from '@/lib/api/coverCache';
import { hasLocalPersistentPlaybackBytes } from '@/store/localPlaybackResolve';
import { useAuthStore } from '@/store/authStore';

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
  // Capped playback streams are transcoded bytes. The promote path stores them
  // on disk under the ORIGINAL file's suffix/tier (the Rust side matches the
  // live bytes by track id only), so promoting them would masquerade a low-
  // bitrate transcode as the original. Keep capped streams out of the hot
  // cache entirely; a quality-aware tier can lift this later.
  if (useAuthStore.getState().streamMaxBitRateKbps > 0) return;
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
    // The promoted bytes are whatever the live player streamed — the Rust match
    // is by track id and ignores maxBitRate — so tag the entry with the cap in
    // effect, so a capped blob is never later reused for a different quality.
    const cap = useAuthStore.getState().streamMaxBitRateKbps;
    useHotCacheStore.getState().setEntry(
      track.id,
      serverIndexKey,
      res.path,
      res.size || 0,
      'stream-promote',
      res.layoutFingerprint,
      track.suffix || 'mp3',
      cap,
    );
  } catch {
    // best-effort promotion; normal hot-cache prefetch remains fallback
  }
}
