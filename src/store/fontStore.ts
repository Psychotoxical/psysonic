import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type FontId = 'inter' | 'outfit' | 'dm-sans' | 'nunito' | 'rubik' | 'space-grotesk' | 'figtree' | 'manrope' | 'plus-jakarta-sans' | 'lexend';

interface FontState {
  font: FontId;
  setFont: (font: FontId) => void;
}

export const useFontStore = create<FontState>()(
  persist(
    (set) => ({
      font: 'inter',
      setFont: (font) => set({ font }),
    }),
    { name: 'psysonic_font' }
  )
);
