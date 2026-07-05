import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { recordAnalysisTrackPerf } from '@/lib/perf/analysisPerfStore';

type AnalysisTrackPerfPayload = {
  trackId: string;
  fetchMs: number;
  seedMs: number;
  bpmMs: number;
  totalMs: number;
};

/** Wire Rust `analysis:track-perf` events into the perf probe store. */
export function useAnalysisPerfListener(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<AnalysisTrackPerfPayload>('analysis:track-perf', ({ payload }) => {
      if (cancelled || !payload?.trackId) return;
      recordAnalysisTrackPerf({
        trackId: payload.trackId,
        fetchMs: payload.fetchMs ?? 0,
        seedMs: payload.seedMs ?? 0,
        bpmMs: payload.bpmMs ?? 0,
        totalMs: payload.totalMs ?? 0,
      });
    }).then(fn => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active]);
}
