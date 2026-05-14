import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { setPerfProbeTelemetryActive } from '../utils/perf/perfTelemetry';

interface PerfCpu {
  app: number;
  webkit: number;
  supported: boolean;
}

interface PerfDiagRates {
  progress: number;
  waveform: number;
  home: number;
}

interface Result {
  perfProbeOpen: boolean;
  setPerfProbeOpen: (open: boolean) => void;
  perfCpu: PerfCpu | null;
  perfDiagRates: PerfDiagRates | null;
}

/** Wires up Ctrl+Shift+D to open the perf probe; polls CPU + diag-rate counters
 *  every 2s while it is open. */
export function useSidebarPerfProbe(): Result {
  const [perfProbeOpen, setPerfProbeOpen] = useState(false);
  const [perfCpu, setPerfCpu] = useState<PerfCpu | null>(null);
  const [perfDiagRates, setPerfDiagRates] = useState<PerfDiagRates | null>(null);

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
    if (!perfProbeOpen) return;
    type Snapshot = {
      supported: boolean;
      total_jiffies: number;
      app_jiffies: number;
      webkit_jiffies: number;
      logical_cpus: number;
    };
    let cancelled = false;
    let prev: Snapshot | null = null;
    let prevCounters: { progress: number; waveform: number; home: number } | null = null;
    let prevCountersAt = 0;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const snap = await invoke<Snapshot>('performance_cpu_snapshot');
        if (cancelled) return;
        if (!snap.supported) {
          setPerfCpu({ app: 0, webkit: 0, supported: false });
          return;
        }
        if (prev) {
          const totalDelta = snap.total_jiffies - prev.total_jiffies;
          const appDelta = snap.app_jiffies - prev.app_jiffies;
          const webkitDelta = snap.webkit_jiffies - prev.webkit_jiffies;
          if (totalDelta > 0) {
            const cpuScale = Math.max(1, snap.logical_cpus || 1) * 100;
            const appPct = Math.max(0, Math.min(1000, (appDelta / totalDelta) * cpuScale));
            const webkitPct = Math.max(0, Math.min(1000, (webkitDelta / totalDelta) * cpuScale));
            setPerfCpu({
              app: Number.isFinite(appPct) ? appPct : 0,
              webkit: Number.isFinite(webkitPct) ? webkitPct : 0,
              supported: true,
            });
          }
        }
        const now = Date.now();
        const root = globalThis as unknown as { __psyPerfCounters?: Record<string, number> };
        const counters = root.__psyPerfCounters ?? {};
        const nextCounters = {
          progress: counters.audioProgressEvents ?? 0,
          waveform: counters.waveformDraws ?? 0,
          home: counters.homeCommits ?? 0,
        };
        if (prevCounters && prevCountersAt > 0) {
          const dt = Math.max(0.25, (now - prevCountersAt) / 1000);
          setPerfDiagRates({
            progress: (nextCounters.progress - prevCounters.progress) / dt,
            waveform: (nextCounters.waveform - prevCounters.waveform) / dt,
            home: (nextCounters.home - prevCounters.home) / dt,
          });
        }
        prevCounters = nextCounters;
        prevCountersAt = now;
        prev = snap;
      } catch {
        if (!cancelled) setPerfCpu({ app: 0, webkit: 0, supported: false });
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [perfProbeOpen]);

  useEffect(() => {
    if (!perfProbeOpen) {
      setPerfCpu(null);
      setPerfDiagRates(null);
    }
  }, [perfProbeOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey)) return;
      if (e.key.toLowerCase() !== 'd') return;
      const target = e.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      )) return;
      e.preventDefault();
      setPerfProbeOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { perfProbeOpen, setPerfProbeOpen, perfCpu, perfDiagRates };
}
