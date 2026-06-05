import type { QueueItemRef } from './playerStoreTypes';
import { create } from 'zustand';
import type { HotCacheEntry } from './hotCacheStoreTypes';
import { useLocalPlaybackStore } from './localPlaybackStore';

export type { HotCacheEntry } from './hotCacheStoreTypes';
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
  removeEntry: (trackId: string, serverId: string) => void;
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
  entries: Record<string, import('./localPlaybackStore').LocalPlaybackEntry>,
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

  removeEntry: (trackId, serverId) => {
    const e = useLocalPlaybackStore.getState().getEntry(trackId, serverId);
    if (e?.tier === 'ephemeral') {
      useLocalPlaybackStore.getState().removeEntry(trackId, serverId, 'hot-cache-shim');
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
