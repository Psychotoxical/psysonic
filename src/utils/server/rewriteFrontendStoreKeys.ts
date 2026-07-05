import type { ServerProfile } from '../../store/authStoreTypes';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { useCoverStrategyStore } from '../../store/coverStrategyStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { useOfflineStore } from '@/features/offline';
import { usePlayerStore } from '@/features/playback/store/playerStore';
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

function rewriteOfflineStoreKeys(mappings: Mapping[]): void {
  const map = new Map(mappings.map(mapping => [mapping.legacyId, mapping.indexKey]));
  useOfflineStore.setState((state) => {
    const albums = { ...state.albums };
    for (const [key, meta] of Object.entries(state.albums)) {
      const i = key.indexOf(':');
      if (i <= 0) continue;
      const legacyId = key.slice(0, i);
      const albumId = key.slice(i + 1);
      const indexKey = map.get(legacyId);
      if (!indexKey) continue;
      const nextKey = `${indexKey}:${albumId}`;
      if (!albums[nextKey]) {
        albums[nextKey] = { ...meta, serverId: indexKey };
      }
      delete albums[key];
    }
    return { albums };
  });
}

function rewriteLocalPlaybackStoreKeys(mappings: Mapping[]): void {
  const map = new Map(mappings.map(mapping => [mapping.legacyId, mapping.indexKey]));
  useLocalPlaybackStore.setState((state) => {
    const entries = { ...state.entries };
    for (const [key, entry] of Object.entries(state.entries)) {
      const i = key.indexOf(':');
      if (i <= 0) continue;
      const legacyId = key.slice(0, i);
      const trackId = key.slice(i + 1);
      const indexKey = map.get(legacyId);
      if (!indexKey) continue;
      const nextKey = `${indexKey}:${trackId}`;
      if (!entries[nextKey]) {
        entries[nextKey] = { ...entry, serverIndexKey: indexKey };
      }
      delete entries[key];
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

export async function rewriteFrontendStoreKeys(servers: ServerProfile[]): Promise<void> {
  const mappings = buildMappings(servers);
  if (mappings.length === 0) return;
  rewriteOfflineStoreKeys(mappings);
  rewriteLocalPlaybackStoreKeys(mappings);
  rewriteAnalysisStrategyStoreKeys(mappings);
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
