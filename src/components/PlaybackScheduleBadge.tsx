import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { formatPlaybackScheduleRemaining } from '../utils/playbackScheduleFormat';

export interface PlaybackScheduleBadgeProps {
  /** Wrap around play/pause — used to position the floating pill (viewport-fixed, avoids player-bar clip). */
  layoutAnchorRef: React.RefObject<HTMLElement | null>;
  /** Extra classes on the portaled pill (e.g. fullscreen sizing). */
  className?: string;
}

/**
 * Small pill at the top-right of play/pause (overlapping) when a timer is armed.
 * Portaled to `document.body` so it is not clipped by `contain: paint` on the player bar.
 */
export default function PlaybackScheduleBadge({ layoutAnchorRef, className }: PlaybackScheduleBadgeProps) {
  const { t } = useTranslation();
  const { isPlaying, scheduledPauseAtMs, scheduledResumeAtMs } = usePlayerStore(
    useShallow(s => ({
      isPlaying: s.isPlaying,
      scheduledPauseAtMs: s.scheduledPauseAtMs,
      scheduledResumeAtMs: s.scheduledResumeAtMs,
    })),
  );

  const deadlineMs = isPlaying ? scheduledPauseAtMs : scheduledResumeAtMs;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  useEffect(() => {
    if (deadlineMs == null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [deadlineMs]);

  useLayoutEffect(() => {
    if (deadlineMs == null) return;
    const el = layoutAnchorRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      setPanelStyle({
        position: 'fixed',
        left: r.right,
        top: r.top,
        transform: 'translate(-88%, -36%)',
        zIndex: 9998,
        visibility: 'visible',
      });
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    const iv = window.setInterval(sync, 400);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      window.clearInterval(iv);
    };
  }, [deadlineMs, layoutAnchorRef]);

  if (deadlineMs == null) return null;

  const text = formatPlaybackScheduleRemaining(deadlineMs, nowMs);
  const label =
    isPlaying && scheduledPauseAtMs != null
      ? `${t('player.delayPauseSection')}: ${t('player.delayIn')} ${text}`
      : `${t('player.delayStartSection')}: ${t('player.delayIn')} ${text}`;

  const pillClass = ['playback-schedule-badge', 'playback-schedule-badge--floating', className].filter(Boolean).join(' ');

  return createPortal(
    <span className={pillClass} style={panelStyle} aria-live="polite" title={label}>
      {text}
    </span>,
    document.body,
  );
}
