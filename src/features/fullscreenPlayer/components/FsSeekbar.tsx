import { memo, useCallback, useRef } from 'react';
import { usePlayerStore, type PlaybackProgressSnapshot } from '@/features/playback';
import { formatTrackTime } from '@/lib/format/formatDuration';
import { useImperativeSeek } from '@/features/fullscreenPlayer/hooks/useImperativeSeek';

// Full-width seekbar — imperative DOM updates, zero React re-renders on tick.
export const FsSeekbar = memo(function FsSeekbar({ duration }: { duration: number }) {
  const timeRef     = useRef<HTMLSpanElement>(null);
  const playedRef   = useRef<HTMLDivElement>(null);
  const bufRef      = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);

  const paint = useCallback((s: PlaybackProgressSnapshot) => {
    const pct = s.progress * 100;
    if (timeRef.current)   timeRef.current.textContent  = formatTrackTime(s.currentTime);
    if (playedRef.current) playedRef.current.style.width = `${pct}%`;
    if (bufRef.current)    bufRef.current.style.width    = `${Math.max(pct, s.buffered * 100)}%`;
    if (inputRef.current)  inputRef.current.value        = String(s.progress);
  }, []);

  const previewPaint = useCallback((p: number) => {
    const s = usePlayerStore.getState();
    if (timeRef.current) {
      const previewTime = duration > 0 ? p * duration : s.currentTime;
      timeRef.current.textContent = formatTrackTime(previewTime);
    }
    if (playedRef.current) playedRef.current.style.width = `${p * 100}%`;
    if (bufRef.current)    bufRef.current.style.width    = `${Math.max(p * 100, s.buffered * 100)}%`;
    if (inputRef.current)  inputRef.current.value        = String(p);
  }, [duration]);

  const seekHandlers = useImperativeSeek({ paint, previewPaint });

  return (
    <div className="fs-seekbar-wrap">
      <div className="fs-seekbar-times">
        <span ref={timeRef} />
        <span>{formatTrackTime(duration)}</span>
      </div>
      <div className="fs-seekbar">
        <div className="fs-seekbar-bg" />
        <div className="fs-seekbar-buf" ref={bufRef} />
        <div className="fs-seekbar-played" ref={playedRef} />
        <input
          ref={inputRef}
          type="range" min={0} max={1} step={0.001}
          defaultValue={0}
          aria-label="Seek"
          {...seekHandlers}
        />
      </div>
    </div>
  );
});
