import { memo, useEffect, useRef } from 'react';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '@/features/playback/store/playbackProgress';
import { formatTrackTime } from '@/lib/format/formatDuration';

/**
 * Centered "current / total" readout for the control bar. Updates the current
 * time imperatively from the playback-progress store — no React re-render per
 * tick (same pattern as FsSeekbar).
 */
export const FsTimeReadout = memo(function FsTimeReadout({ duration }: { duration: number }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const apply = (state: { currentTime: number }) => {
      if (ref.current) ref.current.textContent = formatTrackTime(state.currentTime);
    };
    apply(getPlaybackProgressSnapshot());
    return subscribePlaybackProgress(apply);
  }, []);

  return (
    <span className="fsp-time">
      <span ref={ref} /> / {formatTrackTime(duration)}
    </span>
  );
});
