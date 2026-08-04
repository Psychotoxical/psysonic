export type BenchmarkProfile = 'realistic' | 'isolated';

export interface BenchmarkRunRequest {
  scenario: string;
  runs: number;
  profile: BenchmarkProfile;
}

export interface BenchmarkReactCommit {
  phase: 'mount' | 'update' | 'nested-update';
  actualDurationMs: number;
  baseDurationMs: number;
  startTimeMs: number;
  commitTimeMs: number;
}

export type BenchmarkInteractionKind = 'search' | 'filter' | 'pagination';
export type BenchmarkInteractionStatus = 'completed' | 'skipped' | 'timeout' | 'error';

export interface BenchmarkInteractionResult {
  name: string;
  kind: BenchmarkInteractionKind;
  status: BenchmarkInteractionStatus;
  durationMs: number;
  semanticMs: number;
  quietAfterSemanticMs: number;
  mutationCount: number;
  details?: Record<string, unknown>;
}

export interface BenchmarkRendererStartupTiming {
  navigationType: string | null;
  responseEndMs: number | null;
  domInteractiveMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  runnerModuleReadyMs: number;
  requestAcceptedMs: number;
  migrationReadyMs: number;
  routeResolutionCompletedMs: number;
  instrumentationReadyMs: number;
  benchmarkReadyMs: number;
  phases: {
    requestToMigrationReadyMs: number;
    routeResolutionMs: number;
    instrumentationSetupMs: number;
    transitionSetupMs: number;
  };
}

export interface BenchmarkPageResult {
  route: string;
  fromRoute: string;
  actualRoute: string;
  iteration: number;
  temperature: 'cold' | 'warm';
  navigationMs: number;
  readinessMs: number;
  quietAfterReadyMs: number;
  stableMs: number;
  totalMs: number;
  timedOut: boolean;
  readinessTimedOut: boolean;
  stabilityTimedOut: boolean;
  readinessDetails?: unknown;
  mutationCount: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  resourceCount: number;
  resourceDurationMs: number;
  reactCommitCount: number;
  reactActualDurationMs: number;
  reactBaseDurationMs: number;
  domNodeCount: number;
  imageCount: number;
  incompleteImageCount: number;
  scrollHeight: number;
  viewportHeight: number;
  interactions: BenchmarkInteractionResult[];
  cpuBefore?: unknown;
  cpuAfter?: unknown;
}

export interface BenchmarkSkippedRoute {
  route: string;
  reason: string;
}

export interface BenchmarkReport {
  schemaVersion: 2;
  id: string;
  startedAt: string;
  finishedAt: string;
  scenario: string;
  runs: number;
  profile: BenchmarkProfile;
  environment: {
    userAgent: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
    serverCount: number;
    selectedServerCount: number;
    libraryScopeFingerprint: string | null;
  };
  rendererStartup: BenchmarkRendererStartupTiming;
  pages: BenchmarkPageResult[];
  skippedRoutes: BenchmarkSkippedRoute[];
  logs: string[];
  summary: BenchmarkSummaryRow[];
  markdown: string;
}

export interface BenchmarkSummaryRow {
  route: string;
  samples: number;
  coldTotalMs: number;
  warmMedianTotalMs: number;
  medianTotalMs: number;
  maxTotalMs: number;
  medianReadinessMs: number;
  medianQuietAfterReadyMs: number;
  medianReactMs: number;
  medianLongTaskMs: number;
  timeouts: number;
}

const BENCHMARK_TERMINAL_STATUSES = new Set(['ready', 'empty', 'error', 'timeout']);

const BENCHMARK_ROUTE_TERMINAL_STEPS: Record<string, readonly string[]> = {
  '/albums': ['ui_loading_false'],
  '/artists': ['ui_loading_false'],
  '/tracks': ['load_effect_done', 'load_more_done', 'load_more_error'],
  '/favorites': ['load_complete'],
};

export function benchmarkRouteTerminalSteps(route: string): readonly string[] {
  return BENCHMARK_ROUTE_TERMINAL_STEPS[route] ?? [];
}

export function benchmarkSectionsReady(statuses: readonly string[]): boolean {
  return statuses.some(status => BENCHMARK_TERMINAL_STATUSES.has(status))
    && statuses.every(status => status !== 'loading');
}

let activeRoute: string | null = null;
let reactCommits: BenchmarkReactCommit[] = [];

export function beginBenchmarkReactCollection(route: string): void {
  activeRoute = route;
  reactCommits = [];
}

export function recordBenchmarkReactCommit(commit: BenchmarkReactCommit): void {
  if (!activeRoute) return;
  reactCommits.push(commit);
}

export function finishBenchmarkReactCollection(route: string): BenchmarkReactCommit[] {
  if (activeRoute !== route) return [];
  const snapshot = reactCommits;
  activeRoute = null;
  reactCommits = [];
  return snapshot;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : Math.round(sorted[middle]);
}

export function summarizeBenchmarkPages(pages: BenchmarkPageResult[]): BenchmarkSummaryRow[] {
  const routes = new Map<string, BenchmarkPageResult[]>();
  for (const page of pages) {
    const rows = routes.get(page.route) ?? [];
    rows.push(page);
    routes.set(page.route, rows);
  }
  return [...routes.entries()].map(([route, rows]) => ({
    route,
    samples: rows.length,
    coldTotalMs: rows.find(row => row.temperature === 'cold')?.totalMs ?? 0,
    warmMedianTotalMs: median(rows.filter(row => row.temperature === 'warm').map(row => row.totalMs)),
    medianTotalMs: median(rows.map(row => row.totalMs)),
    maxTotalMs: Math.max(...rows.map(row => row.totalMs)),
    medianReadinessMs: median(rows.map(row => row.readinessMs)),
    medianQuietAfterReadyMs: median(rows.map(row => row.quietAfterReadyMs)),
    medianReactMs: median(rows.map(row => row.reactActualDurationMs)),
    medianLongTaskMs: median(rows.map(row => row.longTaskTotalMs)),
    timeouts: rows.filter(row => row.timedOut).length,
  })).sort((a, b) => b.medianTotalMs - a.medianTotalMs);
}

export function formatBenchmarkMarkdown(report: Omit<BenchmarkReport, 'markdown'>): string {
  const interactions = report.pages.flatMap(page => (
    page.interactions.map(interaction => ({ route: page.route, iteration: page.iteration, ...interaction }))
  ));
  const lines = [
    `# Psysonic benchmark ${report.id}`,
    '',
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Scenario: ${report.scenario}`,
    `- Profile: ${report.profile}`,
    `- Runs: ${report.runs}`,
    `- Servers: ${report.environment.selectedServerCount} selected / ${report.environment.serverCount} configured`,
    '',
    '## Renderer startup',
    '',
    `- Navigation type: ${report.rendererStartup.navigationType ?? 'unknown'}`,
    `- DOM interactive: ${report.rendererStartup.domInteractiveMs ?? 'n/a'} ms`,
    `- DOM content loaded: ${report.rendererStartup.domContentLoadedMs ?? 'n/a'} ms`,
    `- Window load: ${report.rendererStartup.loadEventMs ?? 'n/a'} ms`,
    `- Benchmark runner module ready: ${report.rendererStartup.runnerModuleReadyMs} ms`,
    `- Benchmark request accepted: ${report.rendererStartup.requestAcceptedMs} ms`,
    `- Migrations ready: ${report.rendererStartup.migrationReadyMs} ms`,
    `- Route resolution: ${report.rendererStartup.phases.routeResolutionMs} ms`,
    `- Instrumentation setup: ${report.rendererStartup.phases.instrumentationSetupMs} ms`,
    `- Transition setup: ${report.rendererStartup.phases.transitionSetupMs} ms`,
    `- Benchmark ready: ${report.rendererStartup.benchmarkReadyMs} ms`,
    '',
    '| Route | Samples | Cold total | Warm median | Median readiness | Median quiet | Max total | Median React | Median long tasks | Timeouts |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.summary.map(row => (
      `| ${row.route} | ${row.samples} | ${row.coldTotalMs} ms | ${row.warmMedianTotalMs} ms | ${row.medianReadinessMs} ms | ${row.medianQuietAfterReadyMs} ms | ${row.maxTotalMs} ms | ${row.medianReactMs} ms | ${row.medianLongTaskMs} ms | ${row.timeouts} |`
    )),
    ...(report.skippedRoutes.length > 0 ? [
      '',
      '## Skipped routes',
      '',
      ...report.skippedRoutes.map(row => `- ${row.route}: ${row.reason}`),
    ] : []),
    '',
    '## Samples',
    '',
    '| From | Route | Actual | Run | Cache | Activation | Readiness | Quiet | Total | React commits | React time | Long tasks | DOM nodes | Images pending |',
    '|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.pages.map(page => (
      `| ${page.fromRoute} | ${page.route} | ${page.actualRoute} | ${page.iteration} | ${page.temperature} | ${page.navigationMs} ms | ${page.readinessMs} ms | ${page.quietAfterReadyMs} ms | ${page.totalMs} ms | ${page.reactCommitCount} | ${page.reactActualDurationMs} ms | ${page.longTaskTotalMs} ms | ${page.domNodeCount} | ${page.incompleteImageCount} |`
    )),
    ...(interactions.length > 0 ? [
      '',
      '## Interactions',
      '',
      '| Route | Run | Interaction | Kind | Status | Semantic | Quiet | Total | Mutations |',
      '|---|---:|---|---|---|---:|---:|---:|---:|',
      ...interactions.map(interaction => (
        `| ${interaction.route} | ${interaction.iteration} | ${interaction.name} | ${interaction.kind} | ${interaction.status} | ${interaction.semanticMs} ms | ${interaction.quietAfterSemanticMs} ms | ${interaction.durationMs} ms | ${interaction.mutationCount} |`
      )),
    ] : []),
  ];
  return lines.join('\n');
}
