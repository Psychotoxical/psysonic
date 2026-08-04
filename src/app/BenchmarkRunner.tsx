import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useLocation, useNavigate } from 'react-router';
import { commands } from '@/generated/bindings';
import { APP_MAIN_SCROLL_VIEWPORT_ID, mainRouteInpageScrollViewportId } from '@/constants/appScroll';
import { deriveLibraryBrowseScope } from '@/lib/library/libraryBrowseScope';
import { useAuthStore } from '@/store/authStore';
import { useMigrationStore } from '@/store/migrationStore';
import { getAlbumBrowseTraceSnapshot } from '@/lib/library/albumBrowseDebug';
import { getArtistBrowseTraceSnapshot } from '@/lib/library/artistBrowseDebug';
import { getFavoritesBrowseTraceSnapshot } from '@/lib/library/favoritesBrowseDebug';
import { getTrackBrowseTraceSnapshot } from '@/lib/library/trackBrowseDebug';
import {
  restoreMainstageDiagnosticSections,
  snapshotMainstageDiagnosticSections,
  useMainstageDiagnosticStore,
} from '@/features/home/store/mainstageDiagnosticStore';
import {
  getPsyLabDebugTraceOverrides,
  refreshPsyLabDebugTraceSubscribers,
  setPsyLabDebugTraceOverrides,
  type PsyLabDebugTraces,
} from '@/lib/perf/psyLabDebugTraces';
import {
  getRuntimeDebugLoggingOverride,
  setRuntimeDebugLoggingOverride,
} from '@/lib/perf/debugLoggingMode';
import {
  coverTrafficBenchmarkHoldActive,
  coverTrafficSetBenchmarkHold,
} from '@/cover/coverTraffic';
import { benchmarkRouteMatchesLocation, resolveBenchmarkRoutes } from './benchmarkRoutes';
import { runBenchmarkInteractions } from './benchmarkInteractions';
import {
  benchmarkRouteTerminalSteps,
  beginBenchmarkReactCollection,
  benchmarkSectionsReady,
  finishBenchmarkReactCollection,
  formatBenchmarkMarkdown,
  summarizeBenchmarkPages,
  type BenchmarkPageResult,
  type BenchmarkReport,
  type BenchmarkRunRequest,
  type BenchmarkRendererStartupTiming,
} from '@/lib/perf/benchmark';

const ROUTE_TIMEOUT_MS = 30_000;
const STABLE_WINDOW_MS = 700;
const CPU_SNAPSHOT_TIMEOUT_MS = 2_000;
const MIGRATION_READY_TIMEOUT_MS = 60_000;
const BENCHMARK_TRACE_OVERRIDES: PsyLabDebugTraces = {
  albumsBrowse: true,
  artistsBrowse: true,
  favoritesBrowse: true,
  tracksBrowse: true,
  mainstage: true,
};
const BENCHMARK_RUNNER_MODULE_READY_MS = Math.round(performance.now());

function rendererNavigationTiming(): Pick<
  BenchmarkRendererStartupTiming,
  'navigationType' | 'responseEndMs' | 'domInteractiveMs' | 'domContentLoadedMs' | 'loadEventMs'
> {
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return {
    navigationType: navigation?.type ?? null,
    responseEndMs: navigation ? Math.round(navigation.responseEnd) : null,
    domInteractiveMs: navigation ? Math.round(navigation.domInteractive) : null,
    domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
    loadEventMs: navigation?.loadEventEnd ? Math.round(navigation.loadEventEnd) : null,
  };
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function waitForMigrationReady(): Promise<void> {
  if (useMigrationStore.getState().phase === 'completed') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error('benchmark startup timed out waiting for migrations'));
    }, MIGRATION_READY_TIMEOUT_MS);
    const unsubscribe = useMigrationStore.subscribe(state => {
      if (state.phase === 'completed') {
        window.clearTimeout(timeout);
        unsubscribe();
        resolve();
      } else if (state.phase === 'error') {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(new Error(state.lastError ?? 'benchmark startup migration failed'));
      }
    });
  });
}

function waitForPath(route: string, timeoutMs: number): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (benchmarkRouteMatchesLocation(route, window.location)) {
        resolve(Math.round(performance.now() - started));
        return;
      }
      if (performance.now() - started >= timeoutMs) {
        reject(new Error(`route activation timed out: ${route}`));
        return;
      }
      requestAnimationFrame(poll);
    };
    poll();
  });
}

function semanticRouteReady(route: string): boolean {
  if (route === '/') {
    const sections = Object.values(useMainstageDiagnosticStore.getState().sections);
    return benchmarkSectionsReady(sections.map(section => section.status));
  }
  const terminalSteps = benchmarkRouteTerminalSteps(route);
  if (terminalSteps.length === 0) return true;
  const entries = route === '/albums'
    ? getAlbumBrowseTraceSnapshot()
    : route === '/artists'
      ? getArtistBrowseTraceSnapshot()
      : route === '/tracks'
        ? getTrackBrowseTraceSnapshot()
        : getFavoritesBrowseTraceSnapshot();
  return entries.some(entry => terminalSteps.includes(entry.step));
}

function currentRoute(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function routeReadinessDetails(route: string): unknown {
  if (route === '/') return useMainstageDiagnosticStore.getState().sections;
  if (route === '/albums') return getAlbumBrowseTraceSnapshot().slice(-12);
  if (route === '/artists') return getArtistBrowseTraceSnapshot().slice(-12);
  if (route === '/tracks') return getTrackBrowseTraceSnapshot().slice(-12);
  if (route === '/favorites') return getFavoritesBrowseTraceSnapshot().slice(-12);
  return undefined;
}

function waitForRouteReadiness(route: string, timeoutMs: number): Promise<{ durationMs: number; timedOut: boolean }> {
  const started = performance.now();
  return new Promise(resolve => {
    const poll = () => {
      const elapsed = performance.now() - started;
      if (semanticRouteReady(route)) {
        resolve({ durationMs: Math.round(elapsed), timedOut: false });
        return;
      }
      if (elapsed >= timeoutMs) {
        resolve({ durationMs: Math.round(elapsed), timedOut: true });
        return;
      }
      window.setTimeout(poll, 50);
    };
    poll();
  });
}

async function waitForRouteStability(route: string): Promise<{
  durationMs: number;
  mutationCount: number;
  timedOut: boolean;
}> {
  await nextFrame();
  await nextFrame();
  const root = document.querySelector('.app-shell-route-host') ?? document.getElementById('root');
  if (!root) return { durationMs: 0, mutationCount: 0, timedOut: false };
  const started = performance.now();
  let lastMutationAt = started;
  let mutationCount = 0;
  const observer = new MutationObserver(records => {
    mutationCount += records.length;
    lastMutationAt = performance.now();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  const result = await new Promise<{ durationMs: number; mutationCount: number; timedOut: boolean }>(resolve => {
    const poll = () => {
      const now = performance.now();
      if (now - lastMutationAt >= STABLE_WINDOW_MS) {
        resolve({ durationMs: Math.round(now - started), mutationCount, timedOut: false });
        return;
      }
      if (now - started >= ROUTE_TIMEOUT_MS) {
        resolve({ durationMs: Math.round(now - started), mutationCount, timedOut: true });
        return;
      }
      window.setTimeout(poll, 100);
    };
    window.setTimeout(poll, 100);
  });
  observer.disconnect();
  void route;
  return result;
}

function routeScrollMetrics(route: string): { scrollHeight: number; viewportHeight: number } {
  const id = mainRouteInpageScrollViewportId(route) ?? APP_MAIN_SCROLL_VIEWPORT_ID;
  const viewport = document.getElementById(id);
  return {
    scrollHeight: viewport?.scrollHeight ?? 0,
    viewportHeight: viewport?.clientHeight ?? 0,
  };
}

async function cpuSnapshot(): Promise<unknown> {
  let timeoutId: number | undefined;
  const timeout = new Promise<{ status: 'timeout' }>(resolve => {
    timeoutId = window.setTimeout(() => resolve({ status: 'timeout' }), CPU_SNAPSHOT_TIMEOUT_MS);
  });
  const result = await Promise.race([commands.performanceCpuSnapshot(false), timeout]);
  if (timeoutId != null) window.clearTimeout(timeoutId);
  if (result.status === 'timeout') return { error: 'cpu snapshot timed out' };
  return result.status === 'ok' ? result.data : { error: result.error };
}

function reportId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export default function BenchmarkRunner() {
  const navigate = useNavigate();
  const location = useLocation();
  const runningRef = useRef(false);
  const originalPathRef = useRef(location.pathname);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const runPending = async () => {
      const request = await invoke<BenchmarkRunRequest | null>('benchmark_take_pending_request');
      if (!request) return;
      if (runningRef.current) return;
      runningRef.current = true;
      const requestAcceptedMs = performance.now();
      originalPathRef.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const startedAt = new Date().toISOString();
      const id = reportId();
      const pages: BenchmarkPageResult[] = [];
      const initialAuth = useAuthStore.getState();
      const initialBrowseScope = deriveLibraryBrowseScope(initialAuth, new Set());
      const mainstageSnapshot = snapshotMainstageDiagnosticSections();
      const previousBenchmarkAttribute = document.documentElement.getAttribute('data-benchmark-running');
      const previousTraceOverrides = getPsyLabDebugTraceOverrides();
      const previousRuntimeDebugOverride = getRuntimeDebugLoggingOverride();
      const previousCoverHold = coverTrafficBenchmarkHoldActive();
      let previousLoggingMode: string | null = null;
      let routeResolution = {
        routes: [] as string[],
        skippedRoutes: [] as { route: string; reason: string }[],
        searchQuery: null as string | null,
      };
      let migrationReadyMs = requestAcceptedMs;
      let routeResolutionStartedMs = requestAcceptedMs;
      let routeResolutionCompletedMs = requestAcceptedMs;
      let instrumentationStartedMs = requestAcceptedMs;
      let instrumentationReadyMs = requestAcceptedMs;
      let transitionStartedMs = requestAcceptedMs;
      let benchmarkReadyMs = requestAcceptedMs;
      const buildRendererStartup = (): BenchmarkRendererStartupTiming => ({
        ...rendererNavigationTiming(),
        runnerModuleReadyMs: BENCHMARK_RUNNER_MODULE_READY_MS,
        requestAcceptedMs: Math.round(requestAcceptedMs),
        migrationReadyMs: Math.round(migrationReadyMs),
        routeResolutionCompletedMs: Math.round(routeResolutionCompletedMs),
        instrumentationReadyMs: Math.round(instrumentationReadyMs),
        benchmarkReadyMs: Math.round(benchmarkReadyMs),
        phases: {
          requestToMigrationReadyMs: Math.round(migrationReadyMs - requestAcceptedMs),
          routeResolutionMs: Math.round(routeResolutionCompletedMs - routeResolutionStartedMs),
          instrumentationSetupMs: Math.round(instrumentationReadyMs - instrumentationStartedMs),
          transitionSetupMs: Math.round(benchmarkReadyMs - transitionStartedMs),
        },
      });
      let reportPayload: BenchmarkReport | Record<string, unknown>;
      try {
        document.documentElement.setAttribute('data-benchmark-running', 'true');
        await waitForMigrationReady();
        migrationReadyMs = performance.now();
        routeResolutionStartedMs = migrationReadyMs;
        routeResolution = await resolveBenchmarkRoutes(request.scenario);
        routeResolutionCompletedMs = performance.now();
        instrumentationStartedMs = routeResolutionCompletedMs;
        const routes = routeResolution.routes;
        const initialLogs = await commands.tailRuntimeLogs(null, 1);
        let logSeq = initialLogs.lastSeq;
        previousLoggingMode = await commands.getLoggingMode();
        await commands.setLoggingMode('debug');
        setRuntimeDebugLoggingOverride(true);
        await setPsyLabDebugTraceOverrides(BENCHMARK_TRACE_OVERRIDES);
        useMainstageDiagnosticStore.getState().reset();
        if (request.profile === 'isolated') {
          await coverTrafficSetBenchmarkHold(true);
        }
        instrumentationReadyMs = performance.now();
        transitionStartedMs = instrumentationReadyMs;
        navigate('/__benchmark-transition');
        await waitForPath('/__benchmark-transition', ROUTE_TIMEOUT_MS);
        await nextFrame();
        await nextFrame();
        benchmarkReadyMs = performance.now();
        for (let iteration = 1; iteration <= request.runs; iteration += 1) {
          for (const route of routes) {
            if (request.profile === 'isolated') {
              navigate('/__benchmark-transition');
              await waitForPath('/__benchmark-transition', ROUTE_TIMEOUT_MS);
              await nextFrame();
              await nextFrame();
            }
            const fromRoute = currentRoute();
            const cpuBefore = await cpuSnapshot();
            const totalStarted = performance.now();
            const resourceStartedAt = totalStarted;
            const longTasks: number[] = [];
            const longTaskObserver = typeof PerformanceObserver !== 'undefined'
              ? new PerformanceObserver(list => {
                  for (const entry of list.getEntries()) longTasks.push(entry.duration);
                })
              : null;
            try {
              longTaskObserver?.observe({ entryTypes: ['longtask'] });
            } catch {
              longTaskObserver?.disconnect();
            }
            beginBenchmarkReactCollection(route);
            if (route === '/') useMainstageDiagnosticStore.getState().reset();
            navigate(route);
            let navigationMs = 0;
            let readiness = { durationMs: ROUTE_TIMEOUT_MS, timedOut: true };
            let quiet = { durationMs: 0, mutationCount: 0, timedOut: false };
            try {
              navigationMs = await waitForPath(route, ROUTE_TIMEOUT_MS);
              await nextFrame();
              await nextFrame();
              if (route === '/') {
                refreshPsyLabDebugTraceSubscribers();
                await nextFrame();
              }
              readiness = await waitForRouteReadiness(route, ROUTE_TIMEOUT_MS);
              quiet = await waitForRouteStability(route);
            } catch {
              readiness.timedOut = true;
            }
            longTaskObserver?.disconnect();
            const commits = finishBenchmarkReactCollection(route);
            const host = document.querySelector('.app-shell-route-host');
            const images = host ? [...host.querySelectorAll('img')] : [];
            const scroll = routeScrollMetrics(route);
            const resources = performance.getEntriesByType('resource')
              .filter(entry => entry.startTime >= resourceStartedAt);
            const totalMs = Math.round(performance.now() - totalStarted);
            const cpuAfter = await cpuSnapshot();
            const interactions = await runBenchmarkInteractions(route, routeResolution.searchQuery);
            pages.push({
              route,
              fromRoute,
              actualRoute: currentRoute(),
              iteration,
              temperature: iteration === 1 ? 'cold' : 'warm',
              navigationMs,
              readinessMs: readiness.durationMs,
              quietAfterReadyMs: quiet.durationMs,
              stableMs: readiness.durationMs + quiet.durationMs,
              totalMs,
              timedOut: readiness.timedOut || quiet.timedOut,
              readinessTimedOut: readiness.timedOut,
              stabilityTimedOut: quiet.timedOut,
              readinessDetails: routeReadinessDetails(route),
              mutationCount: quiet.mutationCount,
              longTaskCount: longTasks.length,
              longTaskTotalMs: Math.round(longTasks.reduce((sum, value) => sum + value, 0)),
              resourceCount: resources.length,
              resourceDurationMs: Math.round(resources.reduce((sum, entry) => sum + entry.duration, 0)),
              reactCommitCount: commits.length,
              reactActualDurationMs: Math.round(commits.reduce((sum, commit) => sum + commit.actualDurationMs, 0)),
              reactBaseDurationMs: Math.round(commits.reduce((sum, commit) => sum + commit.baseDurationMs, 0)),
              domNodeCount: host?.querySelectorAll('*').length ?? 0,
              imageCount: images.length,
              incompleteImageCount: images.filter(image => !image.complete).length,
              scrollHeight: scroll.scrollHeight,
              viewportHeight: scroll.viewportHeight,
              interactions,
              cpuBefore,
              cpuAfter,
            });
          }
        }
        const logTail = await commands.tailRuntimeLogs(logSeq, 20_000);
        logSeq = logTail.lastSeq;
        const summary = summarizeBenchmarkPages(pages);
        const reportWithoutMarkdown = {
          schemaVersion: 2 as const,
          id,
          startedAt,
          finishedAt: new Date().toISOString(),
          scenario: request.scenario,
          runs: request.runs,
          profile: request.profile,
          environment: {
            userAgent: navigator.userAgent,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio,
            },
            serverCount: initialAuth.servers.length,
            selectedServerCount: initialBrowseScope.serverIds.length,
            libraryScopeFingerprint: initialBrowseScope.fingerprint || null,
          },
          rendererStartup: buildRendererStartup(),
          pages,
          skippedRoutes: routeResolution.skippedRoutes,
          logs: logTail.lines.map(line => line.text),
          summary,
        };
        reportPayload = {
          ...reportWithoutMarkdown,
          markdown: formatBenchmarkMarkdown(reportWithoutMarkdown),
        };
      } catch (error) {
        reportPayload = {
          schemaVersion: 2,
          id,
          startedAt,
          finishedAt: new Date().toISOString(),
          scenario: request.scenario,
          runs: request.runs,
          profile: request.profile,
          rendererStartup: buildRendererStartup(),
          error: error instanceof Error ? error.message : String(error),
          pages,
          skippedRoutes: routeResolution.skippedRoutes,
        };
      } finally {
        await coverTrafficSetBenchmarkHold(previousCoverHold).catch(() => {});
        await setPsyLabDebugTraceOverrides(previousTraceOverrides);
        setRuntimeDebugLoggingOverride(previousRuntimeDebugOverride);
        restoreMainstageDiagnosticSections(mainstageSnapshot);
        if (previousLoggingMode != null) {
          await commands.setLoggingMode(previousLoggingMode).catch(() => {});
        }
        navigate(originalPathRef.current);
        await waitForPath(originalPathRef.current, ROUTE_TIMEOUT_MS).catch(() => {});
        if (previousBenchmarkAttribute == null) {
          document.documentElement.removeAttribute('data-benchmark-running');
        } else {
          document.documentElement.setAttribute('data-benchmark-running', previousBenchmarkAttribute);
        }
        runningRef.current = false;
      }
      await invoke('benchmark_publish_run', { payload: reportPayload }).catch(() => {});
    };
    listen('cli:benchmark-run', () => { void runPending(); }).then(value => {
      unlisten = value;
      void runPending();
    });
    return () => { unlisten?.(); };
  }, [navigate]);

  return null;
}
