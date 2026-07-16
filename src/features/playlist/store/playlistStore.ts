import {
  createPlaylistForServer,
  getPlaylistsForServer,
} from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAuthStore } from '@/store/authStore';
import { isOfflineBrowseActive, fetchOfflineBrowsablePlaylists } from '@/features/offline';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { isSubsonicServerReachableForUnifiedScope } from '@/lib/network/subsonicNetworkGuard';

interface PlaylistStore {
  recentIds: string[];
  playlists: SubsonicPlaylist[];
  playlistsLoading: boolean;
  lastModified: Record<string, number>;
  touchPlaylist: (id: string, serverId?: string) => void;
  removeId: (id: string, serverId?: string) => void;
  fetchPlaylists: (serverIds?: string[]) => Promise<void>;
  createPlaylist: (name: string, songIds?: string[], serverId?: string) => Promise<SubsonicPlaylist | null>;
  addPlaylist: (playlist: SubsonicPlaylist) => void;
}

export const usePlaylistStore = create<PlaylistStore>()(
  persist(
    (set) => ({
      recentIds: [],
      playlists: [],
      playlistsLoading: false,
      lastModified: {},
      touchPlaylist: (id, serverId = '') =>
        set((s) => ({
          recentIds: [`${serverId}:${id}`, ...s.recentIds.filter((x) => x !== `${serverId}:${id}`)].slice(0, 50),
          lastModified: { ...s.lastModified, [`${serverId}:${id}`]: Date.now() },
        })),
      removeId: (id, serverId = '') => {
        usePlaylistMembershipStore.getState().invalidatePlaylistSongIds(id, serverId);
        set((s) => ({ recentIds: s.recentIds.filter((x) => x !== `${serverId}:${id}`) }));
      },
      fetchPlaylists: async (requestedServerIds) => {
        set({ playlistsLoading: true });
        usePlaylistMembershipStore.getState().clearAllPlaylistSongIds();
        try {
          const serverId = useAuthStore.getState().activeServerId;
          if (isOfflineBrowseActive() && serverId) {
            const playlists = await fetchOfflineBrowsablePlaylists(serverId);
            set({ playlists, playlistsLoading: false });
            return;
          }
          const serverIds = (requestedServerIds ?? useAuthStore.getState().musicLibraryServerIds)
            .filter(isSubsonicServerReachableForUnifiedScope);
          const playlists = (await Promise.all(serverIds.map(serverId => getPlaylistsForServer(serverId))))
            .flat();
          set({ playlists, playlistsLoading: false });
        } catch {
          set({ playlistsLoading: false });
        }
      },
      createPlaylist: async (name: string, songIds?: string[], ownerServerId?: string) => {
        try {
          const serverId = ownerServerId ?? useAuthStore.getState().activeServerId;
          if (!serverId) return null;
          const playlist = await createPlaylistForServer(serverId, name, songIds);
          const key = `${serverId}:${playlist.id}`;
          set((s) => ({
            playlists: [...s.playlists, playlist],
            recentIds: [key, ...s.recentIds.filter((x) => x !== key)].slice(0, 50),
          }));
          usePlaylistMembershipStore.getState().setPlaylistSongIds(playlist.id, songIds ?? [], serverId);
          return playlist;
        } catch {
          return null;
        }
      },
      addPlaylist: (playlist) => {
        set((s) => ({
          playlists: [...s.playlists, playlist],
        }));
      },
    }),
    {
      name: 'psysonic_playlists_recent',
      partialize: (state) => ({
        recentIds: state.recentIds,
        playlists: state.playlists,
        lastModified: state.lastModified,
      }),
    },
  ),
);
