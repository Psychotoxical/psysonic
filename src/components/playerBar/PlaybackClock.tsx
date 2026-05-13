import { memo, useEffect, useRef } from 'react';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../../store/playbackProgress';
import { formatTime } from '../../utils/playerBarHelpers';

/** Renders the playback clock without ever causing PlayerBar to re-render.
 *  Updates the DOM directly via an imperative store subscription. */
export const PlaybackTime = memo(function PlaybackTime({ className }: { className?: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (spanRef.current) {
      spanRef.current.textContent = formatTime(getPlaybackProgressSnapshot().currentTime);
    }
    return subscribePlaybackProgress(state => {
      if (spanRef.current) spanRef.current.textContent = formatTime(state.currentTime);
    });
  }, []);
  return <span className={className} ref={spanRef} />;
});

/** Renders the remaining time (duration - currentTime) without causing PlayerBar
 *  to re-render. */
export const RemainingTime = memo(function RemainingTime({ duration, className }: { duration: number; className?: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const updateRemaining = () => {
      if (spanRef.current) {
        const remaining = Math.max(0, duration - getPlaybackProgressSnapshot().currentTime);
        spanRef.current.textContent = `-${formatTime(remaining)}`;
      }
    };
    updateRemaining();
    return subscribePlaybackProgress(updateRemaining);
  }, [duration]);
  return <span className={className} ref={spanRef} />;
});
