import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { formatPlaybackScheduleRemaining } from '../utils/playbackScheduleFormat';
import { useWindowVisibility } from '../hooks/useWindowVisibility';

export interface PlaybackScheduleBadgeProps {
  /** Anchor element (usually the play/pause button wrapper) — the ring centres on it. */
  layoutAnchorRef: React.RefObject<HTMLElement | null>;
  /** Extra class on the portaled ring (e.g. fullscreen sizing). */
  className?: string;
}

/**
 * Circular progress ring around the play/pause button, portaled to document.body
 * so it is never clipped by `contain: paint` on the player bar.
 *
 *  - Accent-coloured SVG stroke with a gradient; depletes as the deadline approaches.
 *  - Colour shifts to a warm warning hue when <10 % of the scheduled time remains.
 *  - The remaining time is rendered _inside_ the button (replaces the
 *    Play/Pause icon) by the consuming view, not here — avoids the floating
 *    pill clipping against the viewport edge.
 */
export default function PlaybackScheduleBadge({ layoutAnchorRef, className }: PlaybackScheduleBadgeProps) {
  const { t } = useTranslation();
  const {
    isPlaying,
    scheduledPauseAtMs,
    scheduledPauseStartMs,
    scheduledResumeAtMs,
    scheduledResumeStartMs,
  } = usePlayerStore(
    useShallow(s => ({
      isPlaying: s.isPlaying,
      scheduledPauseAtMs: s.scheduledPauseAtMs,
      scheduledPauseStartMs: s.scheduledPauseStartMs,
      scheduledResumeAtMs: s.scheduledResumeAtMs,
      scheduledResumeStartMs: s.scheduledResumeStartMs,
    })),
  );

  // Active timer: pause if playing, resume if paused.
  const deadlineMs = isPlaying ? scheduledPauseAtMs : scheduledResumeAtMs;
  const startMs    = isPlaying ? scheduledPauseStartMs : scheduledResumeStartMs;

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [anchorRect, setAnchorRect] = useState<{ left: number; top: number; size: number } | null>(null);
  const windowHidden = useWindowVisibility();

  useEffect(() => {
    if (deadlineMs == null || windowHidden) return;
    const id = window.setInterval(() => {
      if (document.hidden || (window as any).__psyHidden) return;
      setNowMs(Date.now());
    }, 500);
    return () => window.clearInterval(id);
  }, [deadlineMs, windowHidden]);

  useLayoutEffect(() => {
    if (deadlineMs == null || windowHidden) return;
    const el = layoutAnchorRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      setAnchorRect({
        left: r.left + r.width / 2,
        top: r.top + r.height / 2,
        size: Math.max(r.width, r.height),
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
  }, [deadlineMs, layoutAnchorRef, windowHidden]);

  if (deadlineMs == null || startMs == null || !anchorRect) return null;

  const totalMs     = Math.max(1, deadlineMs - startMs);
  const remainingMs = Math.max(0, deadlineMs - nowMs);
  const progress    = Math.min(1, Math.max(0, 1 - remainingMs / totalMs)); // 0 → just armed, 1 → fires now
  const nearEnd     = remainingMs / totalMs < 0.1;

  const label = isPlaying && scheduledPauseAtMs != null
    ? `${t('player.delayPauseSection')}: ${t('player.delayIn')} ${formatPlaybackScheduleRemaining(deadlineMs, nowMs)}`
    : `${t('player.delayStartSection')}: ${t('player.delayIn')} ${formatPlaybackScheduleRemaining(deadlineMs, nowMs)}`;

  // Ring sits snug around the button; diameter ~1.22× button size for breathing room.
  const ringSize = Math.round(anchorRect.size * 1.22);
  const strokeW  = Math.max(2.5, ringSize / 28);
  const r        = ringSize / 2 - strokeW / 2;
  const circ     = 2 * Math.PI * r;
  // Reversed direction so the ring shrinks counter-clockwise from the top.
  const dashOffset = -circ * progress;

  // Mode selects the gradient tint: pause = lavender, start = peach.
  const mode: 'pause' | 'start' = isPlaying ? 'pause' : 'start';
  // Uniqueish gradient id — multiple badges (player bar + fullscreen) can coexist.
  const gradId = `psy-sched-grad-${mode}`;

  const wrapStyle: React.CSSProperties = {
    position: 'fixed',
    left:  anchorRect.left,
    top:   anchorRect.top,
    transform: 'translate(-50%, -50%)',
    width:  ringSize,
    height: ringSize,
    zIndex: 9998,
    pointerEvents: 'none',
  };

  return createPortal(
    <span
      className={[
        'playback-schedule-ring',
        `playback-schedule-ring--${mode}`,
        nearEnd ? 'is-warn' : '',
        className,
      ].filter(Boolean).join(' ')}
      style={wrapStyle}
      aria-label={label}
    >
      <svg
        className="playback-schedule-ring__svg"
        width={ringSize}
        height={ringSize}
        viewBox={`0 0 ${ringSize} ${ringSize}`}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   className="playback-schedule-ring__grad-a" />
            <stop offset="100%" className="playback-schedule-ring__grad-b" />
          </linearGradient>
        </defs>
        <circle
          className="playback-schedule-ring__track"
          cx={ringSize / 2}
          cy={ringSize / 2}
          r={r}
          fill="none"
          strokeWidth={strokeW}
        />
        <circle
          className="playback-schedule-ring__fill"
          cx={ringSize / 2}
          cy={ringSize / 2}
          r={r}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
        />
      </svg>
    </span>,
    document.body,
  );
}
