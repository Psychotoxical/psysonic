import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'mocha' | 'macchiato' | 'frappe' | 'latte' | 'nord' | 'nord-snowstorm' | 'nord-frost' | 'nord-aurora' | 'psychowave' | 'wnamp' | 'poison' | 'nucleo' | 'navy-jukebox' | 'cobalt-media' | 'onyx-cinema' | 'vintage-tube-radio' | 'neon-drift' | 'aero-glass' | 'luna-teal' | 'w98' | 'cupertino-light' | 'cupertino-dark' | 'gruvbox-dark-hard' | 'gruvbox-dark-medium' | 'gruvbox-dark-soft' | 'gruvbox-light-hard' | 'gruvbox-light-medium' | 'gruvbox-light-soft' | 'spotless' | 'dzr0' | 'cupertino-beats' | 'lambda-17' | 'azerothian-gold' | 'ascalon' | 'grand-theft-audio' | 'v-tactical' | 'nightcity-2077' | 'middle-earth' | 'morpheus' | 'pandora' | 'stark-hud' | 'blade' | 'imperial-sith' | 'order-of-the-phoenix' | 'heisenberg' | 'ice-and-fire' | 'doh-matic';

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
