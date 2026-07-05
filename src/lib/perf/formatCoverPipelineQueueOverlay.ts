import type { CoverPipelineQueueStatsDto } from '@/lib/api/coverCache';
import type { CoverEnsureQueueStats } from '@/cover/ensureQueue';
import type { CoverPeekQueueStats } from '@/cover/peekQueue';
import { formatAnalysisTierQueue } from '@/lib/perf/formatAnalysisQueueStats';

export type CoverPipelineOverlayInput = {
  rust: CoverPipelineQueueStatsDto;
  ensure: CoverEnsureQueueStats;
  peek: CoverPeekQueueStats;
};

export function formatCoverPipelineQueueOverlay(input: CoverPipelineOverlayInput): string[] {
  const { rust, ensure, peek } = input;
  const ensureQueued = ensure.queuedHigh + ensure.queuedMiddle + ensure.queuedLow;
  const ensureLine = `ui ensure ${formatAnalysisTierQueue(
    ensureQueued,
    ensure.queuedHigh,
    ensure.queuedMiddle,
    ensure.queuedLow,
  )} · invoke ${ensure.inflight}/${ensure.maxInflight}`;

  const libPass = rust.libraryBackfillPassRunning ? ' · pass' : '';
  const httpLine = `http ui ${rust.httpActive}/${rust.httpMax} · lib ${rust.libraryBackfillHttpActive}/${rust.libraryBackfillHttpMax}${libPass}`;

  const cpuLine = `enc ui ${rust.cpuUiActive}/${rust.cpuUiMax} · lib ${rust.cpuBackfillActive}/${rust.cpuBackfillMax}`;

  const lines = [ensureLine, httpLine, cpuLine];
  if (peek.pending > 0 || peek.inflight > 0) {
    lines.push(`disk peek ${peek.pending} pending · ${peek.inflight} inflight`);
  }
  return lines;
}
