import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { formatClockTime } from '@/lib/format/formatClockTime';

/**
 * Standalone wall-clock for the fullscreen player. Owns its own state so the
 * static player never re-renders for the time. Ticks every 30s (enough to catch
 * the minute rollover) and pauses while the window/tab is hidden.
 */
export const FsClock = memo(function FsClock() {
  const clockFormat = useAuthStore(s => s.clockFormat);
  const { i18n } = useTranslation();

  const formatNow = () => formatClockTime(Date.now(), clockFormat, i18n.language);
  const [time, setTime] = useState(formatNow);

  useEffect(() => {
    setTime(formatClockTime(Date.now(), clockFormat, i18n.language));
  }, [clockFormat, i18n.language]);

  useEffect(() => {
    let id: number | undefined;
    const tick = () => setTime(formatClockTime(Date.now(), clockFormat, i18n.language));
    const sync = () => {
      if (document.hidden) {
        if (id !== undefined) { clearInterval(id); id = undefined; }
      } else {
        tick();
        if (id === undefined) id = window.setInterval(tick, 30_000);
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      if (id !== undefined) clearInterval(id);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [clockFormat, i18n.language]);

  return <span className="fsp-clock">{time}</span>;
});
