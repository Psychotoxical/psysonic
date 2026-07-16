import type { AuthState } from './authStoreTypes';
import { generateId } from './authStoreHelpers';
import { getQueueServerId, clearQueueServerForPlayback } from './playbackEngineBridge';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { discardPendingEntityMutationsForServer } from './entityMutationBridge';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

function withoutKey<T>(record: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _removed, ...rest } = record;
  return rest;
}

function selectedIdsInServerOrder(
  servers: AuthState['servers'],
  selectedIds: string[],
  fallbackId: string | null,
): string[] {
  const selected = new Set(selectedIds);
  const ordered = servers.map(server => server.id).filter(id => selected.has(id));
  if (ordered.length > 0 || servers.length === 0) return ordered;
  const fallback = fallbackId && servers.some(server => server.id === fallbackId)
    ? fallbackId
    : servers[0]!.id;
  return [fallback];
}

/**
 * Server profile + connection lifecycle. `removeServer` is the
 * non-trivial one: when the active server is the one being removed it
 * also drops every per-server map entry tied to that id and switches
 * the active id to the next available server (or null) so the rest of
 * the app doesn't end up reading stale state.
 */
export function createServerProfileActions(set: SetState): Pick<
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
        return {
          servers,
          musicLibraryServerIds: s.servers.length === 0 ? [id] : s.musicLibraryServerIds,
        };
      });
      return id;
    },

    updateServer: (id, data) => {
      set(s => ({
        servers: s.servers.map(srv => srv.id === id ? { ...srv, ...data } : srv),
      }));
    },

    removeServer: (id) => {
      discardPendingEntityMutationsForServer(id);
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
        const activeServerId = switchedAway ? (newServers[0]?.id ?? null) : s.activeServerId;
        return {
          servers: newServers,
          activeServerId,
          isLoggedIn: switchedAway ? false : s.isLoggedIn,
          musicFolders: switchedAway && activeServerId
            ? (s.musicFoldersByServer[activeServerId] ?? [])
            : s.musicFolders,
          musicLibraryServerIds: selectedIdsInServerOrder(
            newServers,
            s.musicLibraryServerIds.filter(serverId => serverId !== id),
            activeServerId,
          ),
          musicFoldersByServer: withoutKey(s.musicFoldersByServer, id),
          musicLibrarySelectionByServer: withoutKey(s.musicLibrarySelectionByServer, id),
          musicLibraryFilterByServer: withoutKey(s.musicLibraryFilterByServer, id),
          entityRatingSupportByServer: withoutKey(s.entityRatingSupportByServer, id),
          audiomuseNavidromeByServer: withoutKey(s.audiomuseNavidromeByServer, id),
          subsonicServerIdentityByServer: withoutKey(s.subsonicServerIdentityByServer, id),
          audiomuseNavidromeIssueByServer: withoutKey(s.audiomuseNavidromeIssueByServer, id),
          instantMixProbeByServer: withoutKey(s.instantMixProbeByServer, id),
          audiomusePluginProbeByServer: withoutKey(s.audiomusePluginProbeByServer, id),
          openSubsonicExtensionsByServer: withoutKey(s.openSubsonicExtensionsByServer, id),
        };
      });
    },

    setServers: (servers) => set(s => ({
      servers,
      musicLibraryServerIds: selectedIdsInServerOrder(
        servers,
        s.musicLibraryServerIds,
        s.activeServerId,
      ),
    })),
    setActiveServer: (id) => set(s => {
      const moveSingleServerSelection = s.musicLibraryServerIds.length === 1
        && s.musicLibraryServerIds[0] === s.activeServerId;
      return {
        activeServerId: id,
        musicFolders: s.musicFoldersByServer[id] ?? [],
        ...(moveSingleServerSelection ? { musicLibraryServerIds: [id] } : {}),
      };
    }),
    setLoggedIn: (v) => set({ isLoggedIn: v }),
    setConnecting: (v) => set({ isConnecting: v }),
    setConnectionError: (e) => set({ connectionError: e }),
    logout: () => set({ isLoggedIn: false, musicFolders: [] }),
  };
}
