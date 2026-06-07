import { create } from 'zustand';

/** DEV-only: simulate full offline (no server probes, no Subsonic, local playback only). */
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

/** True when DEV mode forces disconnected server + offline player behavior. */
export function isDevOfflineBrowseForced(): boolean {
  return import.meta.env.DEV && useDevOfflineBrowseStore.getState().forceOffline;
}
