import type { AuthState } from './authStoreTypes';
import { generateId } from './authStoreHelpers';
import { getQueueServerId, clearQueueServerForPlayback } from './playbackEngineBridge';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { deriveLibraryBrowseServerIdsWithFallback } from '@/lib/library/libraryBrowseScope';
import {
  emitMultiServerDebug,
  summarizeMultiServerProfiles,
} from '@/lib/library/multiServerDebug';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

/**
 * Server profile + connection lifecycle. `removeServer` is the
 * non-trivial one: when the active server is the one being removed it
 * also drops every per-server map entry tied to that id and switches
 * the active id to the next available server (or null) so the rest of
 * the app doesn't end up reading stale state.
 */
export function createServerProfileActions(set: SetState, get: GetState): Pick<
  AuthState,
  | 'addServer'
  | 'updateServer'
  | 'removeServer'
  | 'setServers'
  | 'setActiveServer'
  | 'setLoggedIn'
  | 'setConnecting'
  | 'setConnectionError'
  | 'logout'
> {
  return {
    addServer: (profile) => {
      const id = generateId();
      set(s => {
        const servers = [...s.servers, { ...profile, id }];
        const libraryBrowseServerIds = deriveLibraryBrowseServerIdsWithFallback({
          servers,
          activeServerId: s.activeServerId,
          libraryBrowseServerIds: s.libraryBrowseServerIds,
        });
        const scopeChanged = libraryBrowseServerIds.length !== s.libraryBrowseServerIds.length
          || libraryBrowseServerIds.some((serverId, index) => serverId !== s.libraryBrowseServerIds[index]);
        return {
          servers,
          libraryBrowseServerIds,
          ...(scopeChanged
            ? { libraryBrowseScopeVersion: s.libraryBrowseScopeVersion + 1 }
            : {}),
        };
      });
      emitMultiServerDebug('server_profile_added', {
        addedServerId: id,
        servers: summarizeMultiServerProfiles(get().servers),
        configuredServerIds: get().libraryBrowseServerIds,
      });
      return id;
    },

    updateServer: (id, data) => {
      set(s => ({
        servers: s.servers.map(srv => srv.id === id ? { ...srv, ...data } : srv),
      }));
    },

    removeServer: (id) => {
      // queueServerId is the canonical index key (B1); resolve the
      // canonical id back to a server UUID before comparing so a profile
      // delete still clears the matching queue binding.
      const queueSid = getQueueServerId();
      if (queueSid && resolveServerIdForIndexKey(queueSid) === id) {
        clearQueueServerForPlayback();
      }
      set(s => {
        const newServers = s.servers.filter(srv => srv.id !== id);
        const switchedAway = s.activeServerId === id;
        const { [id]: _r, ...entityRatingRest } = s.entityRatingSupportByServer;
        const { [id]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
        const { [id]: _idn, ...identityRest } = s.subsonicServerIdentityByServer;
        const { [id]: _iss, ...issueRest } = s.audiomuseNavidromeIssueByServer;
        const { [id]: _pr, ...probeRest } = s.instantMixProbeByServer;
        const { [id]: _ppl, ...pluginProbeRest } = s.audiomusePluginProbeByServer;
        const { [id]: _ex, ...extRest } = s.openSubsonicExtensionsByServer;
        const { [id]: _folders, ...foldersRest } = s.musicFoldersByServer;
        const { [id]: _browseSelection, ...browseSelectionRest } = s.libraryBrowseSelectionByServer;
        const activeServerId = switchedAway ? (newServers[0]?.id ?? null) : s.activeServerId;
        return {
          servers: newServers,
          activeServerId,
          isLoggedIn: switchedAway ? false : s.isLoggedIn,
          libraryBrowseServerIds: deriveLibraryBrowseServerIdsWithFallback({
            servers: newServers,
            activeServerId,
            libraryBrowseServerIds: s.libraryBrowseServerIds.filter(serverId => serverId !== id),
          }),
          musicFolders: switchedAway && activeServerId
            ? (foldersRest[activeServerId] ?? [])
            : s.musicFolders,
          musicFoldersByServer: foldersRest,
          libraryBrowseSelectionByServer: browseSelectionRest,
          libraryBrowseScopeVersion: s.libraryBrowseScopeVersion + 1,
          entityRatingSupportByServer: entityRatingRest,
          audiomuseNavidromeByServer: audiomuseRest,
          subsonicServerIdentityByServer: identityRest,
          audiomuseNavidromeIssueByServer: issueRest,
          instantMixProbeByServer: probeRest,
          audiomusePluginProbeByServer: pluginProbeRest,
          openSubsonicExtensionsByServer: extRest,
        };
      });
    },

    setServers: (servers) => {
      const before = get();
      set(s => ({
        servers,
        libraryBrowseServerIds: deriveLibraryBrowseServerIdsWithFallback({
          servers,
          activeServerId: s.activeServerId,
          libraryBrowseServerIds: s.libraryBrowseServerIds,
        }),
        libraryBrowseScopeVersion: s.libraryBrowseScopeVersion + 1,
      }));
      const after = get();
      emitMultiServerDebug('server_profiles_set', {
        previousServers: summarizeMultiServerProfiles(before.servers),
        servers: summarizeMultiServerProfiles(after.servers),
        activeServerId: after.activeServerId,
        previousConfiguredServerIds: before.libraryBrowseServerIds,
        configuredServerIds: after.libraryBrowseServerIds,
        libraryBrowseScopeVersion: after.libraryBrowseScopeVersion,
      });
    },
    setActiveServer: (id) => {
      const before = get();
      set(s => ({
        activeServerId: id,
        musicFolders: s.musicFoldersByServer[id] ?? [],
      }));
      const after = get();
      emitMultiServerDebug('active_server_set', {
        previousActiveServerId: before.activeServerId,
        activeServerId: after.activeServerId,
        configuredServerIds: after.libraryBrowseServerIds,
        activeFolders: after.musicFolders.map(folder => ({ id: folder.id, name: folder.name })),
      });
    },
    setLoggedIn: (v) => set({ isLoggedIn: v }),
    setConnecting: (v) => set({ isConnecting: v }),
    setConnectionError: (e) => set({ connectionError: e }),
    logout: () => set({ isLoggedIn: false, musicFolders: [] }),
  };
}
