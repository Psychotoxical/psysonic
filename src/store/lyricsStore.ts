import { create } from 'zustand';

type SidebarTab = 'queue' | 'lyrics';

interface LyricsState {
  activeTab: SidebarTab;
  setTab: (tab: SidebarTab) => void;
  showLyrics: () => void;
  showQueue: () => void;
}

export const useLyricsStore = create<LyricsState>()((set) => ({
  activeTab: 'queue',
  setTab: (tab) => set({ activeTab: tab }),
  showLyrics: () => set({ activeTab: 'lyrics' }),
  showQueue: () => set({ activeTab: 'queue' }),
}));
