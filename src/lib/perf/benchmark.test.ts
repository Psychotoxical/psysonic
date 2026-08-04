import { describe, expect, it } from 'vitest';
import {
  benchmarkRouteTerminalSteps,
  benchmarkSectionsReady,
  formatBenchmarkMarkdown,
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
    interactions: [],
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

describe('formatBenchmarkMarkdown', () => {
  it('includes renderer phases and measured interactions', () => {
    const albumPage = page('/albums', 100);
    albumPage.interactions = [{
      name: 'filter:starred',
      kind: 'filter',
      status: 'completed',
      durationMs: 30,
      semanticMs: 20,
      quietAfterSemanticMs: 10,
      mutationCount: 4,
    }];
    const markdown = formatBenchmarkMarkdown({
      schemaVersion: 2,
      id: 'run-1',
      startedAt: '2026-08-04T00:00:00.000Z',
      finishedAt: '2026-08-04T00:00:01.000Z',
      scenario: 'core-pages',
      runs: 1,
      profile: 'realistic',
      environment: {
        userAgent: 'test',
        viewport: { width: 1000, height: 700, devicePixelRatio: 1 },
        serverCount: 1,
        selectedServerCount: 1,
        libraryScopeFingerprint: 'scope',
      },
      rendererStartup: {
        navigationType: 'navigate',
        responseEndMs: 10,
        domInteractiveMs: 20,
        domContentLoadedMs: 30,
        loadEventMs: 40,
        runnerModuleReadyMs: 50,
        requestAcceptedMs: 60,
        migrationReadyMs: 70,
        routeResolutionCompletedMs: 80,
        instrumentationReadyMs: 90,
        benchmarkReadyMs: 100,
        phases: {
          requestToMigrationReadyMs: 10,
          routeResolutionMs: 10,
          instrumentationSetupMs: 10,
          transitionSetupMs: 10,
        },
      },
      pages: [albumPage],
      skippedRoutes: [],
      logs: [],
      summary: summarizeBenchmarkPages([albumPage]),
    });

    expect(markdown).toContain('## Renderer startup');
    expect(markdown).toContain('Route resolution: 10 ms');
    expect(markdown).toContain('| /albums | 1 | filter:starred | filter | completed |');
  });
});
