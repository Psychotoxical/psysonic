import { useEffect, useMemo, useRef, useState } from 'react';
import { useWindowVisibility } from '@/lib/hooks/useWindowVisibility';
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
  /** Mount without running the feed (offscreen, collapsed panel, etc.). */
  paused?: boolean;
  className?: string;
  /** Mode override; defaults to the stored preference. */
  mode?: VisualizerMode;
}

/**
 * Canvas rendering stays outside React state. React only tracks low-rate
 * visibility changes so hidden/offscreen surfaces release their feed lease;
 * fresh audio wakes the otherwise quiescent RAF loop through `feed.subscribe`.
 */
export default function VisualizerCanvas({
  artUrl,
  artKey,
  paused = false,
  className,
  mode,
}: VisualizerCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden,
  );
  const [intersecting, setIntersecting] = useState(true);
  const windowHidden = useWindowVisibility();

  const storedMode = useVisualizerStore(s => s.mode);
  const sensitivity = useVisualizerStore(s => s.sensitivity);
  const showPeaks = useVisualizerStore(s => s.showPeaks);
  const colorSource = useVisualizerStore(s => s.colorSource);
  const fps = useVisualizerStore(s => s.fps);
  const responsiveness = useVisualizerStore(s => s.responsiveness);

  const activeMode = mode ?? storedMode;
  const palette = useVisualizerPalette(artUrl, artKey, colorSource);
  const feedParams = useMemo(() => ({ fps, responsiveness }), [fps, responsiveness]);
  const feedActive = !paused && documentVisible && intersecting && !windowHidden;
  const feedRef = useSpectrumFeed(feedActive, feedParams);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const syncVisibility = (): void => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some(entry => entry.isIntersecting);
      setIntersecting(current => current === visible ? current : visible);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Frame-to-frame scratch for the radial trail. Dropped on a mode change so a
  // switched-away ghost cannot bleed into the next mode.
  const rendererStateRef = useRef(createRendererState());
  useEffect(() => {
    const state = rendererStateRef.current;
    resetRendererState(state);
    return () => resetRendererState(state);
  }, [activeMode]);

  const optionsRef = useRef({
    palette,
    sensitivity,
    showPeaks,
    activeMode,
    reducedMotion: false,
  });
  const scheduleRenderRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    optionsRef.current.palette = palette;
    optionsRef.current.sensitivity = sensitivity;
    optionsRef.current.showPeaks = showPeaks;
    optionsRef.current.activeMode = activeMode;
    scheduleRenderRef.current?.();
  }, [palette, sensitivity, showPeaks, activeMode]);

  useEffect(() => {
    if (!feedActive) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasElement: HTMLCanvasElement = canvas;

    const motionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    const syncMotion = (): void => {
      optionsRef.current.reducedMotion = motionQuery?.matches ?? false;
      scheduleRenderRef.current?.();
    };
    syncMotion();
    motionQuery?.addEventListener?.('change', syncMotion);

    const hasNativeRaf = typeof requestAnimationFrame === 'function';
    const requestFrame = (callback: FrameRequestCallback): number => (
      hasNativeRaf
        ? requestAnimationFrame(callback)
        : window.setTimeout(() => callback(performance.now()), 16)
    );
    const cancelFrame = (id: number): void => {
      if (hasNativeRaf) cancelAnimationFrame(id);
      else window.clearTimeout(id);
    };

    let disposed = false;
    let raf: number | null = null;

    const schedule = (): void => {
      if (disposed || raf !== null) return;
      raf = requestFrame(loop);
    };
    scheduleRenderRef.current = schedule;

    function loop(now: number): void {
      raf = null;
      if (disposed) return;

      const feed = feedRef.current;
      feed.sample(now);
      const surface = setupCanvas(canvasElement);
      if (surface) {
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
      }

      if (feed.shouldAnimate) schedule();
    }

    const unsubscribeFeed = feedRef.current.subscribe(schedule);
    schedule();

    return () => {
      disposed = true;
      if (scheduleRenderRef.current === schedule) scheduleRenderRef.current = null;
      unsubscribeFeed();
      if (raf !== null) cancelFrame(raf);
      motionQuery?.removeEventListener?.('change', syncMotion);
      const ctx = canvasElement.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    };
  }, [feedActive, feedRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => scheduleRenderRef.current?.());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className ? `psy-viz-canvas ${className}` : 'psy-viz-canvas'}
      // Decorative: the audio it depicts is already announced by the player.
      aria-hidden="true"
    />
  );
}
