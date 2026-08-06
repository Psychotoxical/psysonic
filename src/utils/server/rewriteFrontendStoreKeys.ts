import type { ServerProfile } from '../../store/authStoreTypes';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { useCoverStrategyStore } from '../../store/coverStrategyStore';
import {
  useLocalPlaybackStore,
  type LocalPlaybackEntry,
  type LocalPlaybackTier,
} from '../../store/localPlaybackStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { useOfflineStore, type OfflineAlbumMeta } from '@/features/offline';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useDeviceSyncStore } from '@/features/deviceSync';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';

/**
 * One `legacyId → indexKey` rewrite step. `legacyId` is whatever the keys
 * used to be tagged with — the historical name reflects the very first
 * migration (UUID → index key), but the same plumbing now also covers the
 * URL-change remigration (oldKey → newKey).
 */
type Mapping = { legacyId: string; indexKey: string };

function buildMappings(servers: ServerProfile[]): Mapping[] {
  return servers
    .map(server => ({
      legacyId: server.id.trim(),
      indexKey: serverIndexKeyFromUrl(server.url).trim(),
    }))
    .filter(mapping => mapping.legacyId.length > 0 && mapping.indexKey.length > 0);
}

function matchCompositeKey(key: string, mappings: Mapping[]): (Mapping & { suffix: string }) | null {
  let matched: Mapping | null = null;
  for (const mapping of mappings) {
    if (
      key.startsWith(`${mapping.legacyId}:`) &&
      (!matched || mapping.legacyId.length > matched.legacyId.length)
    ) {
      matched = mapping;
    }
  }
  if (!matched) return null;
  return { ...matched, suffix: key.slice(matched.legacyId.length + 1) };
}

export function mergeOfflineAlbum(
  existing: OfflineAlbumMeta,
  incoming: OfflineAlbumMeta,
  serverId: string,
): OfflineAlbumMeta {
  return {
    ...incoming,
    ...existing,
    serverId,
    trackIds: [...new Set([...existing.trackIds, ...incoming.trackIds])],
  };
}

const LOCAL_PLAYBACK_TIER_PRIORITY: Record<LocalPlaybackTier, number> = {
  ephemeral: 0,
  'favorite-auto': 1,
  library: 2,
};

export function mergeLocalPlaybackEntry(
  existing: LocalPlaybackEntry,
  incoming: LocalPlaybackEntry,
  serverIndexKey: string,
): LocalPlaybackEntry {
  const incomingWins =
    LOCAL_PLAYBACK_TIER_PRIORITY[incoming.tier] > LOCAL_PLAYBACK_TIER_PRIORITY[existing.tier]
    || (
      LOCAL_PLAYBACK_TIER_PRIORITY[incoming.tier] === LOCAL_PLAYBACK_TIER_PRIORITY[existing.tier]
      && incoming.cachedAt > existing.cachedAt
    );
  const winner = incomingWins ? incoming : existing;
  const other = incomingWins ? existing : incoming;
  return {
    ...winner,
    serverIndexKey,
    lastPlayedAt: Math.max(winner.lastPlayedAt ?? 0, other.lastPlayedAt ?? 0) || undefined,
    pinSource: winner.pinSource ?? other.pinSource,
  };
}

function rewriteOfflineStoreKeys(mappings: Mapping[]): void {
  useOfflineStore.setState((state) => {
    const albums = { ...state.albums };
    for (const [key, meta] of Object.entries(state.albums)) {
      const match = matchCompositeKey(key, mappings);
      if (!match) continue;
      const nextKey = `${match.indexKey}:${match.suffix}`;
      const existing = albums[nextKey];
      albums[nextKey] = existing
        ? mergeOfflineAlbum(existing, meta, match.indexKey)
        : { ...meta, serverId: match.indexKey };
      if (key !== nextKey) delete albums[key];
    }
    return { albums };
  });
}

function rewriteLocalPlaybackStoreKeys(mappings: Mapping[]): void {
  useLocalPlaybackStore.setState((state) => {
    const entries = { ...state.entries };
    for (const [key, entry] of Object.entries(state.entries)) {
      const match = matchCompositeKey(key, mappings);
      if (!match) continue;
      const nextKey = `${match.indexKey}:${match.suffix}`;
      const existing = entries[nextKey];
      entries[nextKey] = existing
        ? mergeLocalPlaybackEntry(existing, entry, match.indexKey)
        : { ...entry, serverIndexKey: match.indexKey };
      if (key !== nextKey) delete entries[key];
    }
    return { entries };
  });
}

function rewriteAnalysisStrategyStoreKeys(mappings: Mapping[]): void {
  const map = new Map(mappings.map(mapping => [mapping.legacyId, mapping.indexKey]));
  useAnalysisStrategyStore.setState((state) => {
    const strategyByServer = { ...state.strategyByServer };
    for (const [key, value] of Object.entries(state.strategyByServer)) {
      const indexKey = map.get(key);
      if (!indexKey || value === undefined) continue;
      if (strategyByServer[indexKey] === undefined) {
        strategyByServer[indexKey] = value;
      }
      delete strategyByServer[key];
    }

    const advancedParallelismByServer = { ...state.advancedParallelismByServer };
    for (const [key, value] of Object.entries(state.advancedParallelismByServer)) {
      const indexKey = map.get(key);
      if (!indexKey || value === undefined) continue;
      if (advancedParallelismByServer[indexKey] === undefined) {
        advancedParallelismByServer[indexKey] = value;
      }
      delete advancedParallelismByServer[key];
    }
    return { strategyByServer, advancedParallelismByServer };
  });
}

function rewriteDeviceSyncStoreKeys(mappings: Mapping[]): void {
  const map = new Map(mappings.map(mapping => [mapping.legacyId, mapping.indexKey]));
  const remapSourceKey = (key: string): string => {
    try {
      const parsed = JSON.parse(key) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string') return key;
      const serverIndexKey = map.get(parsed[0]);
      return serverIndexKey ? JSON.stringify([serverIndexKey, parsed[1], parsed[2]]) : key;
    } catch {
      return key;
    }
  };
  useDeviceSyncStore.setState(state => ({
    sources: state.sources.map(source => {
      const serverIndexKey = map.get(source.serverIndexKey);
      return serverIndexKey ? { ...source, serverIndexKey } : source;
    }),
    checkedIds: state.checkedIds.map(remapSourceKey),
    pendingDeletion: state.pendingDeletion.map(remapSourceKey),
  }));
}

export async function rewriteFrontendStoreKeys(servers: ServerProfile[]): Promise<void> {
  const mappings = buildMappings(servers);
  if (mappings.length === 0) return;
  rewriteOfflineStoreKeys(mappings);
  rewriteLocalPlaybackStoreKeys(mappings);
  rewriteAnalysisStrategyStoreKeys(mappings);
  rewriteDeviceSyncStoreKeys(mappings);
  // Keep migration explicit: Zustand persist writes the current state snapshot.
  useAnalysisStrategyStore.getState().migrateServerOverrides(servers);
  useCoverStrategyStore.getState().migrateServerOverrides(servers);
  useLibraryIndexStore.setState(state => ({ masterEnabled: state.masterEnabled }));
}

/**
 * URL-change remigration entry point: rewrites every front-end keyed store
 * for one or more explicit `oldKey → newKey` index-key remaps. Used after
 * `migration_run` has re-tagged the SQLite tables (library + analysis) and
 * `cover_cache_rename_server_bucket` has moved the disk bucket — without
 * this step the in-memory zustand state would still point at the old keys.
 *
 * Player queue `queueServerId` and per-item `queueItems[].serverId` are
 * included here so mixed-server playback keeps resolving through the rename.
 */
export async function rewriteFrontendStoreKeysForRemap(
  remaps: ReadonlyArray<{ oldKey: string; newKey: string }>,
): Promise<void> {
  const mappings: Mapping[] = remaps
    .map(r => ({ legacyId: r.oldKey.trim(), indexKey: r.newKey.trim() }))
    .filter(m => m.legacyId.length > 0 && m.indexKey.length > 0 && m.legacyId !== m.indexKey);
  if (mappings.length === 0) return;

  rewriteOfflineStoreKeys(mappings);
  rewriteLocalPlaybackStoreKeys(mappings);
  rewriteAnalysisStrategyStoreKeys(mappings);
  rewriteDeviceSyncStoreKeys(mappings);

  // Player queue: queueServerId + per-item refs may carry remapped index keys.
  const queueRemap = new Map(mappings.map(m => [m.legacyId, m.indexKey]));
  usePlayerStore.setState(state => {
    let queueServerId = state.queueServerId;
    if (queueServerId) {
      const next = queueRemap.get(queueServerId);
      if (next) queueServerId = next;
    }
    let queueItems = state.queueItems;
    if (queueItems.length > 0) {
      let changed = queueServerId !== state.queueServerId;
      const nextItems = queueItems.map(ref => {
        const nextServerId = queueRemap.get(ref.serverId);
        if (!nextServerId) return ref;
        changed = true;
        return { ...ref, serverId: nextServerId };
      });
      if (changed) queueItems = nextItems;
    }
    if (queueServerId === state.queueServerId && queueItems === state.queueItems) {
      return state;
    }
    return { queueServerId, queueItems };
  });

  // The analysis/cover strategy stores carry per-server-id maps that the
  // `migrateServerOverrides` helpers already handle for the UUID→indexKey
  // case; for index-key→index-key we run the same map-remap path inline.
  useAnalysisStrategyStore.setState(state => {
    const strategyByServer = { ...state.strategyByServer };
    const advancedParallelismByServer = { ...state.advancedParallelismByServer };
    for (const { legacyId, indexKey } of mappings) {
      if (strategyByServer[legacyId] !== undefined && strategyByServer[indexKey] === undefined) {
        strategyByServer[indexKey] = strategyByServer[legacyId];
      }
      delete strategyByServer[legacyId];
      if (
        advancedParallelismByServer[legacyId] !== undefined &&
        advancedParallelismByServer[indexKey] === undefined
      ) {
        advancedParallelismByServer[indexKey] = advancedParallelismByServer[legacyId];
      }
      delete advancedParallelismByServer[legacyId];
    }
    return { strategyByServer, advancedParallelismByServer };
  });

  // Cover strategy overrides are keyed by the same index key — spec §8.2
  // lists "analysis/cover strategy maps", so remap both. Without this a
  // user-set cover strategy on the old key drops silently on URL edit.
  useCoverStrategyStore.setState(state => {
    const strategyByServer = { ...state.strategyByServer };
    for (const { legacyId, indexKey } of mappings) {
      if (strategyByServer[legacyId] !== undefined && strategyByServer[indexKey] === undefined) {
        strategyByServer[indexKey] = strategyByServer[legacyId];
      }
      delete strategyByServer[legacyId];
    }
    return { strategyByServer };
  });

  useLibraryIndexStore.setState(state => ({ masterEnabled: state.masterEnabled }));
}
