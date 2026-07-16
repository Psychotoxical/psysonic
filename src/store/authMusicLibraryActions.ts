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

/**
 * Selecting every library one-by-one is the same as "All libraries": normalize
 * such a selection to the empty/all scope so the picker shows the All-libraries
 * option and future libraries are included automatically. `musicFolders` is the
 * active server's folder list, so this only applies once it has loaded.
 */
function collapseFullSelection(state: AuthState, serverId: string, libraryIds: string[]): string[] {
  if (libraryIds.length === 0) return libraryIds;
  const folders = state.musicFoldersByServer[serverId]
    ?? (serverId === state.activeServerId ? state.musicFolders : []);
  if (folders.length === 0 || libraryIds.length < folders.length) return libraryIds;
  const selected = new Set(libraryIds);
  return folders.every(folder => selected.has(folder.id)) ? [] : libraryIds;
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
  | 'setMusicLibraryServerSelected'
  | 'setMusicFoldersForServer'
  | 'setMusicLibrarySelectionForServer'
  | 'setMusicFolders'
  | 'setMusicLibraryFilter'
  | 'setMusicLibrarySelection'
> {
  return {
    setMusicLibraryServerSelected: (serverId, selected) => {
      const state = get();
      if (!state.servers.some(server => server.id === serverId)) return;
      const selectedIds = new Set(state.musicLibraryServerIds);
      if (selected) {
        selectedIds.add(serverId);
      } else {
        selectedIds.delete(serverId);
        if (selectedIds.size === 0 && state.servers.length > 0) return;
      }
      set({
        musicLibraryServerIds: state.servers
          .map(server => server.id)
          .filter(id => selectedIds.has(id)),
      });
      deferMusicLibraryCatalogReload(get, set, serverId);
    },

    setMusicFoldersForServer: (serverId, folders) => {
      const state = get();
      if (!state.servers.some(server => server.id === serverId)) return;
      const folderIds = new Set(folders.map(x => x.id));
      const updates: Partial<AuthState> = {
        musicFoldersByServer: { ...state.musicFoldersByServer, [serverId]: folders },
        ...(state.activeServerId === serverId ? { musicFolders: folders } : {}),
      };
      let scopeChanged = false;

      const f = state.musicLibraryFilterByServer[serverId];
      const invalidFilter = f && f !== 'all' && !folderIds.has(f);
      if (invalidFilter) {
        updates.musicLibraryFilterByServer = {
          ...state.musicLibraryFilterByServer,
          [serverId]: 'all',
        };
        scopeChanged = true;
      }

      const selection = state.musicLibrarySelectionByServer[serverId];
      if (selection && selection.length > 0) {
        const pruned = selection.filter(id => folderIds.has(id));
        if (pruned.length !== selection.length) {
          updates.musicLibrarySelectionByServer = {
            ...state.musicLibrarySelectionByServer,
            [serverId]: pruned,
          };
          updates.musicLibraryFilterByServer = {
            ...(updates.musicLibraryFilterByServer ?? state.musicLibraryFilterByServer),
            [serverId]: legacyFilterFromSelection(pruned),
          };
          scopeChanged = true;
        }
      }

      set(updates);
      // Pruning a no-longer-existing folder narrows the effective scope, so the
      // ~30 hooks gated on `musicLibraryFilterVersion` and the browse-catalog
      // caches must refetch/evict — same as an explicit selection change.
      if (scopeChanged) {
        deferMusicLibraryCatalogReload(get, set, serverId);
      }
    },

    setMusicLibrarySelectionForServer: (serverId, libraryIds) => {
      const selection = collapseFullSelection(get(), serverId, libraryIds);
      set(s => ({
        musicLibrarySelectionByServer: {
          ...s.musicLibrarySelectionByServer,
          [serverId]: selection,
        },
        musicLibraryFilterByServer: {
          ...s.musicLibraryFilterByServer,
          [serverId]: legacyFilterFromSelection(selection),
        },
      }));
      deferMusicLibraryCatalogReload(get, set, serverId);
    },

    setMusicFolders: (folders) => {
      const serverId = get().activeServerId;
      if (!serverId) {
        set({ musicFolders: folders });
        return;
      }
      get().setMusicFoldersForServer(serverId, folders);
    },

    setMusicLibraryFilter: (folderId) => {
      const sid = get().activeServerId;
      if (!sid) return;
      // Selection readers prefer the ordered selection over the legacy field, so
      // a legacy-only write would be a no-op once a selection exists. Keep both
      // in sync: 'all' clears the selection (browse all), a folder id becomes a
      // single-entry ordered selection.
      get().setMusicLibrarySelectionForServer(sid, folderId === 'all' ? [] : [folderId]);
    },

    setMusicLibrarySelection: (libraryIds) => {
      const sid = get().activeServerId;
      if (!sid) return;
      get().setMusicLibrarySelectionForServer(sid, libraryIds);
    },
  };
}
