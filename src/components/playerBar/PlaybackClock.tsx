import { memo, useEffect, useRef } from 'react';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../../store/playbackProgress';
import {
  formatPlaybarClock,
  formatPlaybarToggleClock,
  formatTrackTime,
} from '../../utils/format/formatDuration';

/** Renders the playback clock without ever causing PlayerBar to re-render.
 *  Updates the DOM directly via an imperative store subscription. */
export const PlaybackTime = memo(function PlaybackTime({
  className,
  minuteFieldWidth,
}: {
  className?: string;
  minuteFieldWidth?: number;
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const format = (seconds: number) =>
      minuteFieldWidth != null
        ? formatPlaybarClock(seconds, minuteFieldWidth)
        : formatTrackTime(seconds);
    if (spanRef.current) {
      spanRef.current.textContent = format(getPlaybackProgressSnapshot().currentTime);
    }
    return subscribePlaybackProgress(state => {
      if (spanRef.current) spanRef.current.textContent = format(state.currentTime);
    });
  }, [minuteFieldWidth]);
  return <span className={className} ref={spanRef} />;
});

/** Remaining/duration toggle clock — fixed-length string, imperative updates. */
export const ToggleClock = memo(function ToggleClock({
  duration,
  minuteFieldWidth,
  remaining,
  className,
}: {
  duration: number;
  minuteFieldWidth: number;
  remaining: boolean;
  className?: string;
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      if (!spanRef.current) return;
      const seconds = remaining
        ? Math.max(0, duration - getPlaybackProgressSnapshot().currentTime)
        : duration;
      spanRef.current.textContent = formatPlaybarToggleClock(seconds, minuteFieldWidth, remaining);
    };
    update();
    return remaining ? subscribePlaybackProgress(update) : undefined;
  }, [duration, minuteFieldWidth, remaining]);
  return <span className={className} ref={spanRef} />;
});
