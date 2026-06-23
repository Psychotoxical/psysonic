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

/** Trigger for the day/night theme switch. */
export type ThemeSchedulerMode = 'time' | 'system';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  enableThemeScheduler: boolean;
  setEnableThemeScheduler: (v: boolean) => void;
  /** What drives the day/night switch: a clock schedule or the OS theme. */
  schedulerMode: ThemeSchedulerMode;
  setSchedulerMode: (v: ThemeSchedulerMode) => void;
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
  /** Master toggle for external artist artwork (fanart.tv). Off by default (§20). */
  externalArtworkEnabled: boolean;
  setExternalArtworkEnabled: (v: boolean) => void;
  /** Optional personal fanart.tv API key (BYOK) — sent in addition to the app key (§22). */
  externalArtworkByok: string;
  setExternalArtworkByok: (v: string) => void;
}

export function getScheduledTheme(
  state: Pick<
    ThemeState,
    'enableThemeScheduler' | 'schedulerMode' | 'theme' | 'themeDay' | 'themeNight' | 'timeDayStart' | 'timeNightStart'
  >,
  systemPrefersDark = false,
): string {
  if (!state.enableThemeScheduler) return state.theme;
  // Follow the OS theme: dark → night theme, light → day theme.
  if (state.schedulerMode === 'system') return systemPrefersDark ? state.themeNight : state.themeDay;
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
      schedulerMode: 'time',
      setSchedulerMode: (v) => set({ schedulerMode: v }),
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
      externalArtworkEnabled: false,
      setExternalArtworkEnabled: (v) => set({ externalArtworkEnabled: v }),
      externalArtworkByok: '',
      setExternalArtworkByok: (v) => set({ externalArtworkByok: v }),
    }),
    {
      name: 'psysonic_theme',
      version: 1,
      // Identity migrate: preserve persisted state from older versions as-is.
      // Theme-id repair for removed / store-only themes now happens in the
      // pre-React bootstrap migration (see utils/themes/themeMigration).
      migrate: (persistedState) => persistedState,
    }
  )
);
