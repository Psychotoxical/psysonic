import { memo, useEffect, useState } from 'react';

function formatClock(): string {
  return new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Standalone wall-clock for the fullscreen player. Owns its own state so the
 * static player never re-renders for the time. Ticks every 30s (enough to catch
 * the minute rollover) and pauses while the window/tab is hidden.
 */
export const FsClock = memo(function FsClock() {
  const [time, setTime] = useState(formatClock);

  useEffect(() => {
    let id: number | undefined;
    const tick = () => setTime(formatClock());
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
  }, []);

  return <span className="fsp-clock">{time}</span>;
});
