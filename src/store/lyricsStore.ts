import { create } from 'zustand';

type SidebarTab = 'queue' | 'lyrics' | 'info';

interface LyricsState {
  activeTab: SidebarTab;
  setTab: (tab: SidebarTab) => void;
  showLyrics: () => void;
  showQueue: () => void;
  showInfo: () => void;
}

export const useLyricsStore = create<LyricsState>()((set) => ({
  activeTab: 'queue',
  setTab: (tab) => set({ activeTab: tab }),
  showLyrics: () => set({ activeTab: 'lyrics' }),
  showQueue: () => set({ activeTab: 'queue' }),
  showInfo: () => set({ activeTab: 'info' }),
}));
