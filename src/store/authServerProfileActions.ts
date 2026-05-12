import type { AuthState } from './authStoreTypes';
import { generateId } from './authStoreHelpers';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

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
      set(s => ({ servers: [...s.servers, { ...profile, id }] }));
      return id;
    },

    updateServer: (id, data) => {
      set(s => ({
        servers: s.servers.map(srv => srv.id === id ? { ...srv, ...data } : srv),
      }));
    },

    removeServer: (id) => {
      set(s => {
        const newServers = s.servers.filter(srv => srv.id !== id);
        const switchedAway = s.activeServerId === id;
        const { [id]: _r, ...entityRatingRest } = s.entityRatingSupportByServer;
        const { [id]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
        const { [id]: _idn, ...identityRest } = s.subsonicServerIdentityByServer;
        const { [id]: _iss, ...issueRest } = s.audiomuseNavidromeIssueByServer;
        const { [id]: _pr, ...probeRest } = s.instantMixProbeByServer;
        return {
          servers: newServers,
          activeServerId: switchedAway ? (newServers[0]?.id ?? null) : s.activeServerId,
          isLoggedIn: switchedAway ? false : s.isLoggedIn,
          entityRatingSupportByServer: entityRatingRest,
          audiomuseNavidromeByServer: audiomuseRest,
          subsonicServerIdentityByServer: identityRest,
          audiomuseNavidromeIssueByServer: issueRest,
          instantMixProbeByServer: probeRest,
        };
      });
    },

    setServers: (servers) => set({ servers }),
    setActiveServer: (id) => set({ activeServerId: id, musicFolders: [] }),
    setLoggedIn: (v) => set({ isLoggedIn: v }),
    setConnecting: (v) => set({ isConnecting: v }),
    setConnectionError: (e) => set({ connectionError: e }),
    logout: () => set({ isLoggedIn: false, musicFolders: [] }),
  };
}
