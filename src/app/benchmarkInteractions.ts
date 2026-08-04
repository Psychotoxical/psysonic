import { APP_MAIN_SCROLL_VIEWPORT_ID, mainRouteInpageScrollViewportId } from '@/constants/appScroll';
import type {
  BenchmarkInteractionKind,
  BenchmarkInteractionResult,
  BenchmarkInteractionStatus,
} from '@/lib/perf/benchmark';

const INTERACTION_TIMEOUT_MS = 30_000;
const STABLE_WINDOW_MS = 700;
const ROUTE_HOST_SELECTOR = '.app-shell-route-host';

const SCROLL_PAGINATED_ROUTES = new Set([
  '/albums',
  '/artists',
  '/composers',
  '/tracks',
  '/new-releases',
  '/lossless-albums',
  '/search/advanced',
]);

type SemanticResult = {
  status: BenchmarkInteractionStatus;
  details?: Record<string, unknown>;
};

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function routePath(route: string): string {
  return new URL(route, window.location.origin).pathname.replace(/\/$/, '') || '/';
}

export function routeSupportsScrollPagination(route: string): boolean {
  const path = routePath(route);
  return SCROLL_PAGINATED_ROUTES.has(path) || /^\/genres\/[^/]+$/.test(path);
}

function routeHost(): Element | null {
  return document.querySelector(ROUTE_HOST_SELECTOR) ?? document.getElementById('root');
}

function roundDuration(started: number): number {
  return Math.round(performance.now() - started);
}

function waitForCondition(predicate: () => boolean, timeoutMs = INTERACTION_TIMEOUT_MS): Promise<boolean> {
  const started = performance.now();
  return new Promise(resolve => {
    const poll = () => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (performance.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(poll, 50);
    };
    poll();
  });
}

async function waitForDomQuiet(root: Element): Promise<{ durationMs: number; timedOut: boolean }> {
  await nextFrame();
  await nextFrame();
  const started = performance.now();
  let lastMutationAt = started;
  const observer = new MutationObserver(() => {
    lastMutationAt = performance.now();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  const result = await new Promise<{ durationMs: number; timedOut: boolean }>(resolve => {
    const poll = () => {
      const now = performance.now();
      if (now - lastMutationAt >= STABLE_WINDOW_MS) {
        resolve({ durationMs: Math.round(now - started), timedOut: false });
        return;
      }
      if (now - started >= INTERACTION_TIMEOUT_MS) {
        resolve({ durationMs: Math.round(now - started), timedOut: true });
        return;
      }
      window.setTimeout(poll, 100);
    };
    window.setTimeout(poll, 100);
  });
  observer.disconnect();
  return result;
}

async function measureInteraction(
  name: string,
  kind: BenchmarkInteractionKind,
  action: () => Promise<SemanticResult>,
): Promise<BenchmarkInteractionResult> {
  const root = routeHost();
  if (!root) {
    return {
      name,
      kind,
      status: 'error',
      durationMs: 0,
      semanticMs: 0,
      quietAfterSemanticMs: 0,
      mutationCount: 0,
      details: { reason: 'route host unavailable' },
    };
  }

  const started = performance.now();
  let mutationCount = 0;
  const observer = new MutationObserver(records => {
    mutationCount += records.length;
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });

  try {
    const semantic = await action();
    const semanticMs = roundDuration(started);
    if (semantic.status !== 'completed') {
      return {
        name,
        kind,
        status: semantic.status,
        durationMs: semanticMs,
        semanticMs,
        quietAfterSemanticMs: 0,
        mutationCount,
        details: semantic.details,
      };
    }
    const quiet = await waitForDomQuiet(root);
    return {
      name,
      kind,
      status: quiet.timedOut ? 'timeout' : 'completed',
      durationMs: roundDuration(started),
      semanticMs,
      quietAfterSemanticMs: quiet.durationMs,
      mutationCount,
      details: semantic.details,
    };
  } catch (error) {
    return {
      name,
      kind,
      status: 'error',
      durationMs: roundDuration(started),
      semanticMs: roundDuration(started),
      quietAfterSemanticMs: 0,
      mutationCount,
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    observer.disconnect();
  }
}

function click(selector: string): boolean {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return false;
  element.click();
  return true;
}

function browseState(selector: string, attribute: string): string | null {
  return document.querySelector<HTMLElement>(selector)?.getAttribute(attribute) ?? null;
}

async function waitForBrowseState(
  selector: string,
  attribute: string,
  expected: string,
): Promise<boolean> {
  return waitForCondition(() => {
    const root = document.querySelector<HTMLElement>(selector);
    return root?.getAttribute(attribute) === expected
      && root.getAttribute('data-benchmark-loading') === 'false';
  });
}

async function setBooleanFilter(
  rootSelector: string,
  attribute: string,
  controlSelector: string,
  expected: boolean,
): Promise<boolean> {
  const expectedValue = expected ? 'true' : 'false';
  if (browseState(rootSelector, attribute) === expectedValue) {
    return waitForBrowseState(rootSelector, attribute, expectedValue);
  }
  if (!click(controlSelector)) return false;
  return waitForBrowseState(rootSelector, attribute, expectedValue);
}

async function setCycledFilter(
  rootSelector: string,
  attribute: string,
  controlSelector: string,
  expected: string,
  maxClicks: number,
): Promise<boolean> {
  for (let index = 0; index < maxClicks; index += 1) {
    const before = browseState(rootSelector, attribute);
    if (before === expected) return waitForBrowseState(rootSelector, attribute, expected);
    if (!click(controlSelector)) return false;
    if (!await waitForCondition(() => browseState(rootSelector, attribute) !== before)) return false;
  }
  return waitForBrowseState(rootSelector, attribute, expected);
}

function resultCount(selector: string): number {
  const raw = document.querySelector<HTMLElement>(selector)?.getAttribute('data-benchmark-result-count');
  const value = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

async function runAlbumsFilters(): Promise<BenchmarkInteractionResult[]> {
  const rootSelector = '[data-benchmark-filter-compilation]';
  const starControl = '[data-benchmark-filter="starred"]';
  const compilationControl = '[data-benchmark-filter="compilation"]';
  const originalStarred = browseState(rootSelector, 'data-benchmark-filter-starred') === 'true';
  const originalCompilation = browseState(rootSelector, 'data-benchmark-filter-compilation') ?? 'all';
  const results: BenchmarkInteractionResult[] = [];

  try {
    await setBooleanFilter(rootSelector, 'data-benchmark-filter-starred', starControl, false);
    await setCycledFilter(rootSelector, 'data-benchmark-filter-compilation', compilationControl, 'all', 3);
    results.push(await measureInteraction('filter:starred', 'filter', async () => {
      if (!click(starControl)) return { status: 'skipped', details: { reason: 'starred filter unavailable' } };
      const completed = await waitForBrowseState(rootSelector, 'data-benchmark-filter-starred', 'true');
      return {
        status: completed ? 'completed' : 'timeout',
        details: { resultCount: resultCount(rootSelector) },
      };
    }));
    results.push(await measureInteraction('filter:starred+compilation', 'filter', async () => {
      if (!click(compilationControl)) {
        return { status: 'skipped', details: { reason: 'compilation filter unavailable' } };
      }
      const completed = await waitForBrowseState(rootSelector, 'data-benchmark-filter-compilation', 'only');
      return {
        status: completed ? 'completed' : 'timeout',
        details: { resultCount: resultCount(rootSelector) },
      };
    }));
    await setCycledFilter(rootSelector, 'data-benchmark-filter-compilation', compilationControl, 'all', 3);
    await setBooleanFilter(rootSelector, 'data-benchmark-filter-starred', starControl, false);
    results.push(await runPaginationInteraction('/albums'));
  } finally {
    await setCycledFilter(
      rootSelector,
      'data-benchmark-filter-compilation',
      compilationControl,
      originalCompilation,
      3,
    );
    await setBooleanFilter(rootSelector, 'data-benchmark-filter-starred', starControl, originalStarred);
  }
  return results;
}

async function runArtistsFilters(): Promise<BenchmarkInteractionResult[]> {
  const rootSelector = '[data-benchmark-filter-credit]';
  const starControl = '[data-benchmark-filter="starred"]';
  const creditControl = '[data-benchmark-filter="credit"]';
  const originalStarred = browseState(rootSelector, 'data-benchmark-filter-starred') === 'true';
  const originalCredit = browseState(rootSelector, 'data-benchmark-filter-credit') ?? 'album';
  const results: BenchmarkInteractionResult[] = [];

  try {
    await setBooleanFilter(rootSelector, 'data-benchmark-filter-starred', starControl, false);
    await setCycledFilter(rootSelector, 'data-benchmark-filter-credit', creditControl, 'album', 2);
    results.push(await measureInteraction('filter:starred', 'filter', async () => {
      if (!click(starControl)) return { status: 'skipped', details: { reason: 'starred filter unavailable' } };
      const completed = await waitForBrowseState(rootSelector, 'data-benchmark-filter-starred', 'true');
      return {
        status: completed ? 'completed' : 'timeout',
        details: { resultCount: resultCount(rootSelector) },
      };
    }));
    results.push(await measureInteraction('filter:starred+track-credits', 'filter', async () => {
      if (!click(creditControl)) return { status: 'skipped', details: { reason: 'credit filter unavailable' } };
      const completed = await waitForBrowseState(rootSelector, 'data-benchmark-filter-credit', 'track');
      return {
        status: completed ? 'completed' : 'timeout',
        details: { resultCount: resultCount(rootSelector) },
      };
    }));
    await setCycledFilter(rootSelector, 'data-benchmark-filter-credit', creditControl, 'album', 2);
    await setBooleanFilter(rootSelector, 'data-benchmark-filter-starred', starControl, false);
    results.push(await runPaginationInteraction('/artists'));
  } finally {
    await setCycledFilter(rootSelector, 'data-benchmark-filter-credit', creditControl, originalCredit, 2);
    await setBooleanFilter(rootSelector, 'data-benchmark-filter-starred', starControl, originalStarred);
  }
  return results;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function runSearchInteraction(searchQuery: string | null): Promise<BenchmarkInteractionResult> {
  return measureInteraction('search:real-library-query', 'search', async () => {
    if (!searchQuery) return { status: 'skipped', details: { reason: 'no indexed artist or album name available' } };
    const input = document.querySelector<HTMLInputElement>('[data-benchmark-search-input]');
    const submit = document.querySelector<HTMLButtonElement>('[data-benchmark-search-submit]');
    if (!input || !submit) return { status: 'skipped', details: { reason: 'advanced search controls unavailable' } };
    setInputValue(input, searchQuery);
    await nextFrame();
    submit.click();
    const completed = await waitForCondition(() => {
      const root = document.querySelector<HTMLElement>('[data-advanced-search-root]');
      return root?.getAttribute('data-benchmark-search-state') === 'ready'
        && root.getAttribute('data-benchmark-search-query') === searchQuery;
    });
    return {
      status: completed ? 'completed' : 'timeout',
      details: {
        query: searchQuery,
        resultCount: resultCount('[data-advanced-search-root]'),
      },
    };
  });
}

function sentinelItemCount(sentinel: HTMLElement | null): number {
  const raw = sentinel?.getAttribute('data-benchmark-item-count');
  const value = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

async function runPaginationInteraction(route: string): Promise<BenchmarkInteractionResult> {
  return measureInteraction('pagination:scroll-next-page', 'pagination', async () => {
    const initialSentinel = document.querySelector<HTMLElement>('[data-benchmark-scroll-sentinel]');
    if (!initialSentinel) {
      return { status: 'skipped', details: { reason: 'no additional page available' } };
    }
    const initialCount = sentinelItemCount(initialSentinel);
    const viewportId = mainRouteInpageScrollViewportId(route) ?? APP_MAIN_SCROLL_VIEWPORT_ID;
    const viewport = document.getElementById(viewportId);
    if (!viewport) return { status: 'error', details: { reason: `scroll viewport unavailable: ${viewportId}` } };

    let sawLoading = initialSentinel.getAttribute('data-benchmark-loading') === 'true';
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.dispatchEvent(new Event('scroll', { bubbles: false }));
    const completed = await waitForCondition(() => {
      const sentinel = document.querySelector<HTMLElement>('[data-benchmark-scroll-sentinel]');
      if (!sentinel) return true;
      const loading = sentinel.getAttribute('data-benchmark-loading') === 'true';
      if (loading) sawLoading = true;
      return sentinelItemCount(sentinel) > initialCount || (sawLoading && !loading);
    });
    const currentSentinel = document.querySelector<HTMLElement>('[data-benchmark-scroll-sentinel]');
    return {
      status: completed ? 'completed' : 'timeout',
      details: {
        initialItemCount: initialCount,
        finalItemCount: currentSentinel ? sentinelItemCount(currentSentinel) : null,
        loadingObserved: sawLoading,
        hasMoreAfter: currentSentinel != null,
        viewportId,
      },
    };
  });
}

export async function runBenchmarkInteractions(
  route: string,
  searchQuery: string | null,
): Promise<BenchmarkInteractionResult[]> {
  const path = routePath(route);
  if (path === '/albums') return runAlbumsFilters();
  if (path === '/artists') return runArtistsFilters();
  if (path === '/search/advanced') {
    const search = await runSearchInteraction(searchQuery);
    return [search, await runPaginationInteraction(route)];
  }
  if (routeSupportsScrollPagination(route)) return [await runPaginationInteraction(route)];
  return [];
}
