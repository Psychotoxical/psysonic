import type { LibraryScopePair, SyncStateDto } from '@/lib/api/library/dto';
import { libraryStatusIsReady } from '@/lib/library/libraryReady';
import type { LibraryServerConnection } from '@/lib/network/libraryServerReachability';
import {
  assertSelectedIndexAliasesCompatible,
  serverIndexKeyFromUrl,
  serverIndexOwners,
} from '@/lib/server/serverIndexKey';

interface LibraryScopeState {
  servers: Array<{ id: string; url: string; name?: string }>;
  musicLibraryServerIds: string[];
  musicLibrarySelectionByServer: Record<string, string[]>;
  musicLibraryFilterByServer: Record<string, 'all' | string>;
}

export interface ReachableLibrarySource {
  serverId: string;
  name: string;
}

export interface LibraryScopeRuntime {
  statusByServer: Record<string, SyncStateDto | null>;
  connectionByServer: Record<string, LibraryServerConnection>;
}

export type BrowseScopeExcludedReason =
  | 'offline'
  | 'connection_unknown'
  | 'index_not_ready';

export interface BrowseScopeExcludedSource {
  serverId: string;
  reasons: BrowseScopeExcludedReason[];
}

export interface MutationLibraryScopeSource {
  serverId: string;
  readiness: 'ready' | 'not_ready';
  pairs: LibraryScopePair[];
}

export interface DerivedLibraryScopes {
  configured: LibraryScopePair[];
  browse: LibraryScopePair[];
  mutation: MutationLibraryScopeSource[];
  browseExcluded: BrowseScopeExcludedSource[];
}

export function configuredLibraryServerIds(state: LibraryScopeState): string[] {
  const selected = new Set(state.musicLibraryServerIds);
  return serverIndexOwners(state).flatMap(server => selected.has(server.id) ? [server.id] : []);
}

/** Selected live Subsonic sources. Unlike indexed browse, this ignores index readiness. */
export function buildReachableLibrarySources(
  state: LibraryScopeState,
  runtime: Pick<LibraryScopeRuntime, 'connectionByServer'>,
  options?: { navigatorOffline?: boolean },
): ReachableLibrarySource[] {
  if (options?.navigatorOffline) return [];
  const selected = new Set(configuredLibraryServerIds(state));
  return state.servers.flatMap(server => {
    if (!selected.has(server.id)) return [];
    const indexKey = serverIndexKeyFromUrl(server.url) || server.id;
    if (runtime.connectionByServer[indexKey] !== 'online') return [];
    return [{ serverId: server.id, name: server.name?.trim() || server.url }];
  });
}

export function buildConfiguredLibraryScopePairs(state: LibraryScopeState): LibraryScopePair[] {
  assertSelectedIndexAliasesCompatible(state);
  const selected = new Set(state.musicLibraryServerIds);
  const scopesByIndexKey = new Map<string, { ownerServerId: string; libraryIds: string[] | null }>();
  for (const server of state.servers) {
    if (!selected.has(server.id)) continue;
    const indexKey = serverIndexKeyFromUrl(server.url) || server.id;
    const stored = state.musicLibrarySelectionByServer[server.id];
    const libraryIds = stored !== undefined
      ? stored
      : state.musicLibraryFilterByServer[server.id] === 'all'
        || state.musicLibraryFilterByServer[server.id] === undefined
        ? []
        : [state.musicLibraryFilterByServer[server.id]];
    const existing = scopesByIndexKey.get(indexKey);
    if (!existing) {
      scopesByIndexKey.set(indexKey, {
        ownerServerId: server.id,
        libraryIds: libraryIds.length === 0 ? null : [...new Set(libraryIds)],
      });
      continue;
    }
    if (existing.libraryIds === null || libraryIds.length === 0) {
      existing.libraryIds = null;
      continue;
    }
    const seen = new Set(existing.libraryIds);
    for (const libraryId of libraryIds) {
      if (!seen.has(libraryId)) {
        seen.add(libraryId);
        existing.libraryIds.push(libraryId);
      }
    }
  }
  return [...scopesByIndexKey.values()].flatMap<LibraryScopePair>(({ ownerServerId, libraryIds }) =>
    libraryIds === null
      ? [{ serverId: ownerServerId, libraryId: null }]
      : libraryIds.map(libraryId => ({ serverId: ownerServerId, libraryId })),
  );
}

function runtimeForProfile(
  state: LibraryScopeState,
  runtime: LibraryScopeRuntime,
  serverId: string,
): { status: SyncStateDto | null; connection: LibraryServerConnection } {
  const server = state.servers.find(candidate => candidate.id === serverId);
  const indexKey = server ? serverIndexKeyFromUrl(server.url) || serverId : serverId;
  return {
    status: runtime.statusByServer[indexKey] ?? null,
    connection: runtime.connectionByServer[indexKey] ?? 'unknown',
  };
}

export function buildBrowseLibraryScopePairs(
  state: LibraryScopeState,
  runtime: LibraryScopeRuntime,
  options?: { navigatorOffline?: boolean },
): LibraryScopePair[] {
  if (options?.navigatorOffline) return [];
  return buildConfiguredLibraryScopePairs(state).filter(pair => {
    const { status, connection } = runtimeForProfile(state, runtime, pair.serverId);
    return connection === 'online' && status != null && libraryStatusIsReady(status);
  });
}

export function buildMutationLibraryScope(
  state: LibraryScopeState,
  runtime: LibraryScopeRuntime,
): MutationLibraryScopeSource[] {
  const configured = buildConfiguredLibraryScopePairs(state);
  return configuredLibraryServerIds(state).map(serverId => {
    const { status } = runtimeForProfile(state, runtime, serverId);
    return {
      serverId,
      readiness: status != null && libraryStatusIsReady(status) ? 'ready' : 'not_ready',
      pairs: configured.filter(pair => pair.serverId === serverId),
    };
  });
}

export function buildMutationLibraryScopePairs(state: LibraryScopeState): LibraryScopePair[] {
  return buildConfiguredLibraryScopePairs(state);
}

export function buildBrowseScopeExcludedSources(
  state: LibraryScopeState,
  runtime: LibraryScopeRuntime,
  options?: { navigatorOffline?: boolean },
): BrowseScopeExcludedSource[] {
  return configuredLibraryServerIds(state).flatMap(serverId => {
    const { status, connection } = runtimeForProfile(state, runtime, serverId);
    const reasons: BrowseScopeExcludedReason[] = [];
    if (options?.navigatorOffline || connection === 'offline') reasons.push('offline');
    else if (connection === 'unknown') reasons.push('connection_unknown');
    if (status == null || !libraryStatusIsReady(status)) reasons.push('index_not_ready');
    return reasons.length > 0 ? [{ serverId, reasons }] : [];
  });
}

export function buildDerivedLibraryScopes(
  state: LibraryScopeState,
  runtime: LibraryScopeRuntime,
  options?: { navigatorOffline?: boolean },
): DerivedLibraryScopes {
  return {
    configured: buildConfiguredLibraryScopePairs(state),
    browse: buildBrowseLibraryScopePairs(state, runtime, options),
    mutation: buildMutationLibraryScope(state, runtime),
    browseExcluded: buildBrowseScopeExcludedSources(state, runtime, options),
  };
}

export function libraryScopeFingerprint(pairs: LibraryScopePair[]): string {
  return JSON.stringify(pairs.map(({ serverId, libraryId }) => [serverId, libraryId]));
}
