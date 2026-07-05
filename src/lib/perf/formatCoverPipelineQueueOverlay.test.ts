import { describe, expect, it } from 'vitest';
import { formatCoverPipelineQueueOverlay } from '@/lib/perf/formatCoverPipelineQueueOverlay';

describe('formatCoverPipelineQueueOverlay', () => {
  it('formats ensure tiers, rust pools, and optional peek backlog', () => {
    expect(
      formatCoverPipelineQueueOverlay({
        rust: {
          httpMax: 16,
          httpActive: 8,
          cpuUiMax: 2,
          cpuUiActive: 2,
          cpuBackfillMax: 2,
          cpuBackfillActive: 1,
          libraryBackfillHttpMax: 2,
          libraryBackfillHttpActive: 1,
          libraryBackfillPassRunning: true,
          uiEnsuredTotal: 0,
        },
        ensure: {
          queuedHigh: 2,
          queuedMiddle: 4,
          queuedLow: 6,
          inflight: 10,
          maxInflight: 10,
        },
        peek: { pending: 24, inflight: 1 },
      }),
    ).toEqual([
      'ui ensure 12(2,4,6) · invoke 10/10',
      'http ui 8/16 · lib 1/2 · pass',
      'enc ui 2/2 · lib 1/2',
      'disk peek 24 pending · 1 inflight',
    ]);
  });

  it('omits peek line when idle', () => {
    expect(
      formatCoverPipelineQueueOverlay({
        rust: {
          httpMax: 16,
          httpActive: 0,
          cpuUiMax: 2,
          cpuUiActive: 0,
          cpuBackfillMax: 2,
          cpuBackfillActive: 0,
          libraryBackfillHttpMax: 2,
          libraryBackfillHttpActive: 0,
          libraryBackfillPassRunning: false,
          uiEnsuredTotal: 0,
        },
        ensure: {
          queuedHigh: 0,
          queuedMiddle: 0,
          queuedLow: 0,
          inflight: 0,
          maxInflight: 10,
        },
        peek: { pending: 0, inflight: 0 },
      }),
    ).toEqual([
      'ui ensure 0(0,0,0) · invoke 0/10',
      'http ui 0/16 · lib 0/2',
      'enc ui 0/2 · lib 0/2',
    ]);
  });
});
