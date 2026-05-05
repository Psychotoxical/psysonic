import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePerfProbeFlags } from '../utils/perfFlags';

/** Average requestAnimationFrame rate; gated by Performance Probe → Show FPS overlay. */
export default function FpsOverlay() {
  const showFpsOverlay = usePerfProbeFlags().showFpsOverlay;
  const [fps, setFps] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!showFpsOverlay) {
      setFps(0);
      return;
    }

    let frames = 0;
    let lastReport = performance.now();

    const loop = () => {
      frames++;
      const now = performance.now();
      if (now - lastReport >= 500) {
        const elapsedSec = (now - lastReport) / 1000;
        setFps(Math.round(frames / elapsedSec));
        frames = 0;
        lastReport = now;
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
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
