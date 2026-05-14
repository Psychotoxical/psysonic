import React, { memo, useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/playerStore';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../../store/playbackProgress';
import { formatTrackTime } from '../../utils/format/formatDuration';

// Full-width seekbar — imperative DOM updates, zero React re-renders on tick.
export const FsSeekbar = memo(function FsSeekbar({ duration }: { duration: number }) {
  const seek        = usePlayerStore(s => s.seek);
  const timeRef     = useRef<HTMLSpanElement>(null);
  const playedRef   = useRef<HTMLDivElement>(null);
  const bufRef      = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const isDraggingRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);

  const previewSeek = useCallback((progress: number) => {
    const s = usePlayerStore.getState();
    const p = Math.max(0, Math.min(1, progress));
    pendingSeekRef.current = p;
    if (timeRef.current) {
      const previewTime = duration > 0 ? p * duration : s.currentTime;
      timeRef.current.textContent = formatTrackTime(previewTime);
    }
    if (playedRef.current) playedRef.current.style.width = `${p * 100}%`;
    if (bufRef.current) bufRef.current.style.width = `${Math.max(p * 100, s.buffered * 100)}%`;
    if (inputRef.current) inputRef.current.value = String(p);
  }, [duration]);

  const commitSeek = useCallback(() => {
    const pending = pendingSeekRef.current;
    if (pending === null) return;
    pendingSeekRef.current = null;
    seek(pending);
  }, [seek]);

  useEffect(() => {
    const s = getPlaybackProgressSnapshot();
    const pct = s.progress * 100;
    if (timeRef.current)   timeRef.current.textContent  = formatTrackTime(s.currentTime);
    if (playedRef.current) playedRef.current.style.width = `${pct}%`;
    if (bufRef.current)    bufRef.current.style.width    = `${Math.max(pct, s.buffered * 100)}%`;
    if (inputRef.current)  inputRef.current.value        = String(s.progress);

    return subscribePlaybackProgress(state => {
      if (isDraggingRef.current) return;
      const p = state.progress * 100;
      if (timeRef.current)   timeRef.current.textContent  = formatTrackTime(state.currentTime);
      if (playedRef.current) playedRef.current.style.width = `${p}%`;
      if (bufRef.current)    bufRef.current.style.width    = `${Math.max(p, state.buffered * 100)}%`;
      if (inputRef.current)  inputRef.current.value        = String(state.progress);
    });
  }, []);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      previewSeek(parseFloat(e.target.value));
    },
    [previewSeek]
  );

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
          onChange={handleSeek}
          onMouseDown={() => { isDraggingRef.current = true; }}
          onMouseUp={() => { isDraggingRef.current = false; commitSeek(); }}
          onTouchStart={() => { isDraggingRef.current = true; }}
          onTouchEnd={() => { isDraggingRef.current = false; commitSeek(); }}
          onPointerDown={() => { isDraggingRef.current = true; }}
          onPointerUp={() => { isDraggingRef.current = false; commitSeek(); }}
          onKeyUp={commitSeek}
          onBlur={() => { isDraggingRef.current = false; commitSeek(); }}
          aria-label="seek"
        />
      </div>
    </div>
  );
});
