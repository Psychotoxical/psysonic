import type { ServerProfile } from '../../store/authStoreTypes';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { useCoverStrategyStore } from '../../store/coverStrategyStore';
import { useHotCacheStore } from '../../store/hotCacheStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { useOfflineStore } from '../../store/offlineStore';
import { serverIndexKeyFromUrl } from './serverIndexKey';

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
    const tracks = { ...state.tracks };
    for (const [key, meta] of Object.entries(state.tracks)) {
      const i = key.indexOf(':');
      if (i <= 0) continue;
      const legacyId = key.slice(0, i);
      const trackId = key.slice(i + 1);
      const indexKey = map.get(legacyId);
      if (!indexKey) continue;
      const nextKey = `${indexKey}:${trackId}`;
      if (!tracks[nextKey]) {
        tracks[nextKey] = { ...meta, serverId: indexKey };
      }
      delete tracks[key];
    }

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
    return { tracks, albums };
  });
}

function rewriteHotCacheStoreKeys(mappings: Mapping[]): void {
  const map = new Map(mappings.map(mapping => [mapping.legacyId, mapping.indexKey]));
  useHotCacheStore.setState((state) => {
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
        entries[nextKey] = entry;
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
  rewriteHotCacheStoreKeys(mappings);
  rewriteAnalysisStrategyStoreKeys(mappings);
  // Keep migration explicit: Zustand persist writes the current state snapshot.
  useAnalysisStrategyStore.getState().migrateServerOverrides(servers);
  useCoverStrategyStore.getState().migrateServerOverrides(servers);
  useLibraryIndexStore.setState(state => ({ masterEnabled: state.masterEnabled }));
}
