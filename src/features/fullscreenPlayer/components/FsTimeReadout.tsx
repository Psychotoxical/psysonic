import { memo, useEffect, useRef } from 'react';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '@/features/playback/store/playbackProgress';
import { formatTrackTime } from '@/lib/format/formatDuration';

interface Props {
  duration: number;
  /** Show a live `-remaining` tail (e.g. `1:35 / -2:42`) instead of the total. */
  remaining?: boolean;
  /** Outer span class — lets each player style the readout. Defaults to `fsp-time`. */
  className?: string;
}

/**
 * Centered "current / total" readout for the control bar. Updates imperatively
 * from the playback-progress store — no React re-render per tick (same pattern
 * as FsSeekbar). With `remaining`, the tail counts down (`current / -remaining`)
 * and is repainted every tick too.
 */
export const FsTimeReadout = memo(function FsTimeReadout({
  duration, remaining = false, className = 'fsp-time',
}: Props) {
  const curRef = useRef<HTMLSpanElement>(null);
  const tailRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const apply = (state: { currentTime: number }) => {
      if (curRef.current) curRef.current.textContent = formatTrackTime(state.currentTime);
      if (tailRef.current) {
        tailRef.current.textContent = remaining
          ? `-${formatTrackTime(Math.max(0, duration - state.currentTime))}`
          : formatTrackTime(duration);
      }
    };
    apply(getPlaybackProgressSnapshot());
    return subscribePlaybackProgress(apply);
  }, [duration, remaining]);

  return (
    <span className={className}>
      <span ref={curRef} /> / <span ref={tailRef} />
    </span>
  );
});
