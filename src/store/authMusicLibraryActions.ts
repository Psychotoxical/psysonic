import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

/**
 * Per-server music-folder selection. `setMusicFolders` is called
 * after login / server change with the fresh Subsonic folder list;
 * if the currently-persisted filter for that server points at a
 * folder that no longer exists on the server, it falls back to
 * `'all'` so the page doesn't end up filtering by a stale id.
 *
 * `setMusicLibraryFilter` writes the new filter and bumps
 * `musicLibraryFilterVersion` so subscribed pages refetch their
 * catalog data.
 */
export function createMusicLibraryActions(set: SetState, get: GetState): Pick<
  AuthState,
  'setMusicFolders' | 'setMusicLibraryFilter'
> {
  return {
    setMusicFolders: (folders) => {
      const sid = get().activeServerId;
      set(s => {
        const f = sid ? s.musicLibraryFilterByServer[sid] : undefined;
        const invalidFilter = f && f !== 'all' && !folders.some(x => x.id === f);
        return {
          musicFolders: folders,
          ...(sid && invalidFilter
            ? { musicLibraryFilterByServer: { ...s.musicLibraryFilterByServer, [sid]: 'all' } }
            : {}),
        };
      });
    },

    setMusicLibraryFilter: (folderId) => {
      const sid = get().activeServerId;
      if (!sid) return;
      set(s => ({
        musicLibraryFilterByServer: { ...s.musicLibraryFilterByServer, [sid]: folderId },
        musicLibraryFilterVersion: s.musicLibraryFilterVersion + 1,
      }));
    },
  };
}
