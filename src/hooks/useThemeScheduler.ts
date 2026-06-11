import { useEffect, useState } from 'react';
import { useThemeStore, getScheduledTheme } from '../store/themeStore';

/**
 * Effective theme id for `data-theme` — scheduler-aware when enabled.
 * Derived synchronously from the store so `App.tsx` never paints a stale id
 * (the previous useState+mirror lag could leave `data-theme` on Mocha for a
 * commit cycle in production React).
 */
export function useThemeScheduler(): string {
  const enableScheduler = useThemeStore(s => s.enableThemeScheduler);
  const theme = useThemeStore(s => s.theme);
  const themeDay = useThemeStore(s => s.themeDay);
  const themeNight = useThemeStore(s => s.themeNight);
  const timeDayStart = useThemeStore(s => s.timeDayStart);
  const timeNightStart = useThemeStore(s => s.timeNightStart);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enableScheduler) return;
    const id = setInterval(() => setTick(n => n + 1), 60_000);
    return () => clearInterval(id);
  }, [enableScheduler, themeDay, themeNight, timeDayStart, timeNightStart]);

  void tick;
  return getScheduledTheme({
    enableThemeScheduler: enableScheduler,
    theme,
    themeDay,
    themeNight,
    timeDayStart,
    timeNightStart,
  });
}
