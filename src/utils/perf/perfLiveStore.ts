import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { clearPerfLiveHistory } from './perfLiveHistory';
import { getAnalysisTracksPerMinute } from './analysisPerfStore';
import {
  buildPerfCpuSnapshotRequest,
  getPerfLivePollIntervalMs,
  registerPerfLivePollScheduleBump,
} from './perfLivePollSettings';

export type PerfProcessMemory = {
  label: string;
  rss_kb: number;
};

export type PerfThreadCpu = {
  label: string;
  threadCount: number;
  pct: number;
};

export type PerfLiveCpu = {
  app: number;
  webkit: number;
  supported: boolean;
  memory: PerfProcessMemory[];
  threadCpu: PerfThreadCpu[];
};

export type PerfDiagRates = {
  progress: number;
  waveform: number;
  home: number;
};

export type PerfAnalysisDiag = {
  tracksPerMinute: number;
  lastTotalMs: number | null;
  lastFetchMs: number | null;
  lastSeedMs: number | null;
  lastBpmMs: number | null;
};

export type PerfLiveSnapshot = {
  cpu: PerfLiveCpu | null;
  diagRates: PerfDiagRates | null;
  analysis: PerfAnalysisDiag | null;
  collecting: boolean;
  /** Wall time of the last CPU poll; shared clock for overlay sparklines. */
  updatedAt: number;
};

type ProcSnapshot = {
  supported: boolean;
  total_jiffies: number;
  app_jiffies: number;
  webkit_jiffies: number;
  logical_cpus: number;
  memory: PerfProcessMemory[];
  thread_cpu_groups: Array<{ label: string; thread_count: number; jiffies: number }>;
};

const EMPTY: PerfLiveSnapshot = {
  cpu: null,
  diagRates: null,
  analysis: null,
  collecting: false,
  updatedAt: 0,
};

let snapshot: PerfLiveSnapshot = { ...EMPTY };
let pollRefCount = 0;
const listeners = new Set<() => void>();
let pollTimer: number | null = null;
let prevProc: ProcSnapshot | null = null;
let prevCounters: { progress: number; waveform: number; home: number } | null = null;
let prevCountersAt = 0;
let pollGeneration = 0;

function emit(): void {
  listeners.forEach(fn => fn());
}

function setSnapshot(next: PerfLiveSnapshot): void {
  snapshot = next;
  emit();
}

function readUiCounters(): { progress: number; waveform: number; home: number } {
  const root = globalThis as unknown as { __psyPerfCounters?: Record<string, number> };
  const counters = root.__psyPerfCounters ?? {};
  return {
    progress: counters.audioProgressEvents ?? 0,
    waveform: counters.waveformDraws ?? 0,
    home: counters.homeCommits ?? 0,
  };
}

async function pollOnce(): Promise<void> {
  const generation = pollGeneration;
  const now = Date.now();
  try {
    const snap = await invoke<ProcSnapshot>('performance_cpu_snapshot', buildPerfCpuSnapshotRequest());
    if (generation !== pollGeneration) return;

    if (!snap.supported) {
      setSnapshot({
        cpu: { app: 0, webkit: 0, supported: false, memory: [], threadCpu: [] },
        diagRates: snapshot.diagRates,
        analysis: {
          tracksPerMinute: getAnalysisTracksPerMinute(),
          lastTotalMs: snapshot.analysis?.lastTotalMs ?? null,
          lastFetchMs: snapshot.analysis?.lastFetchMs ?? null,
          lastSeedMs: snapshot.analysis?.lastSeedMs ?? null,
          lastBpmMs: snapshot.analysis?.lastBpmMs ?? null,
        },
        collecting: false,
        updatedAt: now,
      });
      return;
    }

    const memory = snap.memory;
    let cpu: PerfLiveCpu = {
      app: snapshot.cpu?.app ?? 0,
      webkit: snapshot.cpu?.webkit ?? 0,
      supported: true,
      memory,
      threadCpu: snap.thread_cpu_groups.map(g => ({
        label: g.label,
        threadCount: g.thread_count,
        pct: snapshot.cpu?.threadCpu.find(t => t.label === g.label)?.pct ?? 0,
      })),
    };

    if (prevProc) {
      const totalDelta = snap.total_jiffies - prevProc.total_jiffies;
      const appDelta = snap.app_jiffies - prevProc.app_jiffies;
      const webkitDelta = snap.webkit_jiffies - prevProc.webkit_jiffies;
      if (totalDelta > 0) {
        const cpuScale = Math.max(1, snap.logical_cpus || 1) * 100;
        const prevThreadByLabel = new Map(
          prevProc.thread_cpu_groups.map(g => [g.label, g.jiffies]),
        );
        cpu = {
          app: clampPct((appDelta / totalDelta) * cpuScale),
          webkit: clampPct((webkitDelta / totalDelta) * cpuScale),
          supported: true,
          memory,
          threadCpu: snap.thread_cpu_groups.map(g => {
            const prevJiffies = prevThreadByLabel.get(g.label) ?? g.jiffies;
            const delta = g.jiffies - prevJiffies;
            return {
              label: g.label,
              threadCount: g.thread_count,
              pct: clampPct((delta / totalDelta) * cpuScale),
            };
          }),
        };
      }
    }

    const nextCounters = readUiCounters();
    let diagRates = snapshot.diagRates;
    if (prevCounters && prevCountersAt > 0) {
      const dt = Math.max(0.25, (now - prevCountersAt) / 1000);
      diagRates = {
        progress: (nextCounters.progress - prevCounters.progress) / dt,
        waveform: (nextCounters.waveform - prevCounters.waveform) / dt,
        home: (nextCounters.home - prevCounters.home) / dt,
      };
    }
    prevCounters = nextCounters;
    prevCountersAt = now;
    prevProc = snap;

    setSnapshot({
      cpu,
      diagRates,
      analysis: {
        tracksPerMinute: getAnalysisTracksPerMinute(),
        lastTotalMs: snapshot.analysis?.lastTotalMs ?? null,
        lastFetchMs: snapshot.analysis?.lastFetchMs ?? null,
        lastSeedMs: snapshot.analysis?.lastSeedMs ?? null,
        lastBpmMs: snapshot.analysis?.lastBpmMs ?? null,
      },
      collecting: false,
      updatedAt: now,
    });
  } catch {
    if (generation !== pollGeneration) return;
    setSnapshot({
      ...snapshot,
      cpu: { app: 0, webkit: 0, supported: false, memory: [], threadCpu: [] },
      collecting: false,
      updatedAt: Date.now(),
    });
  }
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1000, value));
}

function schedulePoll(): void {
  if (pollTimer != null) return;
  setSnapshot({ ...snapshot, collecting: snapshot.cpu == null });
  const intervalMs = getPerfLivePollIntervalMs();
  const tick = () => {
    pollTimer = null;
    if (pollRefCount === 0) return;
    void pollOnce().finally(() => {
      if (pollRefCount > 0) {
        pollTimer = window.setTimeout(tick, getPerfLivePollIntervalMs());
      }
    });
  };
  void pollOnce().finally(() => {
    if (pollRefCount > 0) {
      pollTimer = window.setTimeout(tick, intervalMs);
    }
  });
}

/** Restart the poll loop after interval / snapshot options change. */
export function bumpPerfLivePollSchedule(): void {
  if (pollRefCount === 0) return;
  pollGeneration += 1;
  if (pollTimer != null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  // Fresh baseline after interval / thread-group option changes.
  prevProc = null;
  schedulePoll();
}

registerPerfLivePollScheduleBump(bumpPerfLivePollSchedule);

function stopPoll(): void {
  pollGeneration += 1;
  if (pollTimer != null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  prevProc = null;
  prevCounters = null;
  prevCountersAt = 0;
  clearPerfLiveHistory();
  setSnapshot({ ...EMPTY });
}

export function acquirePerfLivePoll(_reason: string): () => void {
  const start = pollRefCount === 0;
  pollRefCount += 1;
  if (start) schedulePoll();
  return () => {
    pollRefCount = Math.max(0, pollRefCount - 1);
    if (pollRefCount === 0) stopPoll();
  };
}

export function patchPerfLiveAnalysis(partial: Partial<PerfAnalysisDiag>): void {
  setSnapshot({
    ...snapshot,
    analysis: {
      tracksPerMinute: partial.tracksPerMinute ?? snapshot.analysis?.tracksPerMinute ?? 0,
      lastTotalMs: partial.lastTotalMs ?? snapshot.analysis?.lastTotalMs ?? null,
      lastFetchMs: partial.lastFetchMs ?? snapshot.analysis?.lastFetchMs ?? null,
      lastSeedMs: partial.lastSeedMs ?? snapshot.analysis?.lastSeedMs ?? null,
      lastBpmMs: partial.lastBpmMs ?? snapshot.analysis?.lastBpmMs ?? null,
    },
  });
}

export function getPerfLiveSnapshot(): PerfLiveSnapshot {
  return snapshot;
}

export function subscribePerfLiveSnapshot(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePerfLiveSnapshot(): PerfLiveSnapshot {
  return useSyncExternalStore(subscribePerfLiveSnapshot, getPerfLiveSnapshot, () => EMPTY);
}
