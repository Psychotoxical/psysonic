import { describe, it, expect } from 'vitest';
import {
  formatAnalysisPipelineQueueOverlay,
  formatAnalysisTierQueue,
} from '@/lib/perf/formatAnalysisQueueStats';

describe('formatAnalysisQueueStats', () => {
  it('formats tier queue as total(high,middle,low)', () => {
    expect(formatAnalysisTierQueue(20, 1, 5, 14)).toBe('20(1,5,14)');
  });

  it('formats pipeline overlay lines with queued + active tiers', () => {
    expect(
      formatAnalysisPipelineQueueOverlay({
        pipelineWorkers: 8,
        httpQueued: 20,
        httpQueuedHigh: 1,
        httpQueuedMiddle: 5,
        httpQueuedLow: 14,
        httpDownloadActive: 2,
        httpDownloadActiveHigh: 0,
        httpDownloadActiveMiddle: 1,
        httpDownloadActiveLow: 1,
        cpuQueued: 12,
        cpuQueuedHigh: 0,
        cpuQueuedMiddle: 2,
        cpuQueuedLow: 10,
        cpuDecodeActive: 3,
        cpuDecodeActiveHigh: 0,
        cpuDecodeActiveMiddle: 0,
        cpuDecodeActiveLow: 3,
      }),
    ).toEqual([
      'http 22(1,6,15) · dl 2/8',
      'cpu 15(0,2,13) · run 3/8',
    ]);
  });

  it('shows active-only backlog when nothing is waiting in deque', () => {
    expect(
      formatAnalysisPipelineQueueOverlay({
        pipelineWorkers: 20,
        httpQueued: 0,
        httpQueuedHigh: 0,
        httpQueuedMiddle: 0,
        httpQueuedLow: 0,
        httpDownloadActive: 15,
        httpDownloadActiveHigh: 0,
        httpDownloadActiveMiddle: 0,
        httpDownloadActiveLow: 15,
        cpuQueued: 0,
        cpuQueuedHigh: 0,
        cpuQueuedMiddle: 0,
        cpuQueuedLow: 0,
        cpuDecodeActive: 1,
        cpuDecodeActiveHigh: 0,
        cpuDecodeActiveMiddle: 0,
        cpuDecodeActiveLow: 1,
      }),
    ).toEqual([
      'http 15(0,0,15) · dl 15/20',
      'cpu 1(0,0,1) · run 1/20',
    ]);
  });
});
