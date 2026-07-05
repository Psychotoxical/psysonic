import type { AuthState } from './authStoreTypes';
import { useLibraryIndexStore } from './libraryIndexStore';
import {
  runMusicLibraryCatalogReloadHandler,
  scheduleMusicLibraryFilterVersionBump,
} from './musicLibraryFilterNotify';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

function legacyFilterFromSelection(libraryIds: string[]): 'all' | string {
  if (libraryIds.length === 0) return 'all';
  return libraryIds[0];
}

function deferMusicLibraryCatalogReload(get: GetState, set: SetState, serverId: string): void {
  // `indexEnabled` is read here in the store layer and handed to the registered
  // catalog-reload handler so the store never imports `src/lib/library` browse
  // helpers directly (that inversion is what keeps `src/lib` at the graph floor
  // and avoids import cycles — see musicLibraryFilterNotify).
  const indexEnabled = useLibraryIndexStore.getState().isIndexEnabled(serverId);
  scheduleMusicLibraryFilterVersionBump(() => {
    set(s => ({
      musicLibraryFilterVersion: s.musicLibraryFilterVersion + 1,
    }));
    runMusicLibraryCatalogReloadHandler(serverId, indexEnabled, get().musicLibraryFilterVersion);
  });
}

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
  'setMusicFolders' | 'setMusicLibraryFilter' | 'setMusicLibrarySelection'
> {
  return {
    setMusicFolders: (folders) => {
      const sid = get().activeServerId;
      set(s => {
        const folderIds = new Set(folders.map(x => x.id));
        const updates: Partial<AuthState> = { musicFolders: folders };
        if (!sid) return updates;

        const f = s.musicLibraryFilterByServer[sid];
        const invalidFilter = f && f !== 'all' && !folderIds.has(f);
        if (invalidFilter) {
          updates.musicLibraryFilterByServer = { ...s.musicLibraryFilterByServer, [sid]: 'all' };
        }

        const selection = s.musicLibrarySelectionByServer[sid];
        if (selection && selection.length > 0) {
          const pruned = selection.filter(id => folderIds.has(id));
          if (pruned.length !== selection.length) {
            updates.musicLibrarySelectionByServer = {
              ...s.musicLibrarySelectionByServer,
              [sid]: pruned,
            };
            updates.musicLibraryFilterByServer = {
              ...(updates.musicLibraryFilterByServer ?? s.musicLibraryFilterByServer),
              [sid]: legacyFilterFromSelection(pruned),
            };
          }
        }

        return updates;
      });
    },

    setMusicLibraryFilter: (folderId) => {
      const sid = get().activeServerId;
      if (!sid) return;
      set(s => ({
        musicLibraryFilterByServer: { ...s.musicLibraryFilterByServer, [sid]: folderId },
      }));
      deferMusicLibraryCatalogReload(get, set, sid);
    },

    setMusicLibrarySelection: (libraryIds) => {
      const sid = get().activeServerId;
      if (!sid) return;
      set(s => ({
        musicLibrarySelectionByServer: {
          ...s.musicLibrarySelectionByServer,
          [sid]: libraryIds,
        },
        musicLibraryFilterByServer: {
          ...s.musicLibraryFilterByServer,
          [sid]: legacyFilterFromSelection(libraryIds),
        },
      }));
      deferMusicLibraryCatalogReload(get, set, sid);
    },
  };
}
