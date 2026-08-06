import {
  getPlaylistsForServer,
  getPlaylistsForServersSettled,
  createPlaylist as apiCreatePlaylist,
} from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAuthStore } from '@/store/authStore';
import { isOfflineBrowseActive, fetchOfflineBrowsablePlaylists } from '@/features/offline';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { deriveEffectiveLibraryBrowseServerIds } from '@/lib/library/libraryBrowseScope';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';

interface PlaylistStore {
  recentIds: string[];
  playlists: SubsonicPlaylist[];
  playlistsLoading: boolean;
  lastModified: Record<string, number>;
  touchPlaylist: (id: string, serverId?: string) => void;
  removeId: (id: string, serverId?: string) => void;
  fetchPlaylists: () => Promise<void>;
  fetchPlaylistsForServer: (serverId: string, isCurrent?: () => boolean) => Promise<void>;
  createPlaylist: (name: string, songIds: string[] | undefined, serverId: string) => Promise<SubsonicPlaylist | null>;
  addPlaylist: (playlist: SubsonicPlaylist) => void;
}

let playlistFetchGeneration = 0;
let playlistMutationGeneration = 0;

export function invalidatePlaylistRequestsForIdentityTransition(): void {
  playlistFetchGeneration += 1;
  playlistMutationGeneration += 1;
}

interface PlaylistPersistedState {
  recentIds?: string[];
  playlists?: SubsonicPlaylist[];
  lastModified?: Record<string, number>;
}

export function migratePlaylistPersistedState(persisted: unknown): PlaylistPersistedState {
  const previous = (persisted ?? {}) as PlaylistPersistedState;
  return {
    playlists: (previous.playlists ?? []).filter(playlist => Boolean(playlist.serverId)),
    recentIds: [],
    lastModified: {},
  };
}

export const usePlaylistStore = create<PlaylistStore>()(
  persist(
    (set) => ({
      recentIds: [],
      playlists: [],
      playlistsLoading: false,
      lastModified: {},
      touchPlaylist: (id, serverId) => {
        if (!serverId) return;
        const key = ownedEntityKey({ id, serverId });
        set((s) => ({
          recentIds: [key, ...s.recentIds.filter((x) => x !== key)].slice(0, 50),
          lastModified: { ...s.lastModified, [key]: Date.now() },
        }));
      },
      removeId: (id, serverId) => {
        if (!serverId) return;
        playlistMutationGeneration += 1;
        const key = ownedEntityKey({ id, serverId });
        usePlaylistMembershipStore.getState().invalidatePlaylistSongIds(id, serverId);
        set((s) => ({ recentIds: s.recentIds.filter((x) => x !== key) }));
      },
      fetchPlaylists: async () => {
        const generation = ++playlistFetchGeneration;
        const mutationGeneration = playlistMutationGeneration;
        set({ playlistsLoading: true });
        usePlaylistMembershipStore.getState().clearAllPlaylistSongIds();
        try {
          const auth = useAuthStore.getState();
          const serverId = auth.activeServerId;
          if (isOfflineBrowseActive() && serverId) {
            const playlists = (await fetchOfflineBrowsablePlaylists(serverId))
              .map(playlist => ({ ...playlist, serverId }));
            if (playlistFetchGeneration === generation) {
              set(mutationGeneration === playlistMutationGeneration
                ? { playlists, playlistsLoading: false }
                : { playlistsLoading: false });
            }
            return;
          }
          const serverIds = deriveEffectiveLibraryBrowseServerIds(auth);
          const { playlists, failedServerIds } = await getPlaylistsForServersSettled(serverIds);
          if (playlistFetchGeneration === generation) {
            if (mutationGeneration !== playlistMutationGeneration) {
              set({ playlistsLoading: false });
            } else {
              const failed = new Set(failedServerIds);
              set(state => ({
                playlists: serverIds.flatMap(ownerServerId => failed.has(ownerServerId)
                  ? state.playlists.filter(playlist => playlist.serverId === ownerServerId)
                  : playlists.filter(playlist => playlist.serverId === ownerServerId)),
                playlistsLoading: false,
              }));
            }
          }
        } catch {
          if (playlistFetchGeneration === generation) set({ playlistsLoading: false });
        }
      },
      fetchPlaylistsForServer: async (serverId, isCurrent) => {
        const mutationGeneration = playlistMutationGeneration;
        try {
          const playlists = await getPlaylistsForServer(serverId);
          if ((isCurrent && !isCurrent()) || mutationGeneration !== playlistMutationGeneration) return;
          set((state) => ({
            playlists: [
              ...state.playlists.filter(playlist => playlist.serverId !== serverId),
              ...playlists,
            ],
          }));
        } catch {
          // Keep the existing aggregate list when an owner-specific refresh fails.
        }
      },
      createPlaylist: async (name: string, songIds: string[] | undefined, serverId: string) => {
        const generation = playlistMutationGeneration;
        try {
          const playlist = { ...await apiCreatePlaylist(name, songIds, serverId), serverId };
          if (generation !== playlistMutationGeneration) return null;
          playlistMutationGeneration += 1;
          const key = ownedEntityKey(playlist);
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
        if (!playlist.serverId) return;
        playlistMutationGeneration += 1;
        set((s) => ({
          playlists: [...s.playlists, playlist],
        }));
      },
    }),
    {
      name: 'psysonic_playlists_recent',
      version: 1,
      migrate: migratePlaylistPersistedState,
      partialize: (state) => ({
        recentIds: state.recentIds,
        playlists: state.playlists,
        lastModified: state.lastModified,
      }),
    },
  ),
);
