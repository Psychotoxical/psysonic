import { create } from 'zustand';

// Module-level callback — not in Zustand state to avoid serialization issues
let _resolve: ((folder: string | null) => void) | null = null;

interface DownloadModalStore {
  isOpen: boolean;
  folder: string;
  remember: boolean;
  requestFolder: () => Promise<string | null>;
  setFolder: (f: string) => void;
  setRemember: (r: boolean) => void;
  confirm: (setDownloadFolder: (v: string) => void) => void;
  cancel: () => void;
}

export const useDownloadModalStore = create<DownloadModalStore>((set, get) => ({
  isOpen: false,
  folder: '',
  remember: false,

  requestFolder: () =>
    new Promise<string | null>(resolve => {
      _resolve = resolve;
      set({ isOpen: true, folder: '', remember: false });
    }),

  setFolder: (folder) => set({ folder }),
  setRemember: (remember) => set({ remember }),

  confirm: (setDownloadFolder) => {
    const { folder, remember } = get();
    if (!folder) return;
    if (remember) setDownloadFolder(folder);
    _resolve?.(folder);
    _resolve = null;
    set({ isOpen: false });
  },

  cancel: () => {
    _resolve?.(null);
    _resolve = null;
    set({ isOpen: false });
  },
}));
