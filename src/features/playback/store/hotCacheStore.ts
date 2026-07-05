import type { QueueItemRef } from '@/lib/media/trackTypes';
import { create } from 'zustand';
import type { HotCacheEntry } from '@/features/playback/store/hotCacheStoreTypes';
import { useLocalPlaybackStore, type LocalPlaybackEntry } from '@/store/localPlaybackStore';
import { entryBelongsToServer } from '@/store/localPlaybackResolve';
import { getMediaDir } from '@/lib/media/mediaDir';
import { deleteMediaFile } from '@/lib/api/syncfs';

export type { HotCacheEntry } from '@/features/playback/store/hotCacheStoreTypes';
/** @deprecated Use {@link LOCAL_PLAYBACK_PROTECT_AFTER_CURRENT}. */
export const HOT_CACHE_PROTECT_AFTER_CURRENT = 1;

interface HotCacheState {
  getLocalUrl: (trackId: string, serverId: string) => string | null;
  setEntry: (
    trackId: string,
    serverId: string,
    localPath: string,
    sizeBytes: number,
    debugSource?: string,
    layoutFingerprint?: string,
    suffix?: string,
  ) => void;
  touchPlayed: (trackId: string, serverId: string) => void;
  removeEntry: (trackId: string, serverId: string) => Promise<void>;
  totalBytes: () => number;
  evictToFit: (
    queue: QueueItemRef[],
    queueIndex: number,
    maxBytes: number,
    activeServerId: string,
    mediaDir: string | null,
  ) => Promise<void>;
  clearAllDisk: (mediaDir: string | null) => Promise<void>;
}

/** Ephemeral-tier view for UI selectors (Settings track count, prefetch helpers). */
export function selectHotCacheEntries(
  entries: Record<string, import('@/store/localPlaybackStore').LocalPlaybackEntry>,
): Record<string, HotCacheEntry> {
  const out: Record<string, HotCacheEntry> = {};
  for (const [key, e] of Object.entries(entries)) {
    if (e.tier !== 'ephemeral') continue;
    out[key] = {
      localPath: e.localPath,
      sizeBytes: e.sizeBytes,
      cachedAt: e.cachedAt,
      lastPlayedAt: e.lastPlayedAt,
    };
  }
  return out;
}

/** Ephemeral-tier row count for Settings (optional active-server scope). */
export function countHotCacheTracks(
  entries: Record<string, LocalPlaybackEntry>,
  scopeServerId?: string,
): number {
  let n = 0;
  for (const e of Object.values(entries)) {
    if (e.tier !== 'ephemeral') continue;
    if (scopeServerId && !entryBelongsToServer(e, scopeServerId)) continue;
    n++;
  }
  return n;
}

export const useHotCacheStore = create<HotCacheState>()(() => ({
  getLocalUrl: (trackId, serverId) =>
    useLocalPlaybackStore.getState().getLocalUrl(trackId, serverId, 'ephemeral'),

  setEntry: (trackId, serverId, localPath, sizeBytes, _debugSource, layoutFingerprint = '', suffix = 'mp3') => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: serverId,
      trackId,
      localPath,
      sizeBytes,
      layoutFingerprint,
      tier: 'ephemeral',
      suffix,
    });
  },

  touchPlayed: (trackId, serverId) => {
    useLocalPlaybackStore.getState().touchPlayed(trackId, serverId);
  },

  removeEntry: async (trackId, serverId) => {
    const lp = useLocalPlaybackStore.getState();
    const e = lp.getEntry(trackId, serverId);
    if (e?.tier === 'ephemeral' && e.localPath) {
      await deleteMediaFile({ localPath: e.localPath, mediaDir: getMediaDir() }).catch(() => {});
      lp.removeEntry(trackId, serverId, 'hot-cache-shim');
    }
  },

  totalBytes: () => useLocalPlaybackStore.getState().ephemeralTotalBytes(),

  evictToFit: async (queue, queueIndex, maxBytes, activeServerId, mediaDir) => {
    await useLocalPlaybackStore.getState().evictEphemeralToFit(
      queue,
      queueIndex,
      maxBytes,
      activeServerId,
      mediaDir,
    );
  },

  clearAllDisk: async (mediaDir) => {
    await useLocalPlaybackStore.getState().purgeEphemeralDisk(mediaDir);
  },
}));
