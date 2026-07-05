import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nextFolderOrder, type PlaylistFolder } from '@/features/playlist/utils/playlistFolders';

/** Folder state for a single server (playlist ids are server-scoped). */
export interface ServerPlaylistFolders {
  folders: PlaylistFolder[];
  /** playlistId → folderId */
  assignments: Record<string, string>;
}

interface PlaylistFolderState {
  byServer: Record<string, ServerPlaylistFolders>;
  /** Whether the Playlists page / sidebar group playlists into folders. */
  groupView: boolean;
  toggleGroupView: () => void;
  createFolder: (serverId: string, name: string) => string;
  renameFolder: (serverId: string, folderId: string, name: string) => void;
  /** Removes the folder; its playlists fall back to ungrouped. */
  deleteFolder: (serverId: string, folderId: string) => void;
  /** Assign a playlist to a folder, or pass `null` to move it back to ungrouped. */
  setPlaylistFolder: (serverId: string, playlistId: string, folderId: string | null) => void;
  toggleFolderCollapsed: (serverId: string, folderId: string) => void;
}

const EMPTY_SERVER: ServerPlaylistFolders = { folders: [], assignments: {} };

function mutateServer(
  byServer: Record<string, ServerPlaylistFolders>,
  serverId: string,
  fn: (s: ServerPlaylistFolders) => ServerPlaylistFolders,
): Record<string, ServerPlaylistFolders> {
  return { ...byServer, [serverId]: fn(byServer[serverId] ?? EMPTY_SERVER) };
}

export const usePlaylistFolderStore = create<PlaylistFolderState>()(
  persist(
    set => ({
      byServer: {},
      groupView: true,

      toggleGroupView: () => set(state => ({ groupView: !state.groupView })),

      createFolder: (serverId, name) => {
        const id = crypto.randomUUID();
        set(state => ({
          byServer: mutateServer(state.byServer, serverId, s => ({
            ...s,
            folders: [
              ...s.folders,
              { id, name: name.trim(), order: nextFolderOrder(s.folders), collapsed: false },
            ],
          })),
        }));
        return id;
      },

      renameFolder: (serverId, folderId, name) =>
        set(state => ({
          byServer: mutateServer(state.byServer, serverId, s => ({
            ...s,
            folders: s.folders.map(f => (f.id === folderId ? { ...f, name: name.trim() } : f)),
          })),
        })),

      deleteFolder: (serverId, folderId) =>
        set(state => ({
          byServer: mutateServer(state.byServer, serverId, s => ({
            folders: s.folders.filter(f => f.id !== folderId),
            assignments: Object.fromEntries(
              Object.entries(s.assignments).filter(([, fid]) => fid !== folderId),
            ),
          })),
        })),

      setPlaylistFolder: (serverId, playlistId, folderId) =>
        set(state => ({
          byServer: mutateServer(state.byServer, serverId, s => {
            const assignments = { ...s.assignments };
            if (folderId == null) delete assignments[playlistId];
            else assignments[playlistId] = folderId;
            return { ...s, assignments };
          }),
        })),

      toggleFolderCollapsed: (serverId, folderId) =>
        set(state => ({
          byServer: mutateServer(state.byServer, serverId, s => ({
            ...s,
            folders: s.folders.map(f =>
              f.id === folderId ? { ...f, collapsed: !f.collapsed } : f,
            ),
          })),
        })),
    }),
    { name: 'psysonic_playlist_folders' },
  ),
);

/** Stable empty fallback so selectors don't churn refs for serverless states. */
export const EMPTY_SERVER_FOLDERS: ServerPlaylistFolders = EMPTY_SERVER;
