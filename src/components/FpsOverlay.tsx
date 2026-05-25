import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { analysisGetPipelineQueueStats, type AnalysisPipelineQueueStatsDto } from '../api/analysis';
import { usePerfProbeFlag } from '../utils/perf/perfFlags';
import {
  formatPerfMs,
  getAnalysisTracksPerMinute,
  useAnalysisPerfLast,
} from '../utils/perf/analysisPerfStore';
import { formatAnalysisPipelineQueueOverlay } from '../utils/perf/formatAnalysisQueueStats';
import { useAnalysisPerfListener } from '../hooks/useAnalysisPerfListener';

const SAMPLE_MS = 500;
const TPM_REFRESH_MS = 500;
const QUEUE_STATS_MS = 750;

/** FPS + analysis throughput overlay (Performance Probe). */
export default function FpsOverlay() {
  const showFpsOverlay = usePerfProbeFlag('showFpsOverlay');
  const showAnalysisPerfOverlay = usePerfProbeFlag('showAnalysisPerfOverlay');
  const [fps, setFps] = useState(0);
  const [tpm, setTpm] = useState(0);
  const [queueStats, setQueueStats] = useState<AnalysisPipelineQueueStatsDto | null>(null);
  const last = useAnalysisPerfLast();

  useAnalysisPerfListener(showAnalysisPerfOverlay);

  useEffect(() => {
    if (!showAnalysisPerfOverlay) {
      setTpm(0);
      return;
    }
    const refresh = () => setTpm(getAnalysisTracksPerMinute());
    refresh();
    const id = window.setInterval(refresh, TPM_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [showAnalysisPerfOverlay, last?.at]);

  useEffect(() => {
    if (!showAnalysisPerfOverlay) {
      setQueueStats(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void analysisGetPipelineQueueStats()
        .then(stats => {
          if (!cancelled) setQueueStats(stats);
        })
        .catch(() => {
          if (!cancelled) setQueueStats(null);
        });
    };
    refresh();
    const id = window.setInterval(refresh, QUEUE_STATS_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [showAnalysisPerfOverlay]);

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

  if (!showFpsOverlay && !showAnalysisPerfOverlay) return null;

  return createPortal(
    <div className="fps-overlay" aria-hidden="true">
      {showFpsOverlay && (
        <div className="fps-overlay__row">
          {fps}
          {' '}
          <span className="fps-overlay__unit">FPS</span>
        </div>
      )}
      {showAnalysisPerfOverlay && (
        <>
          <div className="fps-overlay__row">
            {tpm.toFixed(1)}
            {' '}
            <span className="fps-overlay__unit">tpm</span>
          </div>
          {last && (
            <>
              <div className="fps-overlay__row fps-overlay__row--detail">
                last
                {' '}
                {formatPerfMs(last.totalMs)}
              </div>
              <div className="fps-overlay__row fps-overlay__row--steps">
                f
                {formatPerfMs(last.fetchMs)}
                {' · '}
                s
                {formatPerfMs(last.seedMs)}
                {' · '}
                b
                {formatPerfMs(last.bpmMs)}
              </div>
            </>
          )}
          {queueStats && formatAnalysisPipelineQueueOverlay(queueStats).map(line => (
            <div key={line} className="fps-overlay__row fps-overlay__row--steps">
              {line}
            </div>
          ))}
        </>
      )}
    </div>,
    document.body,
  );
}
