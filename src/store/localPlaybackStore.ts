import type { QueueItemRef } from '@/lib/media/trackTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { frontendDebugLog } from '@/lib/api/debugLog';
import { deleteMediaFile, pruneEmptyMediaTierDirs, purgeMediaTier } from '@/lib/api/syncfs';
import { isHotCachePreviousTrackUnderGrace } from '@/lib/cache/hotCacheGate';
import { emitAnalysisStorageChanged } from './analysisSync';
import { useAuthStore } from './authStore';
import { localPlaybackEntryKey, parseLocalPlaybackEntryKey } from './localPlaybackKeys';
import {
  importLegacyLocalPlayback,
  legacyMigrationAlreadyDone,
  markLegacyMigrationDone,
} from './localPlaybackMigration';
import { createNavidromeCanonicalMigrationAwareJSONStorage } from '@/lib/util/safeStorage';
import {
  evictEphemeralOrphansToFit,
  getEphemeralDiskBytes,
  reconcileEphemeralCache,
} from '@/lib/cache/ephemeralTierReconcile';
import { canonicalQueueServerKey } from '@/lib/server/serverIndexKey';

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
  /** Additional owners when the same local bytes are pinned by multiple sources. */
  pinSources?: PinSource[];
  suffix: string;
  /**
   * Streaming bitrate cap (kbps) the cached bytes were fetched at; 0/undefined
   * means no client-requested cap. Ephemeral (hot) entries promoted from a live
   * capped stream carry the cap so they are only reused when the current
   * setting matches — a 128 kbps blob must not satisfy an uncapped request.
   * Persistent tiers never carry a client-requested cap.
   */
  streamMaxBitRateKbps?: number;
  /**
   * True only when native code verified these bytes against a capability-bound
   * raw-original request. Legacy entries rehydrate as false and are refreshed
   * on confirmed Navidrome profiles before being treated as originals.
   */
  originalBytesVerified?: boolean;
}

export interface PinnedGroup {
  serverIndexKey: string;
  pinSource: PinSource;
  trackIds: string[];
}

export const LOCAL_PLAYBACK_PROTECT_AFTER_CURRENT = 1;

interface LocalPlaybackState {
  entries: Record<string, LocalPlaybackEntry>;
  applyHydratedEntries: (entries: Record<string, LocalPlaybackEntry>) => void;
  getEntry: (trackId: string, serverIndexKey: string) => LocalPlaybackEntry | null;
  getLocalUrl: (trackId: string, serverIndexKey: string, tier?: LocalPlaybackTier) => string | null;
  hasLocalBytes: (trackId: string, serverIndexKey: string) => boolean;
  isPinned: (trackId: string, serverIndexKey: string) => boolean;
  upsertEntry: (entry: Omit<LocalPlaybackEntry, 'cachedAt'> & { cachedAt?: number }) => void;
  touchPlayed: (trackId: string, serverIndexKey: string) => void;
  removeEntry: (trackId: string, serverIndexKey: string, reason?: string) => void;
  removePinSource: (
    trackId: string,
    serverIndexKey: string,
    pinSource: PinSource,
    mediaDir: string | null,
    reason?: string,
  ) => Promise<void>;
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
  frontendDebugLog('local-playback', JSON.stringify(payload));
}

function pinGroupKey(serverIndexKey: string, pinSource: PinSource): string {
  return `${serverIndexKey}:${pinSource.kind}:${pinSource.sourceId}`;
}

function samePinSource(left: PinSource, right: PinSource): boolean {
  return left.kind === right.kind && left.sourceId === right.sourceId;
}

export function localPlaybackPinSources(entry: LocalPlaybackEntry): PinSource[] {
  const sources = entry.pinSources?.length ? entry.pinSources : (entry.pinSource ? [entry.pinSource] : []);
  const unique = new Map<string, PinSource>();
  for (const source of sources) unique.set(`${source.kind}:${source.sourceId}`, source);
  if (entry.pinSource) {
    const key = `${entry.pinSource.kind}:${entry.pinSource.sourceId}`;
    unique.delete(key);
    unique.set(key, entry.pinSource);
  }
  return [...unique.values()];
}

export function localPlaybackEntryHasPinSource(
  entry: LocalPlaybackEntry,
  pinSource: PinSource,
): boolean {
  return localPlaybackPinSources(entry).some(source => samePinSource(source, pinSource));
}

export const useLocalPlaybackStore = create<LocalPlaybackState>()(
  persist(
    (set, get) => ({
      entries: {},
      applyHydratedEntries: entries => set({ entries }),

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
        set(s => {
          const previous = s.entries[key];
          const next = {
            ...entry,
            cachedAt: entry.cachedAt ?? now,
            lastPlayedAt: entry.lastPlayedAt ?? (entry.tier === 'ephemeral' ? now : entry.lastPlayedAt),
          };
          if (entry.tier === 'library' && entry.pinSource) {
            const sources = new Map<string, PinSource>();
            for (const source of previous ? localPlaybackPinSources(previous) : []) {
              sources.set(`${source.kind}:${source.sourceId}`, source);
            }
            for (const source of entry.pinSources ?? []) {
              const sourceKey = `${source.kind}:${source.sourceId}`;
              sources.delete(sourceKey);
              sources.set(sourceKey, source);
            }
            const sourceKey = `${entry.pinSource.kind}:${entry.pinSource.sourceId}`;
            sources.delete(sourceKey);
            sources.set(sourceKey, entry.pinSource);
            const pinSources = [...sources.values()];
            next.pinSource = entry.pinSource;
            next.pinSources = pinSources.length > 1 ? pinSources : undefined;
          }
          return {
            entries: {
              ...s.entries,
              [key]: next,
            },
          };
        });
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
        emitAnalysisStorageChanged({ trackId, serverIndexKey, reason: 'local-playback-delete' });
      },

      removePinSource: async (
        trackId,
        serverIndexKey,
        pinSource,
        mediaDir,
        reason = 'pin-group-delete',
      ) => {
        const key = localPlaybackEntryKey(serverIndexKey, trackId);
        const entry = get().entries[key];
        if (!entry || !localPlaybackEntryHasPinSource(entry, pinSource)) return;
        const remaining = localPlaybackPinSources(entry)
          .filter(source => !samePinSource(source, pinSource));
        if (remaining.length > 0) {
          set(state => {
            const current = state.entries[key];
            if (!current || !localPlaybackEntryHasPinSource(current, pinSource)) return state;
            const currentRemaining = localPlaybackPinSources(current)
              .filter(source => !samePinSource(source, pinSource));
            if (currentRemaining.length === 0) return state;
            const nextPrimary = currentRemaining[currentRemaining.length - 1];
            return {
              entries: {
                ...state.entries,
                [key]: {
                  ...current,
                  pinSource: nextPrimary,
                  pinSources: currentRemaining.length > 1 ? currentRemaining : undefined,
                },
              },
            };
          });
          return;
        }
        await deleteMediaFile({ localPath: entry.localPath, mediaDir }).catch(() => {});
        const current = get().entries[key];
        if (
          current?.localPath === entry.localPath
          && localPlaybackEntryHasPinSource(current, pinSource)
          && localPlaybackPinSources(current).length === 1
        ) {
          get().removeEntry(trackId, serverIndexKey, reason);
        }
      },

      removeEntriesByPinSource: async (serverIndexKey, pinSource, mediaDir) => {
        const targets = Object.values(get().entries).filter(
          e =>
            e.serverIndexKey === serverIndexKey
            && e.tier === 'library'
            && localPlaybackEntryHasPinSource(e, pinSource),
        );
        await Promise.all(
          targets.map(e => get().removePinSource(
            e.trackId,
            e.serverIndexKey,
            pinSource,
            mediaDir,
          )),
        );
      },

      listPinnedGroups: (serverIndexKey) => {
        const groups = new Map<string, PinnedGroup>();
        for (const e of Object.values(get().entries)) {
          if (e.tier !== 'library') continue;
          if (serverIndexKey && e.serverIndexKey !== serverIndexKey) continue;
          for (const pinSource of localPlaybackPinSources(e)) {
            const gk = pinGroupKey(e.serverIndexKey, pinSource);
            const existing = groups.get(gk);
            if (existing) {
              if (!existing.trackIds.includes(e.trackId)) existing.trackIds.push(e.trackId);
            } else {
              groups.set(gk, {
                serverIndexKey: e.serverIndexKey,
                pinSource,
                trackIds: [e.trackId],
              });
            }
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

        await reconcileEphemeralCache({ entries: get().entries, removeEntry: get().removeEntry });

        let diskBytes = await getEphemeralDiskBytes(mediaDir);
        if (diskBytes <= maxBytes) return;

        const protectLo = Math.max(0, queueIndex);
        const protectHi = Math.min(queue.length - 1, queueIndex + LOCAL_PLAYBACK_PROTECT_AFTER_CURRENT);
        const queueEntryKey = (ref: QueueItemRef): string => localPlaybackEntryKey(
          canonicalQueueServerKey(ref.serverId) || activeServerIndexKey,
          ref.trackId,
        );
        const protectedKeys = new Set<string>();
        for (let i = protectLo; i <= protectHi; i++) {
          protectedKeys.add(queueEntryKey(queue[i]));
        }

        const queueIndexByKey = new Map<string, number>();
        queue.forEach((ref, index) => {
          const key = queueEntryKey(ref);
          if (!queueIndexByKey.has(key)) queueIndexByKey.set(key, index);
        });

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
          if (protectedKeys.has(key)) continue;
          if (isHotCachePreviousTrackUnderGrace(trackId, serverIndexKey)) continue;

          const lru = lruStamp(meta);
          if (serverIndexKey !== activeServerIndexKey) {
            cands.push({ key, tier: 0, primary: 0, lru });
            continue;
          }
          const qIdx = queueIndexByKey.get(key) ?? null;
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
          await deleteMediaFile({ localPath: meta.localPath, mediaDir }).catch(() => {});
          localPlaybackFrontendDebug({
            event: 'evict-remove',
            trackId: parsed.trackId,
            serverIndexKey: parsed.serverIndexKey,
            reason: `budget:${evictionReasonForTier(cand.tier)}`,
          });
          sum -= meta.sizeBytes || 0;
          delete entries[cand.key];
          emitAnalysisStorageChanged({
            trackId: parsed.trackId,
            serverIndexKey: parsed.serverIndexKey,
            reason: 'hotcache-delete',
          });
        }

        set({ entries });

        diskBytes = await getEphemeralDiskBytes(mediaDir);
        if (diskBytes > maxBytes) {
          const keepPaths = Object.values(get().entries)
            .filter(e => e.tier === 'ephemeral')
            .map(e => e.localPath);
          await evictEphemeralOrphansToFit(maxBytes, mediaDir, keepPaths);
        }

        await pruneEmptyMediaTierDirs({ tier: 'ephemeral', mediaDir }).catch(() => {});
      },

      purgeEphemeralDisk: async (mediaDir) => {
        await purgeMediaTier({ tier: 'ephemeral', mediaDir }).catch(() => {});
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
        await purgeMediaTier({ tier: 'library', mediaDir }).catch(() => {});
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
        await purgeMediaTier({ tier: 'favorite-auto', mediaDir }).catch(() => {});
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
      storage: createNavidromeCanonicalMigrationAwareJSONStorage(),
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as { entries?: Record<string, LocalPlaybackEntry> };
        if (version >= 1) return { entries: state.entries ?? {} };
        return {
          entries: Object.fromEntries(
            Object.entries(state.entries ?? {}).map(([key, entry]) => [
              key,
              { ...entry, originalBytesVerified: false },
            ]),
          ),
        };
      },
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
        state.applyHydratedEntries(merged);
        markLegacyMigrationDone();
      },
    },
  ),
);
