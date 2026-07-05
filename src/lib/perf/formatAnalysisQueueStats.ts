import type { AnalysisPipelineQueueStatsDto } from '@/lib/api/analysis';

export function formatAnalysisTierQueue(
  total: number,
  high: number,
  middle: number,
  low: number,
): string {
  return `${total}(${high},${middle},${low})`;
}

function combineTierCounts(
  queuedHigh: number,
  queuedMiddle: number,
  queuedLow: number,
  activeHigh: number,
  activeMiddle: number,
  activeLow: number,
): { total: number; high: number; middle: number; low: number } {
  const high = queuedHigh + activeHigh;
  const middle = queuedMiddle + activeMiddle;
  const low = queuedLow + activeLow;
  return { total: high + middle + low, high, middle, low };
}

export function formatAnalysisPipelineQueueOverlay(
  stats: AnalysisPipelineQueueStatsDto,
): string[] {
  const http = combineTierCounts(
    stats.httpQueuedHigh,
    stats.httpQueuedMiddle,
    stats.httpQueuedLow,
    stats.httpDownloadActiveHigh,
    stats.httpDownloadActiveMiddle,
    stats.httpDownloadActiveLow,
  );
  const cpu = combineTierCounts(
    stats.cpuQueuedHigh,
    stats.cpuQueuedMiddle,
    stats.cpuQueuedLow,
    stats.cpuDecodeActiveHigh,
    stats.cpuDecodeActiveMiddle,
    stats.cpuDecodeActiveLow,
  );
  const w = stats.pipelineWorkers;
  const httpLine = `http ${formatAnalysisTierQueue(http.total, http.high, http.middle, http.low)} · dl ${stats.httpDownloadActive}/${w}`;
  const cpuLine = `cpu ${formatAnalysisTierQueue(cpu.total, cpu.high, cpu.middle, cpu.low)} · run ${stats.cpuDecodeActive}/${w}`;
  return [httpLine, cpuLine];
}
