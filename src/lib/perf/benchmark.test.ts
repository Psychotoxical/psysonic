import { describe, expect, it } from 'vitest';
import {
  benchmarkRouteTerminalSteps,
  benchmarkSectionsReady,
  summarizeBenchmarkPages,
  type BenchmarkPageResult,
} from './benchmark';

function page(route: string, totalMs: number): BenchmarkPageResult {
  return {
    route,
    fromRoute: '/from',
    actualRoute: route,
    iteration: 1,
    temperature: 'warm',
    navigationMs: 1,
    readinessMs: totalMs - 1,
    quietAfterReadyMs: 0,
    stableMs: totalMs - 1,
    totalMs,
    timedOut: false,
    readinessTimedOut: false,
    stabilityTimedOut: false,
    mutationCount: 0,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    resourceCount: 0,
    resourceDurationMs: 0,
    reactCommitCount: 0,
    reactActualDurationMs: 0,
    reactBaseDurationMs: 0,
    domNodeCount: 0,
    imageCount: 0,
    incompleteImageCount: 0,
    scrollHeight: 0,
    viewportHeight: 0,
  };
}

describe('summarizeBenchmarkPages', () => {
  it('groups routes, computes medians, and sorts slowest first', () => {
    const coldAlbums = { ...page('/albums', 100), temperature: 'cold' as const };
    expect(summarizeBenchmarkPages([
      coldAlbums, page('/albums', 300), page('/artists', 500),
    ])).toMatchObject([
      { route: '/artists', medianTotalMs: 500, warmMedianTotalMs: 500, samples: 1 },
      { route: '/albums', coldTotalMs: 100, warmMedianTotalMs: 300, medianTotalMs: 200, samples: 2 },
    ]);
  });
});

describe('benchmarkRouteTerminalSteps', () => {
  it('uses the visible Artists loading transition for readiness', () => {
    expect(benchmarkRouteTerminalSteps('/artists')).toEqual(['ui_loading_false']);
  });
});

describe('benchmarkSectionsReady', () => {
  it('waits for started work but ignores sections that remain idle', () => {
    expect(benchmarkSectionsReady(['idle', 'idle'])).toBe(false);
    expect(benchmarkSectionsReady(['ready', 'loading', 'idle'])).toBe(false);
    expect(benchmarkSectionsReady(['ready', 'idle', 'disabled'])).toBe(true);
  });
});
