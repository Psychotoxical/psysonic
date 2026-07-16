import type { LibraryScopePair, SyncStateDto } from '@/lib/api/library/dto';
import { libraryStatusIsReady } from '@/lib/library/libraryReady';
import type { LibraryServerConnection } from '@/lib/network/libraryServerReachability';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';

interface LibraryScopeState {
  servers: Array<{ id: string; url: string }>;
  musicLibraryServerIds: string[];
  musicLibrarySelectionByServer: Record<string, string[]>;
  musicLibraryFilterByServer: Record<string, 'all' | string>;
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
  return state.servers.map(server => server.id).filter(serverId => selected.has(serverId));
}

export function buildConfiguredLibraryScopePairs(state: LibraryScopeState): LibraryScopePair[] {
  return configuredLibraryServerIds(state).flatMap<LibraryScopePair>(serverId => {
    const stored = state.musicLibrarySelectionByServer[serverId];
    const libraryIds = stored !== undefined
      ? stored
      : state.musicLibraryFilterByServer[serverId] === 'all'
        || state.musicLibraryFilterByServer[serverId] === undefined
        ? []
        : [state.musicLibraryFilterByServer[serverId]];
    if (libraryIds.length === 0) return [{ serverId, libraryId: null }];
    return libraryIds.map(libraryId => ({ serverId, libraryId }));
  });
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
