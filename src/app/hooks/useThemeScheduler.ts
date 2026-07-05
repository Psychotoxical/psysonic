import { useEffect, useState } from 'react';
import { useThemeStore, getScheduledTheme } from '@/store/themeStore';
import { useSystemPrefersDark } from '@/lib/hooks/useSystemPrefersDark';

/**
 * Effective theme id for `data-theme` — scheduler-aware when enabled.
 * Derived synchronously from the store so `App.tsx` never paints a stale id
 * (the previous useState+mirror lag could leave `data-theme` on Mocha for a
 * commit cycle in production React).
 *
 * Two trigger modes: a clock schedule (re-evaluated each minute) or the OS
 * theme (re-evaluated whenever the system flips light/dark via
 * `useSystemPrefersDark`).
 */
export function useThemeScheduler(): string {
  const enableScheduler = useThemeStore(s => s.enableThemeScheduler);
  const schedulerMode = useThemeStore(s => s.schedulerMode);
  const theme = useThemeStore(s => s.theme);
  const themeDay = useThemeStore(s => s.themeDay);
  const themeNight = useThemeStore(s => s.themeNight);
  const timeDayStart = useThemeStore(s => s.timeDayStart);
  const timeNightStart = useThemeStore(s => s.timeNightStart);
  const systemPrefersDark = useSystemPrefersDark();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Only the clock mode needs polling; the system mode is event-driven.
    if (!enableScheduler || schedulerMode !== 'time') return;
    const id = setInterval(() => setTick(n => n + 1), 60_000);
    return () => clearInterval(id);
  }, [enableScheduler, schedulerMode, themeDay, themeNight, timeDayStart, timeNightStart]);

  void tick;
  return getScheduledTheme(
    {
      enableThemeScheduler: enableScheduler,
      schedulerMode,
      theme,
      themeDay,
      themeNight,
      timeDayStart,
      timeNightStart,
    },
    systemPrefersDark,
  );
}
