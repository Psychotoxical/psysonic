import type { QueueItemRef } from './playerStoreTypes';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { isHotCachePreviousTrackUnderGrace } from '../utils/cache/hotCacheGate';
import { emitAnalysisStorageChanged } from './analysisSync';
import { useAuthStore } from './authStore';
import { localPlaybackEntryKey, parseLocalPlaybackEntryKey } from './localPlaybackKeys';
import {
  importLegacyLocalPlayback,
  legacyMigrationAlreadyDone,
  markLegacyMigrationDone,
} from './localPlaybackMigration';
import {
  evictEphemeralOrphansToFit,
  getEphemeralDiskBytes,
  reconcileEphemeralCache,
} from '../utils/cache/ephemeralTierReconcile';

export type LocalPlaybackTier = 'ephemeral' | 'library' | 'favorite-auto';

export interface PinSource {
  kind: 'album' | 'playlist' | 'artist' | 'track';
  sourceId: string;
  displayName?: string;
}

export interface LocalPlaybackEntry {
  serverIndexKey: string;
  trackId: string;
  localPath: string;
  layoutFingerprint: string;
  sizeBytes: number;
  tier: LocalPlaybackTier;
  cachedAt: number;
  lastPlayedAt?: number;
  pinSource?: PinSource;
  suffix: string;
}

export interface PinnedGroup {
  serverIndexKey: string;
  pinSource: PinSource;
  trackIds: string[];
}

export const LOCAL_PLAYBACK_PROTECT_AFTER_CURRENT = 1;

interface LocalPlaybackState {
  entries: Record<string, LocalPlaybackEntry>;
  getEntry: (trackId: string, serverIndexKey: string) => LocalPlaybackEntry | null;
  getLocalUrl: (trackId: string, serverIndexKey: string, tier?: LocalPlaybackTier) => string | null;
  hasLocalBytes: (trackId: string, serverIndexKey: string) => boolean;
  isPinned: (trackId: string, serverIndexKey: string) => boolean;
  upsertEntry: (entry: Omit<LocalPlaybackEntry, 'cachedAt'> & { cachedAt?: number }) => void;
  touchPlayed: (trackId: string, serverIndexKey: string) => void;
  removeEntry: (trackId: string, serverIndexKey: string, reason?: string) => void;
  removeEntriesByPinSource: (
    serverIndexKey: string,
    pinSource: PinSource,
    mediaDir: string | null,
  ) => Promise<void>;
  listPinnedGroups: (serverIndexKey?: string) => PinnedGroup[];
  ephemeralEntries: () => Record<string, LocalPlaybackEntry>;
  ephemeralTotalBytes: () => number;
  evictEphemeralToFit: (
    queue: QueueItemRef[],
    queueIndex: number,
    maxBytes: number,
    activeServerIndexKey: string,
    mediaDir: string | null,
  ) => Promise<void>;
  purgeEphemeralDisk: (mediaDir: string | null) => Promise<void>;
  purgeLibraryDisk: (mediaDir: string | null) => Promise<void>;
  purgeFavoriteAutoDisk: (mediaDir: string | null) => Promise<void>;
}

function lruStamp(meta: LocalPlaybackEntry | undefined): number {
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

function localPlaybackFrontendDebug(payload: Record<string, unknown>): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  void invoke('frontend_debug_log', {
    scope: 'local-playback',
    message: JSON.stringify(payload),
  }).catch(() => {});
}

function pinGroupKey(serverIndexKey: string, pinSource: PinSource): string {
  return `${serverIndexKey}:${pinSource.kind}:${pinSource.sourceId}`;
}

export const useLocalPlaybackStore = create<LocalPlaybackState>()(
  persist(
    (set, get) => ({
      entries: {},

      getEntry: (trackId, serverIndexKey) =>
        get().entries[localPlaybackEntryKey(serverIndexKey, trackId)] ?? null,

      getLocalUrl: (trackId, serverIndexKey, tier) => {
        const e = get().entries[localPlaybackEntryKey(serverIndexKey, trackId)];
        if (!e?.localPath) return null;
        if (tier && e.tier !== tier) return null;
        return `psysonic-local://${e.localPath}`;
      },

      hasLocalBytes: (trackId, serverIndexKey) =>
        !!get().entries[localPlaybackEntryKey(serverIndexKey, trackId)]?.localPath,

      isPinned: (trackId, serverIndexKey) =>
        get().entries[localPlaybackEntryKey(serverIndexKey, trackId)]?.tier === 'library',

      upsertEntry: (entry) => {
        const now = Date.now();
        const key = localPlaybackEntryKey(entry.serverIndexKey, entry.trackId);
        set(s => ({
          entries: {
            ...s.entries,
            [key]: {
              ...entry,
              cachedAt: entry.cachedAt ?? now,
              lastPlayedAt: entry.lastPlayedAt ?? (entry.tier === 'ephemeral' ? now : entry.lastPlayedAt),
            },
          },
        }));
      },

      touchPlayed: (trackId, serverIndexKey) => {
        const key = localPlaybackEntryKey(serverIndexKey, trackId);
        set(s => {
          const e = s.entries[key];
          if (!e || e.tier !== 'ephemeral') return s;
          return {
            entries: {
              ...s.entries,
              [key]: { ...e, lastPlayedAt: Date.now() },
            },
          };
        });
      },

      removeEntry: (trackId, serverIndexKey, reason = 'explicit-remove') => {
        const key = localPlaybackEntryKey(serverIndexKey, trackId);
        set(s => {
          const next = { ...s.entries };
          delete next[key];
          return { entries: next };
        });
        localPlaybackFrontendDebug({ event: 'index-remove', trackId, serverIndexKey, reason });
        emitAnalysisStorageChanged({ trackId, reason: 'local-playback-delete' });
      },

      removeEntriesByPinSource: async (serverIndexKey, pinSource, mediaDir) => {
        const targets = Object.values(get().entries).filter(
          e =>
            e.serverIndexKey === serverIndexKey
            && e.tier === 'library'
            && e.pinSource?.kind === pinSource.kind
            && e.pinSource?.sourceId === pinSource.sourceId,
        );
        await Promise.all(
          targets.map(async e => {
            await invoke('delete_media_file', { localPath: e.localPath, mediaDir }).catch(() => {});
            get().removeEntry(e.trackId, e.serverIndexKey, 'pin-group-delete');
          }),
        );
      },

      listPinnedGroups: (serverIndexKey) => {
        const groups = new Map<string, PinnedGroup>();
        for (const e of Object.values(get().entries)) {
          if (e.tier !== 'library' || !e.pinSource) continue;
          if (serverIndexKey && e.serverIndexKey !== serverIndexKey) continue;
          const gk = pinGroupKey(e.serverIndexKey, e.pinSource);
          const existing = groups.get(gk);
          if (existing) {
            if (!existing.trackIds.includes(e.trackId)) existing.trackIds.push(e.trackId);
          } else {
            groups.set(gk, {
              serverIndexKey: e.serverIndexKey,
              pinSource: e.pinSource,
              trackIds: [e.trackId],
            });
          }
        }
        return [...groups.values()];
      },

      ephemeralEntries: () => {
        const out: Record<string, LocalPlaybackEntry> = {};
        for (const [key, e] of Object.entries(get().entries)) {
          if (e.tier === 'ephemeral') out[key] = e;
        }
        return out;
      },

      ephemeralTotalBytes: () =>
        Object.values(get().entries)
          .filter(e => e.tier === 'ephemeral')
          .reduce((acc, e) => acc + (e.sizeBytes || 0), 0),

      evictEphemeralToFit: async (queue, queueIndex, maxBytes, activeServerIndexKey, mediaDir) => {
        if (maxBytes <= 0) return;

        await reconcileEphemeralCache();

        let diskBytes = await getEphemeralDiskBytes(mediaDir);
        if (diskBytes <= maxBytes) return;

        const protectLo = Math.max(0, queueIndex);
        const protectHi = Math.min(queue.length - 1, queueIndex + LOCAL_PLAYBACK_PROTECT_AFTER_CURRENT);
        const protectedIds = new Set<string>();
        for (let i = protectLo; i <= protectHi; i++) {
          protectedIds.add(queue[i].trackId);
        }

        const indexOfInQueue = (trackId: string): number | null => {
          const idx = queue.findIndex(r => r.trackId === trackId);
          return idx >= 0 ? idx : null;
        };

        const entries = { ...get().entries };
        let sum = Object.values(entries)
          .filter(e => e.tier === 'ephemeral')
          .reduce((a, e) => a + (e.sizeBytes || 0), 0);

        type Cand = { key: string; tier: number; primary: number; lru: number };
        const cands: Cand[] = [];

        for (const [key, meta] of Object.entries(entries)) {
          if (meta.tier !== 'ephemeral') continue;
          const parsed = parseLocalPlaybackEntryKey(key);
          if (!parsed) continue;
          const { serverIndexKey, trackId } = parsed;
          if (protectedIds.has(trackId) && serverIndexKey === activeServerIndexKey) continue;
          if (isHotCachePreviousTrackUnderGrace(trackId, serverIndexKey)) continue;

          const lru = lruStamp(meta);
          if (serverIndexKey !== activeServerIndexKey) {
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

        for (const cand of cands) {
          if (sum <= maxBytes) break;
          const meta = entries[cand.key];
          if (!meta || meta.tier !== 'ephemeral') continue;
          const parsed = parseLocalPlaybackEntryKey(cand.key);
          if (!parsed) continue;
          await invoke('delete_media_file', {
            localPath: meta.localPath,
            mediaDir,
          }).catch(() => {});
          localPlaybackFrontendDebug({
            event: 'evict-remove',
            trackId: parsed.trackId,
            serverIndexKey: parsed.serverIndexKey,
            reason: `budget:${evictionReasonForTier(cand.tier)}`,
          });
          sum -= meta.sizeBytes || 0;
          delete entries[cand.key];
          emitAnalysisStorageChanged({ trackId: parsed.trackId, reason: 'hotcache-delete' });
        }

        set({ entries });

        diskBytes = await getEphemeralDiskBytes(mediaDir);
        if (diskBytes > maxBytes) {
          const keepPaths = Object.values(get().entries)
            .filter(e => e.tier === 'ephemeral')
            .map(e => e.localPath);
          await evictEphemeralOrphansToFit(maxBytes, mediaDir, keepPaths);
        }

        await invoke('prune_empty_media_tier_dirs', { tier: 'ephemeral', mediaDir }).catch(() => {});
      },

      purgeEphemeralDisk: async (mediaDir) => {
        await invoke('purge_media_tier', { tier: 'ephemeral', mediaDir }).catch(() => {});
        set(s => {
          const entries = { ...s.entries };
          for (const [key, e] of Object.entries(entries)) {
            if (e.tier === 'ephemeral') delete entries[key];
          }
          return { entries };
        });
        emitAnalysisStorageChanged({ trackId: null, reason: 'hotcache-purge' });
      },

      purgeLibraryDisk: async (mediaDir) => {
        await invoke('purge_media_tier', { tier: 'library', mediaDir }).catch(() => {});
        set(s => {
          const entries = { ...s.entries };
          for (const [key, e] of Object.entries(entries)) {
            if (e.tier === 'library') delete entries[key];
          }
          return { entries };
        });
        emitAnalysisStorageChanged({ trackId: null, reason: 'offline-purge' });
      },

      purgeFavoriteAutoDisk: async (mediaDir) => {
        await invoke('purge_media_tier', { tier: 'favorite-auto', mediaDir }).catch(() => {});
        set(s => {
          const entries = { ...s.entries };
          for (const [key, e] of Object.entries(entries)) {
            if (e.tier === 'favorite-auto') delete entries[key];
          }
          return { entries };
        });
        emitAnalysisStorageChanged({ trackId: null, reason: 'favorites-offline-purge' });
      },
    }),
    {
      name: 'psysonic-local-playback',
      storage: createJSONStorage(() => localStorage),
      partialize: s => ({ entries: s.entries }),
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        if (legacyMigrationAlreadyDone()) return;
        const servers = useAuthStore.getState().servers;
        const imported = importLegacyLocalPlayback(servers);
        if (Object.keys(imported).length === 0) {
          markLegacyMigrationDone();
          return;
        }
        const merged = { ...imported, ...state.entries };
        useLocalPlaybackStore.setState({ entries: merged });
        markLegacyMigrationDone();
      },
    },
  ),
);
