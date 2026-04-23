import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerStore } from '../store/playerStore';
import { useWindowVisibility } from '../hooks/useWindowVisibility';

/** Remaining time until wall-clock `deadlineMs` (m:ss or h:mm:ss). */
export function formatPlaybackScheduleRemaining(deadlineMs: number | null, nowMs: number): string {
  if (deadlineMs == null) return '';
  const sec = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}:${rm.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface PlaybackScheduleInfo {
  /** Formatted countdown, e.g. "4:32". */
  remaining: string;
  /** Which timer is running: `pause` = sleep-timer, `start` = delayed-start. */
  mode: 'pause' | 'start';
}

/**
 * Hook: returns the active playback-schedule countdown + its mode, or null
 * when no timer is armed. Ticks every 500 ms so the caller never needs to
 * set up its own interval. Used by the play/pause button to swap the
 * Play/Pause icon for a mode-icon + countdown text while a timer runs.
 */
export function usePlaybackScheduleRemaining(): PlaybackScheduleInfo | null {
  const { isPlaying, scheduledPauseAtMs, scheduledResumeAtMs } = usePlayerStore(
    useShallow(s => ({
      isPlaying: s.isPlaying,
      scheduledPauseAtMs: s.scheduledPauseAtMs,
      scheduledResumeAtMs: s.scheduledResumeAtMs,
    })),
  );
  const mode: 'pause' | 'start' | null =
    isPlaying && scheduledPauseAtMs != null ? 'pause'
    : !isPlaying && scheduledResumeAtMs != null ? 'start'
    : null;
  const deadlineMs = mode === 'pause' ? scheduledPauseAtMs : mode === 'start' ? scheduledResumeAtMs : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const windowHidden = useWindowVisibility();
  useEffect(() => {
    if (deadlineMs == null || windowHidden) return;
    const id = window.setInterval(() => {
      if (document.hidden || (window as any).__psyHidden) return;
      setNowMs(Date.now());
    }, 500);
    return () => window.clearInterval(id);
  }, [deadlineMs, windowHidden]);
  if (mode == null || deadlineMs == null) return null;
  return { remaining: formatPlaybackScheduleRemaining(deadlineMs, nowMs), mode };
}
