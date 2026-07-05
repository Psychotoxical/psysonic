import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { analysisGetPipelineQueueStats, type AnalysisPipelineQueueStatsDto } from '@/lib/api/analysis';
import { coverGetPipelineQueueStats, type CoverPipelineQueueStatsDto } from '@/lib/api/coverCache';
import { coverEnsureQueueStats } from '@/cover/ensureQueue';
import { coverPeekQueueStats } from '@/cover/peekQueue';
import PerfOverlaySparkline from '@/app/PerfOverlaySparkline';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import {
  formatPerfMs,
  getAnalysisTracksPerMinute,
  useAnalysisPerfLast,
} from '@/lib/perf/analysisPerfStore';
import { formatAnalysisPipelineQueueOverlay } from '@/lib/perf/formatAnalysisQueueStats';
import { formatCoverPipelineQueueOverlay } from '@/lib/perf/formatCoverPipelineQueueOverlay';
import {
  buildLiveOverlayItems,
  type LiveOverlayItem,
} from '@/lib/perf/formatLiveOverlayItems';
import {
  getPerfLiveHistorySamples,
} from '@/lib/perf/perfLiveHistory';
import { usePerfLiveSnapshot } from '@/lib/perf/perfLiveStore';
import { usePerfLiveOverlayPins } from '@/lib/perf/perfOverlayPins';
import {
  perfOverlayCornerClass,
  usePerfOverlayAppearance,
} from '@/lib/perf/perfOverlayAppearance';
import {
  resolveOverlayVisibility,
  usePerfOverlayMode,
} from '@/lib/perf/perfOverlayMode';
import { useAnalysisPerfListener } from '@/lib/hooks/useAnalysisPerfListener';
import { useCoverPerfListener } from '@/cover/useCoverPerfListener';
import { getCoverCachedPerMinute, getCoverUiPerMinute } from '@/lib/perf/coverPerfStore';

const SAMPLE_MS = 500;
const TPM_REFRESH_MS = 500;
const QUEUE_STATS_MS = 750;

function LiveOverlayPinnedMetric({
  item,
  now,
  history,
}: {
  item: LiveOverlayItem;
  now: number;
  history: ReturnType<typeof getPerfLiveHistorySamples>;
}) {
  const sparklineKind = item.kind === 'memory' ? 'memory' : 'cpu';

  return (
    <div className="fps-overlay__live-metric">
      <div className="fps-overlay__row fps-overlay__row--live">{item.line}</div>
      {item.sparkline && (
        <PerfOverlaySparkline samples={history} kind={sparklineKind} now={now} />
      )}
    </div>
  );
}

/** FPS + pipeline + pinned live metrics overlay (PsyLab). */
export default function FpsOverlay() {
  const overlayMode = usePerfOverlayMode();
  const perfFlags = usePerfProbeFlags();
  const livePins = usePerfLiveOverlayPins();
  const live = usePerfLiveSnapshot();
  const overlayAppearance = usePerfOverlayAppearance();
  const [fps, setFps] = useState(0);
  const [tpm, setTpm] = useState(0);
  const [cpm, setCpm] = useState(0);
  const [cpmUi, setCpmUi] = useState(0);
  const [queueStats, setQueueStats] = useState<AnalysisPipelineQueueStatsDto | null>(null);
  const [coverQueueLines, setCoverQueueLines] = useState<string[]>([]);
  const last = useAnalysisPerfLast();

  const liveOverlayItems = useMemo(
    () => buildLiveOverlayItems(livePins, live),
    [livePins, live],
  );

  const visibility = useMemo(
    () => resolveOverlayVisibility(overlayMode, perfFlags, liveOverlayItems.length),
    [overlayMode, perfFlags, liveOverlayItems.length],
  );

  const {
    showFps: showFpsOverlay,
    showAnalysis: showAnalysisPerfOverlay,
    showCover: showCoverPerfOverlay,
    showLive,
  } = visibility;

  const sparklineNow = useMemo(
    // React Compiler purity rule: intentional live-timestamp read at render (Date.now()); the value is allowed to differ between renders.
    // eslint-disable-next-line react-hooks/purity
    () => (live.sampleAt > 0 ? live.sampleAt : Date.now()),
    [live.sampleAt],
  );

  useAnalysisPerfListener(showAnalysisPerfOverlay || livePins.has('analysis:tpm') || livePins.has('analysis:last'));
  useCoverPerfListener(showCoverPerfOverlay || livePins.has('cover:cpm'));

  useEffect(() => {
    if (!showAnalysisPerfOverlay) {
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCpm(0);
      setCpmUi(0);
      return;
    }
    const refresh = () => {
      setCpm(getCoverCachedPerMinute());
      setCpmUi(getCoverUiPerMinute());
    };
    refresh();
    const id = window.setInterval(refresh, TPM_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [showCoverPerfOverlay]);

  useEffect(() => {
    if (!showCoverPerfOverlay) {
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  if (overlayMode === 'off') return null;
  if (!showFpsOverlay && !showAnalysisPerfOverlay && !showCoverPerfOverlay && !showLive) return null;

  const analysisQueueLines = queueStats ? formatAnalysisPipelineQueueOverlay(queueStats) : [];

  return createPortal(
    <div
      className={`fps-overlay ${perfOverlayCornerClass(overlayAppearance.corner)}`}
      style={{ '--fps-overlay-opacity': overlayAppearance.opacity } as CSSProperties}
      aria-hidden="true"
    >
      {showFpsOverlay && (
        <div className="fps-overlay__row fps-overlay__row--fps">
          {fps}
          {' '}
          <span className="fps-overlay__unit">FPS</span>
        </div>
      )}
      {showLive && (
        <div className="fps-overlay__block">
          <div className="fps-overlay__block-title">Live</div>
          {liveOverlayItems.map(item => (
            <LiveOverlayPinnedMetric
              key={item.id}
              item={item}
              now={sparklineNow}
              history={item.sparkline ? getPerfLiveHistorySamples(item.id) : []}
            />
          ))}
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
          <div className="fps-overlay__row">
            {cpm.toFixed(1)}
            {' '}
            <span className="fps-overlay__unit">lib cpm</span>
          </div>
          <div className="fps-overlay__row">
            {cpmUi.toFixed(1)}
            {' '}
            <span className="fps-overlay__unit">ui cpm</span>
          </div>
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
