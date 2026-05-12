import { getPlaylists } from '../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../api/subsonicTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPlaylist as apiCreatePlaylist } from '../api/subsonicPlaylists';
interface PlaylistStore {
  recentIds: string[];
  playlists: SubsonicPlaylist[];
  playlistsLoading: boolean;
  lastModified: Record<string, number>;
  touchPlaylist: (id: string) => void;
  removeId: (id: string) => void;
  fetchPlaylists: () => Promise<void>;
  createPlaylist: (name: string, songIds?: string[]) => Promise<SubsonicPlaylist | null>;
  addPlaylist: (playlist: SubsonicPlaylist) => void;
}

export const usePlaylistStore = create<PlaylistStore>()(
  persist(
    (set, get) => ({
      recentIds: [],
      playlists: [],
      playlistsLoading: false,
      lastModified: {},
      touchPlaylist: (id) =>
        set((s) => ({
          recentIds: [id, ...s.recentIds.filter((x) => x !== id)].slice(0, 50),
          lastModified: { ...s.lastModified, [id]: Date.now() },
        })),
      removeId: (id) =>
        set((s) => ({ recentIds: s.recentIds.filter((x) => x !== id) })),
      fetchPlaylists: async () => {
        set({ playlistsLoading: true });
        try {
          const playlists = await getPlaylists();
          set({ playlists, playlistsLoading: false });
        } catch {
          set({ playlistsLoading: false });
        }
      },
      createPlaylist: async (name: string, songIds?: string[]) => {
        try {
          const playlist = await apiCreatePlaylist(name, songIds);
          set((s) => ({
            playlists: [...s.playlists, playlist],
            recentIds: [playlist.id, ...s.recentIds.filter((x) => x !== playlist.id)].slice(0, 50),
          }));
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
    { name: 'psysonic_playlists_recent' }
  )
);
