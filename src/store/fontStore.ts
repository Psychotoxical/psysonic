import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type FontId = 'inter' | 'outfit' | 'dm-sans' | 'nunito' | 'rubik' | 'space-grotesk' | 'figtree' | 'manrope' | 'plus-jakarta-sans' | 'lexend' | 'geist' | 'jetbrains-mono' | 'golos-text' | 'unbounded' | 'opendyslexic';

interface FontState {
  font: FontId;
  setFont: (font: FontId) => void;
  uiScale: number;
  setUiScale: (scale: number) => void;
}

export const useFontStore = create<FontState>()(
  persist(
    (set) => ({
      font: 'lexend',
      setFont: (font) => set({ font }),
      uiScale: 1.0,
      setUiScale: (uiScale) => set({ uiScale }),
    }),
    { name: 'psysonic_font' }
  )
);
