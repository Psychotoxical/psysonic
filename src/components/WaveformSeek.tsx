import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../store/playbackProgress';
import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { usePreviewStore } from '../store/previewStore';
import { useAuthStore } from '../store/authStore';
import {
  ANIMATED_STYLES, AnimState,
  STATIC_REDRAW_FORCE_MS, STATIC_REDRAW_MIN_MS,
  fmt, invalidateColorCache, isBarQuantizedSeekStyle, makeAnimState,
  quantizeProgressByBars,
} from '../utils/waveform/waveformSeekHelpers';
import { drawSeekbar } from '../utils/waveform/waveformSeekRenderers';
import { useWaveformHeights } from '../hooks/useWaveformHeights';
import { useWaveformInterpolation } from '../hooks/useWaveformInterpolation';

// ── main component ────────────────────────────────────────────────────────────
//
// Architecture:
//   Static styles  (waveform, bar, …): drawn directly in the Zustand subscription
//     callback — no React re-renders, no rAF loop.  2 draws/s at the 500 ms
//     Rust interval.  shadowBlur + 500 canvas bars on a software-rendered
//     WebKitGTK context is too expensive for a continuous 60 fps loop.
//   Animated styles (pulsewave, particletrail, …): rAF loop at 60 fps, reads
//     refs that the subscription keeps up-to-date.
//   Drag: draws synchronously in seekToFraction for 1:1 responsiveness.

interface Props {
  trackId: string | undefined;
}

const SEEK_COMMIT_GUARD_MS = 900;
const SEEK_COMMIT_MIN_HOLD_MS = 320;
const SEEK_COMMIT_PROGRESS_EPS = 0.02;
const WHEEL_SEEK_STEP_SECONDS = 10;
const WHEEL_SEEK_DEBOUNCE_MS = 350;

export default function WaveformSeek({ trackId }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const heightsRef   = useRef<Float32Array | null>(null);
  const progressRef  = useRef(getPlaybackProgressSnapshot().progress);
  const bufferedRef  = useRef(getPlaybackProgressSnapshot().buffered);
  const visualProgressRef = useRef(progressRef.current);
  const visualTargetProgressRef = useRef(progressRef.current);
  const isDragging   = useRef(false);
  const animStateRef = useRef<AnimState>(makeAnimState());
  const lastStaticDrawAtRef = useRef(0);
  const lastStaticDrawProgressRef = useRef(-1);
  const lastStaticDrawBufferedRef = useRef(-1);

  const [hoverPct, setHoverPct] = useState<number | null>(null);

  const seek         = usePlayerStore(s => s.seek);
  const isPlaying    = usePlayerStore(s => s.isPlaying);
  /** Track preview pauses the main sink in Rust; `isPlaying` stays true so the bar must not extrapolate. */
  const previewFreezesMainSeekbar = usePreviewStore(s => s.previewingId != null);
  const waveformBins = usePlayerStore(s => s.waveformBins);
  const duration     = usePlayerStore(s => s.currentTrack?.duration ?? 0);
  const seekbarStyle = useAuthStore(s => s.seekbarStyle);

  // Ref so the subscription callback (closed over at mount) can read the
  // current style without stale-closure issues.
  const styleRef = useRef(seekbarStyle);
  styleRef.current = seekbarStyle;

  useWaveformHeights({
    trackId, waveformBins, seekbarStyle,
    heightsRef, canvasRef, styleRef, progressRef, bufferedRef, animStateRef,
  });


  // Imperative subscription — no React re-renders from progress changes.
  // Static styles draw here; animated styles only update refs.
  useEffect(() => {
    return subscribePlaybackProgress((state, prev) => {
      if (state.progress === prev.progress && state.buffered === prev.buffered) return;
      // While user drags, keep the local preview stable. External progress ticks
      // during streaming/recovery would otherwise fight the cursor and flicker.
      if (isDragging.current) return;
      const now = Date.now();
      const wheelPreviewFraction = wheelPreviewFractionRef.current;
      if (wheelPreviewFraction != null) {
        if (now < wheelPreviewUntilRef.current) return;
        wheelPreviewFractionRef.current = null;
      }
      const pendingCommit = pendingCommittedSeekRef.current;
      if (pendingCommit) {
        const ageMs = Date.now() - pendingCommit.setAtMs;
        if (ageMs < SEEK_COMMIT_MIN_HOLD_MS) return;
        const matched = Math.abs(state.progress - pendingCommit.fraction) <= SEEK_COMMIT_PROGRESS_EPS;
        const expired = ageMs > SEEK_COMMIT_GUARD_MS;
        if (!matched && !expired) return;
        pendingCommittedSeekRef.current = null;
      }
      progressRef.current = state.progress;
      bufferedRef.current = state.buffered;
      progressAnchorRef.current = {
        progress: state.progress,
        atMs: performance.now(),
      };
      visualTargetProgressRef.current = isBarQuantizedSeekStyle(styleRef.current)
        ? quantizeProgressByBars(state.progress)
        : state.progress;
      // While paused the interpolation rAF is disabled, so keep the drawn playhead
      // in sync with external seeks (keyboard, MPRIS, queue). Drag/wheel still
      // update these refs via previewFraction.
      if (!usePlayerStore.getState().isPlaying) {
        visualProgressRef.current = visualTargetProgressRef.current;
      }
      // Static styles always redraw on progress; animated styles let the rAF
      // loop drive paints.
      const drawNow = !ANIMATED_STYLES.has(styleRef.current);
      if (drawNow) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (!ANIMATED_STYLES.has(styleRef.current) && !isDragging.current) {
          const now = Date.now();
          const widthPx = Math.max(1, canvas.clientWidth || canvas.width || 1);
          const minVisualDelta = 0.35 / widthPx; // allow smoother progress while still skipping no-op paints
          const progressDelta = Math.abs(state.progress - lastStaticDrawProgressRef.current);
          const bufferedDelta = Math.abs(state.buffered - lastStaticDrawBufferedRef.current);
          const ageMs = now - lastStaticDrawAtRef.current;
          const visuallySame = progressDelta < minVisualDelta && bufferedDelta < minVisualDelta;
          if (
            ageMs < STATIC_REDRAW_MIN_MS &&
            visuallySame
          ) return;
          if (visuallySame && ageMs < STATIC_REDRAW_FORCE_MS) return;
          lastStaticDrawAtRef.current = now;
          lastStaticDrawProgressRef.current = state.progress;
          lastStaticDrawBufferedRef.current = state.buffered;
        }
        drawSeekbar(canvas, styleRef.current, heightsRef.current, visualProgressRef.current, state.buffered);
      }
    });
  }, []);

  // Initial draw for static styles when style, track, or waveform payload changes.
  useEffect(() => {
    if (ANIMATED_STYLES.has(seekbarStyle)) return;
    const canvas = canvasRef.current;
    if (canvas) drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current);
  }, [
    seekbarStyle,
    trackId,
    waveformBins,
    duration,
  ]);

  // rAF loop — animated styles only.
  useEffect(() => {
    if (!ANIMATED_STYLES.has(seekbarStyle)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    animStateRef.current = makeAnimState();
    let rafId: number | null = null;
    let pollId: number | null = null;
    const stop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pollId !== null) {
        window.clearTimeout(pollId);
        pollId = null;
      }
    };
    const tick = () => {
      if (document.hidden || window.__psyHidden) {
        pollId = window.setTimeout(() => {
          pollId = null;
          tick();
        }, 400);
        return;
      }
      animStateRef.current.time += 0.016;
      drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
      rafId = requestAnimationFrame(tick);
    };
    tick();
    return () => stop();
  }, [seekbarStyle]);

  // Smoothly advance progress between sparse transport ticks.
  // Preview pauses main sink in Rust while UI `isPlaying` may still be true.
  // When preview ends, interpolation must restart from "now", otherwise the
  // old anchor timestamp adds preview duration and causes a one-frame jump.
  useEffect(() => {
    progressAnchorRef.current = {
      progress: progressRef.current,
      atMs: performance.now(),
    };
    const quantizedOrRaw = isBarQuantizedSeekStyle(styleRef.current)
      ? quantizeProgressByBars(progressRef.current)
      : progressRef.current;
    visualTargetProgressRef.current = quantizedOrRaw;
    // Keep current visual position as-is; only reset timing anchor.
  }, [previewFreezesMainSeekbar]);

  // Resize observer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [seekbarStyle]);

  // Theme change observer — redraw canvas when theme changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new MutationObserver(() => {
      invalidateColorCache();
      drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [seekbarStyle]);

  const trackIdRef = useRef(trackId);
  trackIdRef.current = trackId;
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const pendingSeekRef = useRef<number | null>(null);
  const pendingCommittedSeekRef = useRef<{ fraction: number; setAtMs: number } | null>(null);
  const progressAnchorRef = useRef<{ progress: number; atMs: number }>({
    progress: progressRef.current,
    atMs: performance.now(),
  });
  const wheelSeekTimerRef = useRef<number | null>(null);
  const queuedWheelSeekFractionRef = useRef<number | null>(null);
  const wheelPreviewFractionRef = useRef<number | null>(null);
  const wheelPreviewUntilRef = useRef(0);

  useWaveformInterpolation({
    duration, isPlaying, previewFreezesMainSeekbar,
    canvasRef, heightsRef, styleRef,
    progressRef, bufferedRef, visualProgressRef, visualTargetProgressRef,
    progressAnchorRef, animStateRef, isDraggingRef: isDragging,
    wheelPreviewFractionRef, wheelPreviewUntilRef, pendingCommittedSeekRef,
  });

  useEffect(() => () => {
    if (wheelSeekTimerRef.current != null) {
      window.clearTimeout(wheelSeekTimerRef.current);
      wheelSeekTimerRef.current = null;
    }
    wheelPreviewFractionRef.current = null;
    wheelPreviewUntilRef.current = 0;
  }, []);

  // Preview a 0–1 fraction while dragging: draw immediately for 1:1
  // responsiveness; the actual seek is committed on mouseup.
  const previewFraction = (fraction: number) => {
    progressRef.current = fraction;
    visualProgressRef.current = fraction;
    visualTargetProgressRef.current = fraction;
    progressAnchorRef.current = {
      progress: fraction,
      atMs: performance.now(),
    };
    pendingSeekRef.current = fraction;
    const canvas = canvasRef.current;
    if (canvas && !ANIMATED_STYLES.has(styleRef.current)) {
      drawSeekbar(canvas, styleRef.current, heightsRef.current, fraction, bufferedRef.current);
    }
  };

  const commitSeek = () => {
    const fraction = pendingSeekRef.current;
    if (fraction === null) return;
    pendingSeekRef.current = null;
    pendingCommittedSeekRef.current = { fraction, setAtMs: Date.now() };
    seekRef.current(fraction);
  };

  useEffect(() => {
    const seekFromX = (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !trackIdRef.current) return;
      const rect = canvas.getBoundingClientRect();
      previewFraction(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
    };
    const onMove = (e: MouseEvent) => { if (isDragging.current) seekFromX(e.clientX); };
    const onUp   = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      commitSeek();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, []);

  return (
    <div className="waveform-seek-container" style={{ position: 'relative', width: '100%' }}>
      {hoverPct !== null && duration > 0 && (
        <span
          className="player-volume-pct"
          style={{ left: `${hoverPct * 100}%` }}
        >
          {fmt(hoverPct * duration)}
        </span>
      )}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '24px', cursor: trackId ? 'pointer' : 'default', display: 'block' }}
        onWheel={e => {
          if (!trackIdRef.current || duration <= 0 || isDragging.current) return;
          e.preventDefault();

          const wheelSteps = Math.max(1, Math.round(Math.abs(e.deltaY) / 100));
          if (wheelSteps <= 0) return;

          const now = Date.now();
          const currentSeconds = progressRef.current * duration;
          const deltaSeconds = (e.deltaY > 0 ? -1 : 1) * WHEEL_SEEK_STEP_SECONDS * wheelSteps;
          const nextSeconds = Math.max(0, Math.min(duration, currentSeconds + deltaSeconds));
          const nextFraction = Math.max(0, Math.min(1, nextSeconds / duration));

          // Preventive UI update: move visual playhead immediately on every wheel event.
          progressRef.current = nextFraction;
          visualProgressRef.current = nextFraction;
          visualTargetProgressRef.current = nextFraction;
          progressAnchorRef.current = {
            progress: nextFraction,
            atMs: performance.now(),
          };
          wheelPreviewFractionRef.current = nextFraction;
          wheelPreviewUntilRef.current = now + WHEEL_SEEK_DEBOUNCE_MS;
          const canvas = canvasRef.current;
          if (canvas && !ANIMATED_STYLES.has(styleRef.current)) {
            drawSeekbar(canvas, styleRef.current, heightsRef.current, nextFraction, bufferedRef.current);
          }

          // Trailing debounce: commit seek only after wheel activity settles.
          queuedWheelSeekFractionRef.current = nextFraction;
          if (wheelSeekTimerRef.current != null) {
            window.clearTimeout(wheelSeekTimerRef.current);
          }
          wheelSeekTimerRef.current = window.setTimeout(() => {
            wheelSeekTimerRef.current = null;
            const queuedFraction = queuedWheelSeekFractionRef.current;
            queuedWheelSeekFractionRef.current = null;
            if (queuedFraction == null) return;
            wheelPreviewFractionRef.current = null;
            wheelPreviewUntilRef.current = 0;
            pendingCommittedSeekRef.current = { fraction: queuedFraction, setAtMs: Date.now() };
            seekRef.current(queuedFraction);
          }, WHEEL_SEEK_DEBOUNCE_MS);
        }}
        onMouseDown={e => {
          isDragging.current = true;
          const rect = e.currentTarget.getBoundingClientRect();
          previewFraction(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
        }}
        onMouseMove={e => {
          if (!trackId) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
        }}
        onMouseLeave={() => setHoverPct(null)}
      />
    </div>
  );
}
