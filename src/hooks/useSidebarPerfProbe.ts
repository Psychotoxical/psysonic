import { useEffect, useState } from 'react';
import { acquirePerfLivePoll, patchPerfLiveAnalysis } from '../utils/perf/perfLiveStore';
import { setPerfProbeTelemetryActive } from '../utils/perf/perfTelemetry';
import { useAnalysisPerfLast } from '../utils/perf/analysisPerfStore';
import { useAnalysisPerfListener } from './useAnalysisPerfListener';
import {
  getPerfProbeFlags,
  subscribePerfProbeFlags,
} from '../utils/perf/perfFlags';
import { hasAnyLiveMetricPollNeed, usePerfLiveOverlayPins } from '../utils/perf/perfOverlayPins';
import { useSyncExternalStore } from 'react';

interface Result {
  perfProbeOpen: boolean;
  setPerfProbeOpen: (open: boolean) => void;
}

function useNeedAnalysisTelemetry(perfProbeOpen: boolean, livePins: ReadonlySet<string>): boolean {
  return useSyncExternalStore(
    subscribePerfProbeFlags,
    () => {
      const flags = getPerfProbeFlags();
      return (
        perfProbeOpen
        || flags.showAnalysisPerfOverlay
        || livePins.has('analysis:tpm')
        || livePins.has('analysis:last')
      );
    },
    () => perfProbeOpen,
  );
}

/** Wires Ctrl+Shift+D probe modal and shared live metric polling. */
export function useSidebarPerfProbe(): Result {
  const [perfProbeOpen, setPerfProbeOpen] = useState(false);
  const livePins = usePerfLiveOverlayPins();
  const analysisLast = useAnalysisPerfLast();
  const needAnalysis = useNeedAnalysisTelemetry(perfProbeOpen, livePins);

  useAnalysisPerfListener(needAnalysis);

  useEffect(() => {
    setPerfProbeTelemetryActive(perfProbeOpen);
    return () => setPerfProbeTelemetryActive(false);
  }, [perfProbeOpen]);

  useEffect(() => {
    if (!perfProbeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPerfProbeOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [perfProbeOpen]);

  useEffect(() => {
    const releases: Array<() => void> = [];
    if (perfProbeOpen) releases.push(acquirePerfLivePoll('modal'));
    if (hasAnyLiveMetricPollNeed()) releases.push(acquirePerfLivePoll('overlay-pins'));
    if (releases.length === 0) return;
    return () => releases.forEach(release => release());
  }, [perfProbeOpen, livePins.size]);

  useEffect(() => {
    patchPerfLiveAnalysis({
      lastTotalMs: analysisLast?.totalMs ?? null,
      lastFetchMs: analysisLast?.fetchMs ?? null,
      lastSeedMs: analysisLast?.seedMs ?? null,
      lastBpmMs: analysisLast?.bpmMs ?? null,
    });
  }, [
    analysisLast?.at,
    analysisLast?.totalMs,
    analysisLast?.fetchMs,
    analysisLast?.seedMs,
    analysisLast?.bpmMs,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey)) return;
      if (e.key.toLowerCase() !== 'd') return;
      const target = e.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      )) return;
      e.preventDefault();
      setPerfProbeOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return {
    perfProbeOpen,
    setPerfProbeOpen,
  };
}
