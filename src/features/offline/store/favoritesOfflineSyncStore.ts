import { create } from 'zustand';

interface FavoritesOfflineSyncState {
  running: boolean;
  lastError: string | null;
  targetTrackIds: string[];
  setRunning: (v: boolean) => void;
  setLastError: (v: string | null) => void;
  setTargetTrackIds: (ids: string[]) => void;
}

export const useFavoritesOfflineSyncStore = create<FavoritesOfflineSyncState>()((set) => ({
  running: false,
  lastError: null,
  targetTrackIds: [],
  setRunning: (v) => set({ running: v }),
  setLastError: (v) => set({ lastError: v }),
  setTargetTrackIds: (ids) => set({ targetTrackIds: ids }),
}));
