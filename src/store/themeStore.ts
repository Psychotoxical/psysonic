import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Themes that ship bundled with the app and can never be uninstalled. */
export type BuiltinTheme =
  | 'mocha'
  | 'latte'
  | 'kanagawa-wave'
  | 'stark-hud'
  | 'vision-dark'
  | 'vision-navy';

/**
 * A theme id. Built-in ids get autocomplete; installed community themes apply
 * any string id (the `& {}` keeps the literal hints without collapsing to a
 * bare `string`). Non-core palettes now live in the community Theme Store and
 * are applied by their string id once installed.
 */
export type Theme = BuiltinTheme | (string & {});

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

/** Themes removed in PR #490 (community theme redesign). Each key maps to the
 *  closest surviving palette so persisted state from older builds doesn't land
 *  on a non-existent `data-theme` attribute and silently fall back to :root. */
const REMOVED_THEME_REMAP: Record<string, string> = {
  'amber-night':    'obsidian-gold',   // warm gold/amber dark family
  'ice-blue':       'carbon-grey',     // cool neutral dark (no surviving cyan)
  'monochrome':     'carbon-grey',     // neutral grey dark
  'phosphor-green': 'deep-forest',     // green dark family
  'rose-dark':      'sakura-night',    // pink/rose dark family
};

function remapTheme(value: unknown): unknown {
  return typeof value === 'string' && value in REMOVED_THEME_REMAP
    ? REMOVED_THEME_REMAP[value]
    : value;
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
      version: 1,
      migrate: (persistedState, _version) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState;
        const s = persistedState as Record<string, unknown>;
        return {
          ...s,
          theme:      remapTheme(s.theme),
          themeDay:   remapTheme(s.themeDay),
          themeNight: remapTheme(s.themeNight),
        };
      },
    }
  )
);
