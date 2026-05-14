import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePerfProbeFlag } from '../utils/perf/perfFlags';

const SAMPLE_MS = 500;

/** FPS from rAF callbacks over sliding ~500ms windows; only runs when Performance Probe enables the overlay. */
export default function FpsOverlay() {
  const showFpsOverlay = usePerfProbeFlag('showFpsOverlay');
  const [fps, setFps] = useState(0);

  useEffect(() => {
    if (!showFpsOverlay) {
      setFps(0);
      return;
    }

    let frames = 0;
    let lastReport = performance.now();
    let rafId = 0;

    const loop = () => {
      frames++;
      const now = performance.now();
      if (now - lastReport >= SAMPLE_MS) {
        const elapsedSec = (now - lastReport) / 1000;
        setFps(Math.round(frames / elapsedSec));
        frames = 0;
        lastReport = now;
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [showFpsOverlay]);

  if (!showFpsOverlay) return null;

  return createPortal(
    <div className="fps-overlay" aria-hidden="true">
      {fps}
      {' '}
      <span className="fps-overlay__unit">FPS</span>
    </div>,
    document.body,
  );
}
