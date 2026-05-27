import { describe, it, expect } from 'vitest';
import {
  computeLibraryBackfillTargetDepth,
  libraryBackfillNeedsTopUp,
  libraryBackfillPipelineBacklog,
  libraryBackfillTopUpLimit,
} from './libraryAnalysisBackfillPolicy';

describe('libraryAnalysisBackfillPolicy', () => {
  it('targets workers × 3 with floor and cap', () => {
    expect(computeLibraryBackfillTargetDepth(1)).toBe(8);
    expect(computeLibraryBackfillTargetDepth(4)).toBe(12);
    expect(computeLibraryBackfillTargetDepth(8)).toBe(24);
    expect(computeLibraryBackfillTargetDepth(100)).toBe(240);
  });

  const zeroCpu = { cpuQueued: 0, cpuDecodeActive: 0 };

  it('measures backlog as HTTP plus CPU seed pipeline load', () => {
    expect(
      libraryBackfillPipelineBacklog({
        httpQueued: 5,
        httpDownloadActive: 3,
        ...zeroCpu,
      }),
    ).toBe(8);
    expect(
      libraryBackfillPipelineBacklog({
        httpQueued: 0,
        httpDownloadActive: 0,
        cpuQueued: 4,
        cpuDecodeActive: 2,
      }),
    ).toBe(6);
  });

  it('requests top-up while backlog stays below target', () => {
    const stats = { httpQueued: 2, httpDownloadActive: 1, ...zeroCpu };
    expect(libraryBackfillNeedsTopUp(stats, 8)).toBe(true);
    expect(libraryBackfillTopUpLimit(stats, 8)).toBe(20);
  });

  it('stops top-up when backlog meets target', () => {
    const stats = { httpQueued: 20, httpDownloadActive: 4, ...zeroCpu };
    expect(libraryBackfillNeedsTopUp(stats, 8)).toBe(false);
    expect(libraryBackfillTopUpLimit(stats, 8)).toBe(0);
  });
});
