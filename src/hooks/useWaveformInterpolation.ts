import React, { useEffect } from 'react';
import type { SeekbarStyle } from '../store/authStoreTypes';
import { getPlaybackProgressSnapshot } from '../store/playbackProgress';
import {
  ANIMATED_STYLES, AnimState, INTERPOLATION_PAINT_MIN_MS,
  isBarQuantizedSeekStyle, quantizeProgressByBars,
} from '../utils/waveform/waveformSeekHelpers';
import { drawSeekbar } from '../utils/waveform/waveformSeekRenderers';

interface Args {
  duration: number;
  isPlaying: boolean;
  previewFreezesMainSeekbar: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  heightsRef: React.MutableRefObject<Float32Array | null>;
  styleRef: React.MutableRefObject<SeekbarStyle>;
  progressRef: React.MutableRefObject<number>;
  bufferedRef: React.MutableRefObject<number>;
  visualProgressRef: React.MutableRefObject<number>;
  visualTargetProgressRef: React.MutableRefObject<number>;
  progressAnchorRef: React.MutableRefObject<{ progress: number; atMs: number }>;
  animStateRef: React.MutableRefObject<AnimState>;
  isDraggingRef: React.MutableRefObject<boolean>;
  wheelPreviewFractionRef: React.MutableRefObject<number | null>;
  wheelPreviewUntilRef: React.MutableRefObject<number>;
  pendingCommittedSeekRef: React.MutableRefObject<{ fraction: number; setAtMs: number } | null>;
}

/** Smooth interpolation rAF loop — predicts playhead position between sparse
 *  transport heartbeats, with proper anchor reset on resume. Inactive while
 *  paused, dragging, wheel-preview, or pending-committed-seek. */
export function useWaveformInterpolation({
  duration, isPlaying, previewFreezesMainSeekbar,
  canvasRef, heightsRef, styleRef,
  progressRef, bufferedRef, visualProgressRef, visualTargetProgressRef,
  progressAnchorRef, animStateRef, isDraggingRef,
  wheelPreviewFractionRef, wheelPreviewUntilRef, pendingCommittedSeekRef,
}: Args) {
  useEffect(() => {
    if (!isPlaying || previewFreezesMainSeekbar || duration <= 0 || !isFinite(duration)) return;
    // This effect is torn down while paused, so `progressAnchorRef.atMs` is not refreshed.
    // On resume the first `tick` would add the entire pause duration to `elapsedSec` and
    // overshoot the playhead until the next transport heartbeat corrects it.
    const snap = getPlaybackProgressSnapshot();
    const raw = snap.buffering || snap.currentTime < 0.005 ? 0 : snap.progress;
    progressRef.current = raw;
    progressAnchorRef.current = {
      progress: raw,
      atMs: performance.now(),
    };
    const resumeVisual = isBarQuantizedSeekStyle(styleRef.current)
      ? quantizeProgressByBars(raw)
      : raw;
    visualTargetProgressRef.current = resumeVisual;
    visualProgressRef.current = resumeVisual;

    let rafId: number | null = null;
    let lastPaintAt = 0;
    const tick = (now: number) => {
      if (document.hidden || window.__psyHidden) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (isDraggingRef.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const wheelPreviewFraction = wheelPreviewFractionRef.current;
      if (wheelPreviewFraction != null && Date.now() < wheelPreviewUntilRef.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (pendingCommittedSeekRef.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const snap = getPlaybackProgressSnapshot();
      if (snap.buffering || snap.currentTime < 0.005) {
        progressRef.current = 0;
        visualTargetProgressRef.current = 0;
        visualProgressRef.current = 0;
        progressAnchorRef.current = { progress: 0, atMs: now };
        rafId = requestAnimationFrame(tick);
        return;
      }
      const anchor = progressAnchorRef.current;
      const elapsedSec = Math.max(0, (now - anchor.atMs) / 1000);
      const predicted = Math.max(0, Math.min(1, anchor.progress + elapsedSec / duration));
      const nextTargetProgress = isBarQuantizedSeekStyle(styleRef.current)
        ? quantizeProgressByBars(predicted)
        : predicted;
      if (Math.abs(nextTargetProgress - visualTargetProgressRef.current) > 0.000001) {
        visualTargetProgressRef.current = nextTargetProgress;
      }
      const currentVisual = visualProgressRef.current;
      const targetVisual = visualTargetProgressRef.current;
      const delta = targetVisual - currentVisual;
      if (Math.abs(delta) > 0.000001) {
        const smoothing = isBarQuantizedSeekStyle(styleRef.current) ? 0.22 : 0.28;
        const nextVisualProgress = Math.abs(delta) < 0.002
          ? targetVisual
          : currentVisual + delta * smoothing;
        visualProgressRef.current = nextVisualProgress;
        progressRef.current = nextVisualProgress;
        const needsDirectDraw = !ANIMATED_STYLES.has(styleRef.current);
        if (needsDirectDraw && now - lastPaintAt >= INTERPOLATION_PAINT_MIN_MS) {
          const canvas = canvasRef.current;
          if (canvas) {
            drawSeekbar(canvas, styleRef.current, heightsRef.current, nextVisualProgress, bufferedRef.current, animStateRef.current);
            lastPaintAt = now;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, isPlaying, previewFreezesMainSeekbar]);
}
