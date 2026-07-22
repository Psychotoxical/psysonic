import type { AuthState, MusicFolder } from './authStoreTypes';
import { useLibraryIndexStore } from './libraryIndexStore';
import {
  runMusicLibraryCatalogReloadHandler,
  scheduleMusicLibraryFilterVersionBump,
} from './musicLibraryFilterNotify';
import { deriveLibraryBrowseServerIdsWithFallback } from '@/lib/library/libraryBrowseScope';
import { emitMultiServerDebug } from '@/lib/library/multiServerDebug';

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
function collapseFullSelection(state: AuthState, libraryIds: string[]): string[] {
  if (libraryIds.length === 0) return libraryIds;
  const folders = state.musicFolders;
  if (folders.length === 0 || libraryIds.length < folders.length) return libraryIds;
  const selected = new Set(libraryIds);
  return folders.every(folder => selected.has(folder.id)) ? [] : libraryIds;
}

function collapseServerSelection(folders: MusicFolder[], libraryIds: string[]): string[] {
  if (libraryIds.length === 0 || folders.length === 0 || libraryIds.length < folders.length) {
    return libraryIds;
  }
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
  | 'setMusicFolders'
  | 'setMusicFoldersForServer'
  | 'setLibraryBrowseServerExclusive'
  | 'setLibraryBrowseServerSelected'
  | 'setLibraryBrowseSelectionForServer'
  | 'setMusicLibraryFilter'
  | 'setMusicLibrarySelection'
> {
  return {
    setMusicFolders: (folders) => {
      const sid = get().activeServerId;
      const folderIds = new Set(folders.map(x => x.id));
      if (!sid) {
        set({ musicFolders: folders });
        return;
      }

      const s = get();
      const updates: Partial<AuthState> = {
        musicFolders: folders,
        musicFoldersByServer: { ...s.musicFoldersByServer, [sid]: folders },
      };
      let scopeChanged = false;

      const f = s.musicLibraryFilterByServer[sid];
      const invalidFilter = f && f !== 'all' && !folderIds.has(f);
      if (invalidFilter) {
        updates.musicLibraryFilterByServer = { ...s.musicLibraryFilterByServer, [sid]: 'all' };
        scopeChanged = true;
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
          scopeChanged = true;
        }
      }

      set(updates);
      // Pruning a no-longer-existing folder narrows the effective scope, so the
      // ~30 hooks gated on `musicLibraryFilterVersion` and the browse-catalog
      // caches must refetch/evict — same as an explicit selection change.
      if (scopeChanged) {
        deferMusicLibraryCatalogReload(get, set, sid);
      }
    },

    setMusicFoldersForServer: (serverId, folders) => {
      const s = get();
      if (!s.servers.some(server => server.id === serverId)) {
        emitMultiServerDebug('folders_store_update_skip', {
          serverId,
          reason: 'profile_missing',
          folderCount: folders.length,
          savedServerIds: s.servers.map(server => server.id),
        });
        return;
      }
      const previousFolders = s.musicFoldersByServer[serverId] ?? [];
      const foldersChanged = folders.length !== previousFolders.length
        || folders.some((folder, index) => {
          const previous = previousFolders[index];
          return previous?.id !== folder.id || previous.name !== folder.name;
        });
      const folderIds = new Set(folders.map(folder => folder.id));
      const previousBrowseSelection = s.libraryBrowseSelectionByServer[serverId];
      const prunedBrowseSelection = previousBrowseSelection?.filter(id => folderIds.has(id));
      const browseScopeChanged = previousBrowseSelection !== undefined
        && prunedBrowseSelection?.length !== previousBrowseSelection.length;

      set(state => ({
        musicFoldersByServer: {
          ...state.musicFoldersByServer,
          [serverId]: folders,
        },
        ...(state.activeServerId === serverId ? { musicFolders: folders } : {}),
        ...(browseScopeChanged ? {
          libraryBrowseSelectionByServer: {
            ...state.libraryBrowseSelectionByServer,
            [serverId]: prunedBrowseSelection ?? [],
          },
        } : {}),
        ...(browseScopeChanged || (foldersChanged && state.libraryBrowseServerIds.includes(serverId))
          ? { libraryBrowseScopeVersion: state.libraryBrowseScopeVersion + 1 }
          : {}),
      }));
      const next = get();
      emitMultiServerDebug('folders_store_update', {
        serverId,
        activeServerId: next.activeServerId,
        configuredServerIds: next.libraryBrowseServerIds,
        previousFolders: previousFolders.map(folder => ({ id: folder.id, name: folder.name })),
        folders: folders.map(folder => ({ id: folder.id, name: folder.name })),
        foldersChanged,
        previousBrowseSelection: previousBrowseSelection ?? [],
        browseSelection: next.libraryBrowseSelectionByServer[serverId] ?? [],
        browseScopeChanged,
        libraryBrowseScopeVersion: next.libraryBrowseScopeVersion,
      });
    },

    setLibraryBrowseServerExclusive: (serverId) => {
      const s = get();
      if (!s.servers.some(server => server.id === serverId)) {
        emitMultiServerDebug('library_scope_exclusive_skip', {
          serverId,
          reason: 'profile_missing',
          configuredServerIds: s.libraryBrowseServerIds,
        });
        return;
      }
      if (s.libraryBrowseServerIds.length === 1 && s.libraryBrowseServerIds[0] === serverId) {
        emitMultiServerDebug('library_scope_exclusive_skip', {
          serverId,
          reason: 'already_exclusive',
          configuredServerIds: s.libraryBrowseServerIds,
        });
        return;
      }
      set(state => ({
        libraryBrowseServerIds: [serverId],
        libraryBrowseScopeVersion: state.libraryBrowseScopeVersion + 1,
      }));
      emitMultiServerDebug('library_scope_exclusive_set', {
        serverId,
        previousServerIds: s.libraryBrowseServerIds,
        configuredServerIds: get().libraryBrowseServerIds,
        libraryBrowseScopeVersion: get().libraryBrowseScopeVersion,
      });
    },

    setLibraryBrowseServerSelected: (serverId, selected) => {
      const s = get();
      if (!s.servers.some(server => server.id === serverId)) {
        emitMultiServerDebug('library_scope_membership_skip', {
          serverId,
          selected,
          reason: 'profile_missing',
          configuredServerIds: s.libraryBrowseServerIds,
        });
        return;
      }
      const current = new Set(s.libraryBrowseServerIds);
      if (selected) current.add(serverId);
      else current.delete(serverId);
      if (current.size === 0 && s.servers.length > 0) {
        emitMultiServerDebug('library_scope_membership_skip', {
          serverId,
          selected,
          reason: 'cannot_remove_final_server',
          configuredServerIds: s.libraryBrowseServerIds,
        });
        return;
      }
      const next = deriveLibraryBrowseServerIdsWithFallback({
        servers: s.servers,
        activeServerId: s.activeServerId,
        libraryBrowseServerIds: [...current],
      });
      if (next.length === s.libraryBrowseServerIds.length
        && next.every((id, index) => id === s.libraryBrowseServerIds[index])) {
        emitMultiServerDebug('library_scope_membership_skip', {
          serverId,
          selected,
          reason: 'unchanged',
          configuredServerIds: s.libraryBrowseServerIds,
        });
        return;
      }
      set(state => ({
        libraryBrowseServerIds: next,
        libraryBrowseScopeVersion: state.libraryBrowseScopeVersion + 1,
      }));
      emitMultiServerDebug('library_scope_membership_set', {
        serverId,
        selected,
        previousServerIds: s.libraryBrowseServerIds,
        configuredServerIds: next,
        libraryBrowseScopeVersion: get().libraryBrowseScopeVersion,
      });
    },

    setLibraryBrowseSelectionForServer: (serverId, libraryIds) => {
      const s = get();
      if (!s.libraryBrowseServerIds.includes(serverId)) {
        emitMultiServerDebug('library_folder_selection_skip', {
          serverId,
          requestedLibraryIds: libraryIds,
          reason: 'server_not_in_scope',
          configuredServerIds: s.libraryBrowseServerIds,
        });
        return;
      }
      const folders = s.musicFoldersByServer[serverId] ?? [];
      const knownFolderIds = new Set(folders.map(folder => folder.id));
      const unique = [...new Set(libraryIds)].filter(id => folders.length === 0 || knownFolderIds.has(id));
      const selection = collapseServerSelection(folders, unique);
      const previous = s.libraryBrowseSelectionByServer[serverId] ?? [];
      if (selection.length === previous.length
        && selection.every((id, index) => id === previous[index])) {
        emitMultiServerDebug('library_folder_selection_skip', {
          serverId,
          requestedLibraryIds: libraryIds,
          normalizedLibraryIds: selection,
          reason: 'unchanged',
        });
        return;
      }
      set(state => ({
        libraryBrowseSelectionByServer: {
          ...state.libraryBrowseSelectionByServer,
          [serverId]: selection,
        },
        libraryBrowseScopeVersion: state.libraryBrowseScopeVersion + 1,
      }));
      emitMultiServerDebug('library_folder_selection_set', {
        serverId,
        requestedLibraryIds: libraryIds,
        previousLibraryIds: previous,
        normalizedLibraryIds: selection,
        availableFolderIds: folders.map(folder => folder.id),
        libraryBrowseScopeVersion: get().libraryBrowseScopeVersion,
      });
    },

    setMusicLibraryFilter: (folderId) => {
      const sid = get().activeServerId;
      if (!sid) return;
      // Selection readers prefer the ordered selection over the legacy field, so
      // a legacy-only write would be a no-op once a selection exists. Keep both
      // in sync: 'all' clears the selection (browse all), a folder id becomes a
      // single-entry ordered selection.
      const selection = folderId === 'all' ? [] : [folderId];
      set(s => ({
        musicLibrarySelectionByServer: {
          ...s.musicLibrarySelectionByServer,
          [sid]: selection,
        },
        musicLibraryFilterByServer: { ...s.musicLibraryFilterByServer, [sid]: folderId },
      }));
      deferMusicLibraryCatalogReload(get, set, sid);
    },

    setMusicLibrarySelection: (libraryIds) => {
      const sid = get().activeServerId;
      if (!sid) return;
      const selection = collapseFullSelection(get(), libraryIds);
      set(s => ({
        musicLibrarySelectionByServer: {
          ...s.musicLibrarySelectionByServer,
          [sid]: selection,
        },
        musicLibraryFilterByServer: {
          ...s.musicLibraryFilterByServer,
          [sid]: legacyFilterFromSelection(selection),
        },
      }));
      deferMusicLibraryCatalogReload(get, set, sid);
    },
  };
}
