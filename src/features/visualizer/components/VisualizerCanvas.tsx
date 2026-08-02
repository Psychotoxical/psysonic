import { useEffect, useMemo, useRef } from 'react';
import { useSpectrumFeed } from '@/features/visualizer/hooks/useSpectrumFeed';
import { useVisualizerPalette } from '@/features/visualizer/hooks/useVisualizerPalette';
import { useVisualizerStore } from '@/features/visualizer/store/visualizerStore';
import {
  createRendererState,
  renderFrame,
  resetRendererState,
  setupCanvas,
  type VisualizerMode,
} from '@/features/visualizer/utils/visualizerRenderers';

interface VisualizerCanvasProps {
  /** Cover art URL used to derive the palette. */
  artUrl: string;
  /** Cover cache key for the same. */
  artKey: string;
  /** Mount without running the feed (offscreen, collapsed panel, …). */
  paused?: boolean;
  className?: string;
  /** Mode override; defaults to the stored preference. */
  mode?: VisualizerMode;
}

/**
 * The visualizer surface itself: a canvas driven by `requestAnimationFrame`.
 *
 * Nothing here goes through React state per frame — the feed hands back a
 * mutable frame and the loop draws it. React only re-renders when a *setting*
 * changes, which is what keeps a 60 Hz animation off the reconciler.
 *
 * `requestAnimationFrame` also gives the throttling for free: a hidden window
 * stops calling back, so a backgrounded app draws nothing even though Rust may
 * still be emitting for another surface.
 */
export default function VisualizerCanvas({
  artUrl,
  artKey,
  paused = false,
  className,
  mode,
}: VisualizerCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const storedMode = useVisualizerStore(s => s.mode);
  const sensitivity = useVisualizerStore(s => s.sensitivity);
  const showPeaks = useVisualizerStore(s => s.showPeaks);
  const colorSource = useVisualizerStore(s => s.colorSource);
  const fps = useVisualizerStore(s => s.fps);
  const responsiveness = useVisualizerStore(s => s.responsiveness);

  const activeMode = mode ?? storedMode;
  const palette = useVisualizerPalette(artUrl, artKey, colorSource);
  // Memoised so the feed effect doesn't see a new object every render.
  const feedParams = useMemo(() => ({ fps, responsiveness }), [fps, responsiveness]);
  const feedRef = useSpectrumFeed(!paused, feedParams);

  // Frame-to-frame scratch for the radial trail. Dropped on a mode change so a
  // switched-away ghost can't bleed into the next mode.
  const rendererStateRef = useRef(createRendererState());
  useEffect(() => {
    const state = rendererStateRef.current;
    resetRendererState(state);
    return () => resetRendererState(state);
  }, [activeMode]);

  // Latest render inputs, read inside the loop so a settings change never
  // restarts the animation. Held in a lazily-initialised state container rather
  // than a ref: it is written from an effect, never during render.
  const optionsRef = useRef({
    palette,
    sensitivity,
    showPeaks,
    activeMode,
    reducedMotion: false,
  });

  useEffect(() => {
    optionsRef.current.palette = palette;
    optionsRef.current.sensitivity = sensitivity;
    optionsRef.current.showPeaks = showPeaks;
    optionsRef.current.activeMode = activeMode;
  }, [palette, sensitivity, showPeaks, activeMode]);

  useEffect(() => {
    if (paused) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const motionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    const syncMotion = (): void => {
      optionsRef.current.reducedMotion = motionQuery?.matches ?? false;
    };
    syncMotion();
    motionQuery?.addEventListener?.('change', syncMotion);

    let raf = 0;
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      const surface = setupCanvas(canvas);
      if (!surface) return;

      const feed = feedRef.current;
      feed.sample(now);

      const o = optionsRef.current;
      renderFrame(
        surface.ctx,
        surface.width,
        surface.height,
        feed.frame,
        o.activeMode,
        {
          palette: o.palette,
          sensitivity: o.sensitivity,
          showPeaks: o.showPeaks,
          reducedMotion: o.reducedMotion,
        },
        rendererStateRef.current,
      );
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      motionQuery?.removeEventListener?.('change', syncMotion);
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [paused, feedRef]);

  return (
    <canvas
      ref={canvasRef}
      className={className ? `psy-viz-canvas ${className}` : 'psy-viz-canvas'}
      // Decorative: the audio it depicts is already announced by the player.
      aria-hidden="true"
    />
  );
}
