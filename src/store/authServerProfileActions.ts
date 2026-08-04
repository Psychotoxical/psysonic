import type { AuthState } from './authStoreTypes';
import { generateId } from './authStoreHelpers';
import {
  clearQueueServerForPlayback,
  getQueueServerId,
  invalidatePlaybackPreloads,
} from './playbackEngineBridge';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { serverProfileBaseUrl } from '@/lib/server/serverBaseUrl';
import { deriveLibraryBrowseServerIdsWithFallback } from '@/lib/library/libraryBrowseScope';
import {
  emitMultiServerDebug,
  summarizeMultiServerProfiles,
} from '@/lib/library/multiServerDebug';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

/** Normalized `[url, alternateUrl]` of a profile (mirrors `allNormalizedAddresses`,
 *  duplicated here because the store layer must not import the connect layer). */
function profileAddresses(srv: { url: string; alternateUrl?: string }): string[] {
  return [...new Set([srv.url, srv.alternateUrl]
    .filter((u): u is string => !!u && u.trim().length > 0)
    .map(u => serverProfileBaseUrl({ url: u })))];
}

function profileAddressSetChanged(
  before: { url: string; alternateUrl?: string },
  after: { url: string; alternateUrl?: string },
): boolean {
  const beforeAddresses = new Set(profileAddresses(before));
  const afterAddresses = new Set(profileAddresses(after));
  return beforeAddresses.size !== afterAddresses.size
    || [...beforeAddresses].some(address => !afterAddresses.has(address));
}

function serverAddressSetsChanged(
  before: Array<{ id: string; url: string; alternateUrl?: string }>,
  after: Array<{ id: string; url: string; alternateUrl?: string }>,
): boolean {
  if (before.length !== after.length) return true;
  const afterById = new Map(after.map(server => [server.id, server]));
  return before.some((server) => {
    const next = afterById.get(server.id);
    return !next || profileAddressSetChanged(server, next);
  });
}

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
      let addressesChanged = false;
      set(s => {
        const prev = s.servers.find(srv => srv.id === id);
        const servers = s.servers.map(srv => srv.id === id ? { ...srv, ...data } : srv);
        const next = servers.find(srv => srv.id === id);
        addressesChanged = Boolean(prev && next && profileAddressSetChanged(prev, next));
        // Address edit invalidates that address's streaming-quality preference:
        // the new address's Navidrome identity / transport is unverified until
        // re-probed, so caps for addresses no longer on any profile are dropped.
        let streamQualityByAddress = s.streamQualityByAddress;
        let streamFormatByAddress = s.streamFormatByAddress;
        let subsonicServerIdentityByServer = s.subsonicServerIdentityByServer;
        if (addressesChanged) {
          const live = new Set(
            servers.flatMap(profileAddresses),
          );
          streamQualityByAddress = Object.fromEntries(
            Object.entries(s.streamQualityByAddress).filter(([addr]) => live.has(addr)),
          );
          streamFormatByAddress = Object.fromEntries(
            Object.entries(s.streamFormatByAddress).filter(([addr]) => live.has(addr)),
          );
          // The edited address is an unverified endpoint: drop the cached
          // server identity so Navidrome-gated features (streaming quality)
          // hide until the connection re-probe confirms what it is.
          const { [id]: _stale, ...identityRest } = s.subsonicServerIdentityByServer;
          subsonicServerIdentityByServer = identityRest;
        }
        return {
          servers,
          streamQualityByAddress,
          streamFormatByAddress,
          subsonicServerIdentityByServer,
        };
      });
      if (addressesChanged) void invalidatePlaybackPreloads().catch(() => {});
    },

    removeServer: (id) => {
      const serversBeforeRemoval = get().servers;
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
        // Drop streaming-quality prefs for addresses no other profile uses.
        const liveAddresses = new Set(newServers.flatMap(profileAddresses));
        const streamQualityByAddress = Object.fromEntries(
          Object.entries(s.streamQualityByAddress).filter(([addr]) => liveAddresses.has(addr)),
        );
        const streamFormatByAddress = Object.fromEntries(
          Object.entries(s.streamFormatByAddress).filter(([addr]) => liveAddresses.has(addr)),
        );
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
          streamQualityByAddress,
          streamFormatByAddress,
        };
      });
      if (serverAddressSetsChanged(serversBeforeRemoval, get().servers)) {
        void invalidatePlaybackPreloads().catch(() => {});
      }
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
      if (serverAddressSetsChanged(before.servers, after.servers)) {
        void invalidatePlaybackPreloads().catch(() => {});
      }
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
