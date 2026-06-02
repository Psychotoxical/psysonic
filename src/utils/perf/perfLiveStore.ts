import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { clearPerfLiveHistory, syncPerfLiveHistoryFromPoll } from './perfLiveHistory';
import { getAnalysisTracksPerMinute } from './analysisPerfStore';
import { getCoverCachedPerMinute, getCoverUiPerMinute, getCoverPerfState } from './coverPerfStore';
import { perfLiveCpuSnapshotSupported } from './perfLiveCpuSnapshot';
import { getPerfLiveOverlayPins } from './perfOverlayPins';
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

export type PerfCoverDiag = {
  cachedPerMinute: number;
  uiPerMinute: number;
  done: number;
  total: number;
  pending: number;
};

export type PerfLiveSnapshot = {
  cpu: PerfLiveCpu | null;
  diagRates: PerfDiagRates | null;
  analysis: PerfAnalysisDiag | null;
  cover: PerfCoverDiag | null;
  collecting: boolean;
  /** Wall time of the last displayed sample change (memory / diag / rates). */
  updatedAt: number;
  /** Wall time of the last CPU rate sample; stable sparkline clock between polls. */
  sampleAt: number;
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
  cover: null,
  collecting: false,
  updatedAt: 0,
  sampleAt: 0,
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

function memoryRowsEqual(a: readonly PerfProcessMemory[], b: readonly PerfProcessMemory[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => row.label === b[index].label && row.rss_kb === b[index].rss_kb);
}

function threadCpuEqual(a: readonly PerfThreadCpu[], b: readonly PerfThreadCpu[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => (
    row.label === b[index].label
    && row.pct === b[index].pct
    && row.threadCount === b[index].threadCount
  ));
}

function diagRatesEqual(a: PerfDiagRates | null, b: PerfDiagRates | null): boolean {
  if (a == null || b == null) return a === b;
  return a.progress === b.progress && a.waveform === b.waveform && a.home === b.home;
}

function analysisEqual(a: PerfAnalysisDiag | null, b: PerfAnalysisDiag | null): boolean {
  if (a == null || b == null) return a === b;
  return a.tracksPerMinute === b.tracksPerMinute
    && a.lastTotalMs === b.lastTotalMs
    && a.lastFetchMs === b.lastFetchMs
    && a.lastSeedMs === b.lastSeedMs
    && a.lastBpmMs === b.lastBpmMs;
}

function coverEqual(a: PerfCoverDiag | null, b: PerfCoverDiag | null): boolean {
  if (a == null || b == null) return a === b;
  return a.cachedPerMinute === b.cachedPerMinute
    && a.uiPerMinute === b.uiPerMinute
    && a.done === b.done
    && a.total === b.total
    && a.pending === b.pending;
}

function cpuEqual(a: PerfLiveCpu | null, b: PerfLiveCpu | null): boolean {
  if (a == null || b == null) return a === b;
  return a.app === b.app
    && a.webkit === b.webkit
    && a.supported === b.supported
    && memoryRowsEqual(a.memory, b.memory)
    && threadCpuEqual(a.threadCpu, b.threadCpu);
}

function publishLiveSnapshot(next: PerfLiveSnapshot): void {
  const cpuChanged = !cpuEqual(snapshot.cpu, next.cpu);
  const diagChanged = !diagRatesEqual(snapshot.diagRates, next.diagRates);
  const analysisChanged = !analysisEqual(snapshot.analysis, next.analysis);
  const coverChanged = !coverEqual(snapshot.cover, next.cover);
  if (!cpuChanged && !diagChanged && !analysisChanged && !coverChanged && next.updatedAt === snapshot.updatedAt) {
    return;
  }
  if (next.sampleAt > snapshot.sampleAt && next.cpu?.supported) {
    syncPerfLiveHistoryFromPoll(getPerfLiveOverlayPins(), next, { emit: false });
  }
  setSnapshot(next);
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

function buildAnalysisDiag(): PerfAnalysisDiag {
  return {
    tracksPerMinute: getAnalysisTracksPerMinute(),
    lastTotalMs: snapshot.analysis?.lastTotalMs ?? null,
    lastFetchMs: snapshot.analysis?.lastFetchMs ?? null,
    lastSeedMs: snapshot.analysis?.lastSeedMs ?? null,
    lastBpmMs: snapshot.analysis?.lastBpmMs ?? null,
  };
}

function buildCoverDiag(): PerfCoverDiag {
  const cover = getCoverPerfState();
  return {
    cachedPerMinute: getCoverCachedPerMinute(),
    uiPerMinute: getCoverUiPerMinute(),
    done: cover.done,
    total: cover.total,
    pending: cover.pending,
  };
}

function nextDiagRates(
  nextCounters: { progress: number; waveform: number; home: number },
  now: number,
): PerfDiagRates | null {
  if (!prevCounters || prevCountersAt <= 0) return snapshot.diagRates;
  const dt = Math.max(0.25, (now - prevCountersAt) / 1000);
  return {
    progress: (nextCounters.progress - prevCounters.progress) / dt,
    waveform: (nextCounters.waveform - prevCounters.waveform) / dt,
    home: (nextCounters.home - prevCounters.home) / dt,
  };
}

const UNSUPPORTED_CPU: PerfLiveCpu = {
  app: 0,
  webkit: 0,
  supported: false,
  memory: [],
  threadCpu: [],
};

function applyJsMetricsSnapshot(now: number): void {
  const nextCounters = readUiCounters();
  const diagRates = nextDiagRates(nextCounters, now);
  prevCounters = nextCounters;
  prevCountersAt = now;
  publishLiveSnapshot({
    cpu: snapshot.cpu ?? UNSUPPORTED_CPU,
    diagRates,
    analysis: buildAnalysisDiag(),
    cover: buildCoverDiag(),
    collecting: false,
    updatedAt: now,
    sampleAt: snapshot.sampleAt,
  });
}

async function pollOnce(): Promise<void> {
  const generation = pollGeneration;

  if (!perfLiveCpuSnapshotSupported()) {
    if (generation !== pollGeneration) return;
    applyJsMetricsSnapshot(Date.now());
    return;
  }

  try {
    const snap = await invoke<ProcSnapshot>('performance_cpu_snapshot', buildPerfCpuSnapshotRequest());
    if (generation !== pollGeneration) return;

    const completedAt = Date.now();
    const nextCounters = readUiCounters();
    const diagRates = nextDiagRates(nextCounters, completedAt);
    prevCounters = nextCounters;
    prevCountersAt = completedAt;

    if (!snap.supported) {
      publishLiveSnapshot({
        cpu: UNSUPPORTED_CPU,
        diagRates,
        analysis: buildAnalysisDiag(),
    cover: buildCoverDiag(),
        collecting: false,
        updatedAt: completedAt,
        sampleAt: snapshot.sampleAt,
      });
      return;
    }

    const memory = snap.memory;
    const baselineProc = prevProc;
    const prevCpu = snapshot.cpu;
    let app = prevCpu?.app ?? 0;
    let webkit = prevCpu?.webkit ?? 0;
    let threadCpu: PerfThreadCpu[] = prevCpu?.threadCpu ?? snap.thread_cpu_groups.map(g => ({
      label: g.label,
      threadCount: g.thread_count,
      pct: 0,
    }));
    let rateSampleReady = false;

    if (baselineProc) {
      const totalDelta = snap.total_jiffies - baselineProc.total_jiffies;
      const appDelta = snap.app_jiffies - baselineProc.app_jiffies;
      const webkitDelta = snap.webkit_jiffies - baselineProc.webkit_jiffies;
      if (totalDelta > 0) {
        rateSampleReady = true;
        const cpuScale = Math.max(1, snap.logical_cpus || 1) * 100;
        const prevThreadByLabel = new Map(
          baselineProc.thread_cpu_groups.map(g => [g.label, g.jiffies]),
        );
        app = clampPct((appDelta / totalDelta) * cpuScale);
        webkit = clampPct((webkitDelta / totalDelta) * cpuScale);
        threadCpu = snap.thread_cpu_groups.map(g => {
          const prevJiffies = prevThreadByLabel.get(g.label) ?? g.jiffies;
          const delta = g.jiffies - prevJiffies;
          return {
            label: g.label,
            threadCount: g.thread_count,
            pct: clampPct((delta / totalDelta) * cpuScale),
          };
        });
      }
    }

    const memoryChanged = !memoryRowsEqual(prevCpu?.memory ?? [], memory);
    const diagChanged = !diagRatesEqual(snapshot.diagRates, diagRates);
    const ratesChanged = rateSampleReady && (
      app !== (prevCpu?.app ?? 0)
      || webkit !== (prevCpu?.webkit ?? 0)
      || !threadCpuEqual(prevCpu?.threadCpu ?? [], threadCpu)
    );

    prevProc = snap;

    if (!rateSampleReady) {
      if (baselineProc == null) return;
      if (!memoryChanged && !diagChanged) return;
    }

    const nextUpdatedAt = (ratesChanged || memoryChanged || diagChanged)
      ? completedAt
      : snapshot.updatedAt;

    const nextSampleAt = ratesChanged ? completedAt : snapshot.sampleAt;

    publishLiveSnapshot({
      cpu: {
        app,
        webkit,
        supported: true,
        memory,
        threadCpu,
      },
      diagRates,
      analysis: buildAnalysisDiag(),
    cover: buildCoverDiag(),
      collecting: false,
      updatedAt: nextUpdatedAt,
      sampleAt: nextSampleAt,
    });
  } catch {
    if (generation !== pollGeneration) return;
    publishLiveSnapshot({
      ...snapshot,
      cpu: { app: 0, webkit: 0, supported: false, memory: [], threadCpu: [] },
      collecting: false,
      updatedAt: Date.now(),
      sampleAt: 0,
    });
  }
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1000, value));
}

function schedulePoll(): void {
  if (pollTimer != null) return;
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

/** True while the first CPU baseline sample is still pending. */
export function isPerfLivePollWaitingForCpu(): boolean {
  return pollRefCount > 0 && snapshot.cpu == null && perfLiveCpuSnapshotSupported();
}

export function patchPerfLiveAnalysis(partial: Partial<PerfAnalysisDiag>): void {
  const nextAnalysis: PerfAnalysisDiag = {
    tracksPerMinute: partial.tracksPerMinute ?? snapshot.analysis?.tracksPerMinute ?? 0,
    lastTotalMs: partial.lastTotalMs ?? snapshot.analysis?.lastTotalMs ?? null,
    lastFetchMs: partial.lastFetchMs ?? snapshot.analysis?.lastFetchMs ?? null,
    lastSeedMs: partial.lastSeedMs ?? snapshot.analysis?.lastSeedMs ?? null,
    lastBpmMs: partial.lastBpmMs ?? snapshot.analysis?.lastBpmMs ?? null,
  };
  if (analysisEqual(snapshot.analysis, nextAnalysis)) return;
  publishLiveSnapshot({
    ...snapshot,
    analysis: nextAnalysis,
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
