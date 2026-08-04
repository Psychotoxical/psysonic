import { getUnavailableServerIds } from '@/lib/network/serverReachability';

export interface LibraryBrowseScopePair {
  serverId: string;
  libraryId: string | null;
}

export interface LibraryBrowseScopeSource {
  servers: Array<{ id: string }>;
  activeServerId: string | null;
  libraryBrowseServerIds: string[];
  musicFoldersByServer: Record<string, Array<{ id: string }>>;
  libraryBrowseSelectionByServer: Record<string, string[]>;
}

let readLibraryBrowseScopeSource: () => LibraryBrowseScopeSource = () => ({
  servers: [],
  activeServerId: null,
  libraryBrowseServerIds: [],
  musicFoldersByServer: {},
  libraryBrowseSelectionByServer: {},
});

/** Store-layer injection keeps `src/lib` independent of Zustand. */
export function setLibraryBrowseScopeSource(source: () => LibraryBrowseScopeSource): void {
  readLibraryBrowseScopeSource = source;
}

export interface LibraryBrowseScope {
  anchorServerId: string | null;
  /** Ordered selected servers represented by this scope. */
  serverIds: string[];
  pairs: LibraryBrowseScopePair[];
  fingerprint: string;
  multiServer: boolean;
}

export interface LibraryBrowseIndexScope {
  serverId: string;
  /** Empty means every indexed library on this server. */
  libraryIds: string[];
}

/** Ordered concrete library ids for one server; empty means the whole server. */
export function browseScopeLibraryIdsForServer(
  scopes: readonly LibraryBrowseScopePair[],
  serverId: string,
): string[] {
  const matching = scopes.filter(scope => scope.serverId === serverId);
  if (matching.length === 0 || matching.some(scope => scope.libraryId === null)) return [];
  return [...new Set(matching.flatMap(scope => scope.libraryId ? [scope.libraryId] : []))];
}

type LibraryBrowseServerOrderSource = Pick<
  LibraryBrowseScopeSource,
  'servers' | 'activeServerId' | 'libraryBrowseServerIds'
>;

export function deriveOrderedLibraryBrowseServerIds(
  state: LibraryBrowseServerOrderSource,
): string[] {
  const selectedServers = new Set(state.libraryBrowseServerIds);
  return state.servers
    .filter(server => selectedServers.has(server.id))
    .map(server => server.id);
}

export function deriveLibraryBrowseServerIdsWithFallback(
  state: LibraryBrowseServerOrderSource,
): string[] {
  const orderedServerIds = deriveOrderedLibraryBrowseServerIds(state);
  if (orderedServerIds.length > 0 || state.servers.length === 0) return orderedServerIds;

  const fallback = state.servers.find(server => server.id === state.activeServerId) ?? state.servers[0];
  return fallback ? [fallback.id] : [];
}

export function deriveEffectiveLibraryBrowseServerIds(
  state: LibraryBrowseServerOrderSource,
  unavailableServerIds: ReadonlySet<string> = getUnavailableServerIds(),
): string[] {
  return deriveLibraryBrowseServerIdsWithFallback(state)
    .filter(serverId => !unavailableServerIds.has(serverId));
}

export function deriveLibraryBrowseIndexScopes(
  state: LibraryBrowseScopeSource,
  unavailableServerIds: ReadonlySet<string> = getUnavailableServerIds(),
): LibraryBrowseIndexScope[] {
  return deriveEffectiveLibraryBrowseServerIds(state, unavailableServerIds).map(serverId => ({
    serverId,
    libraryIds: state.libraryBrowseSelectionByServer[serverId] ?? [],
  }));
}

/** Ordered scope pairs used only by Library pages and search. */
export function deriveLibraryBrowseScope(
  state: LibraryBrowseScopeSource,
  unavailableServerIds: ReadonlySet<string> = getUnavailableServerIds(),
): LibraryBrowseScope {
  const orderedServerIds = deriveOrderedLibraryBrowseServerIds(state);
  const effectiveServerIds = orderedServerIds
    .filter(serverId => !unavailableServerIds.has(serverId));
  const fallbackServerIds = orderedServerIds.length === 0
    ? deriveEffectiveLibraryBrowseServerIds(state, unavailableServerIds)
    : [];
  const scopeServerIds = effectiveServerIds.length > 0 ? effectiveServerIds : fallbackServerIds;
  const pairs: LibraryBrowseScopePair[] = [];
  const fingerprintEntries: Array<[string, Array<string | null>]> = [];

  for (const serverId of effectiveServerIds) {
    const selection = state.libraryBrowseSelectionByServer[serverId] ?? [];
    const libraryIds = selection.length > 0
      ? selection
      : [null];
    fingerprintEntries.push([serverId, libraryIds]);
    for (const libraryId of libraryIds) {
      pairs.push({ serverId, libraryId });
    }
  }

  if (fingerprintEntries.length === 0) {
    for (const serverId of fallbackServerIds) {
      const selection = state.libraryBrowseSelectionByServer[serverId] ?? [];
      const libraryIds = selection.length > 0 ? selection : [null];
      fingerprintEntries.push([serverId, libraryIds]);
      for (const libraryId of libraryIds) {
        pairs.push({ serverId, libraryId });
      }
    }
  }

  const fingerprint = fingerprintEntries.length > 0 ? JSON.stringify(fingerprintEntries) : '';

  return {
    anchorServerId: scopeServerIds[0] ?? null,
    serverIds: scopeServerIds,
    pairs,
    fingerprint,
    multiServer: scopeServerIds.length > 1,
  };
}

/** Configured scope for entity-source resolution, with the concrete anchor as a defensive fallback. */
export function deriveEntitySourceScopes(
  state: LibraryBrowseScopeSource,
  anchorServerId: string,
): LibraryBrowseScopePair[] {
  const configured = deriveOrderedLibraryBrowseServerIds(state).length > 0
    ? deriveLibraryBrowseScope(state, new Set()).pairs
    : [];
  if (configured.length > 0) return configured;
  return anchorServerId ? [{ serverId: anchorServerId, libraryId: null }] : [];
}

export function getLibraryBrowseScope(): LibraryBrowseScope {
  return deriveLibraryBrowseScope(readLibraryBrowseScopeSource());
}

/** Whether the user configured authoritative browse membership instead of using the active-server fallback. */
export function hasConfiguredLibraryBrowseScope(): boolean {
  return deriveOrderedLibraryBrowseServerIds(readLibraryBrowseScopeSource()).length > 0;
}
