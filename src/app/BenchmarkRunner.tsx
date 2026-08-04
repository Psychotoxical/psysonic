import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useLocation, useNavigate } from 'react-router';
import { commands } from '@/generated/bindings';
import { APP_MAIN_SCROLL_VIEWPORT_ID, mainRouteInpageScrollViewportId } from '@/constants/appScroll';
import { deriveLibraryBrowseScope } from '@/lib/library/libraryBrowseScope';
import { useAuthStore } from '@/store/authStore';
import { getAlbumBrowseTraceSnapshot } from '@/lib/library/albumBrowseDebug';
import { getArtistBrowseTraceSnapshot } from '@/lib/library/artistBrowseDebug';
import { getFavoritesBrowseTraceSnapshot } from '@/lib/library/favoritesBrowseDebug';
import { getTrackBrowseTraceSnapshot } from '@/lib/library/trackBrowseDebug';
import { useMainstageDiagnosticStore } from '@/features/home/store/mainstageDiagnosticStore';
import {
  getPsyLabDebugTraces,
  setPsyLabDebugTrace,
  type PsyLabDebugTraceId,
} from '@/lib/perf/psyLabDebugTraces';
import {
  beginBenchmarkReactCollection,
  benchmarkSectionsReady,
  finishBenchmarkReactCollection,
  formatBenchmarkMarkdown,
  summarizeBenchmarkPages,
  type BenchmarkPageResult,
  type BenchmarkReport,
  type BenchmarkRunRequest,
} from '@/lib/perf/benchmark';

const SCENARIOS: Record<string, readonly string[]> = {
  'core-pages': ['/', '/albums', '/artists', '/tracks', '/favorites'],
  'all-pages': [
    '/', '/albums', '/artists', '/composers', '/tracks', '/favorites',
    '/new-releases', '/genres', '/playlists', '/most-played',
    '/lossless-albums', '/folders', '/statistics', '/help', '/settings',
    '/whats-new', '/offline', '/radio',
  ],
};

const ROUTE_TIMEOUT_MS = 30_000;
const STABLE_WINDOW_MS = 700;

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function waitForPath(route: string, timeoutMs: number): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (window.location.pathname === route) {
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
  if (route === '/albums') {
    return getAlbumBrowseTraceSnapshot().some(entry => entry.step === 'ui_loading_false');
  }
  if (route === '/artists') {
    return getArtistBrowseTraceSnapshot().some(entry => entry.step === 'loading_false');
  }
  if (route === '/tracks') {
    return getTrackBrowseTraceSnapshot().some(entry => (
      entry.step === 'load_effect_done' ||
      entry.step === 'load_more_done' ||
      entry.step === 'load_more_error'
    ));
  }
  if (route === '/favorites') {
    return getFavoritesBrowseTraceSnapshot().some(entry => entry.step === 'load_complete');
  }
  if (route === '/') {
    const sections = Object.values(useMainstageDiagnosticStore.getState().sections);
    return benchmarkSectionsReady(sections.map(section => section.status));
  }
  return true;
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
  const result = await commands.performanceCpuSnapshot(false);
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
      document.documentElement.setAttribute('data-benchmark-running', 'true');
      originalPathRef.current = window.location.pathname;
      const routes = SCENARIOS[request.scenario] ?? SCENARIOS['core-pages'];
      const startedAt = new Date().toISOString();
      const id = reportId();
      const pages: BenchmarkPageResult[] = [];
      const initialAuth = useAuthStore.getState();
      const initialBrowseScope = deriveLibraryBrowseScope(initialAuth, new Set());
      const initialLogs = await commands.tailRuntimeLogs(null, 1);
      let logSeq = initialLogs.lastSeq;
      const previousLoggingMode = await commands.getLoggingMode();
      const previousTraces = getPsyLabDebugTraces();
      try {
        await commands.setLoggingMode('debug');
        for (const trace of Object.keys(previousTraces) as PsyLabDebugTraceId[]) {
          setPsyLabDebugTrace(trace, true);
        }
        if (request.profile === 'isolated') {
          await commands.libraryCoverBackfillSetUiPriority(true);
        }
        for (let iteration = 1; iteration <= request.runs; iteration += 1) {
          for (const route of routes) {
            navigate('/__benchmark-transition');
            await waitForPath('/__benchmark-transition', ROUTE_TIMEOUT_MS);
            await nextFrame();
            await nextFrame();
            const totalStarted = performance.now();
            const resourceStarted = performance.getEntriesByType('resource').length;
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
            const cpuBefore = await cpuSnapshot();
            beginBenchmarkReactCollection(route);
            if (route === '/') useMainstageDiagnosticStore.getState().reset();
            navigate(route);
            let navigationMs = 0;
            let stable = { durationMs: ROUTE_TIMEOUT_MS, mutationCount: 0, timedOut: true };
            try {
              navigationMs = await waitForPath(route, ROUTE_TIMEOUT_MS);
              await nextFrame();
              await nextFrame();
              const readiness = await waitForRouteReadiness(route, ROUTE_TIMEOUT_MS);
              const domStable = await waitForRouteStability(route);
              stable = {
                durationMs: readiness.durationMs + domStable.durationMs,
                mutationCount: domStable.mutationCount,
                timedOut: readiness.timedOut || domStable.timedOut,
              };
            } catch {
              stable.timedOut = true;
            }
            longTaskObserver?.disconnect();
            const commits = finishBenchmarkReactCollection(route);
            const host = document.querySelector('.app-shell-route-host');
            const images = host ? [...host.querySelectorAll('img')] : [];
            const scroll = routeScrollMetrics(route);
            const resources = performance.getEntriesByType('resource').slice(resourceStarted);
            const cpuAfter = await cpuSnapshot();
            pages.push({
              route,
              iteration,
              temperature: iteration === 1 ? 'cold' : 'warm',
              navigationMs,
              stableMs: stable.durationMs,
              totalMs: Math.round(performance.now() - totalStarted),
              timedOut: stable.timedOut,
              mutationCount: stable.mutationCount,
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
              cpuBefore,
              cpuAfter,
            });
          }
        }
        const logTail = await commands.tailRuntimeLogs(logSeq, 20_000);
        logSeq = logTail.lastSeq;
        const summary = summarizeBenchmarkPages(pages);
        const reportWithoutMarkdown = {
          schemaVersion: 1 as const,
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
          pages,
          logs: logTail.lines.map(line => line.text),
          summary,
        };
        const report: BenchmarkReport = {
          ...reportWithoutMarkdown,
          markdown: formatBenchmarkMarkdown(reportWithoutMarkdown),
        };
        await invoke('benchmark_publish_run', { payload: report });
      } catch (error) {
        await invoke('benchmark_publish_run', {
          payload: {
            schemaVersion: 1,
            id,
            startedAt,
            finishedAt: new Date().toISOString(),
            scenario: request.scenario,
            runs: request.runs,
            profile: request.profile,
            error: error instanceof Error ? error.message : String(error),
            pages,
          },
        }).catch(() => {});
      } finally {
        if (request.profile === 'isolated') {
          await commands.libraryCoverBackfillSetUiPriority(false).catch(() => {});
        }
        await commands.setLoggingMode(previousLoggingMode).catch(() => {});
        for (const trace of Object.keys(previousTraces) as PsyLabDebugTraceId[]) {
          setPsyLabDebugTrace(trace, previousTraces[trace]);
        }
        navigate(originalPathRef.current);
        document.documentElement.removeAttribute('data-benchmark-running');
        runningRef.current = false;
      }
    };
    listen('cli:benchmark-run', () => { void runPending(); }).then(value => {
      unlisten = value;
      void runPending();
    });
    return () => { unlisten?.(); };
  }, [navigate]);

  return null;
}
