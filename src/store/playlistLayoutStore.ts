import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PlaylistLayoutConfig {
  showAddSongs: boolean;
  showImportCsv: boolean;
  showDownloadZip: boolean;
  showOfflineCache: boolean;
  showSuggestions: boolean;
}

const DEFAULT_CONFIG: PlaylistLayoutConfig = {
  showAddSongs: true,
  showImportCsv: true,
  showDownloadZip: true,
  showOfflineCache: true,
  showSuggestions: true,
};

interface PlaylistLayoutStore {
  config: PlaylistLayoutConfig;
  updateConfig: (updater: (prev: PlaylistLayoutConfig) => PlaylistLayoutConfig) => void;
  reset: () => void;
}

export const usePlaylistLayoutStore = create<PlaylistLayoutStore>()(
  persist(
    (set) => ({
      config: DEFAULT_CONFIG,
      updateConfig: (updater) => set((state) => ({ config: updater(state.config) })),
      reset: () => set({ config: DEFAULT_CONFIG }),
    }),
    { name: 'psysonic_playlist_layout' }
  )
);
