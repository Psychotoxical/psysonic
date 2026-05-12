import type { ServerProfile } from './authStoreTypes';
import { create } from 'zustand';
let _resolve: ((server: ServerProfile | null) => void) | null = null;

interface OrbitAccountPickerStore {
  isOpen: boolean;
  accounts: ServerProfile[];
  /** Open the picker with the given candidates. Resolves with the chosen
   *  server or null if the user cancels. */
  request: (accounts: ServerProfile[]) => Promise<ServerProfile | null>;
  pick: (server: ServerProfile) => void;
  cancel: () => void;
}

export const useOrbitAccountPickerStore = create<OrbitAccountPickerStore>(set => ({
  isOpen: false,
  accounts: [],

  request: (accounts) =>
    new Promise<ServerProfile | null>(resolve => {
      // If another picker is already pending, treat the previous one as cancelled.
      if (_resolve) _resolve(null);
      _resolve = resolve;
      set({ isOpen: true, accounts });
    }),

  pick: (server) => {
    _resolve?.(server);
    _resolve = null;
    set({ isOpen: false });
  },

  cancel: () => {
    _resolve?.(null);
    _resolve = null;
    set({ isOpen: false });
  },
}));
