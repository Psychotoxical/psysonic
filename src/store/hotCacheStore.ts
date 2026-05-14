import type { Track } from './playerStoreTypes';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { isHotCachePreviousTrackUnderGrace } from '../utils/cache/hotCacheGate';
import { emitAnalysisStorageChanged } from './analysisSync';
import { useAuthStore } from './authStore';

/** How many queue slots after the current index are eviction-protected (1 = current + next only). */
export const HOT_CACHE_PROTECT_AFTER_CURRENT = 1;

export interface HotCacheEntry {
  localPath: string;
  sizeBytes: number;
  cachedAt: number;
  /** Last time this file was started as the current track (eviction tie-break: newer = keep longer). */
  lastPlayedAt?: number;
}

interface HotCacheState {
  /** Persisted map `${serverId}:${trackId}` → file meta */
  entries: Record<string, HotCacheEntry>;
  getLocalUrl: (trackId: string, serverId: string) => string | null;
  setEntry: (
    trackId: string,
    serverId: string,
    localPath: string,
    sizeBytes: number,
    debugSource?: string,
  ) => void;
  /** Bump LRU when the user actually plays this track (if it is in the hot cache). */
  touchPlayed: (trackId: string, serverId: string) => void;
  removeEntry: (trackId: string, serverId: string) => void;
  totalBytes: () => number;
  /** Evict until total size ≤ maxBytes. Protects current + next (+ grace for last «previous» track). */
  evictToFit: (
    queue: Track[],
    queueIndex: number,
    maxBytes: number,
    activeServerId: string,
    hotCacheCustomDir: string | null,
  ) => Promise<void>;
  clearAllDisk: (customDir: string | null) => Promise<void>;
}

function entryKey(serverId: string, trackId: string): string {
  return `${serverId}:${trackId}`;
}

function parseKey(key: string): { serverId: string; trackId: string } | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  return { serverId: key.slice(0, i), trackId: key.slice(i + 1) };
}

function lruStamp(meta: HotCacheEntry | undefined): number {
  if (!meta) return 0;
  return meta.lastPlayedAt ?? meta.cachedAt ?? 0;
}

function evictionReasonForTier(tier: number): string {
  const labels: Record<number, string> = {
    0: 'inactive-server',
    1: 'not-in-queue',
    2: 'ahead-of-protected-window',
    3: 'behind-current-in-queue',
  };
  return labels[tier] ?? `tier-${tier}`;
}

/** Settings → Logging → Debug, same as `emitNormalizationDebug` / lucky-mix. */
function hotCacheFrontendDebug(payload: Record<string, unknown>): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  void invoke('frontend_debug_log', {
    scope: 'hot-cache',
    message: JSON.stringify(payload),
  }).catch(() => {});
}

export const useHotCacheStore = create<HotCacheState>()(
  persist(
    (set, get) => ({
      entries: {},

      getLocalUrl: (trackId, serverId) => {
        const e = get().entries[entryKey(serverId, trackId)];
        if (!e?.localPath) return null;
        return `psysonic-local://${e.localPath}`;
      },

      setEntry: (trackId, serverId, localPath, sizeBytes, debugSource) => {
        const now = Date.now();
        set(s => ({
          entries: {
            ...s.entries,
            [entryKey(serverId, trackId)]: {
              localPath,
              sizeBytes,
              cachedAt: now,
              lastPlayedAt: now,
            },
          },
        }));
        hotCacheFrontendDebug({
          event: 'index-add',
          trackId,
          serverId,
          sizeBytes,
          source: debugSource ?? 'unknown',
        });
      },

      touchPlayed: (trackId, serverId) => {
        const k = entryKey(serverId, trackId);
        set(s => {
          const e = s.entries[k];
          if (!e) return s;
          return {
            entries: {
              ...s.entries,
              [k]: { ...e, lastPlayedAt: Date.now() },
            },
          };
        });
      },

      removeEntry: (trackId, serverId) => {
        set(s => {
          const next = { ...s.entries };
          delete next[entryKey(serverId, trackId)];
          return { entries: next };
        });
        hotCacheFrontendDebug({
          event: 'index-remove',
          trackId,
          serverId,
          reason: 'explicit-removeEntry',
        });
        emitAnalysisStorageChanged({ trackId, reason: 'hotcache-delete' });
      },

      totalBytes: () =>
        Object.values(get().entries).reduce((acc, e) => acc + (e.sizeBytes || 0), 0),

      evictToFit: async (queue, queueIndex, maxBytes, activeServerId, hotCacheCustomDir) => {
        if (maxBytes <= 0) return;

        const protectLo = Math.max(0, queueIndex);
        const protectHi = Math.min(queue.length - 1, queueIndex + HOT_CACHE_PROTECT_AFTER_CURRENT);
        const protectedIds = new Set<string>();
        for (let i = protectLo; i <= protectHi; i++) {
          protectedIds.add(queue[i].id);
        }

        const indexOfInQueue = (trackId: string): number | null => {
          const idx = queue.findIndex(t => t.id === trackId);
          return idx >= 0 ? idx : null;
        };

        let entries = { ...get().entries };
        let sum = Object.values(entries).reduce((a, e) => a + (e.sizeBytes || 0), 0);
        if (sum <= maxBytes) return;

        const keys = Object.keys(entries);
        type Cand = { key: string; tier: number; primary: number; lru: number };
        const cands: Cand[] = [];

        for (const key of keys) {
          const parsed = parseKey(key);
          if (!parsed) continue;
          const { serverId, trackId } = parsed;
          if (protectedIds.has(trackId) && serverId === activeServerId) continue;
          if (isHotCachePreviousTrackUnderGrace(trackId, serverId)) continue;

          const meta = entries[key];
          const lru = lruStamp(meta);

          if (serverId !== activeServerId) {
            cands.push({ key, tier: 0, primary: 0, lru });
            continue;
          }

          const qIdx = indexOfInQueue(trackId);
          if (qIdx === null) {
            cands.push({ key, tier: 1, primary: 0, lru });
          } else if (qIdx > protectHi) {
            cands.push({ key, tier: 2, primary: -qIdx, lru });
          } else if (qIdx < protectLo) {
            cands.push({ key, tier: 3, primary: qIdx, lru });
          }
        }

        cands.sort((a, b) => {
          if (a.tier !== b.tier) return a.tier - b.tier;
          if (a.primary !== b.primary) return a.primary - b.primary;
          return a.lru - b.lru;
        });

        if (cands.length === 0) {
          hotCacheFrontendDebug({
            event: 'evict-no-candidates',
            sumBytes: sum,
            maxBytes,
            queueIndex,
            entryKeys: keys.length,
            reason: 'all-protected-or-grace-or-parse-fail',
          });
          return;
        }

        hotCacheFrontendDebug({
          event: 'evict-start',
          sumBytes: sum,
          maxBytes,
          queueIndex,
          protectLo,
          protectHi,
          candidateCount: cands.length,
        });

        for (const cand of cands) {
          if (sum <= maxBytes) break;
          const { key, tier } = cand;
          const meta = entries[key];
          if (!meta) continue;
          const parsed = parseKey(key);
          if (!parsed) continue;
          await invoke('delete_hot_cache_track', {
            localPath: meta.localPath,
            customDir: hotCacheCustomDir || null,
          }).catch((e: unknown) => {
            hotCacheFrontendDebug({
              event: 'evict-disk-delete-failed',
              trackId: parsed.trackId,
              serverId: parsed.serverId,
              error: String(e),
            });
          });
          hotCacheFrontendDebug({
            event: 'evict-remove',
            trackId: parsed.trackId,
            serverId: parsed.serverId,
            reason: `budget:${evictionReasonForTier(tier)}`,
            tier,
            bytes: meta.sizeBytes,
            sumBytesAfter: sum - (meta.sizeBytes || 0),
            maxBytes,
          });
          sum -= meta.sizeBytes || 0;
          delete entries[key];
          emitAnalysisStorageChanged({ trackId: parsed.trackId, reason: 'hotcache-delete' });
        }

        set({ entries });
      },

      clearAllDisk: async (customDir: string | null) => {
        hotCacheFrontendDebug({
          event: 'purge-all',
          customDir: customDir && customDir.length > 0 ? '(custom)' : 'default',
        });
        await invoke('purge_hot_cache', { customDir: customDir || null }).catch(() => {});
        set({ entries: {} });
        emitAnalysisStorageChanged({ trackId: null, reason: 'hotcache-purge' });
      },
    }),
    {
      name: 'psysonic-hot-cache',
      storage: createJSONStorage(() => localStorage),
      partialize: s => ({ entries: s.entries }),
    },
  ),
);
