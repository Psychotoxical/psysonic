import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Last.fm account settings on the auth side: credentials, session
 * connect/disconnect, error flag, and the master scrobbling toggle.
 * The actual scrobble/love network calls live in `lastfmActions.ts`
 * inside the playerStore — these here only manage the persisted
 * account state.
 */
export function createAuthLastfmActions(set: SetState): Pick<
  AuthState,
  | 'setLastfm'
  | 'connectLastfm'
  | 'disconnectLastfm'
  | 'setLastfmSessionError'
  | 'setScrobblingEnabled'
> {
  return {
    setLastfm: (apiKey, apiSecret, sessionKey, username) =>
      set({ lastfmApiKey: apiKey, lastfmApiSecret: apiSecret, lastfmSessionKey: sessionKey, lastfmUsername: username }),

    connectLastfm: (sessionKey, username) =>
      set({ lastfmSessionKey: sessionKey, lastfmUsername: username }),

    disconnectLastfm: () =>
      set({ lastfmSessionKey: '', lastfmUsername: '', lastfmSessionError: false }),

    setLastfmSessionError: (v) => set({ lastfmSessionError: v }),
    setScrobblingEnabled: (v) => set({ scrobblingEnabled: v }),
  };
}
