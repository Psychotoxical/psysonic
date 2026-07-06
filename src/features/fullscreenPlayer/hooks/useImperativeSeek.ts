import React, { useCallback, useEffect, useRef } from 'react';
import {
  usePlayerStore, getPlaybackProgressSnapshot, subscribePlaybackProgress,
  type PlaybackProgressSnapshot,
} from '@/features/playback';

/** Handlers to spread onto a `<input type="range">` for imperative scrub seeking. */
export interface ImperativeSeekHandlers {
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onMouseDown: () => void;
  onMouseUp: () => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onKeyDown: () => void;
  onKeyUp: () => void;
  onBlur: () => void;
}

/**
 * Shared seekbar interaction for the fullscreen players: subscribes to the
 * playback-progress channel and repaints imperatively (zero re-renders per
 * tick) via `paint`, pauses repaints while the user drags, previews the drag
 * position via `previewPaint`, and commits the seek on release. Covers mouse,
 * touch, pointer, and keyboard input so every input method scrubs.
 *
 * `paint` and `previewPaint` must be stable (wrap in `useCallback` with a
 * ref-only body) — `paint` is a subscription dependency.
 */
export function useImperativeSeek(opts: {
  paint: (s: PlaybackProgressSnapshot) => void;
  previewPaint: (progress: number) => void;
}): ImperativeSeekHandlers {
  const { paint, previewPaint } = opts;
  const seek = usePlayerStore(s => s.seek);
  const draggingRef = useRef(false);
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    paint(getPlaybackProgressSnapshot());
    return subscribePlaybackProgress(s => { if (!draggingRef.current) paint(s); });
  }, [paint]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const p = Math.max(0, Math.min(1, parseFloat(e.target.value)));
    pendingRef.current = p;
    previewPaint(p);
  }, [previewPaint]);

  const startDrag = useCallback(() => { draggingRef.current = true; }, []);
  const endDrag = useCallback(() => {
    draggingRef.current = false;
    const pending = pendingRef.current;
    if (pending !== null) { pendingRef.current = null; seek(pending); }
  }, [seek]);

  return {
    onChange,
    onMouseDown: startDrag, onMouseUp: endDrag,
    onTouchStart: startDrag, onTouchEnd: endDrag,
    onPointerDown: startDrag, onPointerUp: endDrag,
    onKeyDown: startDrag, onKeyUp: endDrag,
    onBlur: endDrag,
  };
}
