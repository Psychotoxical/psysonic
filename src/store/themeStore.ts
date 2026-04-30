import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'mocha' | 'macchiato' | 'frappe' | 'latte' | 'nord' | 'nord-snowstorm' | 'nord-frost' | 'nord-aurora' | 'psychowave' | 'wnamp' | 'poison' | 'nucleo' | 'muma-jukebox' | 'winmedplayer' | 'p-dvd' | 'vintage-tube-radio' | 'neon-drift' | 'aero-glass' | 'luna-teal' | 'w98' | 'cupertino-light' | 'cupertino-dark' | 'gruvbox-dark-hard' | 'gruvbox-dark-medium' | 'gruvbox-dark-soft' | 'gruvbox-light-hard' | 'gruvbox-light-medium' | 'gruvbox-light-soft' | 'spotless' | 'dzr0' | 'cupertino-beats' | 'lambda-17' | 'gw1' | 'grand-theft-audio' | 'v-tactical' | 'nightcity-2077' | 'middle-earth' | 'morpheus' | 'stark-hud' | 'blade' | 'heisenberg' | 'ice-and-fire' | 'doh-matic' | 't-800' | 'dune' | 'tetrastack' | 'the-book' | 'readit' | 'insta' | 'hill-valley-85' | 'turtle-power' | 'w3-1' | 'aqua-quartz' | 'spider-tech' | 'dos' | 'unix' | 'jayfin' | 'horde' | 'alliance' | 'w11' | 'w10' | 'north-park' | 'dark-side-of-the-moon' | 'powerslave' | 'nightfox' | 'dayfox' | 'dawnfox' | 'duskfox' | 'nordfox' | 'terafox' | 'carbonfox' | 'dracula' | 'kanagawa-wave' | 'kanagawa-dragon' | 'kanagawa-lotus' | 'one-dark' | 'one-light' | 'vs-1984' | 'vs-1984-cyberpunk' | 'vs-1984-light' | 'vs-1984-orwell' | 'vision-dark' | 'vision-navy';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  enableThemeScheduler: boolean;
  setEnableThemeScheduler: (v: boolean) => void;
  themeDay: string;
  setThemeDay: (v: string) => void;
  themeNight: string;
  setThemeNight: (v: string) => void;
  timeDayStart: string;
  setTimeDayStart: (v: string) => void;
  timeNightStart: string;
  setTimeNightStart: (v: string) => void;
  enableCoverArtBackground: boolean;
  setEnableCoverArtBackground: (v: boolean) => void;
  enablePlaylistCoverPhoto: boolean;
  setEnablePlaylistCoverPhoto: (v: boolean) => void;
  showBitrate: boolean;
  setShowBitrate: (v: boolean) => void;
  showRemainingTime: boolean;
  setShowRemainingTime: (v: boolean) => void;
  expandReplayGain: boolean;
  setExpandReplayGain: (v: boolean) => void;
  floatingPlayerBar: boolean;
  setFloatingPlayerBar: (v: boolean) => void;
}

export function getScheduledTheme(state: Pick<ThemeState, 'enableThemeScheduler' | 'theme' | 'themeDay' | 'themeNight' | 'timeDayStart' | 'timeNightStart'>): string {
  if (!state.enableThemeScheduler) return state.theme;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [dh, dm] = state.timeDayStart.split(':').map(Number);
  const [nh, nm] = state.timeNightStart.split(':').map(Number);
  const dayMins = dh * 60 + dm;
  const nightMins = nh * 60 + nm;
  const isDay = dayMins < nightMins
    ? nowMins >= dayMins && nowMins < nightMins
    : nowMins >= dayMins || nowMins < nightMins;
  return isDay ? state.themeDay : state.themeNight;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'mocha',
      setTheme: (theme) => set({ theme }),
      enableThemeScheduler: false,
      setEnableThemeScheduler: (v) => set({ enableThemeScheduler: v }),
      themeDay: 'latte',
      setThemeDay: (v) => set({ themeDay: v }),
      themeNight: 'mocha',
      setThemeNight: (v) => set({ themeNight: v }),
      timeDayStart: '07:00',
      setTimeDayStart: (v) => set({ timeDayStart: v }),
      timeNightStart: '19:00',
      setTimeNightStart: (v) => set({ timeNightStart: v }),
      enableCoverArtBackground: true,
      setEnableCoverArtBackground: (v) => set({ enableCoverArtBackground: v }),
      enablePlaylistCoverPhoto: true,
      setEnablePlaylistCoverPhoto: (v) => set({ enablePlaylistCoverPhoto: v }),
      showBitrate: true,
      setShowBitrate: (v) => set({ showBitrate: v }),
      showRemainingTime: false,
      setShowRemainingTime: (v) => set({ showRemainingTime: v }),
      expandReplayGain: false,
      setExpandReplayGain: (v) => set({ expandReplayGain: v }),
      floatingPlayerBar: false,
      setFloatingPlayerBar: (v) => set({ floatingPlayerBar: v }),
    }),
    {
      name: 'psysonic_theme',
    }
  )
);
