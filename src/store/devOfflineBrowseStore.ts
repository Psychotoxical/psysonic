import { create } from 'zustand';

/** DEV-only: force offline library browse without disconnecting the server. */
interface DevOfflineBrowseState {
  forceOffline: boolean;
  setForceOffline: (v: boolean) => void;
  toggleForceOffline: () => void;
}

export const useDevOfflineBrowseStore = create<DevOfflineBrowseState>()((set, get) => ({
  forceOffline: false,
  setForceOffline: (v) => set({ forceOffline: v }),
  toggleForceOffline: () => set({ forceOffline: !get().forceOffline }),
}));
