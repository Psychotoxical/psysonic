import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'mocha' | 'macchiato' | 'frappe' | 'latte' | 'nord' | 'nord-snowstorm' | 'nord-frost' | 'nord-aurora';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'mocha',
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'psysonic_theme',
    }
  )
);
