import { useEffect, useMemo } from 'react';
import { getMusicFoldersForServer } from '@/lib/api/subsonicLibrary';
import { deriveLibraryBrowseServerIdsWithFallback } from '@/lib/library/libraryBrowseScope';
import {
  describeMultiServerError,
  emitMultiServerDebug,
  summarizeMultiServerProfiles,
  summarizeMusicFoldersByServer,
} from '@/lib/library/multiServerDebug';
import { useAuthStore } from '@/store/authStore';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { navidromeCanonicalCheckpointStatus } from '@/lib/server/navidromeCanonicalCheckpointStatus';

function canonicalizeDiscoveredMusicFolders(
  canonicalIdsReady: boolean,
  folders: Array<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  if (!canonicalIdsReady) return folders;
  const canonical = new Map<string, { id: string; name: string }>();
  for (const folder of folders) {
    const id = canonicalNavidromeId(folder.id);
    const existing = canonical.get(id);
    canonical.set(id, existing
      ? { ...existing, ...folder, id, name: folder.name || existing.name }
      : { ...folder, id });
  }
  return [...canonical.values()];
}

/** Refreshes folder lists for the configured Library scope or its active-server fallback. */
export function useMusicFoldersDiscovery(): void {
  const isLoggedIn = useAuthStore(state => state.isLoggedIn);
  const servers = useAuthStore(state => state.servers);
  const activeServerId = useAuthStore(state => state.activeServerId);
  const configuredServerIds = useAuthStore(state => state.libraryBrowseServerIds);
  const setMusicFoldersForServer = useAuthStore(state => state.setMusicFoldersForServer);
  const selectedServerIds = useMemo(() => deriveLibraryBrowseServerIdsWithFallback({
    servers,
    activeServerId,
    libraryBrowseServerIds: configuredServerIds,
  }), [activeServerId, configuredServerIds, servers]);
  const selectedKey = useMemo(() => selectedServerIds.join('\u0000'), [selectedServerIds]);
  const canonicalReadyServerIds = useMemo(() => new Set(servers.flatMap(server => {
    const serverIndexKey = serverIndexKeyForProfile(server);
    return serverIndexKey && navidromeCanonicalCheckpointStatus(serverIndexKey) === 'ready'
      ? [server.id]
      : [];
  })), [servers]);

  useEffect(() => {
    const stateAtStart = useAuthStore.getState();
    emitMultiServerDebug('folders_discovery_effect', {
      isLoggedIn,
      activeServerId,
      configuredServerIds,
      resolvedServerIds: selectedServerIds,
      selectedKey,
      servers: summarizeMultiServerProfiles(servers),
      existingFolders: summarizeMusicFoldersByServer(stateAtStart.musicFoldersByServer),
    });
    if (!isLoggedIn || selectedServerIds.length === 0) {
      emitMultiServerDebug('folders_discovery_skip', {
        reason: !isLoggedIn ? 'not_logged_in' : 'no_resolved_servers',
        activeServerId,
        configuredServerIds,
        resolvedServerIds: selectedServerIds,
      });
      return;
    }
    const savedIds = new Set(servers.map(server => server.id));
    let cancelled = false;

    for (const serverId of selectedServerIds) {
      if (!savedIds.has(serverId)) {
        emitMultiServerDebug('folders_discovery_server_skip', {
          serverId,
          reason: 'profile_missing',
          savedServerIds: [...savedIds],
        });
        continue;
      }
      const requestStartedAt = performance.now();
      emitMultiServerDebug('folders_discovery_request_start', {
        serverId,
        previousFolders: summarizeMusicFoldersByServer({
          [serverId]: stateAtStart.musicFoldersByServer[serverId] ?? [],
        })[serverId],
      });
      void getMusicFoldersForServer(serverId)
        .then(discoveredFolders => {
          const folders = canonicalizeDiscoveredMusicFolders(
            canonicalReadyServerIds.has(serverId),
            discoveredFolders,
          );
          if (cancelled) {
            emitMultiServerDebug('folders_discovery_request_stale', {
              serverId,
              durationMs: Math.round(performance.now() - requestStartedAt),
              folderCount: folders.length,
              reason: 'effect_cancelled',
            });
            return;
          }
          const state = useAuthStore.getState();
          if (!state.servers.some(server => server.id === serverId)) {
            emitMultiServerDebug('folders_discovery_request_stale', {
              serverId,
              durationMs: Math.round(performance.now() - requestStartedAt),
              folderCount: folders.length,
              reason: 'profile_removed',
            });
            return;
          }
          setMusicFoldersForServer(serverId, folders);
          emitMultiServerDebug('folders_discovery_request_done', {
            serverId,
            durationMs: Math.round(performance.now() - requestStartedAt),
            folderCount: folders.length,
            folders: folders.map(folder => ({ id: folder.id, name: folder.name })),
            activeServerId: state.activeServerId,
            configuredServerIds: state.libraryBrowseServerIds,
          });
        })
        .catch(error => {
          // Preserve the last successful list while a server is temporarily unavailable.
          emitMultiServerDebug('folders_discovery_request_error', {
            serverId,
            durationMs: Math.round(performance.now() - requestStartedAt),
            error: describeMultiServerError(error),
          });
        });
    }

    return () => {
      cancelled = true;
      emitMultiServerDebug('folders_discovery_cleanup', {
        resolvedServerIds: selectedServerIds,
      });
    };
  }, [
    activeServerId,
    canonicalReadyServerIds,
    configuredServerIds,
    isLoggedIn,
    selectedKey,
    selectedServerIds,
    servers,
    setMusicFoldersForServer,
  ]);
}
