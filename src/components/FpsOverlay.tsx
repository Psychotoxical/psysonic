import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { analysisGetPipelineQueueStats, type AnalysisPipelineQueueStatsDto } from '../api/analysis';
import { coverGetPipelineQueueStats, type CoverPipelineQueueStatsDto } from '../api/coverCache';
import { coverEnsureQueueStats } from '../cover/ensureQueue';
import { coverPeekQueueStats } from '../cover/peekQueue';
import { usePerfProbeFlag } from '../utils/perf/perfFlags';
import {
  formatPerfMs,
  getAnalysisTracksPerMinute,
  useAnalysisPerfLast,
} from '../utils/perf/analysisPerfStore';
import { formatAnalysisPipelineQueueOverlay } from '../utils/perf/formatAnalysisQueueStats';
import { formatCoverPipelineQueueOverlay } from '../utils/perf/formatCoverPipelineQueueOverlay';
import { formatLiveOverlayLines } from '../utils/perf/formatLiveOverlayLines';
import { acquirePerfLivePoll, usePerfLiveSnapshot } from '../utils/perf/perfLiveStore';
import { hasAnyLiveMetricPollNeed, usePerfLiveOverlayPins } from '../utils/perf/perfOverlayPins';
import {
  perfOverlayCornerClass,
  usePerfOverlayAppearance,
} from '../utils/perf/perfOverlayAppearance';
import { useAnalysisPerfListener } from '../hooks/useAnalysisPerfListener';

const SAMPLE_MS = 500;
const TPM_REFRESH_MS = 500;
const QUEUE_STATS_MS = 750;

/** FPS + pipeline + pinned live metrics overlay (Performance Probe). */
export default function FpsOverlay() {
  const showFpsOverlay = usePerfProbeFlag('showFpsOverlay');
  const showAnalysisPerfOverlay = usePerfProbeFlag('showAnalysisPerfOverlay');
  const showCoverPerfOverlay = usePerfProbeFlag('showCoverPerfOverlay');
  const livePins = usePerfLiveOverlayPins();
  const live = usePerfLiveSnapshot();
  const overlayAppearance = usePerfOverlayAppearance();
  const [fps, setFps] = useState(0);
  const [tpm, setTpm] = useState(0);
  const [queueStats, setQueueStats] = useState<AnalysisPipelineQueueStatsDto | null>(null);
  const [coverQueueLines, setCoverQueueLines] = useState<string[]>([]);
  const last = useAnalysisPerfLast();

  const liveOverlayLines = formatLiveOverlayLines(livePins, live);

  useAnalysisPerfListener(showAnalysisPerfOverlay || livePins.has('analysis:tpm') || livePins.has('analysis:last'));

  useEffect(() => {
    if (!hasAnyLiveMetricPollNeed()) return;
    return acquirePerfLivePoll('overlay-pins');
  }, [livePins.size]);

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
    if (!showCoverPerfOverlay) {
      setCoverQueueLines([]);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void coverGetPipelineQueueStats()
        .then((rust: CoverPipelineQueueStatsDto) => {
          if (cancelled) return;
          setCoverQueueLines(
            formatCoverPipelineQueueOverlay({
              rust,
              ensure: coverEnsureQueueStats(),
              peek: coverPeekQueueStats(),
            }),
          );
        })
        .catch(() => {
          if (!cancelled) setCoverQueueLines([]);
        });
    };
    refresh();
    const id = window.setInterval(refresh, QUEUE_STATS_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [showCoverPerfOverlay]);

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

  const showPipeline = showFpsOverlay || showAnalysisPerfOverlay || showCoverPerfOverlay;
  const showLive = liveOverlayLines.length > 0;

  if (!showPipeline && !showLive) return null;

  const analysisQueueLines = queueStats ? formatAnalysisPipelineQueueOverlay(queueStats) : [];

  return createPortal(
    <div
      className={`fps-overlay ${perfOverlayCornerClass(overlayAppearance.corner)}`}
      style={{ '--fps-overlay-opacity': overlayAppearance.opacity } as CSSProperties}
      aria-hidden="true"
    >
      {showLive && (
        <div className="fps-overlay__block">
          <div className="fps-overlay__block-title">Live</div>
          {liveOverlayLines.map(line => (
            <div key={line} className="fps-overlay__row fps-overlay__row--live">
              {line}
            </div>
          ))}
        </div>
      )}
      {showFpsOverlay && (
        <div className="fps-overlay__row fps-overlay__row--fps">
          {fps}
          {' '}
          <span className="fps-overlay__unit">FPS</span>
        </div>
      )}
      {showAnalysisPerfOverlay && (
        <div className="fps-overlay__block">
          <div className="fps-overlay__block-title">Analysis pipeline</div>
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
          {analysisQueueLines.map(line => (
            <div key={line} className="fps-overlay__row fps-overlay__row--steps">
              {line}
            </div>
          ))}
        </div>
      )}
      {showCoverPerfOverlay && (
        <div className="fps-overlay__block">
          <div className="fps-overlay__block-title">Cover pipeline</div>
          {coverQueueLines.length > 0 ? coverQueueLines.map(line => (
            <div key={line} className="fps-overlay__row fps-overlay__row--steps">
              {line}
            </div>
          )) : (
            <div className="fps-overlay__row fps-overlay__row--steps">collecting…</div>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
